const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  return pool;
}

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS game_data (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    INSERT INTO game_data (key, value)
    VALUES ('predictions', '{"dima":{},"diego":{},"firuze":{},"stefan":{}}'), ('results', '{}')
    ON CONFLICT (key) DO NOTHING;
  `);
}

async function readData(db) {
  const { rows } = await db.query('SELECT key, value FROM game_data');
  const out = { predictions: { dima: {}, diego: {}, firuze: {}, stefan: {}, simon: {}, moses: {}, sam: {}, troels: {}, madan: {} }, results: {}, lastSync: null };
  rows.forEach(r => {
    if (r.key === 'last_sync') out.lastSync = r.value?.ts ?? null;
    else out[r.key] = r.value;
  });
  return out;
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'DATABASE_URL not set. Add Vercel Postgres in Storage tab.' });
  }

  const db = getPool();

  try {
    await ensureSchema(db);

    if (req.method === 'GET') {
      return res.json(await readData(db));
    }

    if (req.method === 'POST') {
      const { predictions, results } = req.body || {};
      const data = await readData(db);
      if (predictions) data.predictions = predictions;
      if (results !== undefined) data.results = results;
      await db.query(
        `INSERT INTO game_data (key, value)
         VALUES ('predictions', $1::jsonb), ('results', $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(data.predictions), JSON.stringify(data.results)]
      );
      return res.json(data);
    }

    res.status(405).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
