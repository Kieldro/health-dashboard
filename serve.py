#!/usr/bin/env python3
"""Health dashboard server — queries SQLite databases directly."""

import gzip
import json
import logging
import os
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = 8888
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
GARMIN_DB = os.path.expanduser("~/HealthData/DBs/garmin.db")
LOGS_DIR = os.path.join(STATIC_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOGS_DIR, "dashboard.log")),
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
}

# Thread-local SQLite connections: one connection per (db_path, thread), reused
# for the life of the thread. ThreadingHTTPServer spawns a thread per request
# and worker threads are short-lived, so this puts a natural cap on connection
# count without needing a pool.
_local = threading.local()


def query_db(db_path, sql, params=()):
    conns = getattr(_local, "conns", None)
    if conns is None:
        conns = {}
        _local.conns = conns
    conn = conns.get(db_path)
    if conn is None:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conns[db_path] = conn
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


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
    return query_db(GARMIN_DB,
        "SELECT day as date, hrv_overnight_avg as hrv FROM hrv ORDER BY day")


def api_activities():
    return query_db(GARMIN_DB, """
        SELECT date, start_time, distance_m as distance, duration_sec as duration,
               avg_hr, max_hr, calories, vo2max
        FROM running_activities
        ORDER BY date
    """)


def api_vo2max():
    return query_db(GARMIN_DB, "SELECT day as date, vo2max FROM vo2max ORDER BY day")


def api_workout_volume():
    return query_db(GARMIN_DB,
        "SELECT week_date as week, total_exercises, total_sets, training_days FROM workout_weeks ORDER BY week_date")


def api_lift_progression():
    return query_db(GARMIN_DB, """
        SELECT week_date as week, exercise, top_weight, top_reps, max_reps
        FROM workout_exercises
        WHERE (top_weight IS NOT NULL OR max_reps IS NOT NULL)
          AND (top_reps IS NULL OR top_reps <= 500)
        ORDER BY week_date
    """)


def api_workout_sets():
    return query_db(GARMIN_DB, """
        SELECT week_date as week, exercise, set_num, weight, reps
        FROM workout_sets
        WHERE reps IS NOT NULL AND reps > 0 AND reps <= 500
        ORDER BY week_date, exercise, set_num
    """)


# HRmax used for %HRmax-based zone bins. Set from observed peak HR (~199 bpm).
HRMAX = 200
ZONE_BOUNDS = [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 9.99)]
_zone_cache = {"mtime": 0, "data": None}
_zone_cache_lock = threading.Lock()


