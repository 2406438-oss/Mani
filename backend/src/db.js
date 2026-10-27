'use strict';

require('./env');

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..', '..');
const configuredPath = process.env.DATABASE_PATH || '.data/mani.sqlite';
const databasePath = path.isAbsolute(configuredPath)
  ? configuredPath
  : path.join(projectRoot, configuredPath);

function openDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { databasePath, openDatabase, transaction };
