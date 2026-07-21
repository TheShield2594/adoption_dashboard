const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
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
  )
`);

const getAllStmt = db.prepare('SELECT grant_name, applied, ignored_reason FROM statuses');
const upsertStmt = db.prepare(`
  INSERT INTO statuses (grant_name, applied, ignored_reason, updated_at)
  VALUES (@grantName, @applied, @ignoredReason, @updatedAt)
  ON CONFLICT(grant_name) DO UPDATE SET
    applied = excluded.applied,
    ignored_reason = excluded.ignored_reason,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare('DELETE FROM statuses WHERE grant_name = ?');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/statuses', (req, res) => {
  const result = {};
  for (const row of getAllStmt.all()) {
    if (!row.applied && !row.ignored_reason) continue;
    result[row.grant_name] = { applied: !!row.applied, ignoredReason: row.ignored_reason };
  }
  res.json(result);
});

app.put('/api/statuses/:name', (req, res) => {
  const grantName = req.params.name;
  const applied = req.body.applied === true;
  const ignoredReason = typeof req.body.ignoredReason === 'string' ? req.body.ignoredReason : '';

  if (!applied && !ignoredReason) {
    deleteStmt.run(grantName);
  } else {
    upsertStmt.run({
      grantName,
      applied: applied ? 1 : 0,
      ignoredReason,
      updatedAt: new Date().toISOString(),
    });
  }
  res.json({ ok: true });
});

app.delete('/api/statuses/:name', (req, res) => {
  deleteStmt.run(req.params.name);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Adoption grants dashboard listening on port ${PORT}`);
});
