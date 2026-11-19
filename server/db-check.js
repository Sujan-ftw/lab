'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { testConnection } = require('./db');

async function check() {
  try {
    await testConnection();
    console.log('[DB-WATCH] MariaDB connection healthy.');
  } catch (err) {
    console.error('[DB-WATCH] Database check alert:', err.message);
  }
}

check();
// Repeat periodically every 60s
setInterval(check, 60000);
