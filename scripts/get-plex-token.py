#!/usr/bin/env python3
"""
get-plex-token.py -- one-time helper to obtain a persistent Plex X-Plex-Token
for the webOS Plex client, via Plex's documented device-linking PIN flow, and
write it where the app loads it: plex-client/config.local.js.

Why not the "sign in to Plex Web, view a library item's XML, read the token
from the URL" trick: Plex's own support article says that method returns a
TEMPORARY token and explicitly tells app/tool authors to use this PIN flow
instead. See:
  https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/
  https://forums.plex.tv/t/authenticating-with-plex/609370

Usage:
    python scripts/get-plex-token.py

Re-running it mints a fresh token and replaces the file -- the recovery path if
the old token is ever revoked (e.g. by a password change with "sign out
connected devices").

No third-party dependencies -- stdlib only (urllib), matching tv_telnet.py.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

PRODUCT = "lgtv-tune-plex-client"
CLIENT_ID = str(uuid.uuid4())
BASE_HEADERS = {
    "Accept": "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Client-Identifier": CLIENT_ID,
}
SECRETS_FILE = Path(__file__).resolve().parent.parent / "plex-client" / "config.local.js"


def request(method, url, data=None, extra_headers=None):
    headers = dict(BASE_HEADERS, **(extra_headers or {}))
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode())


def write_app_secrets(token):
    SECRETS_FILE.write_text(
        "// Written by scripts/get-plex-token.py. Holds the account token: keep it out\n"
        "// of anything you share or commit.\n"
        "window.PLEX_SECRETS = {\n"
        f"  token: {json.dumps(token)},\n"
        f"  clientId: {json.dumps(CLIENT_ID)}\n"
        "};\n",
        encoding="utf-8",
    )


def main():
    print(f"Client identifier: {CLIENT_ID}\n", flush=True)

    _, pin = request("POST", "https://plex.tv/api/v2/pins", data={"strong": "true"})
    pin_id, code = pin["id"], pin["code"]

    auth_params = urllib.parse.urlencode(
        {"clientID": CLIENT_ID, "code": code, "context[device][product]": PRODUCT}
    )
    print("Open this URL on your phone or any browser, sign in, and approve:\n", flush=True)
    print(f"  https://app.plex.tv/auth#?{auth_params}\n", flush=True)
    print(f"Waiting for approval (PIN expires in {pin['expiresIn']} sec)...", flush=True)

    poll_qs = urllib.parse.urlencode({"code": code})
    poll_url = f"https://plex.tv/api/v2/pins/{pin_id}?{poll_qs}"
    deadline = time.time() + pin["expiresIn"] - 60  # safety margin
    token = None
    while time.time() < deadline:
        try:
            _, result = request("GET", poll_url)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                # Rate-limited -- back off and keep waiting rather than crash.
                wait = int(e.headers.get("Retry-After", 10))
                time.sleep(wait)
                continue
            raise
        if result.get("authToken"):
            token = result["authToken"]
            break
        time.sleep(3)

    if not token:
        print("Timed out waiting for sign-in. Re-run the script and try again.")
        return

    # Verify it actually works before declaring success -- don't hand back
    # a token that merely looks right.
    status, _ = request(
        "GET", "https://plex.tv/api/v2/user", extra_headers={"X-Plex-Token": token}
    )
    if status != 200:
        print(f"Got a token but verification returned HTTP {status} -- something's off.")
        return

    write_app_secrets(token)
    print("Success -- verified working token.")
    print(f"Wrote it, with the client identifier, to {SECRETS_FILE}")
    print("The build packs that file into the .ipk; keep it out of anything you share.")


if __name__ == "__main__":
    main()
