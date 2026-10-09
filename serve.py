#!/usr/bin/env python3
"""Health dashboard server — queries SQLite databases directly."""

import base64
import gzip
import hashlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from collections import namedtuple
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from logging.handlers import RotatingFileHandler
from urllib.parse import quote

# PORT / GARMIN_DB / GARMIN_SYNC_DIR are overridable from the environment so a
# test instance can run from a worktree on a scratch port, against scratch
# data, without a patched copy of this file. Production sets none of them.
PORT = int(os.environ.get("PORT", "8888"))
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
GARMIN_DB = os.environ.get("GARMIN_DB") or os.path.expanduser("~/HealthData/DBs/garmin.db")
SYNC_DIR = os.environ.get("GARMIN_SYNC_DIR") or os.path.expanduser("~/garmin-sync")
MASTER_DIR = os.path.join(SYNC_DIR, "data", "master")
LOGS_DIR = os.path.join(STATIC_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        RotatingFileHandler(os.path.join(LOGS_DIR, "dashboard.log"),
                            maxBytes=5_000_000, backupCount=3),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("dashboard")

CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}

# Only these static file types are publicly served. The web root is the repo
# dir, which also holds source (.py), docs (.md), the systemd unit, logs/,
# .git/, .playwright-mcp/ and stray files like *.ics — none of which should be
# reachable, since the server is exposed on the public internet with no auth.
ALLOWED_STATIC_EXTS = {".html", ".css", ".js", ".svg", ".png", ".ico", ".webmanifest"}

# An API handler returns plain JSON-able data (sent as 200) or an ApiResult when
# it needs to choose the status itself (/api/health answers 503 when stale).
ApiResult = namedtuple("ApiResult", "status data")


def _connect(db_path):
    # Read-only: the dashboard never writes, and a plain connect() would create
    # an empty file where a missing garmin.db should be, masking the real fault
    # behind "no such table". garmin.db uses the default rollback journal
    # (PRAGMA journal_mode = delete, not WAL), so a mode=ro open needs no
    # -wal/-shm side files. The timeout rides out the short exclusive lock a
    # sync writer holds while committing.
    return sqlite3.connect(f"file:{quote(db_path)}?mode=ro", uri=True, timeout=5)


def query_db(db_path, sql, params=()):
    # Open and close a connection per request. The server runs HTTP/1.0 (a new
    # thread per request), so the old thread-local cache never actually reused a
    # connection — and never closed one either, so fds to the DB climbed until
    # cyclic GC reclaimed them. SQLite opens are cheap, so per-request open is
    # simpler and leak-free. A missing/corrupt/locked DB raises sqlite3.Error,
    # which the request handler turns into a JSON 503.
    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _load_json(path, default):
    """Parsed JSON file, or `default` if it is missing or unreadable."""
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def api_weight():
    return query_db(GARMIN_DB, "SELECT day as date, weight FROM weight ORDER BY day")


def api_bodyfat():
    return query_db(GARMIN_DB, "SELECT day as date, bodyfat FROM body_fat ORDER BY day")


def api_dexa():
    return query_db(GARMIN_DB,
        "SELECT scan_date as date, total_body_fat_pct as bodyfat FROM bodyspec_scans ORDER BY scan_date")


def api_measurements():
    return query_db(GARMIN_DB,
        "SELECT day as date, neck, waist, stomach, hips, chest, right_bicep, right_forearm, right_quad, right_calf FROM measurements ORDER BY day")


def api_rhr():
    return query_db(GARMIN_DB,
        "SELECT day as date, resting_heart_rate as rhr FROM resting_hr WHERE resting_heart_rate IS NOT NULL ORDER BY day")


def api_hrv():
    # "> 0" drops NULLs and any Garmin no-data sentinel in one predicate.
    return query_db(GARMIN_DB,
        "SELECT day as date, hrv_overnight_avg as hrv FROM hrv WHERE hrv_overnight_avg > 0 ORDER BY day")


def api_activities():
    # start_time breaks ties on the days with more than one run.
    return query_db(GARMIN_DB, """
        SELECT date, start_time, distance_m as distance, duration_sec as duration,
               avg_hr, max_hr, calories, vo2max
        FROM running_activities
        ORDER BY date, start_time
    """)


def api_vo2max():
    return query_db(GARMIN_DB, "SELECT day as date, vo2max FROM vo2max ORDER BY day")


def api_workout_volume():
    return query_db(GARMIN_DB,
        "SELECT week_date as week, total_exercises, total_sets, training_days FROM workout_weeks ORDER BY week_date")


# Rep-count sanity. The lifting sheet has one cell for reps, and a number typed
# into the wrong cell lands there: the load (chest press 205x250, leg press
# 180x270, row machine 190x220 in week 2026-01-24) or, on bodyweight lifts, the
# day's body weight (pull ups "x195"–"x210"). Real rep counts top out around 90
# (push ups), so anything over 100 is rejected — except the holds that log
# *seconds* in the reps cell, which keep the looser cap.
MAX_REPS = 100
MAX_HOLD_SECONDS = 500
TIMED_EXERCISES = ("dead hang", "farmers walk")


def _reps_ok(col):
    """SQL predicate: `col` is a plausible rep count (or hold time) for `exercise`."""
    timed = ", ".join(f"'{e}'" for e in TIMED_EXERCISES)
    return (f"({col} <= {MAX_REPS} OR "
            f"(exercise IN ({timed}) AND {col} <= {MAX_HOLD_SECONDS}))")


