#!/usr/bin/env python3
"""
Stands in for an attacker's collection server.

Run it, then load the demo page: anything a widget manages to send off-machine
shows up here. This is the ground truth for "did data actually leave?" — far
more honest than asking the page whether it thinks it was blocked.

    python3 demo/exfil-listener.py
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, unquote
import datetime
import sys

PORT = 9999


class Handler(BaseHTTPRequestHandler):
    def _record(self):
        query = unquote(urlparse(self.path).query)
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        print(f"\033[31m[{stamp}] STOLEN DATA RECEIVED\033[0m  {query}", flush=True)

    def _respond(self):
        self.send_response(200)
        # The attacker sets this so the widget can also READ the reply. Note it
        # is not needed for the theft: without it the request still arrives here,
        # CORS only stops the widget from reading the response.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        self._record()
        self._respond()

    def do_POST(self):
        self._record()
        self._respond()

    def log_message(self, *args):
        pass  # silence the default one-line-per-request noise


if __name__ == "__main__":
    print(f"attacker's listener on http://127.0.0.1:{PORT} — waiting for loot", file=sys.stderr)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
