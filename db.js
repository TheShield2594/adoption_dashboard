const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'statuses.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS statuses (
    grant_name TEXT PRIMARY KEY,
    applied INTEGER NOT NULL DEFAULT 0,
    ignored_reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS grants (
    name TEXT PRIMARY KEY,
    amount TEXT NOT NULL DEFAULT '',
    amount_raw REAL NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'grant',
    focus TEXT NOT NULL DEFAULT '',
    deadline TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    sent_weeks TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'seed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Statuses -----------------------------------------------------------------

const getAllStatusesStmt = db.prepare('SELECT grant_name, applied, ignored_reason FROM statuses');
const upsertStatusStmt = db.prepare(`
  INSERT INTO statuses (grant_name, applied, ignored_reason, updated_at)
  VALUES (@grantName, @applied, @ignoredReason, @updatedAt)
  ON CONFLICT(grant_name) DO UPDATE SET
    applied = excluded.applied,
    ignored_reason = excluded.ignored_reason,
    updated_at = excluded.updated_at
`);
const deleteStatusStmt = db.prepare('DELETE FROM statuses WHERE grant_name = ?');

function getAllStatuses() {
  const result = {};
  for (const row of getAllStatusesStmt.all()) {
    if (!row.applied && !row.ignored_reason) continue;
    result[row.grant_name] = { applied: !!row.applied, ignoredReason: row.ignored_reason };
  }
  return result;
}

function upsertStatus(grantName, applied, ignoredReason) {
  if (!applied && !ignoredReason) {
    deleteStatusStmt.run(grantName);
  } else {
    upsertStatusStmt.run({
      grantName,
      applied: applied ? 1 : 0,
      ignoredReason,
      updatedAt: new Date().toISOString(),
    });
  }
}

function deleteStatus(grantName) {
  deleteStatusStmt.run(grantName);
}

// Grants ---------------------------------------------------------------------

const getAllGrantsStmt = db.prepare('SELECT * FROM grants ORDER BY created_at ASC');
const getGrantNamesStmt = db.prepare('SELECT name FROM grants');
const countGrantsStmt = db.prepare('SELECT COUNT(*) AS count FROM grants');
const insertGrantStmt = db.prepare(`
  INSERT OR IGNORE INTO grants
    (name, amount, amount_raw, type, focus, deadline, website, details, sent_weeks, source, created_at, updated_at)
  VALUES
    (@name, @amount, @amountRaw, @type, @focus, @deadline, @website, @details, @sentWeeks, @source, @createdAt, @updatedAt)
`);

function rowToGrant(row) {
  let sentWeeks = [];
  try { sentWeeks = JSON.parse(row.sent_weeks); } catch { /* leave as [] */ }
  return {
    name: row.name,
    amount: row.amount,
    amountRaw: row.amount_raw,
    type: row.type,
    focus: row.focus,
    deadline: row.deadline,
    website: row.website,
    details: row.details,
    sentWeeks,
  };
}

function getAllGrants() {
  return getAllGrantsStmt.all().map(rowToGrant);
}

function getGrantNames() {
  return getGrantNamesStmt.all().map((r) => r.name);
}

function grantsCount() {
  return countGrantsStmt.get().count;
}

function insertGrant(grant, source = 'auto-discovered') {
  const now = new Date().toISOString();
  insertGrantStmt.run({
    name: grant.name,
    amount: grant.amount || '',
    amountRaw: Number(grant.amountRaw) || 0,
    type: grant.type || 'grant',
    focus: grant.focus || '',
    deadline: grant.deadline || '',
    website: grant.website || '',
    details: grant.details || '',
    sentWeeks: JSON.stringify(grant.sentWeeks || []),
    source,
    createdAt: now,
    updatedAt: now,
  });
}

// Meta -------------------------------------------------------------------

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(`
  INSERT INTO meta (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getMeta(key, fallback = '') {
  const row = getMetaStmt.get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  setMetaStmt.run({ key, value });
}

// Seeding ------------------------------------------------------------------

function seedFromJsonIfEmpty(seedJsonPath) {
  if (grantsCount() > 0) return;
  if (!fs.existsSync(seedJsonPath)) return;

  const raw = JSON.parse(fs.readFileSync(seedJsonPath, 'utf-8'));
  const now = new Date().toISOString();

  const insertMany = db.transaction((grantList) => {
    for (const g of grantList) {
      if (!g || !g.name) continue;
      insertGrantStmt.run({
        name: g.name,
        amount: g.amount || '',
        amountRaw: Number(g.amountRaw) || 0,
        type: g.type || 'grant',
        focus: g.focus || '',
        deadline: g.deadline || '',
        website: g.website || '',
        details: g.details || '',
        sentWeeks: JSON.stringify(g.sentWeeks || []),
        source: 'seed',
        createdAt: now,
        updatedAt: raw.lastUpdated || now,
      });
    }
  });
  insertMany(Array.isArray(raw.grants) ? raw.grants : []);

  setMeta('version', String(raw.version || 2));
  setMeta('adoptionType', raw.adoptionType || '');
  setMeta('consultant', raw.consultant || '');
  setMeta('presetReasons', JSON.stringify(raw.presetReasons || []));
  setMeta('lastUpdated', raw.lastUpdated || now.split('T')[0]);
}

module.exports = {
  db,
  getAllStatuses,
  upsertStatus,
  deleteStatus,
  getAllGrants,
  getGrantNames,
  grantsCount,
  insertGrant,
  getMeta,
  setMeta,
  seedFromJsonIfEmpty,
};