def api_lift_progression():
    # top_reps/max_reps are per-week aggregates, so one bad set poisons the
    # row. Drop the row rather than fall back to the week's remaining sets:
    # in the load-typed-as-reps case those are warm-ups, and plotting them as
    # the top set would draw a false dip in the progression line.
    return query_db(GARMIN_DB, f"""
        SELECT week_date as week, exercise, top_weight, top_reps, max_reps
        FROM workout_exercises
        WHERE (top_weight IS NOT NULL OR max_reps IS NOT NULL)
          AND (top_reps IS NULL OR {_reps_ok('top_reps')})
          AND (max_reps IS NULL OR {_reps_ok('max_reps')})
        ORDER BY week_date
    """)


def api_workout_sets():
    return query_db(GARMIN_DB, f"""
        SELECT week_date as week, exercise, set_num, weight, reps
        FROM workout_sets
        WHERE reps IS NOT NULL AND reps > 0 AND {_reps_ok('reps')}
        ORDER BY week_date, exercise, set_num
    """)


# HRmax used for %HRmax-based zone bins. Set from observed peak HR (~199 bpm).
HRMAX = 200
ZONE_BOUNDS = [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 9.99)]
# Streams are recorded roughly once a second but ~4% of samples are followed by
# a longer gap (smart recording, auto-pause). Each sample stands for the time
# until the next one, capped so a pause isn't billed to the zone it began in.
MAX_SAMPLE_GAP_S = 10
STREAMS_DIR = os.path.join(MASTER_DIR, "strava_streams")
STRAVA_ACTIVITIES = os.path.join(MASTER_DIR, "strava_activities.json")
GARMIN_ACTIVITIES = os.path.join(MASTER_DIR, "activities.json")
# Metadata a stream file may carry itself (takes precedence over the masters).
STREAM_DATE_KEYS = ("start_date_local", "start_time_local", "startTimeLocal", "start_time", "date")
STREAM_SPORT_KEYS = ("sport_type", "sport", "activity_type", "activityType")
_zone_cache = {"sig": None, "data": None}
_zone_cache_lock = threading.Lock()


def _iso_day(value):
    """'YYYY-MM-DD' from an ISO-ish timestamp string, else None."""
    if isinstance(value, str) and re.match(r"\d{4}-\d{2}-\d{2}", value):
        return value[:10]
    return None


def _is_run(sport):
    """True/False for a sport label, None when there is no label to judge by.

    Labels seen: Strava's "Run"/"TrailRun" (which stravalib serialises as
    "root='Run'"), Garmin's "running"/"treadmill_running", or a Garmin
    activityType dict. Every running variant contains "run"; no other sport
    name does."""
    if isinstance(sport, dict):
        sport = sport.get("typeKey")
    if not isinstance(sport, str) or not sport.strip():
        return None
    return "run" in sport.lower()


def _activity_index():
    """{activity id: (local date, sport label)} from the Strava and Garmin
    activity masters, so a stream file named after either kind of id can be
    dated and classified."""
    index = {}
    garmin = _load_json(GARMIN_ACTIVITIES, [])
    for a in garmin if isinstance(garmin, list) else []:
        if isinstance(a, dict) and a.get("activityId") is not None:
            index[str(a["activityId"])] = (_iso_day(a.get("startTimeLocal")), a.get("activityType"))
    strava = _load_json(STRAVA_ACTIVITIES, [])
    for a in strava if isinstance(strava, list) else []:
        if isinstance(a, dict) and a.get("id") is not None:
            index[str(a["id"])] = (_iso_day(a.get("start_date_local")),
                                   a.get("sport_type") or a.get("type"))
    return index


def _zone_signature():
    """Fingerprint of every /api/zone-minutes input. A directory's own mtime
    only moves when entries are added/removed/renamed, so stat each stream
    file too (~150 stats) to catch one being rewritten in place."""
    def stat(path):
        try:
            st = os.stat(path)
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None
    streams = []
    with os.scandir(STREAMS_DIR) as entries:
        for e in entries:
            if e.name.endswith(".json"):
                st = e.stat()
                streams.append((e.name, st.st_mtime_ns, st.st_size))
    return (stat(STRAVA_ACTIVITIES), stat(GARMIN_ACTIVITIES), tuple(sorted(streams)))


