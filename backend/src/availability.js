'use strict';

const { randomUUID } = require('node:crypto');
const { transaction } = require('./db');

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) badRequest('Укажите дату в формате ГГГГ-ММ-ДД.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) badRequest('Указана некорректная дата.');
  return date;
}

function validIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function timezoneOffset(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return representedAsUtc - date.getTime();
}

function localTimeToUtc(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt++) result = new Date(desired - timezoneOffset(result, timezone));
  return result;
}

function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM product_settings').all().map((row) => [row.key, row.value]));
}

function serviceDetails(db, serviceIds, masterId) {
  if (!Array.isArray(serviceIds) || !serviceIds.length || serviceIds.length > 5 || serviceIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
    badRequest('Выберите от одной до пяти услуг.');
  }
  const ids = [...new Set(serviceIds.map(Number))];
  if (ids.length !== serviceIds.length) badRequest('Услуга указана повторно.');
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT s.id, s.title, s.duration_min, s.price_kopecks
    FROM services s JOIN master_services ms ON ms.service_id = s.id
    WHERE ms.master_id = ? AND s.is_active = 1 AND s.id IN (${placeholders})`).all(masterId, ...ids);
  if (rows.length !== ids.length) badRequest('У выбранного мастера нет одной из выбранных услуг.');
  return rows;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function availableSlots(db, { masterId, date, serviceIds, excludeAppointmentId = null }) {
  if (!Number.isSafeInteger(Number(masterId)) || Number(masterId) < 1) badRequest('Некорректный мастер.');
  const parsedDate = parseDate(date);
  db.prepare('DELETE FROM slot_holds WHERE expires_at <= ?').run(new Date().toISOString());
  const master = db.prepare('SELECT id FROM masters WHERE id = ? AND is_active = 1').get(Number(masterId));
  if (!master) {
    const error = new Error('Мастер не найден.');
    error.status = 404;
    throw error;
  }
  const services = serviceDetails(db, serviceIds, Number(masterId));
  const duration = services.reduce((sum, service) => sum + service.duration_min, 0);
  const settings = getSettings(db);
  const timezone = settings.timezone || process.env.SALON_TIMEZONE || 'Europe/Moscow';
  let step = Number(settings.slot_step_min || 30);
  if (!Number.isInteger(step) || step < 5 || step > 120) step = 30;
  const weekday = parsedDate.getUTCDay() || 7;
  const schedules = db.prepare('SELECT starts_at, ends_at FROM schedules WHERE master_id = ? AND weekday = ? ORDER BY starts_at').all(Number(masterId), weekday);
  const dayStart = localTimeToUtc(date, '00:00', timezone);
  const nextDate = new Date(parsedDate.getTime() + 86400000).toISOString().slice(0, 10);
  const dayEnd = localTimeToUtc(nextDate, '00:00', timezone);
  const busy = [
    ...db.prepare("SELECT starts_at, ends_at FROM appointments WHERE master_id = ? AND status = 'booked' AND (? IS NULL OR id <> ?) AND starts_at < ? AND ends_at > ?")
      .all(Number(masterId), excludeAppointmentId, excludeAppointmentId, dayEnd.toISOString(), dayStart.toISOString()),
    ...db.prepare('SELECT starts_at, ends_at FROM time_blocks WHERE (master_id = ? OR master_id IS NULL) AND starts_at < ? AND ends_at > ?')
      .all(Number(masterId), dayEnd.toISOString(), dayStart.toISOString()),
    ...db.prepare('SELECT starts_at, ends_at FROM slot_holds WHERE master_id = ? AND expires_at > ? AND starts_at < ? AND ends_at > ?')
      .all(Number(masterId), new Date().toISOString(), dayEnd.toISOString(), dayStart.toISOString()),
  ];
  const slots = [];
  const now = Date.now();
  for (const schedule of schedules) {
    const start = localTimeToUtc(date, schedule.starts_at, timezone);
    const end = localTimeToUtc(date, schedule.ends_at, timezone);
    for (let cursor = start.getTime(); cursor + duration * 60000 <= end.getTime(); cursor += step * 60000) {
      const slotEnd = cursor + duration * 60000;
      if (cursor <= now || busy.some((item) => overlaps(cursor, slotEnd, Date.parse(item.starts_at), Date.parse(item.ends_at)))) continue;
      slots.push({ startsAt: new Date(cursor).toISOString(), endsAt: new Date(slotEnd).toISOString() });
    }
  }
  return { timezone, durationMin: duration, slots };
}

function createHold(db, userId, input) {
  return transaction(db, () => {
    const availability = availableSlots(db, input);
    if (!availability.slots.some((slot) => slot.startsAt === input.startsAt)) {
      const error = new Error('Это время уже занято или недоступно.');
      error.status = 409;
      throw error;
    }
    const slot = availability.slots.find((candidate) => candidate.startsAt === input.startsAt);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + Number(process.env.HOLD_TTL_MINUTES || 5) * 60000).toISOString();
    db.prepare('INSERT INTO slot_holds (id, user_id, master_id, starts_at, ends_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, Number(input.masterId), slot.startsAt, slot.endsAt, expiresAt, new Date().toISOString());
    return { id, expiresAt, startsAt: slot.startsAt, endsAt: slot.endsAt };
  });
}

module.exports = { availableSlots, createHold, serviceDetails, validIso, transaction };
