#!/usr/bin/env python3
"""Minimal HTTP server for the health dashboard."""

import os
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8888
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = "/home/keo/garmin-sync/data/master"

CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def translate_path(self, path):
        # Strip query string and fragment
        path = path.split("?", 1)[0].split("#", 1)[0]

        if path.startswith("/data/"):
            rel = path[len("/data/"):]
            return os.path.join(DATA_DIR, rel)

        return super().translate_path(path)

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