def api_zone_minutes():
    """Bin per-second HR samples from strava_streams into Z1-Z5 minutes per week."""
    streams_dir = os.path.expanduser("~/garmin-sync/data/master/strava_streams")
    activities_path = os.path.expanduser("~/garmin-sync/data/master/strava_activities.json")

    if not os.path.isfile(activities_path) or not os.path.isdir(streams_dir):
        return []

    # Cache invalidates when either the activities file or streams dir mtime changes
    sig = max(os.path.getmtime(activities_path), os.path.getmtime(streams_dir))
    with _zone_cache_lock:
        if _zone_cache["data"] is not None and _zone_cache["mtime"] == sig:
            return _zone_cache["data"]

    with open(activities_path) as f:
        id_to_date = {str(a["id"]): a["start_date_local"][:10]
                      for a in json.load(f) if a.get("start_date_local")}

    by_week = {}
    for fname in os.listdir(streams_dir):
        if not fname.endswith(".json"):
            continue
        date = id_to_date.get(fname[:-5])
        if not date:
            continue
        with open(os.path.join(streams_dir, fname)) as f:
            hr = json.load(f).get("heartrate") or []
        if not hr:
            continue
        d = datetime.strptime(date, "%Y-%m-%d")
        week = (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
        zones = by_week.setdefault(week, [0, 0, 0, 0, 0])
        for h in hr:
            pct = h / HRMAX
            for i, (lo, hi) in enumerate(ZONE_BOUNDS):
                if lo <= pct < hi:
                    zones[i] += 1
                    break

    result = [
        {"week": w, "z1": round(z[0]/60, 1), "z2": round(z[1]/60, 1),
         "z3": round(z[2]/60, 1), "z4": round(z[3]/60, 1), "z5": round(z[4]/60, 1)}
        for w, z in sorted(by_week.items())
    ]
    with _zone_cache_lock:
        _zone_cache["mtime"] = sig
        _zone_cache["data"] = result
    return result


def api_hr_recovery():
    path = os.path.expanduser("~/garmin-sync/data/master/hr_recovery.json")
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


def api_version():
    def git(*args):
        return subprocess.check_output(
            ["git", "-C", STATIC_DIR, *args],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
    try:
        return {"sha": git("rev-parse", "--short", "HEAD"),
                "date": git("log", "-1", "--format=%cs", "HEAD")}
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {"sha": "dev", "date": "unknown"}


def api_routes():
    """List of /api/* routes the server exposes. Used by architecture.html
    to render its API-route chip list live so it can't drift from reality."""
    return sorted(p for p in API_ROUTES.keys() if p != "/api/routes")


def api_schema():
    """SQLite tables in garmin.db + their column lists. Used by
    architecture.html to render the storage-layer chip list live."""
    conn = sqlite3.connect(GARMIN_DB)
    conn.row_factory = sqlite3.Row
    tables = [r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]
    result = []
    for t in tables:
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({t})")]
        result.append({"table": t, "columns": cols})
    conn.close()
    return result


def api_cron():
    """Parsed sync schedule from the user's crontab. architecture.html reads
    this so the schedule chips stay aligned with what's actually running."""
    try:
        raw = subprocess.check_output(["crontab", "-l"], text=True, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    jobs = []
    # We only want sync-related lines; skip user comments/aliases.
    keep = ("garmindb", "renpho_sync", "sync_v2", "merge_daily",
            "workout_sync", "strava_sync", "strava_merge",
            "hr_recovery", "backup_garmin")
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not any(k in line for k in keep):
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        m, h = parts[0], parts[1]
        rest = " ".join(parts[5:])
        # Extract a friendly name (last py/sh filename)
        name = next((tok.rsplit("/", 1)[-1] for tok in parts if tok.endswith((".py", ".sh"))), "?")
        jobs.append({"time": f"{int(h):02d}:{int(m):02d}", "name": name})
    return sorted(jobs, key=lambda j: j["time"])


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
    "/api/version": api_version,
    "/api/routes": api_routes,
    "/api/schema": api_schema,
    "/api/cron": api_cron,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]

        if path in API_ROUTES:
            try:
                data = API_ROUTES[path]()
                body = json.dumps(data).encode()
                self._send_json(200, body)
            except Exception as e:
                logger.exception("API handler %s failed", path)
                self._send_json(500, json.dumps({"error": str(e)}).encode())
            return

        super().do_GET()

    def _send_json(self, status, body):
        """Send a JSON response, gzip-compressing when the client accepts it.

        Saves 5-10x on payload size for JSON over the Cloudflare tunnel; the
        decompress cost on a modern browser is negligible.
        """
        encoding = self.headers.get("Accept-Encoding", "")
        if "gzip" in encoding and len(body) > 512:
            body = gzip.compress(body, compresslevel=5)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
        else:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        # Caching policy:
        #   /api/*           → no-store (data must be fresh)
        #   *.html, *.js, /  → no-store (entry points + JS modules — let
        #                      code changes propagate without browser cache
        #                      games; payloads are tiny anyway)
        #   *.css, images    → max-age=3600 (rarely change, save tunnel bw)
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/") or path.endswith(".html") or path.endswith(".js") or path == "/":
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
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
        logger.info("%s - %s", self.address_string(), fmt % args)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving health dashboard at http://localhost:{PORT}")
    server.serve_forever()
