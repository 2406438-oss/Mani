'use strict';

const fs = require('node:fs');
const { databasePath } = require('../src/db');

for (const suffix of ['', '-wal', '-shm']) {
  const target = `${databasePath}${suffix}`;
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
require('./migrate');
