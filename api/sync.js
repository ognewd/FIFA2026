const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  return pool;
}

// ── Team name mapping: football-data.org → our names ──────────────────────────
const API_TO_OURS = {
  'Czechia': 'Czech Republic',
  "Côte d'Ivoire": 'Ivory Coast',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Türkiye': 'Turkey',
  'United States': 'USA',
  'Korea Republic': 'South Korea',
  'Republic of Korea': 'South Korea',
  'Islamic Republic of Iran': 'Iran',
  'Congo DR': 'DR Congo',
  'Democratic Republic of Congo': 'DR Congo',
};
function mapTeam(n) { return API_TO_OURS[n] || n; }
function norm(n) { return n.toLowerCase().replace(/[^a-z]/g, ''); }

// ── All 72 group stage matches ─────────────────────────────────────────────────
const MATCHES = {
  A1:{h:'Mexico',a:'South Africa'}, A2:{h:'South Korea',a:'Czech Republic'},
  A3:{h:'Mexico',a:'Czech Republic'}, A4:{h:'South Africa',a:'South Korea'},
  A5:{h:'Czech Republic',a:'South Africa'}, A6:{h:'Mexico',a:'South Korea'},

  B1:{h:'Canada',a:'Bosnia & Herz.'}, B2:{h:'Qatar',a:'Switzerland'},
  B3:{h:'Canada',a:'Qatar'}, B4:{h:'Bosnia & Herz.',a:'Switzerland'},
  B5:{h:'Switzerland',a:'Canada'}, B6:{h:'Bosnia & Herz.',a:'Qatar'},

  C1:{h:'Brazil',a:'Morocco'}, C2:{h:'Haiti',a:'Scotland'},
  C3:{h:'Brazil',a:'Haiti'}, C4:{h:'Morocco',a:'Scotland'},
  C5:{h:'Scotland',a:'Brazil'}, C6:{h:'Morocco',a:'Haiti'},

  D1:{h:'USA',a:'Paraguay'}, D2:{h:'Australia',a:'Turkey'},
  D3:{h:'USA',a:'Australia'}, D4:{h:'Paraguay',a:'Turkey'},
  D5:{h:'Turkey',a:'USA'}, D6:{h:'Paraguay',a:'Australia'},

  E1:{h:'Germany',a:'Curaçao'}, E2:{h:'Ivory Coast',a:'Ecuador'},
  E3:{h:'Germany',a:'Ivory Coast'}, E4:{h:'Curaçao',a:'Ecuador'},
  E5:{h:'Ecuador',a:'Germany'}, E6:{h:'Ivory Coast',a:'Curaçao'},

  F1:{h:'Netherlands',a:'Japan'}, F2:{h:'Sweden',a:'Tunisia'},
  F3:{h:'Netherlands',a:'Sweden'}, F4:{h:'Japan',a:'Tunisia'},
  F5:{h:'Tunisia',a:'Netherlands'}, F6:{h:'Japan',a:'Sweden'},

  G1:{h:'Belgium',a:'Egypt'}, G2:{h:'Iran',a:'New Zealand'},
  G3:{h:'Belgium',a:'Iran'}, G4:{h:'Egypt',a:'New Zealand'},
  G5:{h:'New Zealand',a:'Belgium'}, G6:{h:'Iran',a:'Egypt'},

  H1:{h:'Spain',a:'Cape Verde'}, H2:{h:'Saudi Arabia',a:'Uruguay'},
  H3:{h:'Spain',a:'Saudi Arabia'}, H4:{h:'Cape Verde',a:'Uruguay'},
  H5:{h:'Uruguay',a:'Spain'}, H6:{h:'Cape Verde',a:'Saudi Arabia'},

  I1:{h:'France',a:'Senegal'}, I2:{h:'Iraq',a:'Norway'},
  I3:{h:'France',a:'Iraq'}, I4:{h:'Senegal',a:'Norway'},
  I5:{h:'Norway',a:'France'}, I6:{h:'Senegal',a:'Iraq'},

  J1:{h:'Argentina',a:'Algeria'}, J2:{h:'Austria',a:'Jordan'},
  J3:{h:'Argentina',a:'Austria'}, J4:{h:'Algeria',a:'Jordan'},
  J5:{h:'Jordan',a:'Argentina'}, J6:{h:'Algeria',a:'Austria'},

  K1:{h:'Portugal',a:'DR Congo'}, K2:{h:'Uzbekistan',a:'Colombia'},
  K3:{h:'Portugal',a:'Uzbekistan'}, K4:{h:'DR Congo',a:'Colombia'},
  K5:{h:'Colombia',a:'Portugal'}, K6:{h:'DR Congo',a:'Uzbekistan'},

  L1:{h:'England',a:'Croatia'}, L2:{h:'Ghana',a:'Panama'},
  L3:{h:'England',a:'Ghana'}, L4:{h:'Croatia',a:'Panama'},
  L5:{h:'Panama',a:'England'}, L6:{h:'Ghana',a:'Croatia'},
};

