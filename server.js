const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Storage backend ──────────────────────────────────────────────────────────

let db = null; // postgres Pool, set up below if DATABASE_URL exists

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
    VALUES ('predictions', '{"dima":{},"diego":{}}'), ('results', '{}')
    ON CONFLICT (key) DO NOTHING;
  `);
  console.log('✅ PostgreSQL connected');
}

// File fallback
const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT = { predictions: { dima: {}, diego: {} }, results: {} };

function fileRead() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return JSON.parse(JSON.stringify(DEFAULT)); }
}
function fileWrite(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Unified read/write
async function readData() {
  if (db) {
    const res = await db.query('SELECT key, value FROM game_data');
    const out = { predictions: { dima: {}, diego: {} }, results: {} };
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

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/data', async (_req, res) => {
  try { res.json(await readData()); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/data', async (req, res) => {
  try {
    const { predictions, results } = req.body || {};
    const data = await readData();
    if (predictions) data.predictions = predictions;
    if (results !== undefined) data.results = results;
    await writeData(data);
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/health', (_req, res) => res.json({ ok: true, db: !!db }));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

(async () => {
  if (process.env.DATABASE_URL) {
    await initDB();
  } else {
    console.log('ℹ️  No DATABASE_URL — using data.json');
    if (!fs.existsSync(DATA_FILE)) fileWrite(DEFAULT);
  }
  app.listen(PORT, () => console.log(`⚽ WC 2026 running at http://localhost:${PORT}`));
})();
