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
  var dashSegmentSeconds = 3; // overwritten by the real MPD value once parsed
  var dashSegmentBaseUrl = null;
  var dashLabel = null;
  var dashSeekGeneration = 0; // bumped on every seek; in-flight fetches from
    // before a seek check this and silently drop their result instead of
    // appending stale data at the wrong position once they resolve.
  var dashPendingSeekTarget = null; // absolute content-seconds to seek
    // videoEl.currentTime to once real data for it exists. Confirmed on real
    // hardware (buffered-range devlog instrumentation): Plex's segments ARE
    // timestamped with the true absolute position (requesting "segment 634"
    // really does buffer content at ~634-635s, no -start_at_zero rebasing
    // despite that flag appearing in the transcoder's own command line --
    // an earlier theory here, wrong, left as a lesson in
    // [[lgtv-plex-hls-ts-vs-dash]]). The actual bug: setting
    // videoEl.currentTime while the SourceBuffers are still empty (no data
    // buffered anywhere yet) gets silently clamped back to 0 -- there's no
    // seekable range at all yet to seek within. Deferring the assignment
    // until after real (non-init) data has landed for every track fixes it.
  var knownDurationMs = 0; // Plex's own reported duration, passed in by the
    // caller -- used as a fallback when the <video> element's own .duration
    // isn't trustworthy yet (MSE reports it based on what's buffered so far,
    // not the true total, until the last segment is appended).
  var listeners = [];

  var overlayEl = null, overlayTimeEl = null, overlayFillEl = null;
  var hideControlsTimer = null;

  function onEvent(cb) { listeners.push(cb); }
  function emit(evt, info) {
    listeners.forEach(function (cb) {
      try { cb(evt, info); } catch (e) {}
    });
  }

  function getCurrentTime() { return videoEl ? videoEl.currentTime * 1000 : 0; }
  function getDuration() {
    var fromVideo = videoEl ? videoEl.duration * 1000 : 0;
    if (fromVideo && isFinite(fromVideo)) return fromVideo;
    return knownDurationMs;
  }

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

    ensureOverlay();
    return videoEl;
  }

  // ---- On-screen controls: time/progress only, shown briefly on input ----
  // No third-party UI library -- a couple of divs, matching the rest of this
  // app's plain-DOM approach. Driven by the video element's own native
  // `timeupdate` event rather than a manual poll, so it tracks playback,
  // pausing, and seeking for free with no extra timer.

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'player-overlay';
    overlayEl.className = 'player-overlay';

    overlayTimeEl = document.createElement('div');
    overlayTimeEl.className = 'player-overlay__time';
    overlayEl.appendChild(overlayTimeEl);

    var barOuter = document.createElement('div');
    barOuter.className = 'player-overlay__bar';
    overlayFillEl = document.createElement('div');
    overlayFillEl.className = 'player-overlay__bar-fill';
    barOuter.appendChild(overlayFillEl);
    overlayEl.appendChild(barOuter);

    document.body.appendChild(overlayEl);
    videoEl.addEventListener('timeupdate', updateOverlay);
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    seconds = Math.floor(seconds);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var mm = (h > 0 && m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? (h + ':' + mm + ':' + ss) : (m + ':' + ss);
  }

  function updateOverlay() {
    if (!overlayEl || !videoEl) return;
    var current = getCurrentTime() / 1000;
    var duration = getDuration() / 1000;
    overlayTimeEl.textContent = formatTime(current) + ' / ' + formatTime(duration);
    var pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
    overlayFillEl.style.width = pct + '%';
  }

  function showControls() {
    if (!overlayEl) return;
    updateOverlay();
    overlayEl.classList.add('visible');
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
    hideControlsTimer = setTimeout(function () {
      if (overlayEl) overlayEl.classList.remove('visible');
    }, 4000);
  }

  function hideControlsNow() {
    if (hideControlsTimer) { clearTimeout(hideControlsTimer); hideControlsTimer = null; }
    if (overlayEl) overlayEl.classList.remove('visible');
  }

  // ---- Direct Play: hand the browser the original file, untouched ----

  function playDirectUrl(url, label, startAtSeconds, durationMs) {
    var v = ensureVideoEl();
    teardownDash();
    knownDurationMs = durationMs || 0;
    v.style.display = 'block';
    devlog('play:direct:start', { label: label, url: url, startAtSeconds: startAtSeconds || 0 });
    v.src = url;
    if (startAtSeconds) {
      v.addEventListener('loadedmetadata', function onMeta() {
        v.removeEventListener('loadedmetadata', onMeta);
        v.currentTime = startAtSeconds;
      });
    }
    v.load();
    var p = v.play();
    if (p && p.catch) {
      p.catch(function (err) {
        devlog('play:direct:play-rejected', { label: label, message: err && err.message });
      });
    }
    showControls();
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
    dashPendingSeekTarget = null;
    dashSeekGeneration++;
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

  // <SegmentTemplate timescale="1" duration="3" .../> -- segment length in
  // seconds is duration/timescale. Needed for seeking (target segment index
  // = floor(targetSeconds / segmentSeconds)); defaults to 3 (the value seen
  // on every file tested so far) if parsing ever fails, rather than crashing.
  function parseMpdSegmentSeconds(xmlText) {
    var m = /<SegmentTemplate\b([^>]*)>/.exec(xmlText);
    if (!m) return 3;
    var duration = /\bduration="([^"]*)"/.exec(m[1]);
    var timescale = /\btimescale="([^"]*)"/.exec(m[1]);
    var d = duration ? parseFloat(duration[1]) : 3;
    var t = timescale ? parseFloat(timescale[1]) : 1;
    return (d > 0 && t > 0) ? (d / t) : 3;
  }

  function playDash(mpdUrl, segmentBaseUrl, label, startAtSeconds, durationMs) {
    var v = ensureVideoEl();
    teardownDash();
    knownDurationMs = durationMs || 0;
    dashSegmentBaseUrl = segmentBaseUrl;
    dashLabel = label;
    v.style.display = 'block';
    devlog('play:dash:start', { label: label, url: mpdUrl, startAtSeconds: startAtSeconds || 0 });

    withTimeoutFetch(mpdUrl, 8000).then(function (res) {
      if (!res.ok) throw new Error('mpd http ' + res.status);
      return res.text();
    }).then(function (xml) {
      var reps = parseMpdRepresentations(xml);
      dashSegmentSeconds = parseMpdSegmentSeconds(xml);
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
      devlog('dash:representations', { label: label, video: videoRep.codecs, audio: audioRep.codecs, segmentSeconds: dashSegmentSeconds });
      startDashPlayback(videoRep, audioRep, startAtSeconds || 0);
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

  function dashSegUrl(track, part) {
    return dashSegmentBaseUrl + track.rep.id + '/' + part;
  }

  function dashLoadInit(track, generation) {
    devlog('dash:init-fetch', { label: dashLabel, id: track.rep.id, url: dashSegUrl(track, 'header') });
    withTimeoutFetch(dashSegUrl(track, 'header'), 8000).then(function (res) {
      if (!res.ok) throw new Error('init http ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      if (generation !== dashSeekGeneration) return;
      devlog('dash:init-fetched', { label: dashLabel, id: track.rep.id, bytes: buf.byteLength });
      dashAppendThenContinue(track, buf, generation, 'init');
    }).catch(function (err) {
      if (generation !== dashSeekGeneration) return;
      devlog('dash:init-failed', { label: dashLabel, id: track.rep.id, message: err && err.message });
      emit('error', { reason: 'dash-init-failed' });
    });
  }

  function dashAppendThenContinue(track, buf, generation, kind) {
    if (dashTracks === null || generation !== dashSeekGeneration) return;
    track.buf.addEventListener('updateend', function onDone() {
      track.buf.removeEventListener('updateend', onDone);
      if (generation !== dashSeekGeneration) return;
      var bufferedDesc = '';
      try {
        var r = track.buf.buffered;
        for (var i = 0; i < r.length; i++) bufferedDesc += '[' + r.start(i) + '-' + r.end(i) + ']';
      } catch (e) { bufferedDesc = 'err:' + e.message; }
      devlog('dash:appended', {
        label: dashLabel, id: track.rep.id, kind: kind, buffered: bufferedDesc,
        videoCurrentTime: videoEl.currentTime, videoReadyState: videoEl.readyState
      });
      if (kind !== 'init') {
        track.gotFirstData = true;
        if (dashPendingSeekTarget !== null && dashTracks.every(function (t) { return t.gotFirstData; })) {
          var target = dashPendingSeekTarget;
          dashPendingSeekTarget = null;
          devlog('dash:apply-pending-seek', { label: dashLabel, target: target });
          videoEl.currentTime = target;
        }
      }
      dashFetchNextSegment(track, generation);
    });
    try {
      track.buf.appendBuffer(buf);
    } catch (e) {
      devlog('dash:append-failed', { label: dashLabel, id: track.rep.id, kind: kind, message: e.message });
      emit('error', { reason: 'dash-append-failed' });
    }
  }

  function dashFetchNextSegment(track, generation) {
    if (dashTracks === null || track.ended || generation !== dashSeekGeneration) return;
    // Simple backpressure: a movie-length file fetched with no limit would
    // sit entirely in memory ahead of playback. 30s/segment-count is a
    // generous cushion for smooth playback without that.
    var aheadSeconds = 0;
    try {
      var r = track.buf.buffered;
      if (r.length) aheadSeconds = r.end(r.length - 1) - videoEl.currentTime;
    } catch (e) {}
    if (aheadSeconds > 30) {
      setTimeout(function () { dashFetchNextSegment(track, generation); }, 1000);
      return;
    }
    var n = track.nextSegment++;
    devlog('dash:segment-fetch', { label: dashLabel, id: track.rep.id, n: n, url: dashSegUrl(track, n + '.m4s') });
    withTimeoutFetch(dashSegUrl(track, n + '.m4s'), 8000).then(function (res) {
      if (res.status === 404) { track.ended = true; dashMaybeEndStream(); return null; }
      if (!res.ok) throw new Error('segment http ' + res.status);
      track.retried = false;
      return res.arrayBuffer();
    }).then(function (buf) {
      if (generation !== dashSeekGeneration) return;
      if (buf) {
        devlog('dash:segment-fetched', { label: dashLabel, id: track.rep.id, n: n, bytes: buf.byteLength });
        dashAppendThenContinue(track, buf, generation, 'seg' + n);
      }
    }).catch(function (err) {
      if (generation !== dashSeekGeneration) return;
      // One retry for a transient LAN blip (seen in practice: fragLoadError-
      // style repeated failures on an otherwise-fine file) before giving up.
      if (!track.retried) {
        track.retried = true;
        track.nextSegment = n;
        devlog('dash:segment-retry', { label: dashLabel, id: track.rep.id, n: n, message: err && err.message });
        setTimeout(function () { dashFetchNextSegment(track, generation); }, 1000);
        return;
      }
      devlog('dash:segment-failed', { label: dashLabel, id: track.rep.id, n: n, message: err && err.message });
      emit('error', { reason: 'dash-segment-failed' });
    });
  }

  function dashMaybeEndStream() {
    if (!dashTracks || !dashTracks.every(function (t) { return t.ended; })) return;
    try { if (dashMediaSource && dashMediaSource.readyState === 'open') dashMediaSource.endOfStream(); } catch (e) {}
    devlog('dash:end-of-stream', { label: dashLabel });
  }

  function startDashPlayback(videoRep, audioRep, startAtSeconds) {
    var v = videoEl;
    var videoMime = 'video/mp4; codecs="' + videoRep.codecs + '"';
    var audioMime = 'audio/mp4; codecs="' + audioRep.codecs + '"';
    if (!window.MediaSource || !MediaSource.isTypeSupported(videoMime) || !MediaSource.isTypeSupported(audioMime)) {
      devlog('dash:unsupported-mime', { label: dashLabel, videoMime: videoMime, audioMime: audioMime });
      emit('error', { reason: 'dash-unsupported-mime' });
      return;
    }

    var generation = dashSeekGeneration;
    var ms = new MediaSource();
    dashMediaSource = ms;
    dashObjectUrl = URL.createObjectURL(ms);
    v.src = dashObjectUrl;

    var startSegment = Math.max(0, Math.floor(startAtSeconds / dashSegmentSeconds));
    dashPendingSeekTarget = startAtSeconds > 0 ? startAtSeconds : null;

    ms.addEventListener('sourceopen', function onOpen() {
      ms.removeEventListener('sourceopen', onOpen);
      if (generation !== dashSeekGeneration) return; // torn down before this fired
      var videoBuf, audioBuf;
      try {
        videoBuf = ms.addSourceBuffer(videoMime);
        audioBuf = ms.addSourceBuffer(audioMime);
      } catch (e) {
        devlog('dash:add-source-buffer-failed', { label: dashLabel, message: e.message });
        emit('error', { reason: 'dash-add-source-buffer-failed' });
        return;
      }
      dashTracks = [
        { buf: videoBuf, rep: videoRep, nextSegment: startSegment, ended: false, retried: false, gotFirstData: false },
        { buf: audioBuf, rep: audioRep, nextSegment: startSegment, ended: false, retried: false, gotFirstData: false }
      ];
      dashTracks.forEach(function (track) { dashLoadInit(track, generation); });
    });
    v.load();
    var p = v.play();
    if (p && p.catch) {
      p.catch(function (err) { devlog('play:dash:play-rejected', { label: dashLabel, message: err && err.message }); });
    }
    showControls();
  }

  // Random-access seek: bump the generation (so any in-flight fetch/append
  // from before this point silently drops its result instead of landing at
  // the wrong position once it resolves -- this device has no
  // AbortController to cancel the underlying fetch outright), clear each
  // track's buffered data, and resume fetching from the segment index
  // covering the new target time. DASH's SourceBuffer "segments" mode (the
  // default, left untouched) places each appended segment according to its
  // own embedded timestamp, not append order, so jumping straight to an
  // arbitrary segment number is enough -- no special-casing needed beyond
  // that for this to land in the right place.
  function seekDash(targetSeconds) {
    if (!dashTracks) return;
    dashSeekGeneration++;
    var generation = dashSeekGeneration;
    var targetSegment = Math.floor(targetSeconds / dashSegmentSeconds);
    dashPendingSeekTarget = targetSeconds;
    devlog('dash:seek', { label: dashLabel, targetSeconds: targetSeconds, targetSegment: targetSegment });
    dashTracks.forEach(function (track) {
      track.ended = false;
      track.retried = false;
      track.nextSegment = targetSegment;
      track.gotFirstData = false; // need fresh post-seek data before the
        // pending currentTime assignment is safe to apply (see dashAppendThenContinue)
      try { if (track.buf.updating) track.buf.abort(); } catch (e) {}
      var resume = function () { dashFetchNextSegment(track, generation); };
      try {
        var buffered = track.buf.buffered;
        if (buffered.length) {
          track.buf.addEventListener('updateend', function onCleared() {
            track.buf.removeEventListener('updateend', onCleared);
            if (generation === dashSeekGeneration) resume();
          });
          track.buf.remove(0, buffered.end(buffered.length - 1));
        } else {
          resume();
        }
      } catch (e) {
        resume();
      }
    });
  }

  // ---- Shared playback controls: used by both Direct Play and DASH ----

  function togglePause() {
    if (!videoEl) return;
    if (videoEl.paused) { videoEl.play(); } else { videoEl.pause(); }
    showControls();
  }

  function seekTo(targetSeconds) {
    if (!videoEl) return;
    if (targetSeconds < 0) targetSeconds = 0;
    var durationSeconds = getDuration() / 1000;
    if (durationSeconds > 0 && targetSeconds > durationSeconds - 1) {
      targetSeconds = Math.max(0, durationSeconds - 1);
    }
    if (dashTracks) {
      seekDash(targetSeconds);
    } else {
      videoEl.currentTime = targetSeconds;
    }
    showControls();
  }

  function seekRelative(deltaSeconds) {
    seekTo(getCurrentTime() / 1000 + deltaSeconds);
  }

  function stop() {
    hideControlsNow();
    teardownDash();
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      try { videoEl.load(); } catch (e) {}
      videoEl.style.display = 'none';
    }
    knownDurationMs = 0;
  }

  window.PlexPlayer = {
    playDirectUrl: playDirectUrl,
    playDash: playDash,
    stop: stop,
    devlog: devlog,
    onEvent: onEvent,
    getCurrentTime: getCurrentTime,
    getDuration: getDuration,
    togglePause: togglePause,
    seekTo: seekTo,
    seekRelative: seekRelative,
    showControls: showControls
  };
})();
