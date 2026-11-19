'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { testConnection } = require('./db');
const { identity, ensureCsrf } = require('./auth');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public');

app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

// Session Setup
app.use(session({
  name: 'PSGWORK',
  secret: process.env.SESSION_SECRET || 'psg-pems-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 28800000 // 8 hours
  }
}));

// API Endpoint (must precede static files)
app.use('/api.php', apiRouter);

function h(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Serve root / index.php by evaluating dynamic template tokens
app.get(['/', '/index.php'], async (req, res) => {
  try {
    const u = await identity(req);
    const csrf = ensureCsrf(req);

    const indexPath = path.join(PUBLIC_DIR, 'index.php');
    let template = fs.readFileSync(indexPath, 'utf8');

    // Remove the PHP auth prologue
    template = template.replace(/<\?php\s*require[\s\S]*?\?>/i, '');

    // Replace CSRF token
    template = template.replace(/<\?=\s*h\(\$_SESSION\['csrf'\]\)\s*\?>/g, h(csrf));

    // Replace user data attributes on body
    template = template.replace(/<\?=\s*h\(\$u\['role'\]\s*\?\?\s*''\)\s*\?>/g, h(u?.role || ''));
    template = template.replace(/<\?=\s*h\(\$u\['name'\]\s*\?\?\s*''\)\s*\?>/g, h(u?.name || ''));
    template = template.replace(/<\?=\s*h\(\$u\['department'\]\s*\?\?\s*''\)\s*\?>/g, h(u?.department || ''));
    template = template.replace(/<\?=\s*h\(\$u\['email'\]\s*\?\?\s*''\)\s*\?>/g, h(u?.email || ''));

    // Handle the conditional rendering block
    // <?php if(!$u): ?> ... <?php else: ?> ... <?php endif; ?>
    const ifElseMatch = template.match(/<\?php\s+if\(!\$u\):\s*\?>([\s\S]*?)<\?php\s+else:\s*\?>([\s\S]*?)<\?php\s+endif;\s*\?>/i);
    if (ifElseMatch) {
      const signinHtml = ifElseMatch[1];
      const shellHtml = ifElseMatch[2];
      const chosenHtml = u ? shellHtml : signinHtml;
      template = template.replace(ifElseMatch[0], chosenHtml);
    }

    // Handle avatar / name replacements inside shell
    if (u) {
      template = template.replace(/<\?=\s*h\(mb_substr\(\$u\['name'\],0,1\)\)\s*\?>/g, h(u.name.charAt(0)));
      template = template.replace(/<\?=\s*h\(\$u\['name'\]\)\s*\?>/g, h(u.name));
      template = template.replace(/<\?=\s*h\(\$u\['department'\]\)\s*\?>/g, h(u.department));
      // script tags at end
      template = template.replace(/<\?php\s+if\(\$u\):\s*\?>([\s\S]*?)<\?php\s+endif;\s*\?>/i, '$1');
    } else {
      template = template.replace(/<\?php\s+if\(\$u\):\s*\?>([\s\S]*?)<\?php\s+endif;\s*\?>/i, '');
    }

    // Clean any remaining php tags
    template = template.replace(/<\?php[\s\S]*?\?>/g, '').replace(/<\?=[\s\S]*?\?>/g, '');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(template);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Serve static assets from public
app.use(express.static(PUBLIC_DIR));

// Start server
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🎓 PSG Practical Examination Management System (PEMS)`);
  console.log(`🌐 Local Server running at: http://localhost:${PORT}`);
  console.log(`🔑 Administrator Login: admin@psg.local`);
  console.log(`=======================================================`);
  try {
    await testConnection();
    await require('./migrations').runMigrations();
    console.log(`✅ Database connection verified.`);
  } catch (err) {
    console.error(`❌ Database connection failed:`, err.message);
  }
});