// Build reverse lookup: norm(home)|norm(away) → matchId
const LOOKUP = {};
for (const [id, m] of Object.entries(MATCHES)) {
  LOOKUP[norm(m.h) + '|' + norm(m.a)] = id;
}

// ── Handler ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (!process.env.FOOTBALL_API_KEY) {
    return res.status(200).json({ skipped: true, reason: 'FOOTBALL_API_KEY not set' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(200).json({ skipped: true, reason: 'DATABASE_URL not set' });
  }

  const db = getPool();

  // Rate limit: skip if synced within last 5 minutes (unless forced via POST)
  if (req.method !== 'POST') {
    try {
      const ls = await db.query("SELECT value FROM game_data WHERE key='last_sync'");
      const lastTs = ls.rows[0]?.value?.ts || 0;
      if (Date.now() - lastTs < 5 * 60 * 1000) {
        return res.json({
          skipped: true,
          reason: 'Rate limited',
          lastSync: lastTs,
          nextIn: Math.round((lastTs + 5 * 60 * 1000 - Date.now()) / 1000) + 's'
        });
      }
    } catch (e) { /* table may not exist yet */ }
  }

  try {
    // Fetch all finished WC 2026 matches
    const apiRes = await fetch(
      'https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED',
      { headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY } }
    );

    if (!apiRes.ok) {
      const body = await apiRes.text();
      return res.status(apiRes.status).json({ error: `API ${apiRes.status}`, body });
    }

    const data = await apiRes.json();
    const apiMatches = data.matches || [];

    // Load current results
    const dbRow = await db.query("SELECT value FROM game_data WHERE key='results'");
    const results = dbRow.rows[0]?.value || {};

    const updated = [];

    for (const m of apiMatches) {
      if (m.status !== 'FINISHED') continue;
      const h = mapTeam(m.homeTeam?.name || '');
      const a = mapTeam(m.awayTeam?.name || '');
      const key = norm(h) + '|' + norm(a);
      const matchId = LOOKUP[key];
      if (!matchId) continue;

      const score = m.score?.fullTime;
      if (score?.home == null || score?.away == null) continue;

      if (!results[matchId] ||
          results[matchId].h !== score.home ||
          results[matchId].a !== score.away) {
        results[matchId] = { h: score.home, a: score.away };
        updated.push({ matchId, score: `${score.home}-${score.away}` });
      }
    }

    if (updated.length > 0) {
      await db.query(
        `INSERT INTO game_data (key, value) VALUES ('results', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(results)]
      );
    }

    const syncTs = Date.now();
    await db.query(
      `INSERT INTO game_data (key, value) VALUES ('last_sync', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ ts: syncTs })]
    );

    res.json({ ok: true, checked: apiMatches.length, updated, syncTs });
  } catch (e) {
    console.error('[sync]', e);
    res.status(500).json({ error: e.message });
  }
};
