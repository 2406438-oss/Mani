'use strict';
const $ = (selector) => document.querySelector(selector);
const notice = (message = '') => { $('#admin-notice').textContent = message; };
async function api(path, options = {}) { const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status}).`); return data; }
let services = []; let masters = [];
function renderCatalog() { const checks = $('#master-services'); checks.replaceChildren(); const catalog = $('#service-catalog'); catalog.replaceChildren(); for (const service of services) { const label = document.createElement('label'); label.className = 'check-option'; label.innerHTML = `<input type="checkbox" name="serviceIds" value="${service.id}" /> <span></span>`; label.querySelector('span').textContent = `${service.title} · ${service.durationMin} мин`; checks.append(label); const item = document.createElement('div'); item.className = 'catalog-item'; const text = document.createElement('span'); text.textContent = `${service.title} · ${service.durationMin} мин · ${(service.priceKopecks / 100).toLocaleString('ru-RU')} ₽`; const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'catalog-remove'; remove.textContent = 'Убрать'; remove.addEventListener('click', async () => { if (!confirm(`Убрать услугу «${service.title}» из доступного каталога?`)) return; try { await api(`/admin/services/${service.id}`, { method: 'DELETE' }); await loadCatalog(); notice('Услуга убрана из доступного каталога.'); } catch (error) { notice(error.message); } }); item.append(text, remove); catalog.append(item); } const select = $('#schedule-master'); select.replaceChildren(...masters.map((master) => new Option(master.name, master.id))); }
async function loadCatalog() { [services, masters] = await Promise.all([api('/services').then((data) => data.items), api('/admin/masters').then((data) => data.items)]); renderCatalog(); }
function formatDate(value) { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(value)); }
async function loadAppointments() { 
  const data = await api('/admin/appointments'); 
  const container = $('#appointments'); 
  container.replaceChildren(); 
  if (!data.items.length) {
    container.textContent = 'Записей пока нет.'; 
    return;
  }
  
  for (const item of data.items) { 
    const card = document.createElement('article'); 
    card.className = 'appointment-card admin-appointment'; 
    
    const info = document.createElement('div');
    info.className = 'appointment-info';
    info.innerHTML = `
      <div class="appointment-date">${formatDate(item.startsAt)}</div>
      <div class="appointment-details">
        <strong>${item.client.name}</strong> (${item.client.email})<br>
        Мастер: ${item.master.name}<br>
        Услуги: ${item.services.map((service) => service.title).join(', ')}
      </div>
      <div class="appointment-status status-${item.status}">${getStatusText(item.status)}</div>
    `;
    
    card.append(info);
    
    // Кнопки управления записью
    if (item.status === 'booked') {
      const actions = document.createElement('div');
      actions.className = 'appointment-actions';
      
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'admin-action-btn cancel';
      cancelBtn.textContent = 'Отменить';
      cancelBtn.addEventListener('click', async () => {
        if (!confirm('Отменить эту запись от имени салона?')) return;
        try {
          await api(`/appointments/${item.id}`, { 
            method: 'PATCH', 
            body: JSON.stringify({ status: 'cancelled_by_salon' }) 
          });
          notice('Запись отменена.');
          await loadAppointments();
        } catch (error) {
          notice(error.message);
        }
      });
      
      const completeBtn = document.createElement('button');
      completeBtn.type = 'button';
      completeBtn.className = 'admin-action-btn complete';
      completeBtn.textContent = 'Завершить';
      completeBtn.addEventListener('click', async () => {
        try {
          await api(`/appointments/${item.id}`, { 
            method: 'PATCH', 
            body: JSON.stringify({ status: 'completed' }) 
          });
          notice('Запись завершена.');
          await loadAppointments();
        } catch (error) {
          notice(error.message);
        }
      });
      
      actions.append(completeBtn, cancelBtn);
      card.append(actions);
    }
    
    container.append(card); 
  } 
}

function getStatusText(status) {
  const statuses = {
    'booked': 'Активна',
    'completed': 'Завершена',
    'cancelled_by_client': 'Отменена клиентом',
    'cancelled_by_salon': 'Отменена салоном',
    'no_show': 'Не пришли'
  };
  return statuses[status] || status;
}
$('#service-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); await api('/admin/services', { method: 'POST', body: JSON.stringify({ title: values.title, durationMin: Number(values.durationMin), priceKopecks: Math.round(Number(values.priceRubles) * 100) }) }); form.reset(); await loadCatalog(); notice('Услуга добавлена.'); } catch (error) { notice(error.message); } });
$('#master-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const serviceIds = [...form.querySelectorAll('[name="serviceIds"]:checked')].map((input) => Number(input.value)); await api('/admin/masters', { method: 'POST', body: JSON.stringify({ ...values, serviceIds }) }); form.reset(); await loadCatalog(); notice('Мастер добавлен. Добавьте ему график работы.'); } catch (error) { notice(error.message); } });
$('#schedule-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const values = Object.fromEntries(new FormData(event.currentTarget)); await api(`/admin/masters/${values.masterId}/schedules`, { method: 'POST', body: JSON.stringify({ weekday: Number(values.weekday), startsAt: values.startsAt, endsAt: values.endsAt }) }); notice('График сохранён.'); } catch (error) { notice(error.message); } });
$('#reload').addEventListener('click', () => loadAppointments().catch((error) => notice(error.message)));
Promise.all([loadCatalog(), loadAppointments()]).catch((error) => { notice(error.message); });
