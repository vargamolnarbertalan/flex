"""
deploy.py -- build, install, and launch the webOS app on the real TV.

Why this exists instead of `ares-install`/`ares-launch`: this TV's dropbear
SSH rejects a second exec-channel request per connection (confirmed via
ares-install's own verbose log + ssh2's source -- see
PLEX-CLIENT-PLAN.md Task 1 and memory/lgtv-ares-install-broken.md). This
script sidesteps SSH entirely: it uploads over the telnet root shell
(already used all session, no auth) and installs/launches via luna-send-pub
against the same Luna services Homebrew Channel itself uses on a
non-Developer-Mode TV.

`ares-package` (pure local, no device I/O) is unaffected and still runs
separately -- see Usage.

Usage:
    ares-package plex-client
    python scripts/deploy.py
"""
import sys
import os
import base64
import json

sys.path.insert(0, os.path.dirname(__file__))
from tv_telnet import TVShell  # noqa: E402

LOCAL_IPK = os.path.join(os.path.dirname(__file__), "..", "com.lgtvtune.plexclient_0.0.1_all.ipk")
REMOTE_IPK = "/tmp/com.lgtvtune.plexclient_0.0.1_all.ipk"
APP_ID = "com.lgtvtune.plexclient"


def main():
    with open(LOCAL_IPK, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode()

    chunk = 700
    lines = ["rm -f %s.b64 %s" % (REMOTE_IPK, REMOTE_IPK)]
    for i in range(0, len(b64), chunk):
        lines.append("echo '%s' >> %s.b64" % (b64[i:i + chunk], REMOTE_IPK))
    lines.append("base64 -d %s.b64 > %s && rm -f %s.b64" % (REMOTE_IPK, REMOTE_IPK, REMOTE_IPK))
    lines.append("wc -c < %s" % REMOTE_IPK)

    sh = TVShell()
    print("--- upload (expect byte count = %d) ---" % len(raw))
    print(sh.run("\n".join(lines), timeout=60))

    install_cmd = (
        "luna-send-pub -n 1 -f luna://com.webos.appInstallService/dev/install "
        + "'" + json.dumps({"id": APP_ID, "ipkUrl": REMOTE_IPK, "subscribe": True}) + "'"
    )
    print("--- install (overwrite) ---")
    print(sh.run(install_cmd, timeout=30))

    # The install call returning success doesn't mean the system has finished
    # settling it -- launching immediately after can hit {"errorCode":-102,
    # "errorText":"app is locked"}. Retry on that specific error rather than
    # guess at a fixed delay that's either too short (still races) or wastes
    # time on every normal run.
    print("--- close if running, then launch (retries on 'app is locked') ---")
    print(sh.run(
        "luna-send-pub -n 1 luna://com.webos.applicationManager/closeByAppId "
        "'{\"id\":\"%s\"}' >/dev/null 2>&1\n"
        "sleep 1\n"
        "for i in 1 2 3 4 5; do\n"
        "  out=$(luna-send-pub -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"%s\"}')\n"
        "  echo \"$out\"\n"
        "  echo \"$out\" | grep -q 'app is locked' || break\n"
        "  sleep 2\n"
        "done" % (APP_ID, APP_ID),
        timeout=30,
    ))
    sh.close()


if __name__ == "__main__":
    main()
