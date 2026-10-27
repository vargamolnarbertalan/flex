// Playback screen. Written for this TV's Chromium 53: no async/await, no
// AbortController, no arrow functions assumed critical (ES5 throughout to
// match the rest of this project, even though Chromium 53 itself supports
// more -- consistency over cleverness).
(function () {
  'use strict';

  // Dev-only diagnostic channel: a fire-and-forget beacon to a throwaway
  // local HTTP listener (scripts/devlog_server.py) on the dev PC, so player
  // behavior can be confirmed without a TV screenshot (compositor screenshot
  // capture was flagged by the coding agent's own safety classifier earlier
  // in this project as surveillance-shaped -- this avoids that path entirely:
  // it's our own app calling home with its own playback diagnostics, nothing
  // captured from the device). Harmless if the listener isn't running --
  // fetch() failures are swallowed. Safe to leave in during development;
  // should be removed or gated behind a debug flag before Task 11 packaging.
  var DEVLOG_URL = 'http://PASTE_DEV_PC_IP:8791/log';
  function devlog(event, data) {
    try {
      var qs = new URLSearchParams();
      qs.set('event', event);
      Object.keys(data || {}).forEach(function (k) {
        var v = data[k];
        qs.set(k, v === null || v === undefined ? '' : String(v));
      });
      fetch(DEVLOG_URL + '?' + qs.toString()).catch(function () {});
    } catch (e) { /* devlog must never break playback */ }
  }

  var videoEl = null;
  var dashMediaSource = null;
  var dashObjectUrl = null;
  var dashTracks = null;
  var listeners = [];

  function onEvent(cb) { listeners.push(cb); }
  function emit(evt, info) {
    listeners.forEach(function (cb) {
      try { cb(evt, info); } catch (e) {}
    });
  }

  function getCurrentTime() { return videoEl ? videoEl.currentTime * 1000 : 0; }
  function getDuration() { return videoEl ? videoEl.duration * 1000 : 0; }

  function ensureVideoEl() {
    if (videoEl) return videoEl;
    videoEl = document.createElement('video');
    videoEl.id = 'player';
    videoEl.style.position = 'fixed';
    videoEl.style.top = '0';
    videoEl.style.left = '0';
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.style.background = '#000';
    videoEl.style.display = 'none';
    videoEl.setAttribute('playsinline', 'true');
    document.body.appendChild(videoEl);

    ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'error', 'ended']
      .forEach(function (evt) {
        videoEl.addEventListener(evt, function () {
          var info = {
            readyState: videoEl.readyState,
            networkState: videoEl.networkState,
            videoWidth: videoEl.videoWidth,
            videoHeight: videoEl.videoHeight,
            currentTime: videoEl.currentTime
          };
          if (evt === 'error' && videoEl.error) {
            info.errorCode = videoEl.error.code;
            info.errorMessage = videoEl.error.message || '';
          }
          devlog('video:' + evt, info);
          emit(evt, info);
        });
      });
    return videoEl;
  }

  // ---- Direct Play: hand the browser the original file, untouched ----

  function playDirectUrl(url, label) {
    var v = ensureVideoEl();
    teardownDash();
    v.style.display = 'block';
    devlog('play:direct:start', { label: label, url: url });
    v.src = url;
    v.load();
    var p = v.play();
    if (p && p.catch) {
      p.catch(function (err) {
        devlog('play:direct:play-rejected', { label: label, message: err && err.message });
      });
    }
  }

  // ---- Direct Stream / Transcode fallback: DASH, fed to MSE by hand ----
  // Found 2026-10-27, replacing an hls.js/HLS(TS) approach that never worked
  // for any file whose audio needed a transcode or an eac3/ac3 copy (see
  // [[lgtv-plex-hls-ts-vs-dash]]): this device's MSE reported an empty audio
  // codec for every TS-demuxed stream hls.js produced, no matter the codec.
  // DASH's fMP4 (ISOBMFF) segments carry the codec in the init segment's own
  // moov/stsd box instead of inferring it from a TS stream_type byte, which
  // sidesteps the problem outright -- confirmed by mitm-ing Plex's own Web
  // client, which uses exactly this (protocol=dash, manual segment fetch),
  // not hls.js or dash.js. No third-party library needed: Plex's MPD here is
  // always one Representation per AdaptationSet (no ABR ladder to pick from)
  // and segments are a plain, predictable numeric sequence
  // (session/<id>/<repId>/header, then .../0.m4s, .../1.m4s, ...), so a
  // manifest-aware fetch-and-appendBuffer loop is simpler and more auditable
  // than vendoring a general-purpose DASH player for one narrow use case.

  function teardownDash() {
    dashTracks = null;
    if (dashMediaSource) {
      try { if (dashMediaSource.readyState === 'open') dashMediaSource.endOfStream(); } catch (e) {}
      dashMediaSource = null;
    }
    if (dashObjectUrl) {
      try { URL.revokeObjectURL(dashObjectUrl); } catch (e) {}
      dashObjectUrl = null;
    }
  }

  // Attribute order isn't assumed -- each is matched independently inside
  // the captured tag -- so this survives PMS changing the order it writes
  // them in, only the attribute names matter.
  function parseMpdRepresentations(xmlText) {
    var reps = [];
    var tagRegex = /<Representation\b([^>]*)\/?>/g;
    var m;
    while ((m = tagRegex.exec(xmlText))) {
      var attrs = m[1];
      var id = /\bid="([^"]*)"/.exec(attrs);
      var mimeType = /\bmimeType="([^"]*)"/.exec(attrs);
      var codecs = /\bcodecs="([^"]*)"/.exec(attrs);
      if (id && mimeType && codecs) {
        reps.push({ id: id[1], mimeType: mimeType[1], codecs: codecs[1] });
      }
    }
    return reps;
  }

  function playDash(mpdUrl, segmentBaseUrl, label) {
    var v = ensureVideoEl();
    teardownDash();
    v.style.display = 'block';
    devlog('play:dash:start', { label: label, url: mpdUrl });

    withTimeoutFetch(mpdUrl, 8000).then(function (res) {
      if (!res.ok) throw new Error('mpd http ' + res.status);
      return res.text();
    }).then(function (xml) {
      var reps = parseMpdRepresentations(xml);
      var videoRep = null, audioRep = null;
      reps.forEach(function (r) {
        if (!videoRep && r.mimeType.indexOf('video/') === 0) videoRep = r;
        else if (!audioRep && r.mimeType.indexOf('audio/') === 0) audioRep = r;
      });
      if (!videoRep || !audioRep) {
        devlog('dash:no-representations', { label: label, count: reps.length });
        emit('error', { reason: 'dash-no-representations' });
        return;
      }
      devlog('dash:representations', { label: label, video: videoRep.codecs, audio: audioRep.codecs });
      startDashPlayback(v, segmentBaseUrl, videoRep, audioRep, label);
    }).catch(function (err) {
      devlog('dash:mpd-failed', { label: label, message: err && err.message });
      emit('error', { reason: 'dash-mpd-failed' });
    });
  }

  // A fetch with no timeout can hang forever on a dead server; reuses the
  // same race-a-timer approach as plex-api.js (no AbortController on this
  // Chromium), duplicated locally so player.js stays independent of it.
  function withTimeoutFetch(url, ms) {
    var timer = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, ms);
    });
    return Promise.race([fetch(url), timer]);
  }

  function startDashPlayback(v, segmentBaseUrl, videoRep, audioRep, label) {
    var videoMime = 'video/mp4; codecs="' + videoRep.codecs + '"';
    var audioMime = 'audio/mp4; codecs="' + audioRep.codecs + '"';
    if (!window.MediaSource || !MediaSource.isTypeSupported(videoMime) || !MediaSource.isTypeSupported(audioMime)) {
      devlog('dash:unsupported-mime', { label: label, videoMime: videoMime, audioMime: audioMime });
      emit('error', { reason: 'dash-unsupported-mime' });
      return;
    }

    var ms = new MediaSource();
    dashMediaSource = ms;
    dashObjectUrl = URL.createObjectURL(ms);
    v.src = dashObjectUrl;

    ms.addEventListener('sourceopen', function onOpen() {
      ms.removeEventListener('sourceopen', onOpen);
      var videoBuf, audioBuf;
      try {
        videoBuf = ms.addSourceBuffer(videoMime);
        audioBuf = ms.addSourceBuffer(audioMime);
      } catch (e) {
        devlog('dash:add-source-buffer-failed', { label: label, message: e.message });
        emit('error', { reason: 'dash-add-source-buffer-failed' });
        return;
      }
      dashTracks = [
        { buf: videoBuf, rep: videoRep, nextSegment: 0, ended: false, retried: false },
        { buf: audioBuf, rep: audioRep, nextSegment: 0, ended: false, retried: false }
      ];
      dashTracks.forEach(function (track) { loadInit(track); });
    });
    v.load();
    var p = v.play();
    if (p && p.catch) {
      p.catch(function (err) { devlog('play:dash:play-rejected', { label: label, message: err && err.message }); });
    }

    function segUrl(track, part) {
      return segmentBaseUrl + track.rep.id + '/' + part;
    }

    function loadInit(track) {
      withTimeoutFetch(segUrl(track, 'header'), 8000).then(function (res) {
        if (!res.ok) throw new Error('init http ' + res.status);
        return res.arrayBuffer();
      }).then(function (buf) {
        appendThenContinue(track, buf);
      }).catch(function (err) {
        devlog('dash:init-failed', { label: label, id: track.rep.id, message: err && err.message });
        emit('error', { reason: 'dash-init-failed' });
      });
    }

    function appendThenContinue(track, buf) {
      if (dashTracks === null) return; // torn down mid-flight
      track.buf.addEventListener('updateend', function onDone() {
        track.buf.removeEventListener('updateend', onDone);
        fetchNextSegment(track);
      });
      try {
        track.buf.appendBuffer(buf);
      } catch (e) {
        devlog('dash:append-failed', { label: label, id: track.rep.id, message: e.message });
        emit('error', { reason: 'dash-append-failed' });
      }
    }

    function fetchNextSegment(track) {
      if (dashTracks === null || track.ended) return;
      // Simple backpressure: a movie-length file fetched with no limit would
      // sit entirely in memory ahead of playback. 30s/segment-count is a
      // generous cushion for smooth playback without that.
      var aheadSeconds = 0;
      try {
        var r = track.buf.buffered;
        if (r.length) aheadSeconds = r.end(r.length - 1) - v.currentTime;
      } catch (e) {}
      if (aheadSeconds > 30) {
        setTimeout(function () { fetchNextSegment(track); }, 1000);
        return;
      }
      var n = track.nextSegment++;
      withTimeoutFetch(segUrl(track, n + '.m4s'), 8000).then(function (res) {
        if (res.status === 404) { track.ended = true; maybeEndStream(); return null; }
        if (!res.ok) throw new Error('segment http ' + res.status);
        track.retried = false;
        return res.arrayBuffer();
      }).then(function (buf) {
        if (buf) appendThenContinue(track, buf);
      }).catch(function (err) {
        // One retry for a transient LAN blip (seen in practice: fragLoadError-
        // style repeated failures on an otherwise-fine file) before giving up.
        if (!track.retried) {
          track.retried = true;
          track.nextSegment = n;
          devlog('dash:segment-retry', { label: label, id: track.rep.id, n: n, message: err && err.message });
          setTimeout(function () { fetchNextSegment(track); }, 1000);
          return;
        }
        devlog('dash:segment-failed', { label: label, id: track.rep.id, n: n, message: err && err.message });
        emit('error', { reason: 'dash-segment-failed' });
      });
    }

    function maybeEndStream() {
      if (!dashTracks || !dashTracks.every(function (t) { return t.ended; })) return;
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch (e) {}
      devlog('dash:end-of-stream', { label: label });
    }
  }

  function stop() {
    teardownDash();
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      try { videoEl.load(); } catch (e) {}
      videoEl.style.display = 'none';
    }
  }

  window.PlexPlayer = {
    playDirectUrl: playDirectUrl,
    playDash: playDash,
    stop: stop,
    devlog: devlog,
    onEvent: onEvent,
    getCurrentTime: getCurrentTime,
    getDuration: getDuration
  };
})();