def _compute_zone_minutes(stream_files):
    index = _activity_index()
    by_week = {}
    for fname in stream_files:
        stream = _load_json(os.path.join(STREAMS_DIR, fname), None)
        if not isinstance(stream, dict):
            logger.warning("zone-minutes: skipping unreadable stream %s", fname)
            continue
        hr = stream.get("heartrate") or []
        if not hr:
            continue
        # Date and sport: from the file itself if it carries them, else from
        # the activity masters by id ("123.json", or "<prefix>_123.json").
        stem = fname[:-5]
        meta = index.get(stem) or index.get(stem.rsplit("_", 1)[-1]) or (None, None)
        date = next((d for d in (_iso_day(stream.get(k)) for k in STREAM_DATE_KEYS) if d), meta[0])
        sport = next((stream[k] for k in STREAM_SPORT_KEYS if stream.get(k)), meta[1])
        # This feeds the Running page, so known non-runs (skate/swim/walk/ride,
        # ~8% of all minutes) are left out. An activity with no sport label is
        # kept; one with no date can't be placed in a week.
        if not date or _is_run(sport) is False:
            continue
        try:
            d = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            continue
        # Weeks run Saturday→Friday: weekday() is Mon=0…Sun=6, so (weekday-5)%7
        # is the number of days back to the most recent Saturday.
        week = (d - timedelta(days=(d.weekday() - 5) % 7)).strftime("%Y-%m-%d")
        zones = by_week.setdefault(week, [0, 0, 0, 0, 0])
        t = stream.get("time")
        if not (isinstance(t, list) and len(t) == len(hr)):
            t = None  # no usable clock — fall back to 1 s per sample
        last = len(hr) - 1
        for i, h in enumerate(hr):
            if not isinstance(h, (int, float)):
                continue  # Strava emits null gaps when the HR sensor drops out
            secs = 1
            if t is not None and i < last:
                a, b = t[i], t[i + 1]
                if isinstance(a, (int, float)) and isinstance(b, (int, float)) and b > a:
                    secs = min(b - a, MAX_SAMPLE_GAP_S)
            pct = h / HRMAX
            for z, (lo, hi) in enumerate(ZONE_BOUNDS):
                if lo <= pct < hi:
                    zones[z] += secs
                    break
    return [
        {"week": w, "z1": round(z[0]/60, 1), "z2": round(z[1]/60, 1),
         "z3": round(z[2]/60, 1), "z4": round(z[3]/60, 1), "z5": round(z[4]/60, 1)}
        for w, z in sorted(by_week.items())
    ]


def api_zone_minutes():
    """Bin per-sample HR from the run streams into Z1-Z5 minutes per week."""
    if not os.path.isdir(STREAMS_DIR):
        return []
    with _zone_cache_lock:  # also keeps concurrent requests from each rebuilding
        sig = _zone_signature()
        if _zone_cache["data"] is None or _zone_cache["sig"] != sig:
            _zone_cache["data"] = _compute_zone_minutes([name for name, _, _ in sig[2]])
            _zone_cache["sig"] = sig
        return _zone_cache["data"]


def api_hr_recovery():
    path = os.path.join(MASTER_DIR, "hr_recovery.json")
    if not os.path.isfile(path):
        return []
    with open(path) as f:
        rows = json.load(f)
    return [
        {"date": r["date"], "recovery": r["avg_recovery_60s"], "name": r.get("name", "")}
        for r in rows
        if r.get("avg_recovery_60s") is not None
        and r.get("sport") == "running"  # exclude swims/cycling — different physiology
    ]


def api_lactate_threshold():
    """Lactate-threshold trend from the nightly Garmin snapshot
    (~/garmin-sync/data/master/lactate_threshold.json — one entry per sync day).

    Garmin stores LT speed as metres-per-second ÷ 10 (e.g. 0.30278 → 3.028 m/s,
    which is 10.9 km/h → 8:52/mi); multiply by 10, then 26.8224 / (m/s) gives
    min/mi. FTP (running functional-threshold power, watts) rides along in the
    same file as a bonus series. Deduped to the latest reading per date."""
    path = os.path.join(MASTER_DIR, "lactate_threshold.json")
    if not os.path.isfile(path):
        return []
    with open(path) as f:
        rows = json.load(f)
    by_date = {}
    for r in rows:
        date = r.get("date")
        shr = r.get("speed_and_heart_rate") or {}
        pwr = r.get("power") or {}
        lthr = shr.get("heartRate")
        if not date or lthr is None:
            continue
        speed = shr.get("speed")
        pace = round(26.8224 / (speed * 10), 2) if speed else None  # m/s÷10 → min/mi
        by_date[date] = {
            "date": date,
            "lthr": lthr,
            "pace": pace,
            "ftp": pwr.get("functionalThresholdPower"),
        }
    return [by_date[d] for d in sorted(by_date)]


def _time_to_min(t):
    """Parse a SQLite TIME string 'HH:MM:SS.ffffff' to float minutes (None if empty)."""
    if not t:
        return None
    hh, mm, ss = t.split(":")
    return round(int(hh) * 60 + int(mm) + float(ss) / 60, 1)


# Garmin keeps one sleep row per day, so when no overnight sleep was recorded a
# daytime nap is filed as that night's sleep and drags the duration/score
# charts down. A row is a nap when it both starts in the daytime and is short.
# Checked against every row in the table: this matches exactly the four known
# naps (starts 08:09, 12:03, 14:51, 17:00; 2h39–3h10) and no real night — the
# latest genuine bedtime is 05:00, and the two sleeps that begin before 19:30
# ran 8 h and 12 h.
NAP_START_FROM, NAP_START_BEFORE = "07:00", "19:00"
NAP_MAX_MINUTES = 240


def _is_nap(start, total_min):
    """`start` is the local 'YYYY-MM-DD HH:MM:SS…' bedtime (None → not a nap)."""
    if not isinstance(start, str) or len(start) < 16:
        return False
    return (NAP_START_FROM <= start[11:16] < NAP_START_BEFORE
            and total_min < NAP_MAX_MINUTES)


