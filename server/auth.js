'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { rows, one, query } = require('./db');

const IDLE_TIMEOUT = 1800;    // 30 minutes
const ABS_TIMEOUT  = 28800;   // 8 hours

/** Get authenticated user from session, or null */
async function identity(req) {
  const sess = req.session;
  if (!sess || !sess.userId) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now - (sess.seen || 0) > IDLE_TIMEOUT) return null;
  if (now - (sess.born || 0) > ABS_TIMEOUT) return null;
  try {
    const u = await one(
      `SELECT u.id, email, u.name, role, epoch, active, d.name department
       FROM users u JOIN departments d ON d.id = u.department_id WHERE u.id = ?`,
      [sess.userId]
    );
    if (!u || !u.active || u.epoch !== sess.epoch) return null;
    sess.seen = now;
    // Update connection heartbeat
    await query('UPDATE connections SET seen=UTC_TIMESTAMP() WHERE token=?',
      [crypto.createHash('sha256').update(req.sessionID).digest('hex')]);
    return u;
  } catch (e) {
    return null;
  }
}

/** Middleware: require authenticated user */
async function requireAuth(req, res, next) {
  const u = await identity(req);
  if (!u) return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  req.user = u;
  next();
}

/** Middleware: require admin role */
async function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

/** Middleware: require staff role */
async function requireStaff(req, res, next) {
  if (req.user?.role !== 'staff') return res.status(403).json({ error: 'Staff access required.' });
  next();
}

/** CSRF check middleware */
function checkCsrf(req, res, next) {
  const token = req.headers['x-csrf-token'] || '';
  const sessToken = req.session?.csrf || '';
  if (!token || !sessToken || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessToken))) {
    return res.status(403).json({ error: 'Refresh the page and try again.' });
  }
  next();
}

/** Login handler */
async function login(req, d) {
  const email = (d.email || '').toLowerCase().trim().substring(0, 190);
  const ip = req.ip || '';
  const hash = crypto.createHash('sha256').update(email).digest('hex');

  // Rate limit: check logins table
  const attempts = await one(
    `SELECT COUNT(*) n FROM logins WHERE (ip=? OR identity_hash=?) AND at > UTC_TIMESTAMP() - INTERVAL 15 MINUTE`,
    [ip, hash]
  );
  if (parseInt(attempts.n) >= 12) {
    const err = new Error('Too many attempts. Try again in 15 minutes.');
    err.statusCode = 429;
    throw err;
  }

  await query('INSERT INTO logins(ip, identity_hash) VALUES (?,?)', [ip, hash]);

  const u = await one('SELECT * FROM users WHERE email=?', [email]);
  const rawHash = u?.password_hash || '';
  const normalizedHash = rawHash.replace(/^\$2y\$/, '$2a$');
  const ok = u && u.active && await bcrypt.compare(String(d.password || ''), normalizedHash);
  if (!ok) {
    const err = new Error('Email or password is incorrect, or this account is inactive.');
    err.statusCode = 401;
    throw err;
  }

  // Regenerate session
  await new Promise((resolve, reject) =>
    req.session.regenerate(err => err ? reject(err) : resolve())
  );

  const now = Math.floor(Date.now() / 1000);
  req.session.userId = u.id;
  req.session.epoch = u.epoch;
  req.session.born = now;
  req.session.seen = now;
  req.session.csrf = crypto.randomBytes(32).toString('hex');

  // Cleanup and log
  await query('DELETE FROM logins WHERE ip=? AND identity_hash=?', [ip, hash]);
  await query('UPDATE users SET last_login=UTC_TIMESTAMP() WHERE id=?', [u.id]);
  const tokenHash = crypto.createHash('sha256').update(req.sessionID).digest('hex');
  await query('INSERT INTO connections VALUES (?,?,UTC_TIMESTAMP())', [tokenHash, u.id]);
  await query('INSERT INTO events(actor,action,detail,session_id,version_id) VALUES (?,?,?,?,?)',
    [u.id, 'Login', 'Signed in to the workspace', null, null]);

  return { ok: true };
}

/** Audit log helper */
async function audit(actor, action, detail, sessionId = null, versionId = null) {
  await query('INSERT INTO events(actor,action,detail,session_id,version_id) VALUES (?,?,?,?,?)',
    [actor, action, detail, sessionId, versionId]);
}

/** Generate CSRF token (or return existing) */
function ensureCsrf(req) {
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrf;
}

module.exports = { identity, requireAuth, requireAdmin, requireStaff, checkCsrf, login, audit, ensureCsrf };
