'use strict';

const { openDatabase, transaction } = require('../src/db');
const { hashPassword } = require('../src/security');

const db = openDatabase();
const now = new Date().toISOString();
const users = [
  { email: 'admin@mani.local', name: 'Администратор MANI', roles: ['admin'], password: 'AdminDemo!24' },
  { email: 'alina@mani.local', name: 'Алина', roles: ['master', 'admin'], password: 'MasterDemo!24', specialization: 'Топ-мастер · стаж 6 лет' },
  { email: 'vera@mani.local', name: 'Вера', roles: ['master'], password: 'MasterDemo!24', specialization: 'Мастер · стаж 4 года' },
  { email: 'client@mani.local', name: 'Тестовый клиент', roles: ['client'], password: 'ClientDemo!24', phone: '+79990000000' },
];

const services = [
  ['Маникюр с покрытием', 120, 240000],
  ['Экспресс-маникюр', 60, 150000],
  ['Маникюр без покрытия', 75, 170000],
  ['Снятие покрытия', 30, 50000],
  ['Укрепление ногтей', 45, 80000],
];

transaction(db, () => {
  const findUser = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, full_name, phone, created_at) VALUES (?, ?, ?, ?, ?)');
  const addRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)');
  const findMaster = db.prepare('SELECT id FROM masters WHERE user_id = ?');
  const insertMaster = db.prepare('INSERT INTO masters (user_id, specialization) VALUES (?, ?)');

  const ids = {};
  for (const user of users) {
    let row = findUser.get(user.email);
    if (!row) {
      const result = insertUser.run(user.email, hashPassword(user.password), user.name, user.phone || null, now);
      row = { id: Number(result.lastInsertRowid) };
    }
    ids[user.email] = Number(row.id);
    for (const role of user.roles) addRole.run(row.id, role);
    if (user.specialization && !findMaster.get(row.id)) insertMaster.run(row.id, user.specialization);
  }

  const masters = db.prepare('SELECT id, user_id FROM masters ORDER BY id').all();
  const insertService = db.prepare('INSERT INTO services (title, duration_min, price_kopecks) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM services WHERE title = ?)');
  for (const [title, duration, price] of services) insertService.run(title, duration, price, title);
  const serviceRows = db.prepare('SELECT id, title FROM services').all();
  const link = db.prepare('INSERT OR IGNORE INTO master_services (master_id, service_id) VALUES (?, ?)');
  for (const master of masters) for (const service of serviceRows) link.run(master.id, service.id);

  const addSchedule = db.prepare('INSERT OR IGNORE INTO schedules (master_id, weekday, starts_at, ends_at) VALUES (?, ?, ?, ?)');
  for (const master of masters) {
    for (let weekday = 1; weekday <= 6; weekday++) addSchedule.run(master.id, weekday, '09:00', '20:00');
  }

  const setting = db.prepare('INSERT OR IGNORE INTO product_settings (key, value) VALUES (?, ?)');
  setting.run('timezone', process.env.SALON_TIMEZONE || 'Europe/Moscow');
  setting.run('slot_step_min', '30');
  setting.run('currency', 'RUB');

  const appointmentExists = db.prepare("SELECT 1 FROM appointments WHERE client_id = ? AND master_id = ? AND status = 'booked' AND starts_at > ?");
  const clientId = ids['client@mani.local'];
  const service = serviceRows.find((row) => row.title === services[1][0]);
  for (const [index, master] of masters.entries()) {
    if (appointmentExists.get(clientId, master.id, now)) continue;
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 2 + index);
    date.setUTCHours(11 + index, 0, 0, 0);
    const starts = date.toISOString();
    date.setUTCMinutes(date.getUTCMinutes() + services[1][1]);
    const ends = date.toISOString();
    const result = db.prepare('INSERT INTO appointments (client_id, master_id, starts_at, ends_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'booked\', ?, ?)').run(clientId, master.id, starts, ends, now, now);
    db.prepare('INSERT INTO appointment_services (appointment_id, service_id, title_snapshot, duration_min, price_kopecks) VALUES (?, ?, ?, ?, ?)').run(Number(result.lastInsertRowid), service.id, services[1][0], services[1][1], services[1][2]);
  }
});

const summary = db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM masters) AS masters, (SELECT COUNT(*) FROM services) AS services, (SELECT COUNT(*) FROM appointments) AS appointments').get();
console.log('Тестовые данные готовы:', summary);
console.log('Учётные записи для локальной разработки:');
for (const user of users) console.log(`  ${user.email} / ${user.password}`);
console.log('Не используйте тестовые пароли вне локальной разработки.');
db.close();
