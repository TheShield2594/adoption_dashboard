# Adoption Grants Dashboard

A dashboard for tracking adoption grant and financial-assistance applications.
Built for a domestic adoption, it lists grant programs, tax credits, and
employer benefits alongside per-program tracking (applied / ignored / reason).
Status is stored server-side in a SQLite database, so it persists across
devices and browsers, not just one machine's local storage.

## Files

- `public/adoption-grants-dashboard.html` — the app (markup, styles, and client-side logic)
- `public/adoption-grants-dashboard.json` — one-time seed data (grant list, preset ignore-reasons,
  metadata); only read on first boot when the database is empty, see below
- `server.js` — small Express server that serves the app and a JSON API backed by SQLite
- `db.js` — shared SQLite access (grants, statuses, and seeding)
- `scripts/fetch-grants.js` — weekly job that discovers new grant programs and posts to Discord
- `Dockerfile` / `docker-compose.yml` — container build for deployment (e.g. via Portainer)

The HTML fetches the grant list and reads/writes grant statuses through the
server's API, so it needs the Node server running — opening the HTML file
directly (`file://`) will not work.

## Weekly grant discovery

`scripts/fetch-grants.js` runs on an in-process schedule (via `node-cron`,
started by `server.js` — no system cron/root needed in the container):

1. Scrapes a fixed list of known grant-program pages, plus any pages
   discovered through a SearXNG search (if `SEARXNG_URL` is set).
2. Sends the scraped text to an OpenRouter model, asking it to extract
   grants that aren't already in the database.
3. Inserts genuinely new grants into SQLite.
4. Posts a summary (new grants found, or "none this week") to a Discord
   webhook.

Any step with a missing env var is skipped, not fatal — e.g. running with no
`OPENROUTER_API_KEY` just scrapes and logs, without extraction.

Configure via env vars (copy `.env.example` to `.env` for `docker compose`):

| Variable | Purpose |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | Where the weekly summary gets posted |
| `OPENROUTER_API_KEY` | Auth for the extraction call ([openrouter.ai/keys](https://openrouter.ai/keys)) |
| `OPENROUTER_MODEL` | Model to use (default `anthropic/claude-3.5-haiku`) |
| `SEARXNG_URL` | Base URL of a SearXNG instance with JSON output enabled (`search: formats: [html, json]` in its `settings.yml`); leave unset to skip discovery and only scrape the fixed sources |
| `GRANT_FETCH_CRON` | Cron expression for the schedule (default `0 17 * * 1`, Mondays 17:00 UTC) |

Run it manually any time (e.g. to test): `node scripts/fetch-grants.js --dry-run`
(dry-run skips DB writes and the Discord post, but still logs what it found).

**Note:** since `.env` isn't committed, never commit real secrets to
`docker-compose.yml` either — it references `${VAR}` placeholders only.

## Running it

### With Docker (recommended, e.g. via Portainer)

```bash
docker compose up -d --build
```

This builds the image, starts the server on port `3000`, and persists the
SQLite database in the `dashboard-data` named Docker volume so status data
survives container recreation/updates. A named volume (rather than a host
bind mount) is used so the container's non-root `node` user always has
write access, regardless of host directory permissions.

In Portainer: create a stack from this repo's `docker-compose.yml`, or point
a Portainer "Git repository" stack at this repo. Put your existing Nginx
Proxy Manager / Cloudflare setup in front of port `3000` like any other
container.

The container also declares a `HEALTHCHECK` (via `GET /api/health`), so
Portainer/Docker report the container as unhealthy if the server or its
database becomes unreachable.

**Access control:** the app has no login of its own — anyone who can reach
port `3000` can view and change grant statuses. Restrict access at the
reverse-proxy layer (e.g. HTTP Basic Auth in Nginx Proxy Manager, or
Cloudflare Access if it's exposed through a tunnel) rather than relying on
TLS termination alone.

### Without Docker

```bash
npm install
npm start
```

Then open http://localhost:3000/adoption-grants-dashboard.html. Set `PORT`
and `DB_PATH` env vars to override the default port (`3000`) and database
file location (`./data/statuses.db`).

## Features

- **Filters** by program type (grant, matching grant, tax credit, employer benefit,
  federal assistance, resource), no-deadline programs, applied, and ignored.
- **Status tracking** — mark a grant as Applied or Ignored (with a preset or custom
  reason). Status is saved to a server-side SQLite database via a small JSON API,
  so it persists across reloads and devices.
- **Export** — download your saved statuses as a JSON file.
- **Summary stats** — total programs, max grant potential, no-deadline count,
  applied/ignored counts, and combined tax + employer benefit potential.

## Editing the data

Grant programs live in the SQLite database (same file as saved statuses),
populated automatically by the weekly discovery job above. `public/adoption-grants-dashboard.json`
is only read once, to seed that database the first time it's empty (e.g. a
fresh volume) — editing it afterward has no effect unless you clear the
database and let it reseed. Each seed entry supports:

| Field | Description |
| --- | --- |
| `name` | Program name (used as the tracking key) |
| `amount` | Display string, e.g. `"Up to $15,000"` |
| `amountRaw` | Numeric amount used for sorting/stats |
| `type` | One of `grant`, `matching_grant`, `tax_credit`, `employer_benefit`, `federal_assistance`, `resource` |
| `focus` | Adoption type the program targets |
| `deadline` | Display string; contains "rolling" or "year-round" to flag it as no-deadline |
| `website` | Application URL |
| `details` | Description shown on the card |
| `sentWeeks` | List of weeks an application/inquiry was sent |
| `applied` / `ignoredReason` | Default status (overridden by any saved status from the database) |

Top-level `presetReasons` supplies the dropdown options for ignoring a grant.

## API

The server exposes a small JSON API used by the front end:

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Health check — verifies the server can query the database |
| `GET /api/grants` | Returns the full grant list plus metadata (`lastUpdated`, `presetReasons`, etc.), read from SQLite |
| `GET /api/statuses` | Returns all saved statuses, keyed by grant name |
| `PUT /api/statuses/:name` | Upserts a status: `{ "applied": bool, "ignoredReason": string }`. If `applied` is `false` and `ignoredReason` is empty, this deletes the saved status instead of storing an empty row. |
| `DELETE /api/statuses/:name` | Clears a grant's saved status |

## Notes

- Saved statuses are keyed by grant `name`; renaming an entry in the JSON will
  disconnect it from any previously saved status.
- The SQLite database lives at `DB_PATH` (default `./data/statuses.db` when
  run without Docker). Under Docker Compose it lives inside the
  `dashboard-data` named volume — back it up with
  `docker run --rm -v adoption_dashboard_dashboard-data:/data -v "$PWD":/backup alpine tar czf /backup/statuses-backup.tgz -C /data .`
  (adjust the volume name if Compose derives a different project prefix).
