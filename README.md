# Flex

A fast, minimal Plex client for rooted LG webOS TVs, built as a lighter
alternative to the official Plex app on older/underpowered hardware.

Built for and tested on an LG 43UM7000PLA (webOS 4.x), rooted via
[Homebrew Channel](https://www.webosbrew.org/). Should work on other
webOS TVs with the same toolchain, untested elsewhere.

## Why this exists

The official Plex app works correctly on this hardware but is slow and
heavy. This is a from-scratch, vanilla-JS web app with no framework
overhead: browse your libraries, pick something, and the server (not the
client) decides whether to send it as-is or transcode it, so quality stays
as close to the source as your TV can actually handle.

## Features

- Browse movie and TV show libraries, with season/episode drill-down
- Poster grid and two-panel home screen, 5-way D-pad + pointer navigation
- Server-decided Direct Play, with a DASH/fMP4 fallback for anything that
  needs a transcode (no third-party video library -- see `src/player.js`)
- Continue Watching / dashboard visibility via Plex's own timeline API

## Requirements

- A webOS TV rooted with Homebrew Channel (root telnet access)
- A Plex Media Server reachable on the same LAN
- [`@webos-tools/cli`](https://github.com/webosbrew/webOS-TV-cli) for
  `ares-package` (building the `.ipk`)
- Python 3 (for the included deploy scripts)

## Setup

1. **Get a Plex token:**
   ```
   python scripts/get-plex-token.py
   ```
   Follow the sign-in link it prints. This writes `config.local.js` for you.

2. **Point it at your server:** edit `src/config.js`, set `serverUrl` to
   your Plex server's LAN address.

3. **Point the deploy scripts at your TV:** edit `scripts/tv_telnet.py`,
   set `HOST` to your TV's LAN IP.

4. **Build:**
   ```
   ares-package .
   ```

5. **Install + launch:**
   ```
   python scripts/deploy.py
   ```
   This exists instead of `ares-install`/`ares-launch` because this TV's
   dropbear SSH rejects a second exec-channel request per connection --
   `deploy.py` uploads over telnet and installs/launches via the same Luna
   service calls Homebrew Channel itself uses. If your TV doesn't hit that
   issue, the standard `ares-install`/`ares-launch` should also work.

## Known limitations

- A file with Dolby Vision video **and** multiple audio tracks where the
  default-for-you track isn't the container's first one will play, but
  loses HDR: Plex's own server policy forces a full transcode down to SDR
  H.264 for this specific combination, and that's not something a client
  can override. Everything else -- including plain Dolby Vision/HDR10 and
  plain multi-track files -- plays at full quality.
- Built and tested against Chromium 53 (this TV's actual embedded engine,
  webOS 4.x) -- no async/await, no CSS Grid, no modern syntax anywhere in
  `src/`, on purpose.

## License

MIT, see [LICENSE](LICENSE). The bundled `webOSTVjs-1.2.13/` is LG's own
official helper library, under its own Apache 2.0 license (included
unmodified).

---

If this saved you the trouble of debugging webOS yourself, consider buying
me a coffee: https://revolut.me/vargamolnarb
