'use strict';

let token = sessionStorage.getItem('mani_token');
let currentUser = null;
let services = [];
let masters = [];
let selectedService = null;
let selectedMaster = null;
let selectedDate = null;
let selectedSlot = null;
let holdId = null;

const $ = (selector) => document.querySelector(selector);
const bookingNotice = (message = '') => { $('#booking-notice').textContent = message; };
const authNotice = (message = '') => { $('#auth-notice').textContent = message; };

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Ошибка сервера (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function goTo(id) {
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.toggle('is-active', screen.id === id));
  if (id === 'booking') loadCatalog().catch(showBookingError);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showBookingError(error) { bookingNotice(error.message || 'Не удалось выполнить запрос.'); }
function formatPrice(kopecks) { return new Intl.NumberFormat('ru-RU').format(kopecks / 100) + ' ₽'; }
function formatTime(iso, timezone = 'Europe/Moscow') { return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function formatDate(iso) { return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }

function renderServices() {
  const container = $('#service-list');
  container.replaceChildren();
  if (!services.length) return container.append(Object.assign(document.createElement('p'), { className: 'empty-message', textContent: 'Сейчас нет доступных услуг.' }));
  if (!selectedService || !services.some((item) => item.id === selectedService.id)) selectedService = services[0];
  for (const service of services) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="service" value="${service.id}" ${service.id === selectedService.id ? 'checked' : ''} /><span><b></b><small></small></span><i>✓</i>`;
    label.querySelector('b').textContent = service.title;
    label.querySelector('small').textContent = `${service.durationMin} мин · ${formatPrice(service.priceKopecks)}`;
    label.querySelector('input').addEventListener('change', () => { selectedService = service; selectedMaster = null; resetSlot(); renderMasters(); });
    container.append(label);
  }
}

function resetSlot() { selectedSlot = null; holdId = null; $('#booking-submit').disabled = true; }

function renderMasters() {
  const container = $('#master-list');
  container.replaceChildren();
  const eligible = masters.filter((master) => master.services.some((service) => service.id === selectedService?.id));
  if (!eligible.length) return container.append(Object.assign(document.createElement('p'), { className: 'empty-message', textContent: 'Для этой услуги пока нет доступного мастера.' }));
  if (!selectedMaster || !eligible.some((item) => item.id === selectedMaster.id)) selectedMaster = eligible[0];
  for (const master of eligible) {
    const label = document.createElement('label');
    const initial = master.name.trim().slice(0, 1).toUpperCase();
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'master'; input.value = master.id; input.checked = master.id === selectedMaster.id;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = initial;
    const details = document.createElement('span');
    const name = document.createElement('b'); name.textContent = master.name;
    const specialization = document.createElement('small'); specialization.textContent = master.specialization;
    const check = document.createElement('i'); check.textContent = '✓';
    details.append(name, specialization); label.append(input, avatar, details, check);
    input.addEventListener('change', () => { selectedMaster = master; resetSlot(); loadSlots().catch(showBookingError); });
    container.append(label);
  }
  loadSlots().catch(showBookingError);
}

function renderDates() {
  const container = $('#date-list');
  container.replaceChildren();
  const formatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'short' });
  const today = new Date();
  const dateKeys = Array.from({ length: 7 }, (_, index) => new Date(today.getTime() + index * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }));
  if (!selectedDate || !dateKeys.includes(selectedDate)) selectedDate = dateKeys[0];
  for (const date of dateKeys) {
    const label = document.createElement('label');
    const parts = formatter.formatToParts(new Date(`${date}T12:00:00Z`));
    const weekday = parts.find((part) => part.type === 'weekday')?.value || '';
    const day = parts.filter((part) => ['day', 'month'].includes(part.type)).map((part) => part.value).join(' ');
    label.innerHTML = `<input type="radio" name="date" value="${date}" ${date === selectedDate ? 'checked' : ''} /><span><b>${weekday}</b><small>${day}</small></span>`;
    label.querySelector('input').addEventListener('change', () => { selectedDate = date; resetSlot(); loadSlots().catch(showBookingError); });
    container.append(label);
  }
}

async function loadCatalog() {
  if (services.length && masters.length) return;
  const [serviceData, masterData] = await Promise.all([api('/services'), api('/masters')]);
  services = serviceData.items;
  masters = masterData.items;
  renderServices();
  renderDates();
  renderMasters();
}

async function loadSlots() {
  const container = $('#time-list');
  container.replaceChildren();
  resetSlot();
  if (!selectedService || !selectedMaster || !selectedDate) return;
  const query = new URLSearchParams({ date: selectedDate, serviceIds: selectedService.id });
  const data = await api(`/masters/${selectedMaster.id}/slots?${query}`);
  if (!data.slots.length) return container.append(Object.assign(document.createElement('p'), { className: 'empty-message', textContent: 'На эту дату свободного времени нет.' }));
  for (const slot of data.slots) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="time" /><span>${formatTime(slot.startsAt, data.timezone)}</span>`;
    label.querySelector('input').addEventListener('change', () => { selectedSlot = slot; holdId = null; $('#booking-submit').disabled = false; bookingNotice(''); });
    container.append(label);
  }
}

async function holdSelectedSlot() {
  const held = await api('/holds', { method: 'POST', body: JSON.stringify({ masterId: selectedMaster.id, serviceIds: [selectedService.id], startsAt: selectedSlot.startsAt }) });
  holdId = held.id;
  bookingNotice(`Время удерживается до ${formatTime(held.expiresAt)}.`);
}

$('#booking-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (!selectedSlot) throw new Error('Выберите свободное время.');
    if (!currentUser) { $('#account-dialog').showModal(); authNotice('Войдите или зарегистрируйтесь, чтобы подтвердить запись.'); return; }
    if (!currentUser.roles.includes('client')) throw new Error('Для самостоятельной записи нужен аккаунт клиента.');
    if (!holdId) await holdSelectedSlot();
    const result = await api('/appointments', { method: 'POST', body: JSON.stringify({ masterId: selectedMaster.id, serviceIds: [selectedService.id], startsAt: selectedSlot.startsAt, holdId }) });
    const appointment = result.appointment;
    $('#summary-service').textContent = appointment.services.map((service) => service.title).join(', ');
    $('#summary-master').textContent = appointment.master.name;
    $('#summary-date').textContent = formatDate(appointment.startsAt);
    resetSlot();
    goTo('confirmation');
  } catch (error) {
    if (error.status === 409) loadSlots().catch(showBookingError);
    showBookingError(error);
  }
});

