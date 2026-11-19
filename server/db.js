'use strict';
const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '33317'),
  database: process.env.DB_NAME || 'psg_workspace',
  user: process.env.DB_USER || 'psg_app',
  password: process.env.DB_PASSWORD || '60bfbf258843e4a3d1fddb757357b357d598774d3b7c56e9',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+00:00',
  charset: 'utf8mb4',
});

/** Execute SQL, return all rows */
async function rows(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/** Execute SQL, return first row or {} */
async function one(sql, params = []) {
  const r = await rows(sql, params);
  return r[0] || {};
}

/** Execute SQL, return raw result (for INSERT/UPDATE/DELETE) */
async function query(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/** Get last insert ID from a result */
function uid(result) {
  return result ? result.insertId : 0;
}

/** Run a function inside a transaction */
async function tx(fn) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    conn.release();
    return result;
  } catch (e) {
    await conn.rollback();
    conn.release();
    throw e;
  }
}

/** Pool-aware versions using connection */
async function rowsConn(conn, sql, params = []) {
  const [result] = await conn.execute(sql, params);
  return result;
}
async function oneConn(conn, sql, params = []) {
  const r = await rowsConn(conn, sql, params);
  return r[0] || {};
}
async function queryConn(conn, sql, params = []) {
  const [result] = await conn.execute(sql, params);
  return result;
}

/** Test connection on startup, with auto-launch if MariaDB is stopped */
async function testConnection() {
  const port = process.env.DB_PORT || 33317;
  try {
    await pool.execute('SELECT 1');
    console.log('[DB] ✓ Connected to MariaDB psg_workspace on port', port);
    return true;
  } catch (e) {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const projectRoot = path.join(__dirname, '..');
    const myIni = path.join(projectRoot, 'var/mysql/my.ini');
    const mysqldExe = 'C:\\xampp\\mysql\\bin\\mysqld.exe';

    if (fs.existsSync(mysqldExe) && fs.existsSync(myIni)) {
      console.log('[DB] Starting local MariaDB instance on port ' + port + '...');
      try {
        const outLog = fs.openSync(path.join(projectRoot, 'var/db-output.log'), 'a');
        const errLog = fs.openSync(path.join(projectRoot, 'var/db-error.log'), 'a');
        const child = spawn(
          mysqldExe,
          [`--defaults-file=${myIni}`, '--bind-address=127.0.0.1', `--port=${port}`, '--console'],
          {
            cwd: projectRoot,
            detached: true,
            stdio: ['ignore', outLog, errLog],
          }
        );
        child.unref();

        // Wait up to 5 seconds for connection
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            await pool.execute('SELECT 1');
            console.log('[DB] ✓ Local MariaDB started and connected on port', port);
            return true;
          } catch (_) {}
        }
      } catch (spawnErr) {
        console.error('[DB] Failed to auto-launch mysqld:', spawnErr.message);
      }
    }

    console.error('[DB] ✗ Database connection failed:', e.message);
    return false;
  }
}

module.exports = { pool, rows, one, query, uid, tx, rowsConn, oneConn, queryConn, testConnection };
