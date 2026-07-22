const path = require('path');
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const runFetchGrants = require('./scripts/fetch-grants');

const PORT = process.env.PORT || 3000;
const SEED_JSON_PATH = path.join(__dirname, 'public', 'adoption-grants-dashboard.json');
const GRANT_FETCH_CRON = process.env.GRANT_FETCH_CRON || '0 17 * * 1';

const seeded = db.seedFromJson(SEED_JSON_PATH);
if (seeded.inserted) {
  console.log(`🌱 Seeded ${seeded.inserted} grant(s) from ${path.basename(SEED_JSON_PATH)}`);
}

const removedAtBoot = db.removeExpiredGrants();
if (removedAtBoot.length) {
  console.log(`🗑️  Removed ${removedAtBoot.length} expired grant(s): ${removedAtBoot.join(', ')}`);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'adoption-grants-dashboard.html' }));

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
    lastChecked: db.getMeta('lastChecked', ''),
    version: Number(db.getMeta('version', '2')),
    adoptionType: db.getMeta('adoptionType', ''),
    consultant: db.getMeta('consultant', ''),
    presetReasons,
    grants,
  });
});

// Bulk import for external tools (e.g. Hermes backfills). Body is either a
// bare array of grants or { grants: [...] }. Existing grants are left
// untouched (matched by name); only new names are inserted. If IMPORT_TOKEN
// is set in the environment, requests must send it as a Bearer token.
app.post('/api/grants/import', (req, res) => {
  const token = process.env.IMPORT_TOKEN;
  if (token && req.get('authorization') !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const grants = Array.isArray(req.body) ? req.body
    : (req.body && Array.isArray(req.body.grants)) ? req.body.grants
    : null;
  if (!grants) {
    return res.status(400).json({ error: 'Body must be an array of grants or { grants: [...] }' });
  }

  let inserted = 0;
  const skipped = [];
  for (const g of grants) {
    if (!g || typeof g.name !== 'string' || !g.name.trim() ||
        typeof g.website !== 'string' || !g.website.trim()) {
      skipped.push({ name: (g && g.name) || '(missing name)', reason: 'invalid — name and website are required' });
      continue;
    }
    if (db.insertGrant(g, 'import')) inserted++;
    else skipped.push({ name: g.name, reason: 'already exists' });
  }

  if (inserted > 0) db.setMeta('lastUpdated', new Date().toISOString().split('T')[0]);
  console.log(`📥 Import: ${inserted} inserted, ${skipped.length} skipped`);
  res.json({ inserted, skipped, total: db.grantsCount() });
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