def api_sleep():
    """Per-night sleep: stage minutes (deep/light/rem/awake), total, score, SpO2.
    Skips no-data nights (total_sleep '00:00:00' when the watch wasn't worn)
    and daytime naps stored in a night's slot."""
    rows = query_db(GARMIN_DB, """
        SELECT day as date, start, total_sleep, deep_sleep, light_sleep, rem_sleep,
               awake, score, avg_spo2 as spo2
        FROM sleep
        WHERE total_sleep IS NOT NULL
        ORDER BY day
    """)
    out = []
    for r in rows:
        total = _time_to_min(r["total_sleep"])
        if not total:  # 0-minute nights = no data recorded
            continue
        if _is_nap(r["start"], total):
            continue
        out.append({
            "date": r["date"], "total": total,
            "deep": _time_to_min(r["deep_sleep"]),
            "light": _time_to_min(r["light_sleep"]),
            "rem": _time_to_min(r["rem_sleep"]),
            "awake": _time_to_min(r["awake"]),
            "score": r["score"], "spo2": r["spo2"],
        })
    return out


def api_steps():
    return query_db(GARMIN_DB,
        "SELECT day as date, steps, step_goal FROM daily_summary "
        "WHERE steps IS NOT NULL ORDER BY day")


def api_stress():
    # Garmin writes -1 for a day with no stress reading; "> 0" drops that and NULLs.
    return query_db(GARMIN_DB,
        "SELECT day as date, stress_avg as stress FROM daily_summary "
        "WHERE stress_avg > 0 ORDER BY day")


def api_body_battery():
    return query_db(GARMIN_DB,
        "SELECT day as date, bb_max as high, bb_min as low FROM daily_summary "
        "WHERE bb_max IS NOT NULL ORDER BY day")


def _run(cmd, timeout=5):
    """stdout of a short helper command; '' if it fails, hangs or isn't installed."""
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL,
                                       timeout=timeout)
    except (subprocess.SubprocessError, OSError):
        return ""


# Cache the version keyed on the reflog mtime (.git/logs/HEAD advances on every
# commit/checkout) so the hot path doesn't fork two git processes per page load.
_version_cache = {"sig": None, "data": None}


def api_version():
    def sig():
        s = 0.0
        for p in (".git/logs/HEAD", ".git/HEAD"):
            try:
                s = max(s, os.path.getmtime(os.path.join(STATIC_DIR, p)))
            except OSError:
                pass
        return s
    cur = sig()
    if _version_cache["data"] is not None and _version_cache["sig"] == cur:
        return _version_cache["data"]

    sha = _run(["git", "-C", STATIC_DIR, "rev-parse", "--short", "HEAD"]).strip()
    date = _run(["git", "-C", STATIC_DIR, "log", "-1", "--format=%cs", "HEAD"]).strip()
    data = {"sha": sha, "date": date} if sha and date else {"sha": "dev", "date": "unknown"}
    _version_cache["sig"] = cur
    _version_cache["data"] = data
    return data


def api_routes():
    """List of /api/* routes the server exposes. Used by architecture.html
    to render its API-route chip list live so it can't drift from reality."""
    return sorted(p for p in API_ROUTES.keys() if p != "/api/routes")