async function displayMember(user) {
  currentUser = user;
  $('#guest-panel').hidden = true;
  $('#member-panel').hidden = false;
  $('#member-name').textContent = user.full_name;
  $('#member-email').textContent = user.email;
  $('#admin-link').hidden = !user.roles.includes('admin');
  document.querySelectorAll('[data-action="account"]').forEach((button) => { button.textContent = 'Профиль'; });
  const data = await api('/appointments/my');
  const container = $('#my-appointments');
  container.replaceChildren();
  if (!data.items.length) container.textContent = 'Записей пока нет.';
  for (const appointment of data.items) {
    const card = document.createElement('article');
    card.className = 'appointment-card';
    card.textContent = `${formatDate(appointment.startsAt)} · ${appointment.master.name} · ${appointment.services.map((service) => service.title).join(', ')} · ${appointment.status}`;
    container.append(card);
  }
}

async function completeLogin(result) {
  token = result.token;
  sessionStorage.setItem('mani_token', token);
  sessionStorage.setItem('mani_user', JSON.stringify(result.user));
  await displayMember(result.user);
  authNotice('Вход выполнен. Теперь можно подтвердить запись.');
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await completeLogin(await api('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) })); } catch (error) { authNotice(error.message); }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/auth/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    event.currentTarget.reset();
    authNotice('Аккаунт создан. Войдите с указанным email и паролем.');
  } catch (error) { authNotice(error.message); }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch (_) { /* local session still must be cleared */ }
  token = null; currentUser = null; sessionStorage.removeItem('mani_token'); sessionStorage.removeItem('mani_user');
  $('#member-panel').hidden = true; $('#guest-panel').hidden = false;
  document.querySelectorAll('[data-action="account"]').forEach((button) => { button.textContent = 'Войти'; });
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-go], [data-action]');
  if (!target) return;
  if (target.dataset.go) { event.preventDefault(); goTo(target.dataset.go); }
  if (target.dataset.action === 'account') $('#account-dialog').showModal();
  if (target.dataset.action === 'close-account') $('#account-dialog').close();
});

if (token) api('/appointments/my').then(() => {
  const storedUser = sessionStorage.getItem('mani_user');
  if (storedUser) return displayMember(JSON.parse(storedUser));
}).catch(() => { token = null; sessionStorage.removeItem('mani_token'); sessionStorage.removeItem('mani_user'); });
