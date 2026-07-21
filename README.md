# Adoption Grants Dashboard

A dashboard for tracking adoption grant and financial-assistance applications.
Built for a domestic adoption, it lists grant programs, tax credits, and
employer benefits alongside per-program tracking (applied / ignored / reason).
Status is stored server-side in a SQLite database, so it persists across
devices and browsers, not just one machine's local storage.

## Files

- `public/adoption-grants-dashboard.html` — the app (markup, styles, and client-side logic)
- `public/adoption-grants-dashboard.json` — the data: grant list, preset ignore-reasons, and metadata
- `server.js` — small Express server that serves the app and a JSON API backed by SQLite
- `Dockerfile` / `docker-compose.yml` — container build for deployment (e.g. via Portainer)

The HTML fetches the grant list from the JSON file and reads/writes grant
statuses through the server's API, so it needs the Node server running —
opening the HTML file directly (`file://`) will not work.

## Running it

### With Docker (recommended, e.g. via Portainer)

```bash
docker compose up -d --build
```

This builds the image, starts the server on port `3000`, and persists the
SQLite database to `./data/statuses.db` on the host (bind-mounted into the
container) so status data survives container recreation/updates.

In Portainer: create a stack from this repo's `docker-compose.yml`, or point
a Portainer "Git repository" stack at this repo. Put your existing Nginx
Proxy Manager / Cloudflare setup in front of port `3000` like any other
container.

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

Grant programs live in `public/adoption-grants-dashboard.json`. Each entry supports:

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
| `GET /api/statuses` | Returns all saved statuses, keyed by grant name |
| `PUT /api/statuses/:name` | Upserts a status: `{ "applied": bool, "ignoredReason": string }` |
| `DELETE /api/statuses/:name` | Clears a grant's saved status |

## Notes

- Saved statuses are keyed by grant `name`; renaming an entry in the JSON will
  disconnect it from any previously saved status.
- The SQLite database lives at `DB_PATH` (default `./data/statuses.db`). Back
  it up like any other file if you want to keep a history of your statuses.
