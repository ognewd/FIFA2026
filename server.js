const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_DATA = {
  predictions: { dima: {}, diego: {} },
  results: {}
};

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/api/data', (req, res) => {
  res.json(readData());
});

app.post('/api/data', (req, res) => {
  const { predictions, results } = req.body || {};
  const data = readData();
  if (predictions) data.predictions = predictions;
  if (results !== undefined) data.results = results;
  writeData(data);
  res.json(data);
});

// Healthcheck for Railway/Render
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚽ WC 2026 Predictions running at http://localhost:${PORT}`);
  if (!fs.existsSync(DATA_FILE)) writeData(DEFAULT_DATA);
});
