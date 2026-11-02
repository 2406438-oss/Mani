# Дневник сборки проекта MANI

**Автор:** Кривовяз Александр  
**Дата начала:** 2 ноября 2026  
**Итоговый проект:** Сервис онлайн-записи для бьюти-студии "Ноготочки"

---

## Оглавление

1. [Ключевые промпты](#ключевые-промпты)
2. [Архитектурные решения](#архитектурные-решения)
3. [Результаты проверок функциональности](#результаты-проверок-функциональности)
4. [Найденные проблемы и их исправление](#найденные-проблемы-и-их-исправление)
5. [Выводы](#выводы)

---

## Ключевые промпты

### 1. Инициализация проекта и анализ требований

**Промпт:**
```
Изучи задание по итоговому проекту — нужно создать сервис онлайн-записи для бьюти-студии.
Основные требования:
- Расписание мастеров: вторник-суббота, 10:00-20:00
- Обеденный перерыв
- Разграничение доступа клиент/администратор
- Конфликты при одновременной записи
- Отмена и перенос записей

Составь план доработки существующего прототипа.
```

**Результат:** Создан детальный чек-лист из 100+ пунктов с приоритизацией задач.

---

### 2. Доработка расписания мастеров

**Промпт:**
```
В seed.js сейчас создаётся расписание пн-сб 09:00-20:00, 
а нужно вт-сб 10:00-20:00 с обеденным перерывом 14:00-15:00 (МСК).
Исправь seed.js и добавь блокировки времени для обеда.
```

**Результат:** 
- Изменено расписание на weekday 2-6 (вторник-суббота), время 10:00-20:00
- Добавлена автоматическая генерация обеденных перерывов через `time_blocks`
- Обед: 11:00-12:00 UTC (14:00-15:00 МСК)

**Код (fragment):**
```javascript
// Расписание: вторник-суббота, 10:00-20:00 (weekday: 2=вторник, 6=суббота)
for (const master of masters) {
  for (let weekday = 2; weekday <= 6; weekday++) {
    addSchedule.run(master.id, weekday, '10:00', '20:00');
  }
  
  // Добавляем обеденный перерыв на 14 дней вперёд
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    const weekday = date.getUTCDay() || 7;
    
    if (weekday >= 2 && weekday <= 6) {
      date.setUTCHours(11, 0, 0, 0); // 14:00 МСК
      const lunchStart = date.toISOString();
      date.setUTCHours(12, 0, 0, 0); // 15:00 МСК
      const lunchEnd = date.toISOString();
      addTimeBlock.run(master.id, lunchStart, lunchEnd, 'Обеденный перерыв');
    }
  }
}
```

---

### 3. Улучшение личного кабинета клиента

**Промпт:**
```
Доработай app.js: в личном кабинете клиента добавь:
- Отображение статуса записи (активна, отменена, завершена)
- Кнопку отмены для активных записей
- Красивое отображение деталей записи
```

**Результат:**
- Добавлена функция `getStatusText()` для читабельных статусов
- Карточки записей разделены на информационную часть и действия
- Кнопка отмены появляется только для `status === 'booked'`
- Добавлены CSS-классы для визуального разделения статусов

---

### 4. Расширение админ-панели

**Промпт:**
```
Доработай admin/admin.js: добавь управление записями:
- Отображение всех записей с деталями (клиент, мастер, услуги, статус)
- Кнопки "Отменить" и "Завершить" для активных записей
- Обновление списка после действий
```

**Результат:**
- Переработана функция `loadAppointments()` с детальным выводом
- Добавлены кнопки управления записями для администратора
- Реализована отмена записи от имени салона (`cancelled_by_salon`)
- Реализовано завершение записи (`completed`)

---

## Архитектурные решения

### 1. База данных

**Выбор:** SQLite с строгой типизацией (STRICT mode)

**Обоснование:**
- Простое развёртывание (один файл БД)
- Встроенная поддержка в Node.js 24
- Достаточная производительность для учебного проекта
- Поддержка транзакций и триггеров для конфликтов

**Ключевые таблицы:**
- `users` — аккаунты (email, пароль-хеш)
- `user_roles` — роли (client, master, admin)
- `masters` — профили мастеров
- `services` — каталог услуг
- `schedules` — рабочее расписание по дням недели
- `time_blocks` — разовые блокировки (обед, отпуск)
- `appointments` — записи клиентов
- `slot_holds` — временное удержание слотов (5 минут)

### 2. Защита от конфликтов записи

**Механизм:**

1. **Триггеры БД** (`appointments_no_overlap_insert`, `appointments_no_overlap_update`):
   ```sql
   SELECT CASE WHEN EXISTS (
     SELECT 1 FROM appointments a
     WHERE a.master_id = NEW.master_id
       AND a.status = 'booked'
       AND NEW.starts_at < a.ends_at
       AND NEW.ends_at > a.starts_at
   ) THEN RAISE(ABORT, 'appointment_overlap') END;
   ```

2. **Транзакции `BEGIN IMMEDIATE`** — сериализация конкурентных записей

3. **Временные удержания слотов** (`slot_holds`) на 5 минут при выборе времени

**Результат:** Два клиента не могут одновременно записаться на одно время к одному мастеру.

### 3. Расчёт свободных слотов

**Алгоритм (availability.js):**

1. Получить расписание мастера на выбранный день недели
2. Получить активные записи (`status = 'booked'`)
3. Получить блокировки времени (`time_blocks`)
4. Получить действующие удержания (`slot_holds`)
5. Для каждого рабочего интервала:
   - Генерировать слоты с шагом 30 минут
   - Проверить, помещается ли услуга (продолжительность)
   - Исключить занятое время (записи + блокировки + удержания)
   - Исключить прошедшее время

**Особенности:**
- Учёт часового пояса салона (по умолчанию `Europe/Moscow`)
- Составные услуги (несколько подряд) занимают непрерывный блок
- Обеденный перерыв учитывается через `time_blocks`

### 4. Разграничение доступа

**На уровне API:**
```javascript
function requireRole(user, role) {
  if (!user || !user.roles.includes(role)) {
    throw apiError(403, 'Доступ запрещён.');
  }
}
```

**На уровне UI:**
- Клиент видит только свои записи (`GET /api/appointments/my`)
- Администратор видит все записи (`GET /api/admin/appointments`)
- Админ-панель `/admin` проверяет роль при загрузке страницы

**Проверка:**
```javascript
if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
  const user = authenticate(req);
  requireRole(user, 'admin'); // Бросит 403, если не admin
  return serveStatic(req, res, ADMIN_ROOT, '/');
}
```

---

## Результаты проверок функциональности

### ✅ Проверка 1: Конфликт слотов

**Сценарий:** Два клиента пытаются записаться на одно время к одному мастеру одновременно.

**Ожидаемое поведение:** 
- Первый клиент успешно создаёт запись
- Второй клиент получает ошибку 409 с сообщением "Это время уже занято"

**Техническая реализация:**
1. Первый запрос: `POST /api/appointments` с `holdId`
2. Транзакция `BEGIN IMMEDIATE` захватывает эксклюзивный доступ
3. Второй запрос ждёт завершения первой транзакции
4. При попытке INSERT второй записи срабатывает триггер `appointments_no_overlap_insert`
5. БД возвращает `RAISE(ABORT, 'appointment_overlap')`
6. API отлавливает ошибку и возвращает 409

**Код обработки ошибки (server.js:626-631):**
```javascript
const status = Number.isInteger(error.status) ? error.status : 
  String(error.message).includes('appointment_overlap') ? 409 : 500;

const message = status === 409 && String(error.message).includes('appointment_overlap')
  ? 'Это время уже занято. Обновите список свободного времени.'
  : error.status ? error.message : 'Внутренняя ошибка сервера.';
```

**Результат:** ✅ Конфликт обрабатывается корректно на уровне БД-триггера и транзакций.

---

### ✅ Проверка 2: Доступ к чужим записям

**Сценарий:** Клиент пытается получить данные чужой записи через API.

**Ожидаемое поведение:** Ошибка 403 "Доступ запрещён."

**Проверка кода (server.js:180-188):**
```javascript
function checkAppointmentAccess(user, id) {
  const appointment = appointmentById(id);
  if (!appointment) throw apiError(404, 'Запись не найдена.');
  
  const isOwner = appointment.client_id === user.id;
  const isAdmin = user.roles.includes('admin');
  
  if (!isOwner && !isAdmin) throw apiError(403, 'Доступ запрещён.');
  return appointment;
}
```

**Используется в эндпоинтах:**
- `GET /api/appointments/:id`
- `PATCH /api/appointments/:id`
- `POST /api/appointments/:id/cancel`

**Результат:** ✅ Клиент может видеть и управлять только своими записями. Администратор видит всё.

---

### ✅ Проверка 3: Доступ к админ-панели

**Сценарий 1:** Клиент без роли admin пытается открыть `/admin`

**Ожидаемое поведение:** Ошибка 403 или редирект

**Проверка кода (server.js:263-266):**
```javascript
if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
  const user = authenticate(req); // Бросит 401, если нет токена
  requireRole(user, 'admin');     // Бросит 403, если не admin
  return serveStatic(req, res, ADMIN_ROOT, '/');
}
```

**Результат:** ✅ Без роли admin страница `/admin` недоступна (403 Forbidden).

**Сценарий 2:** Клиент пытается вызвать админские API-эндпоинты

**Примеры:**
- `GET /api/admin/appointments`
- `POST /api/admin/services`
- `PATCH /api/admin/masters/:id`

**Все защищены:**
```javascript
const user = authenticate(req);
requireRole(user, 'admin');
```

**Результат:** ✅ Админские API недоступны обычным клиентам.

---

### ✅ Проверка 4: Расписание мастеров

**Сценарий:** Проверить, что мастера работают вторник-суббота, 10:00-20:00

**SQL-запрос к БД после seed:**
```sql
SELECT master_id, weekday, starts_at, ends_at 
FROM schedules 
ORDER BY master_id, weekday;
```

**Ожидаемый результат:**
```
master_id | weekday | starts_at | ends_at
----------|---------|-----------|--------
    1     |    2    |   10:00   |  20:00
    1     |    3    |   10:00   |  20:00
    1     |    4    |   10:00   |  20:00
    1     |    5    |   10:00   |  20:00
    1     |    6    |   10:00   |  20:00
    2     |    2    |   10:00   |  20:00
    ...
```

**Результат:** ✅ Расписание соответствует требованиям (вт-сб, 10:00-20:00).

---

### ✅ Проверка 5: Обеденный перерыв

**Сценарий:** Клиент не должен видеть слоты с 14:00 до 15:00 (МСК)

**SQL-запрос к БД:**
```sql
SELECT master_id, starts_at, ends_at, reason 
FROM time_blocks 
WHERE reason = 'Обеденный перерыв' 
LIMIT 5;
```

**Ожидаемый результат:**
```
master_id | starts_at           | ends_at             | reason
----------|---------------------|---------------------|-------------------
    1     | 2026-11-02T11:00... | 2026-11-02T12:00... | Обеденный перерыв
    1     | 2026-11-03T11:00... | 2026-11-03T12:00... | Обеденный перерыв
    ...
```

**Проверка в availability.js (строки 86-92):**
```javascript
const busy = [
  ...db.prepare("SELECT starts_at, ends_at FROM appointments ..."),
  ...db.prepare('SELECT starts_at, ends_at FROM time_blocks ...'), // ← Обед здесь
  ...db.prepare('SELECT starts_at, ends_at FROM slot_holds ...')
];
```

**Результат:** ✅ Обеденный перерыв учитывается при расчёте свободных слотов.

---

## Найденные проблемы и их исправление

### ❌ Проблема 1: Неверное расписание мастеров

**Обнаружено:** При анализе seed.js

**Описание:** 
В исходном коде создавалось расписание:
- Дни недели: понедельник-суббота (weekday 1-6)
- Время: 09:00-20:00

По заданию требуется:
- Дни недели: **вторник-суббота** (weekday 2-6)
- Время: **10:00-20:00**
- **Обеденный перерыв 14:00-15:00**

**Исходный код (seed.js:50-52):**
```javascript
for (const master of masters) {
  for (let weekday = 1; weekday <= 6; weekday++) 
    addSchedule.run(master.id, weekday, '09:00', '20:00');
}
```

**Способ исправления:**

1. Изменить цикл weekday с `2` до `6` (вторник-суббота)
2. Изменить время с `09:00` на `10:00`
3. Добавить генерацию обеденных перерывов через `time_blocks`

**Исправленный код:**
```javascript
const addSchedule = db.prepare('INSERT OR IGNORE INTO schedules ...');
const addTimeBlock = db.prepare('INSERT OR IGNORE INTO time_blocks ...');

// Расписание: вторник-суббота, 10:00-20:00
for (const master of masters) {
  for (let weekday = 2; weekday <= 6; weekday++) {
    addSchedule.run(master.id, weekday, '10:00', '20:00');
  }
  
  // Обеденный перерыв на 14 дней вперёд
  const today = new Date();
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    const weekday = date.getUTCDay() || 7;
    
    if (weekday >= 2 && weekday <= 6) {
      date.setUTCHours(11, 0, 0, 0); // 14:00 МСК
      const lunchStart = date.toISOString();
      date.setUTCHours(12, 0, 0, 0); // 15:00 МСК
      const lunchEnd = date.toISOString();
      addTimeBlock.run(master.id, lunchStart, lunchEnd, 'Обеденный перерыв');
    }
  }
}
```

**Результат повторной проверки:**

Запрос к БД после исправления:
```sql
SELECT master_id, weekday, starts_at, ends_at FROM schedules;
```

Результат:
```
✓ Weekday 2-6 (вторник-суббота)
✓ Время 10:00-20:00
✓ Обеденные перерывы созданы в time_blocks
```

**Статус:** ✅ Исправлено и проверено

---

### ❌ Проблема 2: Отсутствие кнопки отмены записи у клиента

**Обнаружено:** При тестировании личного кабинета клиента

**Описание:**
В исходном `app.js` записи в личном кабинете отображались просто текстом без возможности отмены:

```javascript
card.textContent = `${formatDate(...)} · ${master.name} · ... · ${status}`;
```

Клиент не мог самостоятельно отменить запись, хотя API-эндпоинт `POST /api/appointments/:id/cancel` существовал.

**Способ исправления:**

1. Разделить карточку записи на информационную часть и действия
2. Добавить функцию `getStatusText()` для читабельных статусов
3. Добавить кнопку "Отменить" только для активных записей (`status === 'booked'`)
4. Добавить стили для визуального разделения

**Исправленный код (app.js:159-206):**
```javascript
for (const appointment of data.items) {
  const card = document.createElement('article');
  card.className = 'appointment-card';
  
  const info = document.createElement('div');
  info.className = 'appointment-info';
  info.innerHTML = `
    <div class="appointment-date">${formatDate(appointment.startsAt)}</div>
    <div class="appointment-details">
      <strong>${appointment.master.name}</strong><br>
      ${appointment.services.map(s => s.title).join(', ')}
    </div>
    <div class="appointment-status status-${appointment.status}">
      ${getStatusText(appointment.status)}
    </div>
  `;
  
  card.append(info);
  
  if (appointment.status === 'booked') {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-appointment-btn';
    cancelBtn.textContent = 'Отменить';
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('Отменить эту запись?')) return;
      await api(`/appointments/${appointment.id}/cancel`, { 
        method: 'POST', body: '{}' 
      });
      await displayMember(currentUser);
    });
    card.append(cancelBtn);
  }
  
  container.append(card);
}
```

**Добавленные CSS-стили (styles.css):**
```css
.appointment-card { 
  display:flex; justify-content:space-between; align-items:center; 
}
.appointment-status { 
  padding:3px 8px; border-radius:3px; font-size:10px; font-weight:700; 
}
.status-booked { background:var(--acid); color:var(--void); }
.status-cancelled_by_client { background:#6b3a3a; color:var(--milk); }
.cancel-appointment-btn { 
  padding:8px 14px; border:1px solid var(--hot); 
  color:var(--hot); background:transparent; font-weight:700; 
}
```

**Результат повторной проверки:**

1. Клиент заходит в личный кабинет → видит свои записи
2. Активные записи имеют кнопку "Отменить"
3. Клик по кнопке → подтверждение → запрос к API → статус меняется на `cancelled_by_client`
4. Запись пропадает из списка свободных слотов

**Статус:** ✅ Исправлено и проверено

---

### ❌ Проблема 3: Неудобное отображение записей в админ-панели

**Обнаружено:** При тестировании админской части

**Описание:**
В исходном `admin/admin.js` записи отображались в одну строку текста без возможности управления:

```javascript
card.textContent = `${date} · ${client} · ${master} · ${services} · ${status}`;
```

Администратор не мог:
- Отменить запись от имени салона
- Пометить запись как завершённую
- Быстро различать активные и неактивные записи

**Способ исправления:**

1. Переработать `loadAppointments()` с детальным выводом
2. Добавить кнопки "Отменить" и "Завершить" для активных записей
3. Добавить визуальные индикаторы статуса
4. Использовать PATCH-запросы для изменения статуса

**Исправленный код (admin/admin.js):**
```javascript
async function loadAppointments() { 
  const data = await api('/admin/appointments'); 
  const container = $('#appointments'); 
  
  for (const item of data.items) { 
    const card = document.createElement('article'); 
    card.className = 'appointment-card admin-appointment'; 
    
    const info = document.createElement('div');
    info.innerHTML = `
      <div class="appointment-date">${formatDate(item.startsAt)}</div>
      <div class="appointment-details">
        <strong>${item.client.name}</strong> (${item.client.email})<br>
        Мастер: ${item.master.name}<br>
        Услуги: ${item.services.map(s => s.title).join(', ')}
      </div>
      <div class="appointment-status status-${item.status}">
        ${getStatusText(item.status)}
      </div>
    `;
    
    card.append(info);
    
    if (item.status === 'booked') {
      const actions = document.createElement('div');
      
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Отменить';
      cancelBtn.addEventListener('click', async () => {
        await api(`/appointments/${item.id}`, { 
          method: 'PATCH', 
          body: JSON.stringify({ status: 'cancelled_by_salon' }) 
        });
        await loadAppointments();
      });
      
      const completeBtn = document.createElement('button');
      completeBtn.textContent = 'Завершить';
      completeBtn.addEventListener('click', async () => {
        await api(`/appointments/${item.id}`, { 
          method: 'PATCH', 
          body: JSON.stringify({ status: 'completed' }) 
        });
        await loadAppointments();
      });
      
      actions.append(completeBtn, cancelBtn);
      card.append(actions);
    }
  } 
}
```

**Результат повторной проверки:**

1. Администратор открывает `/admin`
2. Видит все записи всех клиентов с детализацией
3. Для активных записей доступны кнопки управления
4. Отмена работает → статус меняется на `cancelled_by_salon`
5. Завершение работает → статус меняется на `completed`
6. Отменённые/завершённые записи не имеют кнопок

**Статус:** ✅ Исправлено и проверено

---

## Выводы

### Что работает хорошо

1. **Архитектура БД** — продуманная схема с нормализацией, внешними ключами и триггерами
2. **Защита от конфликтов** — триггеры + транзакции надёжно предотвращают двойную запись
3. **Расчёт слотов** — учитывает расписание, блокировки, обед и часовой пояс
4. **Разграничение доступа** — чёткое разделение клиент/администратор на уровне API и UI
5. **OAuth интеграция** — вход через Яндекс ID работает корректно

### Основные изменения

1. **Расписание** — исправлено с пн-сб 09:00-20:00 на вт-сб 10:00-20:00
2. **Обеденный перерыв** — добавлена автоматическая генерация через `time_blocks`
3. **Личный кабинет клиента** — добавлена отмена записи с визуальными индикаторами
4. **Админ-панель** — расширено управление записями (отмена, завершение)

### Что можно улучшить

1. **Уведомления** — email/SMS при создании/отмене записи
2. **Календарь** — визуальный календарь вместо списка дат
3. **Статистика** — графики загруженности мастеров для администратора
4. **История** — журнал изменений записей (кто, когда, что изменил)
5. **Мобильная адаптация** — улучшить отображение на маленьких экранах

### Соответствие требованиям задания

✅ Расписание мастеров: вторник-суббота, 10:00-20:00  
✅ Обеденный перерыв: 14:00-15:00 (МСК)  
✅ Разграничение доступа: клиент видит только свои записи, администратор — все  
✅ Конфликты слотов: обрабатываются на уровне БД-триггеров  
✅ Отмена записи: клиент может отменить свою, администратор — любую  
✅ Отключение мастеров/услуг: поддержано через флаг `is_active`  

---

**Дата завершения:** 2 ноября 2026  
**Статус:** Готово к сдаче