def api_schema():
    """SQLite tables in garmin.db + their column lists. Used by
    architecture.html to render the storage-layer chip list live."""
    conn = _connect(GARMIN_DB)
    try:
        conn.row_factory = sqlite3.Row
        tables = [r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        result = []
        for t in tables:
            quoted = t.replace('"', '""')
            cols = [r["name"] for r in conn.execute(f'PRAGMA table_info("{quoted}")')]
            result.append({"table": t, "columns": cols})
        return result
    finally:
        conn.close()


# ── Sync schedule ──────────────────────────────────────────────────────────
# Crontab lines worth showing; everything else in the crontab is unrelated.
CRON_KEEP = ("garmindb", "renpho_sync", "sync_v2", "merge_daily",
             "workout_sync", "strava_sync", "strava_merge",
             "hr_recovery", "backup_garmin", "run_pipeline")
# The pipeline runner: one cron line, whose jobs are its `step <name> <cmd…>` lines.
PIPELINE_SCRIPT = "run_pipeline.sh"
_STEP_RE = re.compile(r"\s*step\s+([a-z0-9_]+)\s+\S")
SYNC_TIMER = "garmin-sync.timer"
CRON_TTL_S = 60
_cron_cache = {"at": 0.0, "data": None}
_cron_lock = threading.Lock()


def _pipeline_steps(token, command):
    """Ordered step names from the pipeline script a cron command points at
    ([] if the script is missing or defines no steps)."""
    unquote = lambda s: os.path.expanduser(os.path.expandvars(s.strip("'\";")))
    path = unquote(token)
    if not os.path.isabs(path):
        # "cd <dir> && ./run_pipeline.sh": resolve against that dir, else the sync dir.
        base = unquote(command[command.index("cd") + 1]) if "cd" in command[:-1] else SYNC_DIR
        path = os.path.join(base, path)
    try:
        with open(path, errors="replace") as f:
            lines = f.read(262_144).splitlines()
    except OSError:
        return []
    return [m.group(1) for m in map(_STEP_RE.match, lines) if m]


def _cron_jobs(raw):
    """[{time, name}] for the sync lines of `crontab -l` output. A line that
    runs the pipeline script expands to one entry per step, in run order,
    tagged {via, step, steps} since they share the line's start time."""
    jobs = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not any(k in line for k in CRON_KEEP):
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        m, h = parts[0], parts[1]
        hhmm = f"{int(h):02d}:{int(m):02d}" if h.isdigit() and m.isdigit() else f"{h}:{m}"
        command = parts[5:]
        script = next((tok for tok in command if PIPELINE_SCRIPT in tok), None)
        steps = _pipeline_steps(script, command) if script else []
        if steps:
            jobs += [{"time": hhmm, "name": s, "via": PIPELINE_SCRIPT,
                      "step": i, "steps": len(steps)} for i, s in enumerate(steps, 1)]
            continue
        # Friendly name = the script filename (also what an unexpandable
        # pipeline line falls back to).
        name = next((tok.rsplit("/", 1)[-1] for tok in parts if tok.endswith((".py", ".sh"))), "?")
        jobs.append({"time": hhmm, "name": name})
    return jobs


def _timer_jobs():
    """Entries for the systemd user timer that also runs a sync, one per
    OnCalendar time; [] if the timer isn't active or systemctl can't say."""
    props = _run(["systemctl", "--user", "show", SYNC_TIMER,
                  "-p", "ActiveState", "-p", "Unit", "-p", "TimersCalendar"], timeout=3)
    if "ActiveState=active" not in props.splitlines():
        return []
    # "TimersCalendar={ OnCalendar=*-*-* 23:00:00 ; next_elapse=… }"
    times = sorted({f"{int(h):02d}:{m}" for h, m in re.findall(
        r"OnCalendar=[^;]*?\s(\d{1,2}):(\d{2})(?::\d{2})?\s*;", props)})
    name = SYNC_TIMER
    unit = re.search(r"^Unit=([\w@.\-]+)$", props, re.M)
    if unit:
        # Name the job after the script the activated service runs.
        argv = re.search(r"argv\[\]=(.*?) ;", _run(
            ["systemctl", "--user", "show", unit.group(1), "-p", "ExecStart"], timeout=3))
        scripts = [tok.rsplit("/", 1)[-1] for tok in (argv.group(1).split() if argv else [])
                   if tok.endswith((".py", ".sh"))]
        name = scripts[-1] if scripts else unit.group(1)
    return [{"time": t, "name": name, "via": SYNC_TIMER} for t in times]


def api_cron():
    """Parsed sync schedule: the user's crontab plus the sync timer.
    architecture.html reads this so the schedule stays aligned with what's
    actually running. Cached briefly — it forks crontab and systemctl."""
    with _cron_lock:
        if (_cron_cache["data"] is None
                or time.monotonic() - _cron_cache["at"] > CRON_TTL_S):
            jobs = _cron_jobs(_run(["crontab", "-l"])) + _timer_jobs()
            _cron_cache["data"] = sorted(jobs, key=lambda j: j["time"])
            _cron_cache["at"] = time.monotonic()
        return _cron_cache["data"]


# ── Data freshness ─────────────────────────────────────────────────────────
# (source — named after its /api route, max age in days, latest-date query).
# Thresholds come from each source's own gap history in garmin.db (days between
# consecutive dated rows), plus the sync's normal lag:
#   daily Garmin metrics   gaps are 1 d (p99; sleep/hrv 2 d when the watch is
#                          off for a night) and the newest row normally trails
#                          today by 1–2 d                               →  3 d
#   scale (weight/bodyfat) user-driven: 1 d typical, p95 7 d            →  7 d
#   runs                   p95 7 d, max 14 d (7 d in 2026)              → 10 d
#   vo2max                 only updates on qualifying runs: p95 9, max 14 → 21 d
#   lifts                  one row per training week, dated at the week's
#                          start: 7 d typical, 14 d after a skipped week → 14 d
# Manually entered sources (DEXA scans, tape measurements) have no cadence to
# hold them to and are not checked.
HEALTH_DB_SOURCES = (
    ("weight", 7, "SELECT MAX(day) FROM weight WHERE weight IS NOT NULL"),
    ("bodyfat", 7, "SELECT MAX(day) FROM body_fat WHERE bodyfat IS NOT NULL"),
    ("rhr", 3, "SELECT MAX(day) FROM resting_hr WHERE resting_heart_rate IS NOT NULL"),
    ("hrv", 3, "SELECT MAX(day) FROM hrv WHERE hrv_overnight_avg > 0"),
    ("vo2max", 21, "SELECT MAX(day) FROM vo2max WHERE vo2max IS NOT NULL"),
    ("activities", 10, "SELECT MAX(date) FROM running_activities"),
    ("workout-volume", 14, "SELECT MAX(week_date) FROM workout_weeks"),
    ("lift-progression", 14, "SELECT MAX(week_date) FROM workout_exercises"),
    ("workout-sets", 14, "SELECT MAX(week_date) FROM workout_sets"),
    ("sleep", 3, "SELECT MAX(day) FROM sleep WHERE total_sleep NOT LIKE '00:00:00%'"),
    ("steps", 3, "SELECT MAX(day) FROM daily_summary WHERE steps IS NOT NULL"),
    ("stress", 3, "SELECT MAX(day) FROM daily_summary WHERE stress_avg > 0"),
    ("body-battery", 3, "SELECT MAX(day) FROM daily_summary WHERE bb_max IS NOT NULL"),
)
# File-backed sources: (source, max age in days, handler, date field).
#   zone-minutes       weekly buckets dated at the week's start; runs are at
#                      most 7–14 d apart                                → 14 d
#   hr-recovery        only hard-effort runs qualify: p90 15 d          → 30 d
#   lactate-threshold  one snapshot per sync day                        →  3 d
HEALTH_FILE_SOURCES = (
    ("zone-minutes", 14, api_zone_minutes, "week"),
    ("hr-recovery", 30, api_hr_recovery, "date"),
    ("lactate-threshold", 3, api_lactate_threshold, "date"),
)
# Written by ~/garmin-sync/run_pipeline.sh at the end of each run:
#   {"started": ISO, "finished": ISO, "ok": bool, "steps": [{"name","rc","seconds"}]}
PIPELINE_STATUS = os.path.join(SYNC_DIR, "data", "pipeline_status.json")
PIPELINE_MAX_AGE_H = 36  # nightly run + half a day of slack


def _parse_iso(value):
    """Aware datetime from an ISO-8601 string (naive = server local time), else None."""
    try:
        return datetime.fromisoformat(value).astimezone()
    except (TypeError, ValueError):
        return None


def _pipeline_health(now):
    """(summary | None, stale?) from the pipeline's status file. No file means
    the runner isn't installed — reported as null, not as a fault."""
    try:
        with open(PIPELINE_STATUS) as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("not an object")
    except FileNotFoundError:
        return None, False
    except (OSError, ValueError):
        return {"ok": False, "error": "status file unreadable"}, True
    ended = _parse_iso(raw.get("finished")) or _parse_iso(raw.get("started"))
    age_h = round((now - ended).total_seconds() / 3600, 1) if ended else None
    ok = raw.get("ok") is True
    stale = not ok or age_h is None or age_h > PIPELINE_MAX_AGE_H
    number = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    steps = raw.get("steps") if isinstance(raw.get("steps"), list) else []
    # Copy known fields only — this is a public endpoint, so nothing else the
    # runner might add to its status file (paths, error text) leaks through.
    return {
        "started": raw.get("started") if isinstance(raw.get("started"), str) else None,
        "finished": raw.get("finished") if isinstance(raw.get("finished"), str) else None,
        "ok": ok,
        "age_hours": age_h,
        "max_age_hours": PIPELINE_MAX_AGE_H,
        "steps": [{"name": str(s.get("name")), "rc": number(s.get("rc")),
                   "seconds": number(s.get("seconds"))}
                  for s in steps if isinstance(s, dict)],
    }, stale


def api_health():
    """Freshness of every pipeline-fed source: 200 when all are within their
    max age, 503 when any is stale (or the pipeline's last run failed)."""
    now = datetime.now().astimezone()
    today = now.date()

    def source(name, max_age, latest):
        day = _iso_day(latest)
        try:
            age = (today - datetime.strptime(day, "%Y-%m-%d").date()).days
        except (TypeError, ValueError):
            day, age = None, None
        return {"name": name, "latest": day, "age_days": age,
                "max_age_days": max_age, "ok": age is not None and age <= max_age}

    # A DB fault must still produce a well-formed report (every DB source
    # stale), not a generic error — this endpoint is what gets polled to
    # notice exactly that. One log line per check, however many queries fail.
    sources, db_errors = [], []
    try:
        conn = _connect(GARMIN_DB)
    except sqlite3.Error as exc:
        db_errors.append(str(exc))
        conn = None
    try:
        for name, max_age, sql in HEALTH_DB_SOURCES:
            latest = None
            if conn is not None:
                try:
                    latest = conn.execute(sql).fetchone()[0]
                except sqlite3.Error as exc:
                    db_errors.append(f"{name}: {exc}")
            sources.append(source(name, max_age, latest))
    finally:
        if conn is not None:
            conn.close()
    if db_errors:
        logger.error("health: database unavailable (%s%s)", db_errors[0],
                     f"; +{len(db_errors) - 1} more" if len(db_errors) > 1 else "")
    for name, max_age, handler, field in HEALTH_FILE_SOURCES:
        try:
            latest = max((str(r[field]) for r in handler() if r.get(field)), default=None)
        except Exception:
            logger.exception("health: %s source failed", name)
            latest = None
        sources.append(source(name, max_age, latest))

    pipeline, pipeline_stale = _pipeline_health(now)
    stale = [s["name"] for s in sources if not s["ok"]]
    if pipeline_stale:
        stale.append("pipeline")
    return ApiResult(503 if stale else 200, {
        "status": "stale" if stale else "ok",
        "checked_at": now.isoformat(timespec="seconds"),
        "stale": stale,
        "sources": sources,
        "pipeline": pipeline,
    })


API_ROUTES = {
    "/api/weight": api_weight,
    "/api/bodyfat": api_bodyfat,
    "/api/dexa": api_dexa,
    "/api/measurements": api_measurements,
    "/api/rhr": api_rhr,
    "/api/hrv": api_hrv,
    "/api/activities": api_activities,
    "/api/vo2max": api_vo2max,
    "/api/workout-volume": api_workout_volume,
    "/api/lift-progression": api_lift_progression,
    "/api/workout-sets": api_workout_sets,
    "/api/zone-minutes": api_zone_minutes,
    "/api/hr-recovery": api_hr_recovery,
    "/api/lactate-threshold": api_lactate_threshold,
    "/api/sleep": api_sleep,
    "/api/steps": api_steps,
    "/api/stress": api_stress,
    "/api/body-battery": api_body_battery,
    "/api/health": api_health,
    "/api/version": api_version,
    "/api/routes": api_routes,
    "/api/schema": api_schema,
    "/api/cron": api_cron,
}


# ── Response policy ────────────────────────────────────────────────────────
# Only long-cache binary assets (images/fonts), and only on a successful
# response; see Handler.end_headers.
LONG_CACHE_EXTS = (".png", ".svg", ".ico", ".webmanifest", ".jpg", ".jpeg",
                   ".gif", ".webp", ".woff", ".woff2")
# Content-Security-Policy. Scripts: our own files plus the pinned, SRI-checked
# Chart.js bundles on jsDelivr; an HTML page's inline <script> blocks are
# allowed by hash, computed from the file being served so editing
# architecture.html never needs a matching edit here. Styles keep
# 'unsafe-inline' because both pages use style="" attributes (which hashes
# can't cover) and architecture.html is deliberately one self-contained file.
CSP = ("default-src 'self'; "
       "script-src 'self' https://cdn.jsdelivr.net{hashes}; "
       "style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; "
       "object-src 'none'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'none'")
_INLINE_SCRIPT_RE = re.compile(rb"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
_csp_hash_cache = {}  # html path → ((mtime_ns, size), " 'sha256-…' …")


def _inline_script_hashes(html_path):
    """CSP hash sources (as a leading-space-joined string) for the inline
    scripts of an HTML file, cached until the file changes."""
    st = os.stat(html_path)
    sig = (st.st_mtime_ns, st.st_size)
    cached = _csp_hash_cache.get(html_path)
    if cached and cached[0] == sig:
        return cached[1]
    with open(html_path, "rb") as f:
        html = f.read()
    hashes = ""
    for attrs, body in _INLINE_SCRIPT_RE.findall(html):
        if re.search(rb"\bsrc\s*=", attrs, re.I) or not body.strip():
            continue
        # Browsers hash the script text after newline normalisation.
        digest = hashlib.sha256(body.replace(b"\r\n", b"\n")).digest()
        hashes += f" 'sha256-{base64.b64encode(digest).decode()}'"
    _csp_hash_cache[html_path] = (sig, hashes)
    return hashes


# Escape control characters in logged request lines (they are attacker-chosen
# bytes) — the stdlib does this in log_message, which the Handler overrides.
_LOG_ESCAPES = {c: f"\\x{c:02x}" for c in (*range(0x20), *range(0x7f, 0xa0))}
_LOG_ESCAPES[ord("\\")] = "\\\\"
_IP_RE = re.compile(r"[0-9A-Fa-f:.]{2,45}")
_HOST_RE = re.compile(r"[A-Za-z0-9.-]+(:\d{1,5})?")


class Handler(SimpleHTTPRequestHandler):
    server_version = "health-dashboard"  # hide "SimpleHTTP/x Python/y" banner
    sys_version = ""
    # The stdlib assumes HTTP/0.9 until the request line parses, and an
    # HTTP/0.9 reply has no status line or headers — so a malformed request
    # line would be answered with a bare HTML body. Assume 1.0 instead, so it
    # gets a real "400 Bad Request" response.
    default_request_version = "HTTP/1.0"
    # Socket timeout: a client that connects and then stalls (never finishes
    # its request, or stops reading the response) is dropped instead of
    # pinning a thread forever.
    timeout = 30

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        self._handle(head_only=False)

    def do_HEAD(self):
        # SimpleHTTPRequestHandler ships its own do_HEAD that calls send_head()
        # directly, bypassing the _is_private_path guard. Without this
        # override, HEAD would disclose the size/mtime/existence of source, .git,
        # logs and other private files on the public no-auth endpoint. Route HEAD
        # through the same checks as GET.
        self._handle(head_only=True)

    def _handle(self, head_only):
        if self._redirect_to_https():
            return
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path in API_ROUTES:
            self._serve_api(path, head_only)
            return
        if self._is_private_path():
            self.send_error(404, "File not found")
            return
        if head_only:
            super().do_HEAD()
        else:
            super().do_GET()

    def _serve_api(self, path, head_only):
        # Build the whole body before sending so a handler/JSON error can't fire
        # after the status line is on the wire (which would write a second
        # response). Error detail goes to the log only; the public response
        # stays generic so exception text (paths, SQL/schema hints) isn't leaked.
        try:
            result = API_ROUTES[path]()
            status = 200
            if isinstance(result, ApiResult):
                status, result = result
            body = json.dumps(result).encode()
        except sqlite3.Error as exc:
            # Missing, corrupt or locked garmin.db: an outage, not a bug.
            logger.error("API handler %s: database unavailable (%s)", path, exc)
            status, body = 503, json.dumps({"error": "database unavailable"}).encode()
        except Exception:
            logger.exception("API handler %s failed", path)
            status, body = 500, json.dumps({"error": "internal error"}).encode()
        try:
            self._send_json(status, body, head_only)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected mid-response — nothing to salvage

    def _is_private_path(self):
        """True for any static path that must not be public.

        The web root is the repo dir, which also contains source, logs/, .git/
        and other non-public files, and the server is reachable on the public
        internet with no auth. Resolve to a real filesystem path (this also
        neutralizes ../ traversal) and only allow files that live inside the
        repo, carry an allow-listed extension, and have no dot-prefixed or
        logs/ path segment. Directories never list.
        """
        root = os.path.realpath(STATIC_DIR)
        try:
            real = os.path.realpath(self.translate_path(self.path))
        except ValueError:
            return True  # e.g. embedded NUL in the path — never serve it
        if real != root and not real.startswith(root + os.sep):
            return True  # escaped the web root
        rel = os.path.relpath(real, root)
        if rel == ".":
            return False  # "/" maps to index.html
        segments = rel.split(os.sep)
        if any(seg.startswith(".") for seg in segments):
            return True  # .git, .gitignore, .playwright-mcp, …
        if segments[0] == "logs":
            return True  # request log, status_line.json, debug images
        if os.path.isdir(real):
            return True  # no directory autoindex
        return os.path.splitext(real)[1].lower() not in ALLOWED_STATIC_EXTS

    def list_directory(self, path):
        # Belt-and-suspenders: never enumerate a directory even if reached.
        self.send_error(404, "File not found")
        return None

    # ── Behind Cloudflare ──────────────────────────────────────────────────
    # cloudflared is the only non-local client (the server binds loopback), and
    # the edge tells us about the real visitor in request headers. Requests
    # made straight to localhost carry none of them and are left alone.

    def _forwarded_scheme(self):
        """'http' or 'https' as the visitor reached the edge; None if direct."""
        headers = getattr(self, "headers", None)  # absent if the request never parsed
        if not headers:
            return None
        seen = set()
        proto = headers.get("X-Forwarded-Proto")
        if proto:
            seen.add(proto.split(",")[0].strip().lower())
        try:
            seen.add(str(json.loads(headers.get("CF-Visitor") or "{}").get("scheme")).lower())
        except (ValueError, AttributeError):
            pass
        return "http" if "http" in seen else "https" if "https" in seen else None

    def _redirect_to_https(self):
        """Answer a plain-HTTP visit with a 301 to the same URL on https.
        True if the response was sent."""
        if self._forwarded_scheme() != "http":
            return False
        host = self.headers.get("Host", "")
        if not _HOST_RE.fullmatch(host):
            return False  # nothing trustworthy to build a Location from
        if host.endswith(":80"):
            host = host[:-3]
        path = self.path if self.path.startswith("/") else "/"
        self.send_response(301)
        self.send_header("Location", "https://" + host + quote(path, safe="/?&=%:@!$'()*+,;~-._"))
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _client_ip(self):
        """The visitor's address: Cloudflare's CF-Connecting-IP when present
        (the socket peer is always cloudflared on 127.0.0.1), else the peer."""
        headers = getattr(self, "headers", None)
        ip = (headers.get("CF-Connecting-IP") or "").strip() if headers else ""
        return ip if _IP_RE.fullmatch(ip) else self.client_address[0]

    # ── Response plumbing ──────────────────────────────────────────────────

    def _send_json(self, status, body, head_only=False):
        """Send a JSON response, gzip-compressing when the client accepts it.

        Saves 5-10x on payload size for JSON over the Cloudflare tunnel; the
        decompress cost on a modern browser is negligible.
        """
        gzipped = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 512
        if gzipped:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if gzipped:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def send_response(self, code, message=None):
        self._status = int(code)  # end_headers picks policy by status
        super().send_response(code, message)

    def _csp(self):
        hashes = ""
        if getattr(self, "_status", None) == 200:
            try:
                fs_path = self.translate_path(getattr(self, "path", "") or "/")
                if os.path.isdir(fs_path):
                    fs_path = os.path.join(fs_path, "index.html")
                if fs_path.lower().endswith(".html"):
                    hashes = _inline_script_hashes(fs_path)
            except (OSError, ValueError):
                pass  # not a servable file — the base policy applies
        return CSP.format(hashes=hashes)

    def end_headers(self):
        # NB: this also runs for errors raised while *parsing* a request, when
        # neither self.path nor self.headers exists yet — hence the getattrs
        # here and in the helpers.
        status = getattr(self, "_status", None)
        path = getattr(self, "path", "").split("?", 1)[0]
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", self._csp())
        if self._forwarded_scheme() == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        # Caching policy:
        #   /api/*                 → no-store (data must be fresh)
        #   *.html, *.js, *.css, / → no-store (entry points + code — let changes
        #                            propagate without browser cache games so a
        #                            deploy never serves new JS against stale CSS;
        #                            payloads are tiny anyway)
        #   images                 → max-age=3600 (rarely change, save tunnel bw)
        #   anything not 200/304   → no-store, whatever the URL's extension: a
        #                            404 for /nope.png or a redirect must not be
        #                            held by a browser or edge-cached by the CDN.
        ext = os.path.splitext(path)[1].lower()
        if status in (200, 304) and ext in LONG_CACHE_EXTS:
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return CONTENT_TYPES.get(ext, "application/octet-stream")

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # Pipe stdlib request logs into our logger so /logs/dashboard.log has
        # full request history (status code, path, client) alongside app logs.
        logger.info("%s - %s", self._client_ip(), (fmt % args).translate(_LOG_ESCAPES))


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # The stdlib prints handler crashes to stderr, i.e. only the journal.
        # Send them to dashboard.log with the rest; a client hanging up or
        # timing out mid-response is routine and gets one line, no traceback.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            logger.info("%s - connection dropped (%s)", client_address[0], type(exc).__name__)
        elif isinstance(exc, RuntimeError) and "start new thread" in str(exc):
            # At the unit's TasksMax: shed this connection, keep serving the rest.
            logger.warning("%s - connection refused: thread limit reached", client_address[0])
        else:
            logger.exception("Unhandled error serving %s", client_address[0])


if __name__ == "__main__":
    # Bind loopback only: cloudflared proxies health.keo.life -> http://localhost:8888
    # on this host, so the public tunnel still works while the LAN can no longer
    # reach the dashboard directly (bypassing Cloudflare's TLS/WAF).
    server = Server(("127.0.0.1", PORT), Handler)
    print(f"Serving health dashboard at http://localhost:{PORT}")
    server.serve_forever()
