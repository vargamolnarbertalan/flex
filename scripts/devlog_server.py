"""
devlog_server.py -- tiny local HTTP listener so the TV app can report diagnostic
events back to this PC during development, without needing a TV screenshot.

Why this exists: this project's own safety policy flags compositor-screenshot
capture over telnet as device surveillance (see memory/lgtv-tune-plex-client.md),
so visual confirmation has always gone through the user reading the screen. For
autonomous testing we need a different channel: the webOS app does a
fire-and-forget fetch() to this server with event data in the query string, and
this server just logs it. Nothing here touches the TV's camera, screen, or any
personal data -- it's a one-line HTTP access log for an app we wrote ourselves.

Usage:
    python scripts/devlog_server.py [port]      # default port 8787
Logs to stdout and to devlog.jsonl next to this script.
"""
import sys
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
LOG_PATH = os.path.join(os.path.dirname(__file__), "devlog.jsonl")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        record = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "path": parsed.path, **qs}
        line = json.dumps(record)
        print(line, flush=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, fmt, *args):
        pass  # keep stdout clean -- do_GET already prints structured lines


if __name__ == "__main__":
    if os.path.exists(LOG_PATH):
        os.remove(LOG_PATH)
    print("devlog server listening on 0.0.0.0:%d, logging to %s" % (PORT, LOG_PATH))
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
