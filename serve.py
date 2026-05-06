#!/usr/bin/env python3
"""Health dashboard server — queries SQLite databases directly."""

import json
import os
import sqlite3
import subprocess
from datetime import datetime, timedelta
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8888
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
GARMIN_DB = os.path.expanduser("~/HealthData/DBs/garmin.db")

CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}

# API route handlers
def query_db(db_path, sql, params=()):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def api_weight():
    return query_db(GARMIN_DB, "SELECT day as date, weight FROM weight ORDER BY day")


def api_bodyfat():
    return query_db(GARMIN_DB, "SELECT day as date, bodyfat FROM body_fat ORDER BY day")


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


def api_zone_minutes():
    """Bin per-second HR samples from strava_streams into Z1-Z5 minutes per week."""
    streams_dir = os.path.expanduser("~/garmin-sync/data/master/strava_streams")
    activities_path = os.path.expanduser("~/garmin-sync/data/master/strava_activities.json")

    # Cache invalidates when either the activities file or streams dir mtime changes
    sig = max(os.path.getmtime(activities_path), os.path.getmtime(streams_dir))
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
    _zone_cache["mtime"] = sig
    _zone_cache["data"] = result
    return result


def api_hr_recovery():
    path = os.path.expanduser("~/garmin-sync/data/master/hr_recovery.json")
    with open(path) as f:
        rows = json.load(f)
    return [
        {"date": r["date"], "recovery": r["avg_recovery_60s"], "name": r.get("name", "")}
        for r in rows
        if r.get("avg_recovery_60s") is not None
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


API_ROUTES = {
    "/api/weight": api_weight,
    "/api/bodyfat": api_bodyfat,
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
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(body))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(body))
                self.end_headers()
                self.wfile.write(body)
            return

        super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return CONTENT_TYPES.get(ext, "application/octet-stream")

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving health dashboard at http://localhost:{PORT}")
    server.serve_forever()
