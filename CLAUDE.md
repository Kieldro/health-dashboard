# Health Dashboard

Personal health metrics dashboard at https://health.keo.life

## Tech Stack
- Static site: HTML + vanilla JS + CSS (no build tools)
- Charts: Chart.js v4.4.7 (CDN) + date-fns adapter + zoom plugin + hammer
- Server: Python stdlib `ThreadingHTTPServer` (`serve.py`) on port 8888
- Deployment: Cloudflare Tunnel → health.keo.life (no auth — intentional)
- Auto-start: systemd user service (`health-dashboard.service`)

## Data Pipeline
Source-of-truth is SQLite at `~/HealthData/DBs/garmin.db`, populated daily at
**12:00 CDT** by ONE cron line running `~/garmin-sync/run_pipeline.sh` — a
locked (`flock ~/garmin-sync/.pipeline.lock`), sequential run of these steps
(a failed step is recorded and alerted, not fatal; ~17 min, mostly garmindb):
1. `garmindb` — Garmin Connect (sleep, RHR, HRV, VO2, runs, weight, activity FIT records); `--latest`
2. `renpho_sync` — Renpho scale → `weight` (upsert; a scale reading beats Garmin's profile weight), `body_fat` (INSERT OR IGNORE)
3. `sync_v2` — Garmin daily stats → JSON masters in `data/master/`
4. `merge_daily` — stitches `unified_daily.json`; upserts today/yesterday's `sleep`/`resting_hr`/`daily_summary` from the JSON masters (garmindb never fetches the current day)
5. `workout_sync` — lifting logs from two Google Sheets → `workout_*`
6. `strava_sync` — Strava activities + HR streams (Strava deactivated the API app 2026-07-01: logs one `STRAVA INACTIVE:` line, exits 0)
7. `strava_merge` — merges into `running_activities`
8. `garmin_streams` — per-second HR streams from Garmin FIT records for runs with no Strava stream (`strava_streams/garmin-<id>.json`; Strava's copy wins if both exist)
9. `hr_recovery` — 60s HR drop from peak per run
10. `backup` — `backup_garmin_db.sh`: newest 14 garmin.db snapshots + 7 `data/master` tarballs, copied to `/media/keo/hdd-ext4/backups/garmin-sync/`

Also: `garmin-sync.timer` runs `sync_v2` at 23:00 and 00:00 (same lock), and
cron runs `health_check.sh` every 15 min — it polls `/api/health` and sends an
ntfy/desktop alert when the status CHANGES (stale, recovered, unreachable).
Each run writes `data/pipeline_status.json`, which `/api/health` reads.

Some derived data (HR streams, HR-recovery JSON) also lives in
`~/garmin-sync/data/master/`. The dashboard never writes; it only reads
(garmin.db is opened `mode=ro`).

## API endpoints (served by `serve.py`)
All return JSON. `Cache-Control: no-store` on `/api/*`, all entry points
(`*.html`/`*.js`/`*.css`/`/`) **and every non-200/304 response**; `max-age=3600`
only on 200/304 binary assets (images/fonts). Gzip-encoded when client sends
`Accept-Encoding: gzip`. HEAD is routed through the same private-path guard as
GET (see Gotchas). Plain-HTTP visits (per Cloudflare's `X-Forwarded-Proto` /
`CF-Visitor`) get a 301 to https; https responses carry HSTS; every response
carries a CSP + `nosniff`/`X-Frame-Options`/`Referrer-Policy`.

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
| `/api/workout-sets` | `workout_sets` | `{week, exercise, set_num, weight, reps}` (reps ≤ 100; timed holds ≤ 500 s) |
| `/api/hr-recovery` | `hr_recovery.json` | `{date, recovery, name}` (sport=running) |
| `/api/lactate-threshold` | `lactate_threshold.json` | `{date, lthr, pace, ftp}` (Garmin LT snapshot; pace = min/mi, speed decoded m/s÷10) |
| `/api/zone-minutes` | `strava_streams/*` | `{week, z1, z2, z3, z4, z5}` (runs only; time-weighted; cached by mtime) |
| `/api/sleep` | `sleep` | `{date, total, deep, light, rem, awake, score, spo2}` (minutes; 0-min nights and daytime naps skipped) |
| `/api/steps` | `daily_summary` | `{date, steps, step_goal}` |
| `/api/stress` | `daily_summary` | `{date, stress}` (daily avg; Garmin's `-1` no-data value dropped) |
| `/api/body-battery` | `daily_summary` | `{date, high, low}` |
| `/api/health` | DB + JSON + `pipeline_status.json` | `{status, stale[], sources[{name, latest, age_days, max_age_days, ok}], pipeline}` — **200 fresh / 503 stale**; thresholds in `HEALTH_*_SOURCES` |
| `/api/version` | `git log` | `{sha, date}` (cached by `.git/logs/HEAD` mtime) |
| `/api/routes` | `API_ROUTES` | `["/api/…", …]` — drives architecture.html live |
| `/api/schema` | `sqlite_master` | `[{table, columns[]}]` — drives architecture.html live |
| `/api/cron` | `crontab -l` + `run_pipeline.sh` + timer | `[{time, name, via?, step?, steps?}]` — expands the pipeline line into its `step` lines; drives architecture.html live |

## Frontend
- `index.html` — six `#hash`-switched "pages": Overview (KPI landing) / Body / Sleep / Daily / Running / Lifts. Header has range presets (1M/3M/6M/YTD/1Y/All), GitHub link, architecture link.
- `data.js` — fires `Promise.allSettled` of all `/api/*` fetches, returns a `data` object; a failed endpoint keeps its last good response (or `[]` on first load). Computes derived series (7-day MA weight, Navy BF%, weekly mileage incl. zero weeks, sleep-stage hours, etc.).
- `app.js` — creates 28 Chart.js charts. `rebuildCharts()` is idempotent and re-callable (used for the 6h auto-refresh, skipped while the tab is hidden) so DOM state is preserved; a refresh where fetches failed keeps the charts and retries on the next tab visit. Every card has a freshness chip (red when stale; lift cards show "N of M lifts active"). Wheel zoom needs Ctrl in the grid (plain wheel zooms only the expanded view). All date math is local-calendar-day.
- `styles.css` — dark theme, CSS grid layout, skeleton-pulse loading state. Each canvas sits in a fixed-height `.chart-box` (don't size canvases with `!important` — that drew charts squashed).
- `architecture.html` — self-contained architecture diagram (also served at `/architecture.html`).

## Charts (current roster)
**Overview page**: KPI cards (latest value + goal gap) — Weight · Body Fat · RHR · HRV · VO2 · Lactate Threshold · Last Run · This Week · Sleep · Steps
**Body page** (6): Weight Trend · Body Fat % (Renpho + Navy + DEXA) · Body Measurements · Limb Measurements · Resting HR · HRV
**Sleep page** (2): Sleep Duration & Stages (deep/REM/light stacked, 7h goal) · Sleep Score (+30d MA)
**Daily page** (3): Daily Steps (vs adaptive goal) · Stress (+30d MA) · Body Battery (daily low→high range)
**Running page** (9): Efficiency Factor · 5K HR + Pace · Long Run Distance · Weekly Mileage · VO2 Max · HR Recovery · Weekly HR Zone Minutes · Training Log (bubble) · Lactate Threshold (LT HR + pace, dual-axis)
**Lifts page** (8): Weekly Volume · Upper Body Machines · Upper Body DB · Lower Body — Legs · Lower Body — Hip/Core · Lower Body BB/DB · Bodyweight (Pull-ups/V-ups/Push-ups/Calf/Gripper/Front Lever + Dead Hang) · Neck (dot size = weight). The roster per chart is one table, `LIFT_CHARTS` in app.js — add a lift there when the programme changes (old lifts stay as history).

## Development
```bash
python3 serve.py                            # local dev on :8888
PORT=18900 python3 serve.py                 # scratch copy (also GARMIN_DB=, GARMIN_SYNC_DIR=)
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
- Run-vs-walk filter (data.js `processRuns`): **avg HR ≥ 110 AND pace ≤ 18 min/mi** — `running_activities` has no sport column and includes walks; verified nothing faster than 12 min/mi has HR < 110, so this cuts zero real runs while dropping 20–35 min/mi strolls.
- PR stars (lift charts, `prAnnotation`): rank by estimated 1-rep max (Epley: `weight·(1+reps/30)`) across **every set** in `/api/workout-sets`, not raw weight — so 100×10 outranks 100×9; label shows `weight×reps`. Bodyweight/rep-only lifts rank by reps.
- Daily weight = the **last Renpho reading between 04:00 and 12:00** local (else the first one after noon). Older days are only rewritten when the stored value isn't a scale reading at all (`renpho_sync.py`).
- Body-fat goal (12%) is on the **DEXA scale**: the KPI gap and goal line compare against the latest DEXA scan, never the Renpho number (which is just a function of weight).
- Moving averages (30-day, 90-day) are calendar-day windows, not sample counts.
- 5K filter: 2.8–3.5 mi distance, 8–12 min/mi pace
- Long runs: ≥ 5 miles
- HR-recovery: min peak HR 165, sport=running only
- Sleep: 0-minute nights (watch not worn) skipped; stage stack = deep + REM + light ≈ total sleep

## Gotchas
- `garmin.db` is the only writable state — backed up as the pipeline's last step (newest 14 kept, plus a copy on the second disk). Any manual script that writes it must hold `flock ~/garmin-sync/.pipeline.lock`.
- All exercise normalization happens in `~/garmin-sync/workout_sync.py` (substring matching, order-sensitive: more-specific patterns must come first). `machine row` / `plate loaded row` / `high row` are deliberately NOT folded into `row machine` — they are different machines (90–115 lb vs 190–250 lb); all of them predate 2026 except one week, so the YTD chart is unaffected.
- `training_days` in `workout_weeks` is only meaningful for weeks whose sheet tab has weekday headers (2026-01-31 on); the dashboard doesn't display it.
- Annotation animations are off globally (`Chart.defaults.plugins.annotation.animations = false`): a card resize mid-animation used to strand goal lines at the wrong pixel.
- The CSP in `serve.py` must keep allowing `static.cloudflareinsights.com` / `cloudflareinsights.com`: Cloudflare's edge injects its analytics beacon for browsers only, so origin/curl tests never see it. Inline `<script>` blocks are allowed by hash computed from the served HTML.
- A chart that stops updating is usually upstream: check `curl -s localhost:8888/api/health` and `~/garmin-sync/data/pipeline_status.json` first.
- Static web root is the repo dir (source, `.git/`, `logs/`, the systemd unit all live here). `_is_private_path` allow-lists only `.html/.css/.js/.svg/.png/.ico/.webmanifest` and blocks dotfiles/`logs/`; **both GET and HEAD** enforce it (the inherited `do_HEAD` bypassed it before — see serve.py).
- Reps cell supports drop-set notation like `"13,7,7"` → 3 mini-sets via `parse_reps()`.
- HR-recovery is measured from **peak HR** within the interval (not end-of-effort). A fallback path snaps to the global peak HR if no speed-based interval captured post-effort data.
