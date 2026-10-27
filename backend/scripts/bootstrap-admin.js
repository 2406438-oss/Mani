'use strict';

const { openDatabase, transaction } = require('../src/db');
const { hashPassword } = require('../src/security');

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || 'Администратор MANI';

if (!email && !password) {
  console.log('ADMIN_EMAIL и ADMIN_PASSWORD не заданы: начальный администратор не создаётся.');
  process.exit(0);
}

if (!email || !password) throw new Error('Укажите одновременно ADMIN_EMAIL и ADMIN_PASSWORD.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL должен быть корректным email-адресом.');
if (password.length < 10) throw new Error('ADMIN_PASSWORD должен содержать не менее 10 символов.');

const db = openDatabase();
transaction(db, () => {
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    const result = db.prepare('INSERT INTO users (email, password_hash, full_name, phone, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(email, hashPassword(password), name, new Date().toISOString());
    user = { id: Number(result.lastInsertRowid) };
    console.log(`Создан начальный администратор: ${email}`);
  } else {
    console.log(`Начальный администратор уже существует: ${email}`);
  }
  db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'admin')").run(user.id);
});
db.close();
