"""
tv_telnet.py — Root shell access to the LG TV over Telnet (port 23).

Why this exists: SSH access documented in earlier notes (port 9922) was
wrong — the real Homebrew Channel dropbear binds plain port 22, and even
that requires either the "alpine" default password (only active when
/home/root/.ssh/authorized_keys doesn't exist) or a provisioned key. Root
telnet on port 23 is enabled by default by HBC's own startup.sh unless a
/var/luna/preferences/webosbrew_telnet_disabled flag exists, and drops
straight into a root shell with NO login prompt at all. That's what this
wraps.

Usage:
    python -I tv_telnet.py          # runs the __main__ recon block below
    from tv_telnet import TVShell   # or import and drive it yourself

Note: uses the stdlib `telnetlib`, deprecated since Python 3.11 and removed
in 3.13 — it correctly handles Telnet IAC option negotiation, which a raw
socket does not (a raw-socket version of this was tried first and produced
badly desynced output). If telnetlib is gone, reimplement IAC handling by
hand or use `telnetlib3` from PyPI.

Always batch multiple commands into ONE call to .run() (join with \\n)
rather than many small round trips — this device's telnet responses have
enough latency that many sequential small reads tend to desync/lag by one
command.
"""
import telnetlib
import time
import base64

HOST = "PASTE_TV_IP"
PORT = 23


class TVShell:
    def __init__(self, host=HOST, port=PORT, timeout=10):
        self.tn = telnetlib.Telnet(host, port, timeout=timeout)
        self.tn.read_until(b"# ", timeout=8)

    def run(self, cmd, timeout=30):
        """Run one or more shell lines (joined with \\n) in a single round trip."""
        marker = "__M%d__" % int(time.time() * 1000)
        self.tn.write((cmd + "\necho " + marker + "\n").encode())
        raw = self.tn.read_until(marker.encode(), timeout=timeout)
        text = raw.decode(errors="replace")
        idx = text.find(marker)
        if idx != -1:
            text = text[:idx]
        return text.strip()

    def upload_text(self, content: str, remote_path: str, chunk_size=700):
        """Write a local string to a file on the TV. Telnet has no file-transfer
        protocol, so this base64-encodes the content and appends it in chunks
        via `echo >> file`, all in one round trip, then decodes server-side."""
        b64 = base64.b64encode(content.encode()).decode()
        tmp = remote_path + ".b64"
        lines = ["rm -f %s %s" % (tmp, remote_path)]
        for i in range(0, len(b64), chunk_size):
            chunk = b64[i:i + chunk_size]
            lines.append("echo '%s' >> %s" % (chunk, tmp))
        lines.append("base64 -d %s > %s && chmod +x %s && rm -f %s" % (tmp, remote_path, remote_path, tmp))
        lines.append("wc -c < %s" % remote_path)
        return self.run("\n".join(lines), timeout=60)

    def close(self):
        try:
            self.tn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sh = TVShell()
    print(sh.run("date; free -m; initctl list | grep -iE 'preload|content'", timeout=20))
    sh.close()
