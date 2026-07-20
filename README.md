# Adoption Grants Dashboard

A single-page, static dashboard for tracking adoption grant and financial-assistance
applications. Built for a domestic adoption, it lists grant programs, tax credits,
and employer benefits alongside per-program tracking (applied / ignored / reason)
that's saved locally in the browser.

## Files

- `adoption-grants-dashboard.html` — the app (markup, styles, and logic in one file)
- `adoption-grants-dashboard.json` — the data: grant list, preset ignore-reasons, and metadata

The HTML fetches the JSON at runtime, so the two files must stay in the same folder.

## Running it

Because the page loads its data with `fetch()`, it needs to be served over HTTP —
opening the HTML file directly (`file://`) will fail with a CORS/load error.

From this directory, run any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/adoption-grants-dashboard.html.

## Features

- **Filters** by program type (grant, matching grant, tax credit, employer benefit,
  federal assistance, resource), no-deadline programs, applied, and ignored.
- **Status tracking** — mark a grant as Applied or Ignored (with a preset or custom
  reason). Status is saved to `localStorage`, so it persists across reloads on the
  same browser/device.
- **Export** — download your saved statuses as a JSON file.
- **Summary stats** — total programs, max grant potential, no-deadline count,
  applied/ignored counts, and combined tax + employer benefit potential.

## Editing the data

Grant programs live in `adoption-grants-dashboard.json`. Each entry supports:

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
| `applied` / `ignoredReason` | Default status (overridden by any saved `localStorage` status) |

Top-level `presetReasons` supplies the dropdown options for ignoring a grant.

## Notes

- All data and status tracking is local to the browser — nothing is sent to a server.
- Saved statuses are keyed by grant `name`; renaming an entry in the JSON will
  disconnect it from any previously saved status.
