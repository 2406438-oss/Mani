'use strict';

require('./env');

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { openDatabase, transaction } = require('./db');
const { availableSlots, createHold, serviceDetails, validIso } = require('./availability');
const { hashPassword, verifyPassword, newToken, hashToken } = require('./security');

const db = openDatabase();
const PORT = Number(process.env.PORT || 3000);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DRAFT_ROOT = path.join(PROJECT_ROOT, 'draft-ui');
const ADMIN_ROOT = path.join(PROJECT_ROOT, 'admin');

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function conflict(message, alternativeSlots = []) {
  const error = apiError(409, message);
  error.alternativeSlots = alternativeSlots;
  return error;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) {
        reject(apiError(413, 'Размер запроса превышает допустимый.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        const value = JSON.parse(body);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('not_object');
        resolve(value);
      } catch {
        reject(apiError(400, 'Передайте корректный JSON-объект.'));
      }
    });
    req.on('error', reject);
  });
}

function requireString(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw apiError(400, `Проверьте поле «${label}».`);
  return value.trim();
}

function safeUser(userId) {
  const user = db.prepare('SELECT id, email, full_name, phone FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const roles = db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(userId).map((row) => row.role);
  return { ...user, roles };
}

function authenticate(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{32,})$/);
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)mani_session=([A-Za-z0-9_-]{32,})(?:;|$)/);
  const match = bearer || cookie;
  if (!match) throw apiError(401, 'Войдите в аккаунт.');
  const row = db.prepare(`SELECT t.user_id FROM access_tokens t
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?`).get(hashToken(match[1]), new Date().toISOString());
  if (!row) throw apiError(401, 'Сессия истекла. Войдите снова.');
  return { ...safeUser(Number(row.user_id)), tokenHash: hashToken(match[1]) };
}

