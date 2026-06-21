const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/cdc-test', (_req, res) => res.sendFile(path.join(__dirname, 'public/cdc-test.html')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const JWT_EXPIRES = '7d';

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Storage backend ──────────────────────────────────────────────────────────

let db = null;

// Initial users — passwords will be hashed on first DB init
const SEED_USERS = [
  { username: 'nor',    name: 'Nor',    avatar: '🌊', pw: 'nor2026'    },
  { username: 'dima',   name: 'Dima',   avatar: '⚽', pw: 'dima2026'   },
  { username: 'diego',  name: 'Diego',  avatar: '🎯', pw: 'diego2026'  },
  { username: 'per',    name: 'Per',    avatar: '🦁', pw: 'per2026'    },
  { username: 'sam',    name: 'Sam',    avatar: '🔥', pw: 'sam2026'    },
  { username: 'moses',  name: 'Moses',  avatar: '⚡', pw: 'moses2026'  },
  { username: 'simon',  name: 'Simon',  avatar: '🎪', pw: 'simon2026'  },
  { username: 'firuze', name: 'Firuze', avatar: '🌺', pw: 'firuze2026' },
  { username: 'stefan', name: 'Stefan', avatar: '🦅', pw: 'stefan2026' },
  { username: 'troels', name: 'Troels', avatar: '🏆', pw: 'troels2026' },
  { username: 'madan',  name: 'Madan',  avatar: '🎭', pw: 'madan2026'  },
  { username: 'victoria', name: 'Victoria', avatar: '👑', pw: 'victoria2026' },
];

async function initDB() {
  const { Pool } = require('pg');
  db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  await db.query(`
    CREATE TABLE IF NOT EXISTS game_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO game_data (key, value)
    VALUES ('predictions', '{}'), ('results', '{}')
    ON CONFLICT (key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '⚽',
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed users if table is empty
  const { rowCount } = await db.query('SELECT 1 FROM users LIMIT 1');
  if (rowCount === 0) {
    console.log('🌱 Seeding users…');
    for (const u of SEED_USERS) {
      const hash = await bcrypt.hash(u.pw, 12);
      await db.query(
        'INSERT INTO users (username, name, avatar, password_hash, is_admin) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [u.username, u.name, u.avatar, hash, u.username === 'dima']
      );
    }
    console.log('✅ Users seeded');
  }

  // Migration: rename vic → victoria
  const { rowCount: vicRows } = await db.query("SELECT 1 FROM users WHERE username='vic'");
  if (vicRows > 0) {
    const hash = await bcrypt.hash('victoria2026', 12);
    await db.query("UPDATE users SET username='victoria', password_hash=$1 WHERE username='vic'", [hash]);
    console.log('✅ Migrated vic → victoria');
  }

  console.log('✅ PostgreSQL connected');
}

// ─── File fallback (local dev without DB) ─────────────────────────────────────

const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT = { predictions: {}, results: {} };

function fileRead() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return JSON.parse(JSON.stringify(DEFAULT)); }
}
function fileWrite(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function readData() {
  if (db) {
    const res = await db.query('SELECT key, value FROM game_data');
    const out = { predictions: {}, results: {} };
    res.rows.forEach(r => { out[r.key] = r.value; });
    return out;
  }
  return fileRead();
}

async function writeData(data) {
  if (db) {
    await db.query(
      `INSERT INTO game_data (key, value, updated_at) VALUES ('predictions',$1,NOW()),('results',$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [data.predictions, data.results]
    );
  } else {
    fileWrite(data);
  }
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    if (db) {
      const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [username.toLowerCase()]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign(
        { username: user.username, name: user.name, avatar: user.avatar, isAdmin: user.is_admin },
        JWT_SECRET, { expiresIn: JWT_EXPIRES }
      );
      res.json({ token, username: user.username, name: user.name, avatar: user.avatar, isAdmin: user.is_admin });
    } else {
      // Local dev fallback — check against seed list
      const u = SEED_USERS.find(u => u.username === username.toLowerCase());
      if (!u || u.pw !== password) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign(
        { username: u.username, name: u.name, avatar: u.avatar, isAdmin: u.username === 'dima' },
        JWT_SECRET, { expiresIn: JWT_EXPIRES }
      );
      res.json({ token, username: u.username, name: u.name, avatar: u.avatar, isAdmin: u.username === 'dima' });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ─── Data routes ──────────────────────────────────────────────────────────────

app.get('/api/data', async (_req, res) => {
  try { res.json(await readData()); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/data', requireAuth, async (req, res) => {
  try {
    const { predictions, results } = req.body || {};
    const data = await readData();
    if (predictions) data.predictions = predictions;
    // Only admin can write results
    if (results !== undefined && req.user.isAdmin) data.results = results;
    await writeData(data);
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/health', (_req, res) => res.json({ ok: true, db: !!db }));

// ─── SPA fallback ─────────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const _init = (async () => {
  if (process.env.DATABASE_URL) {
    await initDB();
  } else {
    console.log('ℹ️  No DATABASE_URL — using data.json + seed users for auth');
    if (!fs.existsSync(DATA_FILE)) fileWrite(DEFAULT);
  }
})().catch(e => console.error('Startup error:', e));

if (require.main === module) {
  _init.then(() => app.listen(PORT, () => console.log(`⚽ WC 2026 running at http://localhost:${PORT}`)));
}

module.exports = app;
