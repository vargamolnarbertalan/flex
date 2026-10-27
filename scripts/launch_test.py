"""
launch_test.py -- relaunch the already-installed app with debug launch params,
skipping the upload+install step in deploy.py. For iterating on playback
behavior (different ratingKeys, same build) without a 20s+ reinstall each time.

Usage:
    python scripts/launch_test.py <ratingKey>         # jump straight into playback
    python scripts/launch_test.py --show <ratingKey>  # open a show/season's children grid
    python scripts/launch_test.py                     # relaunch with no params (normal boot)
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(__file__))
from tv_telnet import TVShell  # noqa: E402

APP_ID = "com.lgtvtune.plexclient"


def main():
    args = sys.argv[1:]
    if args and args[0] == "--show":
        launch_params = json.dumps({"testOpenShow": args[1]})
    elif args:
        launch_params = json.dumps({"testPlay": args[0]})
    else:
        launch_params = "{}"

    # Deliberately NOT closing the app first: webOS only delivers relaunch
    # params via the webOSRelaunch DOM event to an *already-running* app --
    # a cold launch's initial page load gets neither PalmSystem.launchParams
    # nor a URL query string populated (confirmed empirically on this device).
    sh = TVShell()
    print(sh.run(
        "for i in 1 2 3 4 5; do\n"
        "  out=$(luna-send-pub -n 1 luna://com.webos.applicationManager/launch "
        "'{\"id\":\"%s\",\"params\":%s}')\n"
        "  echo \"$out\"\n"
        "  echo \"$out\" | grep -q 'app is locked' || break\n"
        "  sleep 2\n"
        "done" % (APP_ID, launch_params),
        timeout=30,
    ))
    sh.close()


if __name__ == "__main__":
    main()
