'use strict';

let token = null;
let currentUser = null;
let sessionVersion = 0;
let selectedSlot = null;
let holdId = null;
let services = [];
let masters = [];

const $ = (selector) => document.querySelector(selector);
const notice = (message = '') => { $('#notice').textContent = message; };

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || `Ошибка сервера (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showApp(user) {
  resetSessionView();
  currentUser = user;
  $('#auth-panel').hidden = true;
  $('#app-panel').hidden = false;
  $('#current-user').textContent = `${user.full_name} · роли: ${user.roles.join(', ')}`;
  $('#admin-tab').hidden = !user.roles.includes('admin');
  loadCatalog().catch(showError);
  loadMine().catch(showError);
}

function showError(error) { notice(error.message || 'Не удалось выполнить запрос.'); }

function resetSessionView() {
  sessionVersion += 1;
  for (const id of ['book', 'mine', 'admin']) $(`#tab-${id}`).hidden = id !== 'book';
  $('#appointments').replaceChildren();
  $('#admin-appointments').replaceChildren();
  $('#admin-catalog').replaceChildren();
  $('#admin-booking-form').reset();
  $('#admin-service-form').reset();
  $('#admin-master-form').reset();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(data) });
    token = result.token;
    showApp(result.user);
    notice('Вход выполнен.');
  } catch (error) { showError(error); }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/auth/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    notice(`Аккаунт создан (${result.user.email}). Теперь войдите.`);
    $('#login-form [name="email"]').value = result.user.email;
  } catch (error) { showError(error); }
});

$('#logout').addEventListener('click', async () => {
  const logoutRequest = api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  token = null;
  currentUser = null;
  resetSessionView();
  $('#admin-tab').hidden = true;
  $('#app-panel').hidden = true;
  $('#auth-panel').hidden = false;
  notice('Вы вышли из аккаунта.');
  await logoutRequest;
});

document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  for (const id of ['book', 'mine', 'admin']) $(`#tab-${id}`).hidden = id !== button.dataset.tab;
  if (button.dataset.tab === 'mine') loadMine().catch(showError);
  if (button.dataset.tab === 'admin') loadAdmin().catch(showError);
}));

async function loadCatalog() {
  const [serviceData, masterData] = await Promise.all([api('/services'), api('/masters')]);
  services = serviceData.items;
  masters = masterData.items;
  const serviceSelect = $('#services');
  serviceSelect.replaceChildren(...services.map((service) => {
    const option = document.createElement('option');
    option.value = service.id;
    option.textContent = `${service.title} · ${service.durationMin} мин · ${(service.priceKopecks / 100).toFixed(0)} ₽`;
    return option;
  }));
  const masterSelect = $('#masters');
  masterSelect.replaceChildren(...masters.map((master) => {
    const option = document.createElement('option');
    option.value = master.id;
    option.textContent = `${master.name} — ${master.specialization}`;
    return option;
  }));
  const adminMasterSelect = $('#admin-master');
  adminMasterSelect.replaceChildren(...masters.filter((master) => master.isActive).map((master) => {
    const option = document.createElement('option');
    option.value = master.id;
    option.textContent = `${master.name} — ${master.specialization}`;
    return option;
  }));
}

async function loadAvailableSlots() {
  const serviceIds = [...$('#services').selectedOptions].map((option) => option.value);
  if (!serviceIds.length) throw new Error('Выберите услугу.');
  if (!$('#booking-date').value) throw new Error('Выберите дату.');
  const masterId = $('#masters').value;
  const date = $('#booking-date').value;
  const query = new URLSearchParams({ date, serviceIds: serviceIds.join(',') });
  const data = await api(`/masters/${masterId}/slots?${query}`);
  const container = $('#slots');
  container.replaceChildren();
  selectedSlot = null;
  holdId = null;
  $('#confirm-booking').disabled = true;
  if (!data.slots.length) container.textContent = 'Свободного времени на эту дату нет.';
  for (const slot of data.slots) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = new Intl.DateTimeFormat('ru-RU', { timeZone: data.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(slot.startsAt));
    button.addEventListener('click', async () => {
      try {
        const held = await api('/holds', { method: 'POST', body: JSON.stringify({ masterId, serviceIds, startsAt: slot.startsAt }) });
        selectedSlot = slot;
        holdId = held.id;
        container.querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button));
        $('#confirm-booking').disabled = false;
        notice(`Время удерживается до ${new Date(held.expiresAt).toLocaleTimeString('ru-RU')}.`);
      } catch (error) {
        showError(error);
        if (error.status === 409) {
          try { await loadAvailableSlots(); } catch (refreshError) { showError(refreshError); }
        }
      }
    });
    container.append(button);
  }
}

