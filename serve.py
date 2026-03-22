#!/usr/bin/env python3
"""Health dashboard server — queries SQLite databases directly."""

import json
import os
import sqlite3
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
        "SELECT day as date, neck, waist, stomach, hips, chest FROM measurements ORDER BY day")


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


API_ROUTES = {
    "/api/weight": api_weight,
    "/api/bodyfat": api_bodyfat,
    "/api/measurements": api_measurements,
    "/api/rhr": api_rhr,
    "/api/hrv": api_hrv,
    "/api/activities": api_activities,
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
