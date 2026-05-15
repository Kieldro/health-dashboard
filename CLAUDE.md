# Health Dashboard

Personal health metrics dashboard at https://health.keo.life

## Tech Stack
- Static site: HTML + vanilla JS + CSS (no build tools)
- Charts: Chart.js v4.4.7 (CDN) + date-fns adapter + zoom plugin + hammer
- Server: Python stdlib `ThreadingHTTPServer` (`serve.py`) on port 8888
- Deployment: Cloudflare Tunnel → health.keo.life (no auth — intentional)
- Auto-start: systemd user service (`health-dashboard.service`)

## Data Pipeline
Source-of-truth is SQLite at `~/HealthData/DBs/garmin.db`, populated nightly
(23:00–23:30 CDT) by cron-driven scripts in `~/garmin-sync/`:
- `garmindb_cli` 23:00 — Garmin Connect (sleep, RHR, HRV, VO2, runs, weight)
- `renpho_sync` 23:05 — Renpho scale → `weight`, `body_fat` (INSERT OR IGNORE)
- `sync_v2` 23:08 — Garmin daily stats → JSON masters in `data/master/`
- `merge_daily` 23:10 — stitches `unified_daily.json`
- `workout_sync` 23:12 — pulls lifting logs from two Google Sheets → `workout_*`
- `strava_sync` 23:15 — Strava activities + per-second HR streams
- `strava_merge` 23:20 — merges into `running_activities`
- `hr_recovery` 23:25 — computes 60s HR drop from peak per run
- `backup_garmin_db.sh` 23:30 — rotates 14 nightly snapshots of garmin.db

Some derived data (HR-zone minutes, HR-recovery JSON) also lives in
`~/garmin-sync/data/master/`. The dashboard never writes; it only reads.

## API endpoints (served by `serve.py`)
All return JSON. `Cache-Control: no-store` on `/api/*`, `max-age=3600` on
static. Gzip-encoded when client sends `Accept-Encoding: gzip`.

| Route | Source | Shape |
|---|---|---|
| `/api/weight` | `weight` | `{date, weight}` |
| `/api/bodyfat` | `body_fat` | `{date, bodyfat}` |
| `/api/dexa` | `bodyspec_scans` | `{date, bodyfat}` |
| `/api/measurements` | `measurements` | `{date, neck, waist, stomach, hips, chest, right_bicep, …}` |
| `/api/rhr` | `resting_hr` | `{date, rhr}` |
| `/api/hrv` | `hrv` | `{date, hrv}` |
| `/api/vo2max` | `vo2max` | `{date, vo2max}` |
| `/api/activities` | `running_activities` | `{date, start_time, distance, duration, avg_hr, max_hr, calories, vo2max}` |
| `/api/workout-volume` | `workout_weeks` | `{week, total_exercises, total_sets, training_days}` |
| `/api/lift-progression` | `workout_exercises` | `{week, exercise, top_weight, top_reps, max_reps}` |
| `/api/workout-sets` | `workout_sets` | `{week, exercise, set_num, weight, reps}` |
| `/api/hr-recovery` | `hr_recovery.json` | `{date, recovery, name}` (sport=running) |
| `/api/zone-minutes` | `strava_streams/*` | `{week, z1, z2, z3, z4, z5}` (cached by mtime) |
| `/api/version` | `git log` | `{sha, date}` |

## Frontend
- `index.html` — three `<section>` "pages": Body / Running / Lifts, switched via `#hash`. Header has range presets (1M/3M/6M/YTD/1Y/All), GitHub link, architecture link.
- `data.js` — fires `Promise.allSettled` of all `/api/*` fetches, returns a `data` object; missing endpoints fall back to `[]`. Computes derived series (7-day MA weight, Navy BF%, weekly mileage, etc.).
- `app.js` — creates ~22 Chart.js charts. `rebuildCharts()` is idempotent and re-callable (used for the 6h auto-refresh) so DOM state is preserved.
- `styles.css` — dark theme, CSS grid layout, skeleton-pulse loading state.
- `architecture.html` — self-contained architecture diagram (also served at `/architecture.html`).

## Charts (current roster)
**Body page** (6): Weight Trend · Body Fat % (Renpho + Navy + DEXA) · Body Measurements · Limb Measurements · Resting HR · HRV
**Running page** (7): Efficiency Factor · 5K HR + Pace · Long Run Distance · Weekly Mileage · VO2 Max · HR Recovery · Weekly HR Zone Minutes
**Lifts page** (7): Weekly Volume · Upper Body Machines · Upper Body DB · Lower Body Machines · Lower Body BB/DB · Bodyweight · Neck (dot size = weight)

## Development
```bash
python3 serve.py                            # local dev on :8888
systemctl --user restart health-dashboard   # apply serve.py changes
node --check app.js                         # JS syntax check (no test suite)
```

After editing static files (`*.js`, `*.css`, `*.html`), no restart needed —
served live. After editing `serve.py`, restart the service.

## Services
- `systemctl --user status health-dashboard.service` — Python server
- `sudo systemctl status cloudflared.service` — Cloudflare Tunnel
- Logs: `/home/keo/repos/health-dashboard/logs/dashboard.log`

## Constants & filters
- Height for Navy BF% = **72 inches** (6'0")
- HRmax for zone bins = **200 bpm**
- Weight converted from kg via `* 2.20462`
- 5K filter: 2.8–3.5 mi distance, 8–12 min/mi pace
- Long runs: ≥ 5 miles
- HR-recovery: min peak HR 165, sport=running only

## Gotchas
- `garmin.db` is the only writable state — backup nightly at 23:30 (14-day rolling).
- All exercise normalization happens in `~/garmin-sync/workout_sync.py` (substring matching, order-sensitive: more-specific patterns must come first).
- Reps cell supports drop-set notation like `"13,7,7"` → 3 mini-sets via `parse_reps()`.
- HR-recovery is measured from **peak HR** within the interval (not end-of-effort). A fallback path snaps to the global peak HR if no speed-based interval captured post-effort data.
