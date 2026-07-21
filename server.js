const path = require('path');
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const runFetchGrants = require('./scripts/fetch-grants');

const PORT = process.env.PORT || 3000;
const SEED_JSON_PATH = path.join(__dirname, 'public', 'adoption-grants-dashboard.json');
const GRANT_FETCH_CRON = process.env.GRANT_FETCH_CRON || '0 17 * * 1';

db.seedFromJsonIfEmpty(SEED_JSON_PATH);

const removedAtBoot = db.removeExpiredGrants();
if (removedAtBoot.length) {
  console.log(`🗑️  Removed ${removedAtBoot.length} expired grant(s): ${removedAtBoot.join(', ')}`);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  try {
    db.db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/grants', (req, res) => {
  const removed = db.removeExpiredGrants();
  if (removed.length) {
    console.log(`🗑️  Removed ${removed.length} expired grant(s): ${removed.join(', ')}`);
  }
  const grants = db.getAllGrants();
  let presetReasons = [];
  try { presetReasons = JSON.parse(db.getMeta('presetReasons', '[]')); } catch { /* leave as [] */ }

  res.json({
    lastUpdated: db.getMeta('lastUpdated', ''),
    version: Number(db.getMeta('version', '2')),
    adoptionType: db.getMeta('adoptionType', ''),
    consultant: db.getMeta('consultant', ''),
    presetReasons,
    grants,
  });
});

app.get('/api/statuses', (req, res) => {
  res.json(db.getAllStatuses());
});

app.put('/api/statuses/:name', (req, res) => {
  const applied = req.body.applied === true;
  const rejected = req.body.rejected === true;
  const ignoredReason = typeof req.body.ignoredReason === 'string' ? req.body.ignoredReason : '';
  db.upsertStatus(req.params.name, applied, ignoredReason, rejected);
  res.json({ ok: true });
});

app.delete('/api/statuses/:name', (req, res) => {
  db.deleteStatus(req.params.name);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Adoption grants dashboard listening on port ${PORT}`);
});

let fetchGrantsRunning = false;

if (cron.validate(GRANT_FETCH_CRON)) {
  cron.schedule(GRANT_FETCH_CRON, () => {
    if (fetchGrantsRunning) {
      console.log('⏭️  Skipping scheduled adoption-grants fetch — previous run still in progress.');
      return;
    }
    fetchGrantsRunning = true;
    console.log('⏰ Running scheduled adoption-grants fetch...');
    runFetchGrants()
      .catch((err) => console.error('💥 Scheduled grant fetch failed:', err))
      .finally(() => { fetchGrantsRunning = false; });
  });
  console.log(`Grant fetch scheduled: "${GRANT_FETCH_CRON}"`);
} else {
  console.error(`Invalid GRANT_FETCH_CRON "${GRANT_FETCH_CRON}" — scheduled fetch disabled.`);
}