function sessionCookie(token, maxAge = null, secure = false) {
  const attributes = ['HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (maxAge !== null) attributes.push(`Max-Age=${maxAge}`);
  if (secure) attributes.push('Secure');
  return `mani_session=${token}; ${attributes.join('; ')}`;
}

function cookieValue(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function secureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
}

function clearCookie(name, secure) {
  const attributes = ['HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return `${name}=; ${attributes.join('; ')}`;
}

function createSession(userId) {
  const { token, hash } = newToken();
  const expiresAt = new Date(Date.now() + Number(process.env.SESSION_TTL_HOURS || 12) * 3600000).toISOString();
  db.prepare('INSERT INTO access_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(hash, userId, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

function yandexConfig() {
  const clientId = process.env.YANDEX_CLIENT_ID?.trim();
  const clientSecret = process.env.YANDEX_CLIENT_SECRET;
  const redirectUri = process.env.YANDEX_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri || !/^https:\/\//.test(redirectUri)) throw apiError(503, 'Вход через Яндекс ID пока не настроен.');
  return { clientId, clientSecret, redirectUri };
}

function equalValue(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function yandexJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(502, 'Яндекс ID временно не ответил. Повторите попытку позже.');
  return data;
}

function requireRole(user, role) {
  if (!user.roles.includes(role)) throw apiError(403, 'Недостаточно прав для этого действия.');
}

function salonTimezone() {
  return db.prepare("SELECT value FROM product_settings WHERE key = 'timezone'").get()?.value || process.env.SALON_TIMEZONE || 'Europe/Moscow';
}

function recordAttempt(identity, succeeded) {
  db.prepare('INSERT INTO login_attempts (identity_key, attempted_at, succeeded) VALUES (?, ?, ?)')
    .run(identity, new Date().toISOString(), succeeded ? 1 : 0);
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')").run();
}

function checkRateLimit(identity, failuresOnly = true) {
  const sql = failuresOnly
    ? "SELECT COUNT(*) AS count FROM login_attempts WHERE identity_key = ? AND succeeded = 0 AND attempted_at > datetime('now', '-15 minutes')"
    : "SELECT COUNT(*) AS count FROM login_attempts WHERE identity_key = ? AND attempted_at > datetime('now', '-15 minutes')";
  const recent = db.prepare(sql).get(identity);
  if (Number(recent.count) >= 10) throw apiError(429, 'Слишком много попыток. Повторите через 15 минут.');
}

function clientAddress(req) {
  return req.socket.remoteAddress || 'unknown';
}

function sanitizeAppointment(row) {
  if (!row) return null;
  const services = db.prepare('SELECT service_id AS id, title_snapshot AS title, duration_min AS durationMin, price_kopecks AS priceKopecks FROM appointment_services WHERE appointment_id = ?').all(row.id);
  return {
    id: Number(row.id), startsAt: row.starts_at, endsAt: row.ends_at, status: row.status,
    client: { id: Number(row.client_id), name: row.client_name, email: row.client_email, phone: row.client_phone },
    master: { id: Number(row.master_id), name: row.master_name }, services,
    intentionalOverlap: Boolean(row.intentional_overlap),
  };
}

const APPOINTMENT_SELECT = `SELECT a.id, a.client_id, a.master_id, a.starts_at, a.ends_at, a.status, a.intentional_overlap,
  c.full_name AS client_name, c.email AS client_email, c.phone AS client_phone, muser.full_name AS master_name
  FROM appointments a JOIN users c ON c.id = a.client_id
  JOIN masters m ON m.id = a.master_id JOIN users muser ON muser.id = m.user_id`;

function appointmentById(id) {
  const row = db.prepare(`${APPOINTMENT_SELECT} WHERE a.id = ?`).get(id);
  return sanitizeAppointment(row);
}

function checkAppointmentAccess(user, id) {
  const record = db.prepare('SELECT a.id, a.client_id, a.master_id FROM appointments a WHERE a.id = ?').get(id);
  if (!record) throw apiError(404, 'Запись не найдена.');
  if (user.roles.includes('admin')) return record;
  if (user.roles.includes('client') && Number(record.client_id) === user.id) return record;
  const masterUser = db.prepare('SELECT user_id FROM masters WHERE id = ?').get(record.master_id);
  if (user.roles.includes('master') && masterUser && Number(masterUser.user_id) === user.id) return record;
  throw apiError(403, 'У вас нет доступа к этой записи.');
}

function parseServices(body) {
  const ids = body.serviceIds ?? (body.serviceId ? [body.serviceId] : null);
  if (!Array.isArray(ids)) throw apiError(400, 'Укажите выбранные услуги.');
  return ids;
}

function createAppointment(user, body, options = {}) {
  const masterId = Number(body.masterId);
  if (!Number.isSafeInteger(masterId) || masterId < 1 || !validIso(body.startsAt)) throw apiError(400, 'Проверьте мастера и время записи в UTC.');
  const serviceIds = parseServices(body);
  const serviceRows = serviceDetails(db, serviceIds, masterId);
  const duration = serviceRows.reduce((sum, service) => sum + service.duration_min, 0);
  const start = Date.parse(body.startsAt);
  const end = new Date(start + duration * 60000).toISOString();
  const now = new Date().toISOString();

  return transaction(db, () => {
    db.prepare('DELETE FROM slot_holds WHERE expires_at <= ?').run(now);
    let hold = null;
    if (!options.allowWithoutHold) {
      if (typeof body.holdId !== 'string') throw apiError(400, 'Сначала удержите выбранное время.');
      hold = db.prepare('SELECT id, master_id, starts_at, ends_at FROM slot_holds WHERE id = ? AND user_id = ? AND expires_at > ?').get(body.holdId, user.id, now);
      if (!hold || Number(hold.master_id) !== masterId || hold.starts_at !== body.startsAt || hold.ends_at !== end) throw conflict('Удержание времени истекло. Выберите время заново.');
      db.prepare('DELETE FROM slot_holds WHERE id = ?').run(body.holdId);
    }

    const date = new Intl.DateTimeFormat('en-CA', { timeZone: salonTimezone() }).format(new Date(start));
    const free = availableSlots(db, { masterId, date, serviceIds });
    const requestedIsFree = free.slots.some((slot) => slot.startsAt === body.startsAt && slot.endsAt === end);
    if (!requestedIsFree && !options.intentionalOverlap) throw conflict('Это время уже занято. Выберите другой интервал.', free.slots.slice(0, 5));
    const result = db.prepare(`INSERT INTO appointments
      (client_id, master_id, starts_at, ends_at, status, intentional_overlap, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'booked', ?, ?, ?)`)
      .run(options.clientId || user.id, masterId, body.startsAt, end, options.intentionalOverlap ? 1 : 0, now, now);
    const appointmentId = Number(result.lastInsertRowid);
    const addService = db.prepare(`INSERT INTO appointment_services
      (appointment_id, service_id, title_snapshot, duration_min, price_kopecks) VALUES (?, ?, ?, ?, ?)`);
    for (const service of serviceRows) addService.run(appointmentId, service.id, service.title, service.duration_min, service.price_kopecks);
    return appointmentId;
  });
}

function expireHolds() {
  db.prepare('DELETE FROM slot_holds WHERE expires_at <= ?').run(new Date().toISOString());
}

function serveDraft(req, res, pathname) {
  const relative = pathname === '/draft' || pathname === '/draft/' ? 'index.html' : pathname.replace(/^\/draft\//, '');
  const file = path.resolve(DRAFT_ROOT, relative);
  if (!file.startsWith(`${DRAFT_ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveStatic(req, res, root, pathname, indexPath = '/', allowedFiles = null) {
  const relative = pathname === indexPath ? 'index.html' : pathname.slice(1);
  if (allowedFiles && !allowedFiles.includes(relative)) return false;
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/health') return json(res, 200, { status: 'ok' });
  if (!pathname.startsWith('/api/')) {
    if (serveDraft(req, res, pathname)) return;
    if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      const user = authenticate(req);
      requireRole(user, 'admin');
      return serveStatic(req, res, ADMIN_ROOT, '/');
    }
    if (req.method === 'GET' && pathname === '/admin.js') return serveStatic(req, res, ADMIN_ROOT, '/admin.js');
    if (req.method === 'GET' && serveStatic(req, res, PROJECT_ROOT, pathname, '/', ['index.html', 'styles.css', 'app.js'])) return;
    return json(res, 404, { error: 'Страница не найдена.' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' }).end();
    return;
  }
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
  const route = `${req.method} ${pathname}`;

  if (route === 'POST /api/auth/register') {
    const name = requireString(body.fullName, 'имя', 100);
    const email = requireString(body.email, 'email', 254).toLowerCase();
    const password = requireString(body.password, 'пароль', 128);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) throw apiError(400, 'Укажите корректный email и пароль длиной не менее 10 символов.');
    const identity = `register:${clientAddress(req)}`;
    checkRateLimit(identity, false);
    recordAttempt(identity, true);
    try {
      const result = transaction(db, () => {
        const inserted = db.prepare('INSERT INTO users (email, password_hash, full_name, phone, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(email, hashPassword(password), name, typeof body.phone === 'string' && body.phone.length <= 30 ? body.phone.trim() || null : null, new Date().toISOString());
        const userId = Number(inserted.lastInsertRowid);
        db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, 'client')").run(userId);
        return userId;
      });
      return json(res, 201, { user: safeUser(result) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw apiError(409, 'Пользователь с таким email уже зарегистрирован.');
      throw error;
    }
  }

  if (route === 'POST /api/auth/login') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const identity = `login:${clientAddress(req)}:${email.slice(0, 254)}`;
    const ipIdentity = `login-ip:${clientAddress(req)}`;
    checkRateLimit(identity);
    checkRateLimit(ipIdentity);
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
    const ok = Boolean(user && typeof body.password === 'string' && body.password.length <= 128 && verifyPassword(body.password, user.password_hash));
    recordAttempt(identity, ok);
    recordAttempt(ipIdentity, ok);
    if (!ok) throw apiError(401, 'Неверный email или пароль.');
    const { token, expiresAt } = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000), secureRequest(req)));
    return json(res, 200, { token, expiresAt, user: safeUser(Number(user.id)) });
  }

  if (route === 'GET /api/auth/me') {
    const user = authenticate(req);
    return json(res, 200, { user: safeUser(user.id) });
  }

  if (route === 'GET /api/auth/yandex') {
    const { clientId, redirectUri } = yandexConfig();
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'login:info,login:email', state, code_challenge: challenge, code_challenge_method: 'S256' });
    res.writeHead(302, {
      Location: `https://oauth.yandex.com/authorize?${params}`,
      'Set-Cookie': `mani_yandex_oauth=${state}.${verifier}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureRequest(req) ? '; Secure' : ''}`,
      'Cache-Control': 'no-store',
    }).end();
    return;
  }

  if (route === 'GET /api/auth/yandex/callback') {
    const secure = secureRequest(req);
    const failure = (reason) => {
      res.writeHead(302, { Location: `/?oauth_error=${encodeURIComponent(reason)}`, 'Set-Cookie': clearCookie('mani_yandex_oauth', secure), 'Cache-Control': 'no-store' }).end();
    };
    if (url.searchParams.has('error')) return failure('yandex_denied');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const [savedState, verifier] = (cookieValue(req, 'mani_yandex_oauth') || '').split('.', 2);
    if (!code || !state || !savedState || !verifier || !equalValue(state, savedState)) return failure('invalid_state');
    try {
      const { clientId, clientSecret, redirectUri } = yandexConfig();
      const tokenData = await yandexJson('https://oauth.yandex.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code_verifier: verifier }),
      });
      if (typeof tokenData.access_token !== 'string') throw apiError(502, 'Яндекс ID не выдал токен доступа.');
      const profile = await yandexJson('https://login.yandex.ru/info?format=json', { headers: { Authorization: `OAuth ${tokenData.access_token}` } });
      const providerUserId = String(profile.id || profile.uid || '');
      const email = typeof profile.default_email === 'string' ? profile.default_email.trim().toLowerCase() : typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
      const fullName = typeof profile.real_name === 'string' ? profile.real_name.trim() : typeof profile.display_name === 'string' ? profile.display_name.trim() : typeof profile.login === 'string' ? profile.login.trim() : '';
      if (!providerUserId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName) throw apiError(502, 'Яндекс ID не вернул обязательные данные профиля.');
      const userId = transaction(db, () => {
        const identity = db.prepare("SELECT user_id FROM external_identities WHERE provider = 'yandex' AND provider_user_id = ?").get(providerUserId);
        if (identity) return Number(identity.user_id);
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw apiError(409, 'Аккаунт с таким email уже существует. Войдите паролем.');
        const result = db.prepare('INSERT INTO users (email, password_hash, full_name, created_at) VALUES (?, ?, ?, ?)')
          .run(email, hashPassword(randomBytes(32).toString('base64url')), fullName.slice(0, 100), new Date().toISOString());
        const id = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, 'client')").run(id);
        db.prepare("INSERT INTO external_identities (provider, provider_user_id, user_id, created_at) VALUES ('yandex', ?, ?, ?)").run(providerUserId, id, new Date().toISOString());
        return id;
      });
      const session = createSession(userId);
      res.writeHead(302, { Location: '/?oauth=success', 'Set-Cookie': [sessionCookie(session.token, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000), secure), clearCookie('mani_yandex_oauth', secure)], 'Cache-Control': 'no-store' }).end();
    } catch (error) {
      if (error.status === 409) return failure('email_exists');
      if (error.status === 503) return failure('not_configured');
      console.error('Yandex OAuth error:', error.message);
      return failure('failed');
    }
    return;
  }

  if (route === 'POST /api/auth/logout') {
    const user = authenticate(req);
    db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ?').run(new Date().toISOString(), user.tokenHash);
    res.setHeader('Set-Cookie', sessionCookie('', 0, secureRequest(req)));
    return json(res, 200, { message: 'Вы вышли из аккаунта.' });
  }

  if (route === 'GET /api/services') {
    const items = db.prepare('SELECT id, title, duration_min AS durationMin, price_kopecks AS priceKopecks FROM services WHERE is_active = 1 ORDER BY id').all();
    return json(res, 200, { items });
  }

  if (route === 'GET /api/masters') {
    const items = db.prepare(`SELECT m.id, u.full_name AS name, m.specialization, m.is_active AS isActive,
      (SELECT json_group_array(json_object('id', s.id, 'title', s.title)) FROM master_services ms JOIN services s ON s.id = ms.service_id WHERE ms.master_id = m.id AND s.is_active = 1) AS services
      FROM masters m JOIN users u ON u.id = m.user_id WHERE m.is_active = 1 ORDER BY m.id`).all()
      .map((item) => ({ ...item, id: Number(item.id), isActive: Boolean(item.isActive), services: JSON.parse(item.services || '[]') }));
    return json(res, 200, { items });
  }

  const slotsMatch = pathname.match(/^\/api\/masters\/(\d+)\/slots$/);
  if (req.method === 'GET' && slotsMatch) {
    const serviceIds = (url.searchParams.get('serviceIds') || url.searchParams.get('serviceId') || '').split(',').filter(Boolean);
    return json(res, 200, availableSlots(db, { masterId: Number(slotsMatch[1]), date: url.searchParams.get('date'), serviceIds }));
  }

  if (route === 'POST /api/holds') {
    const user = authenticate(req);
    requireRole(user, 'client');
    if (!validIso(body.startsAt)) throw apiError(400, 'Укажите начало интервала в UTC.');
    const hold = createHold(db, user.id, { masterId: Number(body.masterId), date: new Intl.DateTimeFormat('en-CA', { timeZone: salonTimezone() }).format(new Date(body.startsAt)), serviceIds: parseServices(body), startsAt: body.startsAt });
    return json(res, 201, hold);
  }

  if (route === 'POST /api/appointments') {
    const user = authenticate(req);
    requireRole(user, 'client');
    const id = createAppointment(user, body);
    return json(res, 201, { appointment: appointmentById(id) });
  }

  if (route === 'GET /api/appointments/my') {
    const user = authenticate(req);
    if (!user.roles.some((role) => ['client', 'master', 'admin'].includes(role))) throw apiError(403, 'Недостаточно прав.');
    let rows;
    if (user.roles.includes('admin')) rows = db.prepare(`${APPOINTMENT_SELECT} ORDER BY a.starts_at DESC`).all();
    else if (user.roles.includes('master')) rows = db.prepare(`${APPOINTMENT_SELECT} JOIN masters own_m ON own_m.id = a.master_id WHERE (a.client_id = ? OR own_m.user_id = ?) ORDER BY a.starts_at DESC`).all(user.id, user.id);
    else rows = db.prepare(`${APPOINTMENT_SELECT} WHERE a.client_id = ? ORDER BY a.starts_at DESC`).all(user.id);
    return json(res, 200, { items: rows.map(sanitizeAppointment) });
  }

  const adminAppointments = route === 'GET /api/admin/appointments';
  if (adminAppointments) {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const rows = db.prepare(`${APPOINTMENT_SELECT} ORDER BY a.starts_at DESC`).all();
    return json(res, 200, { items: rows.map(sanitizeAppointment) });
  }

  const appointmentMatch = pathname.match(/^\/api\/appointments\/(\d+)(?:\/(cancel))?$/);
  if (appointmentMatch) {
    const user = authenticate(req);
    const id = Number(appointmentMatch[1]);
    const current = checkAppointmentAccess(user, id);
    if (req.method === 'GET' && !appointmentMatch[2]) return json(res, 200, { appointment: appointmentById(id) });
    if (req.method === 'POST' && appointmentMatch[2]) {
      const status = user.roles.includes('admin') || user.roles.includes('master') ? 'cancelled_by_salon' : 'cancelled_by_client';
      db.prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
      return json(res, 200, { appointment: appointmentById(id) });
    }
    if (req.method === 'PATCH' && !appointmentMatch[2]) {
      if (!user.roles.includes('admin') && Number(current.client_id) !== user.id) throw apiError(403, 'Переносить запись может её владелец или администратор.');
      const startAt = body.startsAt;
      const masterId = body.masterId === undefined ? Number(current.master_id) : Number(body.masterId);
      if (!validIso(startAt)) throw apiError(400, 'Укажите новое время в UTC.');
      const serviceIds = body.serviceIds || db.prepare('SELECT service_id FROM appointment_services WHERE appointment_id = ?').all(id).map((row) => row.service_id);
      const rows = serviceDetails(db, serviceIds, masterId);
      const endAt = new Date(Date.parse(startAt) + rows.reduce((sum, row) => sum + row.duration_min, 0) * 60000).toISOString();
      transaction(db, () => {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: salonTimezone() }).format(new Date(startAt));
        const free = availableSlots(db, { masterId, date, serviceIds, excludeAppointmentId: id });
        if (!free.slots.some((slot) => slot.startsAt === startAt && slot.endsAt === endAt)) throw conflict('Выбранное время занято.', free.slots.slice(0, 5));
        db.prepare("UPDATE appointments SET master_id = ?, starts_at = ?, ends_at = ?, intentional_overlap = 0, updated_at = ? WHERE id = ? AND status = 'booked'")
          .run(masterId, startAt, endAt, new Date().toISOString(), id);
        db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
        const add = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, title_snapshot, duration_min, price_kopecks) VALUES (?, ?, ?, ?, ?)');
        for (const row of rows) add.run(id, row.id, row.title, row.duration_min, row.price_kopecks);
      });
      return json(res, 200, { appointment: appointmentById(id) });
    }
  }

  if (route === 'POST /api/admin/appointments') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const clientId = Number(body.clientId);
    if (!Number.isSafeInteger(clientId) || !db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'client'").get(clientId)) throw apiError(400, 'Укажите существующего клиента.');
    const id = createAppointment(user, body, { allowWithoutHold: true, intentionalOverlap: body.intentionalOverlap === true, clientId });
    return json(res, 201, { appointment: appointmentById(id) });
  }

  if (route === 'POST /api/admin/services') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const title = requireString(body.title, 'название услуги', 100);
    const duration = Number(body.durationMin);
    const price = Number(body.priceKopecks);
    if (!Number.isInteger(duration) || duration < 15 || duration > 600 || !Number.isSafeInteger(price) || price < 0) throw apiError(400, 'Проверьте длительность и цену в копейках.');
    const result = db.prepare('INSERT INTO services (title, duration_min, price_kopecks) VALUES (?, ?, ?)').run(title, duration, price);
    return json(res, 201, { id: Number(result.lastInsertRowid), title, durationMin: duration, priceKopecks: price });
  }

  if (route === 'POST /api/admin/masters') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const name = requireString(body.fullName, 'имя мастера', 100);
    const email = requireString(body.email, 'email', 254).toLowerCase();
    const password = requireString(body.password, 'пароль', 128);
    const specialization = requireString(body.specialization, 'специализация', 200);
    if (body.serviceIds !== undefined && (!Array.isArray(body.serviceIds) || body.serviceIds.length > 30)) throw apiError(400, 'Список услуг должен быть массивом.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) throw apiError(400, 'Проверьте email и пароль (минимум 10 символов).');
    let masterId;
    try {
      masterId = transaction(db, () => {
        const created = db.prepare('INSERT INTO users (email, password_hash, full_name, created_at) VALUES (?, ?, ?, ?)')
          .run(email, hashPassword(password), name, new Date().toISOString());
        const userId = Number(created.lastInsertRowid);
        db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, 'master')").run(userId);
        const profile = db.prepare('INSERT INTO masters (user_id, specialization) VALUES (?, ?)').run(userId, specialization);
        const id = Number(profile.lastInsertRowid);
        const addService = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
        for (const serviceId of body.serviceIds || []) {
          const serviceIdNumber = Number(serviceId);
          if (!Number.isSafeInteger(serviceIdNumber) || !db.prepare('SELECT 1 FROM services WHERE id = ? AND is_active = 1').get(serviceIdNumber)) throw apiError(400, 'Выбрана неизвестная услуга.');
          addService.run(id, serviceIdNumber);
        }
        return id;
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw apiError(409, 'Пользователь с таким email уже существует.');
      throw error;
    }
    const master = db.prepare('SELECT id, user_id AS userId, specialization, is_active AS isActive FROM masters WHERE id = ?').get(masterId);
    return json(res, 201, { master: { ...master, id: Number(master.id), userId: Number(master.userId), isActive: Boolean(master.isActive) } });
  }

  if (route === 'GET /api/admin/masters') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const items = db.prepare(`SELECT m.id, m.user_id AS userId, u.full_name AS name, u.email,
      m.specialization, m.is_active AS isActive FROM masters m JOIN users u ON u.id = m.user_id ORDER BY m.id`).all()
      .map((item) => ({ ...item, id: Number(item.id), userId: Number(item.userId), isActive: Boolean(item.isActive) }));
    return json(res, 200, { items });
  }

  const masterAdminMatch = pathname.match(/^\/api\/admin\/masters\/(\d+)$/);
  if (masterAdminMatch && ['PATCH', 'DELETE'].includes(req.method)) {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const masterId = Number(masterAdminMatch[1]);
    if (req.method === 'DELETE') db.prepare('UPDATE masters SET is_active = 0 WHERE id = ?').run(masterId);
    else {
      const specialization = body.specialization === undefined ? null : requireString(body.specialization, 'специализация', 200);
      const isActive = body.isActive === undefined ? null : body.isActive === true ? 1 : body.isActive === false ? 0 : NaN;
      if (Number.isNaN(isActive)) throw apiError(400, 'Поле isActive должно быть логическим.');
      db.prepare('UPDATE masters SET specialization = COALESCE(?, specialization), is_active = COALESCE(?, is_active) WHERE id = ?').run(specialization, isActive, masterId);
    }
    return json(res, 200, { message: 'Данные мастера обновлены.' });
  }

  const masterServicesMatch = pathname.match(/^\/api\/admin\/masters\/(\d+)\/services$/);
  if (masterServicesMatch && req.method === 'PUT') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const masterId = Number(masterServicesMatch[1]);
    if (!db.prepare('SELECT 1 FROM masters WHERE id = ?').get(masterId) || !Array.isArray(body.serviceIds) || body.serviceIds.length > 30) throw apiError(400, 'Проверьте мастера и список услуг.');
    transaction(db, () => {
      db.prepare('DELETE FROM master_services WHERE master_id = ?').run(masterId);
      const insert = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
      for (const id of [...new Set(body.serviceIds.map(Number))]) {
        if (!Number.isSafeInteger(id) || !db.prepare('SELECT 1 FROM services WHERE id = ? AND is_active = 1').get(id)) throw apiError(400, 'Выбрана неизвестная услуга.');
        insert.run(masterId, id);
      }
    });
    return json(res, 200, { message: 'Список услуг мастера обновлён.' });
  }

  const scheduleMatch = pathname.match(/^\/api\/admin\/masters\/(\d+)\/schedules$/);
  if (scheduleMatch && req.method === 'POST') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const masterId = Number(scheduleMatch[1]);
    const weekday = Number(body.weekday);
    if (!db.prepare('SELECT 1 FROM masters WHERE id = ?').get(masterId) || !Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startsAt || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.endsAt || '') || body.startsAt >= body.endsAt) throw apiError(400, 'Проверьте день недели и время графика.');
    const overlap = db.prepare('SELECT 1 FROM schedules WHERE master_id = ? AND weekday = ? AND starts_at <> ? AND starts_at < ? AND ends_at > ?').get(masterId, weekday, body.startsAt, body.endsAt, body.startsAt);
    if (overlap) throw apiError(409, 'Интервал графика пересекается с уже добавленным.');
    db.prepare('INSERT INTO schedules (master_id, weekday, starts_at, ends_at) VALUES (?, ?, ?, ?) ON CONFLICT(master_id, weekday, starts_at) DO UPDATE SET ends_at = excluded.ends_at')
      .run(masterId, weekday, body.startsAt, body.endsAt);
    return json(res, 201, { message: 'График сохранён.' });
  }

  if (route === 'POST /api/admin/time-blocks') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const masterId = body.masterId === null ? null : Number(body.masterId);
    if ((masterId !== null && !db.prepare('SELECT 1 FROM masters WHERE id = ?').get(masterId)) || !validIso(body.startsAt) || !validIso(body.endsAt) || body.startsAt >= body.endsAt) throw apiError(400, 'Проверьте интервал блокировки.');
    const reason = requireString(body.reason, 'причина блокировки', 160);
    const result = db.prepare('INSERT INTO time_blocks (master_id, starts_at, ends_at, reason) VALUES (?, ?, ?, ?)').run(masterId, body.startsAt, body.endsAt, reason);
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }

  const serviceAdminMatch = pathname.match(/^\/api\/admin\/services\/(\d+)$/);
  if (serviceAdminMatch && ['PATCH', 'DELETE'].includes(req.method)) {
    const user = authenticate(req);
    requireRole(user, 'admin');
    const id = Number(serviceAdminMatch[1]);
    if (req.method === 'DELETE') db.prepare('UPDATE services SET is_active = 0 WHERE id = ?').run(id);
    else {
      const title = body.title === undefined ? null : requireString(body.title, 'название услуги', 100);
      const duration = body.durationMin === undefined ? null : Number(body.durationMin);
      const price = body.priceKopecks === undefined ? null : Number(body.priceKopecks);
      if (duration !== null && (!Number.isInteger(duration) || duration < 15 || duration > 600)) throw apiError(400, 'Проверьте длительность услуги.');
      if (price !== null && (!Number.isSafeInteger(price) || price < 0)) throw apiError(400, 'Проверьте цену в копейках.');
      db.prepare('UPDATE services SET title = COALESCE(?, title), duration_min = COALESCE(?, duration_min), price_kopecks = COALESCE(?, price_kopecks) WHERE id = ?').run(title, duration, price, id);
    }
    return json(res, 200, { message: 'Данные услуги обновлены.' });
  }

  if (route === 'PATCH /api/admin/settings') {
    const user = authenticate(req);
    requireRole(user, 'admin');
    if (typeof body.timezone !== 'string' || body.timezone.length > 80) throw apiError(400, 'Укажите корректный часовой пояс.');
    try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw apiError(400, 'Неизвестный часовой пояс.'); }
    db.prepare("INSERT INTO product_settings (key, value) VALUES ('timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(body.timezone);
    return json(res, 200, { message: 'Настройки сохранены.' });
  }

  return json(res, 404, { error: 'Эндпоинт не найден.' });
}

const server = http.createServer(async (req, res) => {
  try {
    expireHolds();
    await handle(req, res);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : String(error.message).includes('appointment_overlap') ? 409 : 500;
    if (status === 500) console.error(error);
    const message = status === 409 && String(error.message).includes('appointment_overlap')
      ? 'Это время уже занято. Обновите список свободного времени.'
      : error.status ? error.message : 'Внутренняя ошибка сервера.';
    if (!res.headersSent) json(res, status, { error: message, ...(error.alternativeSlots ? { alternativeSlots: error.alternativeSlots } : {}) });
    else res.destroy();
  }
});

server.listen(PORT, () => console.log(`MANI запущен: http://localhost:${PORT}/`));
process.on('SIGINT', () => { server.close(() => { db.close(); process.exit(0); }); });
process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); });
