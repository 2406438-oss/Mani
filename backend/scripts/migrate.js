'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/db');

const db = openDatabase();
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT`);

const migrationsDir = path.join(__dirname, '..', 'migrations');
const migrations = fs.readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();

for (const name of migrations) {
  const exists = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
  if (exists) continue;
  const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    db.exec('COMMIT');
    console.log(`Применена миграция ${name}`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
console.log(`Таблиц в базе: ${tables.length}`);
db.close();