$('#find-slots').addEventListener('click', () => loadAvailableSlots().catch(showError));

$('#booking-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (!selectedSlot || !holdId) throw new Error('Сначала выберите и удержите свободное время.');
    const serviceIds = [...$('#services').selectedOptions].map((option) => Number(option.value));
    const result = await api('/appointments', { method: 'POST', body: JSON.stringify({ masterId: Number($('#masters').value), serviceIds, startsAt: selectedSlot.startsAt, holdId }) });
    notice(`Запись №${result.appointment.id} создана.`);
    selectedSlot = null;
    holdId = null;
    $('#confirm-booking').disabled = true;
    await loadMine();
  } catch (error) { showError(error); }
});

function appointmentCard(item, canCancel = false) {
  const card = document.createElement('article');
  card.className = 'card';
  const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(item.startsAt));
  const details = document.createElement('p');
  details.textContent = `№${item.id} · ${date} · ${item.master.name} · ${item.services.map((service) => service.title).join(', ')} · ${item.status}`;
  card.append(details);
  if (item.status === 'cancelled_by_salon' && item.client.id === currentUser?.id) {
    const cancellationNotice = document.createElement('p');
    cancellationNotice.setAttribute('role', 'status');
    cancellationNotice.textContent = 'Администратор салона отменил эту запись.';
    card.append(cancellationNotice);
  }
  if (canCancel && item.status === 'booked') {
    const button = document.createElement('button');
    button.textContent = 'Отменить';
    button.addEventListener('click', async () => {
      try {
        await api(`/appointments/${item.id}/cancel`, { method: 'POST', body: '{}' });
        notice(`Запись №${item.id} отменена.`);
        await loadMine();
      } catch (error) { showError(error); }
    });
    card.append(button);
  }
  return card;
}

async function loadMine() {
  if (!token) return;
  const version = sessionVersion;
  const userId = currentUser.id;
  const data = await api('/appointments/my');
  if (version !== sessionVersion || currentUser?.id !== userId) return;
  const container = $('#appointments');
  container.replaceChildren();
  if (!data.items.length) container.textContent = 'Записей пока нет.';
  for (const item of data.items) container.append(appointmentCard(item, item.client.id === currentUser.id));
}

async function loadAdmin() {
  if (!currentUser?.roles.includes('admin')) return;
  const version = sessionVersion;
  const data = await api('/admin/appointments');
  if (version !== sessionVersion || !currentUser?.roles.includes('admin')) return;
  const container = $('#admin-appointments');
  container.replaceChildren();
  if (!data.items.length) container.textContent = 'Записей пока нет.';
  for (const item of data.items) {
    const card = appointmentCard(item, true);
    const client = document.createElement('p');
    client.textContent = `Клиент: ${item.client.name} · ${item.client.email}`;
    card.append(client);
    container.append(card);
  }
  const catalog = $('#admin-catalog');
  catalog.replaceChildren();
  const heading = document.createElement('p');
  heading.textContent = `Услуг: ${services.length}; мастеров: ${masters.length}.`;
  catalog.append(heading);
}

$('#admin-booking-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const startsAt = new Date(values.startsAt);
    if (!Number.isFinite(startsAt.getTime())) throw new Error('Укажите корректное время начала записи.');
    const result = await api('/admin/appointments', {
      method: 'POST',
      body: JSON.stringify({
        clientId: Number(values.clientId),
        masterId: Number($('#admin-master').value),
        serviceId: Number(values.serviceId),
        startsAt: startsAt.toISOString(),
        intentionalOverlap: $('#admin-booking-form [name="intentionalOverlap"]').checked
      })
    });
    event.currentTarget.reset();
    notice(`Запись №${result.appointment.id} создана администратором.`);
    await loadAdmin();
  } catch (error) { showError(error); }
});

$('#admin-service-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/admin/services', {
      method: 'POST',
      body: JSON.stringify({
        title: values.title,
        durationMin: Number(values.durationMin),
        priceKopecks: Number(values.priceKopecks)
      })
    });
    event.currentTarget.reset();
    notice(`Услуга «${result.title}» создана.`);
    await loadCatalog();
    await loadAdmin();
  } catch (error) { showError(error); }
});

$('#admin-master-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/admin/masters', { method: 'POST', body: JSON.stringify(values) });
    event.currentTarget.reset();
    notice(`Мастер №${result.master.id} создан.`);
    await loadCatalog();
    await loadAdmin();
  } catch (error) { showError(error); }
});

$('#reload-admin').addEventListener('click', () => loadAdmin().catch(showError));
