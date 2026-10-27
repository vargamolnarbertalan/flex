// Plex Media Server client. Written for the TV's Chromium 53: no async/await,
// no AbortController (timeouts race a timer), URLSearchParams built key by key.
(function () {
  'use strict';

  var TIMEOUT_MS = 8000;

  function settings() {
    var app = window.APP_CONFIG || {};
    var secrets = window.PLEX_SECRETS || {};
    return {
      serverUrl: app.serverUrl,
      product: app.product,
      token: secrets.token,
      clientId: secrets.clientId
    };
  }

  function buildUrl(path, params) {
    var s = settings();
    var qs = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      qs.set(key, params[key]);
    });
    // Identity goes in the query string, not headers: a custom header would
    // turn every call into a CORS preflight.
    qs.set('X-Plex-Token', s.token);
    qs.set('X-Plex-Client-Identifier', s.clientId);
    qs.set('X-Plex-Product', s.product);
    return s.serverUrl + path + '?' + qs.toString();
  }

  function failure(kind, message, status) {
    var err = new Error(message);
    err.kind = kind;
    err.status = status;
    return err;
  }

  function withTimeout(promise) {
    var timer = new Promise(function (resolve, reject) {
      setTimeout(function () {
        reject(failure('timeout', 'No answer from the server in ' + TIMEOUT_MS / 1000 + ' s'));
      }, TIMEOUT_MS);
    });
    return Promise.race([promise, timer]);
  }

  // A fetch that rejects can't tell "the browser blocked the response" (CORS)
  // from "nothing answered". A no-cors fetch to the same URL resolves, opaquely,
  // whenever the server answered at all, which separates the two. Under CORS an
  // HTTP error without a matching Access-Control-Allow-Origin also lands in 'cors'.
  function classifyNetworkFailure(url) {
    return withTimeout(fetch(url, { mode: 'no-cors' })).then(
      function () {
        return failure('cors', 'The server answered, but the TV blocked the response (CORS)');
      },
      function () {
        return failure('unreachable', 'Nothing answered at ' + settings().serverUrl);
      }
    );
  }

  function getJson(path, params) {
    var url = buildUrl(path, params);
    return withTimeout(fetch(url, { headers: { Accept: 'application/json' } }))
      .catch(function (err) {
        if (err.kind === 'timeout') {
          throw err;
        }
        return classifyNetworkFailure(url).then(function (classified) {
          throw classified;
        });
      })
      .then(function (res) {
        if (!res.ok) {
          throw failure('http', 'The server answered HTTP ' + res.status, res.status);
        }
        return res.json().catch(function () {
          throw failure('parse', 'The server answer was not JSON');
        });
      });
  }

  function getLibraryItems(sectionKey) {
    return getJson('/library/sections/' + sectionKey + '/all');
  }

  function getMetadata(ratingKey) {
    return getJson('/library/metadata/' + ratingKey);
  }

  // A show's children are its seasons; a season's children are its episodes.
  // Same shape as getLibraryItems (MediaContainer.Metadata[]).
  function getChildren(ratingKey) {
    return getJson('/library/metadata/' + ratingKey + '/children');
  }

  // ---- Playback decision/session (Task 5) ----
  // A fuller identity than buildUrl's: the decision endpoint uses
  // X-Plex-Platform/Device/Version to pick a base capability profile before
  // our own X-Plex-Client-Profile-Extra augments it. Kept separate from
  // buildUrl rather than changing it, so the already-proven browse/poster
  // calls are untouched.

  // Empirically found (not from docs -- undocumented in this PMS version):
  // this TV's Chromium can direct-play mkv/mp4/mov with h264 or hevc video
  // and aac/ac3/eac3/mp3 audio (confirmed on real hardware for both a 1080p
  // h264 file and a 4K HEVC Main10 HDR10 file). Declaring "Chrome" as the
  // platform makes Plex assume stock desktop Chrome's much narrower codec
  // support (no hevc) unless this profile augments it.
  var CLIENT_PROFILE_EXTRA =
    'add-direct-play-profile(type=videoProfile&container=mkv,mp4,mov&videoCodec=h264,hevc&audioCodec=aac,ac3,eac3,mp3)';

  function identityParams() {
    var s = settings();
    return {
      'X-Plex-Token': s.token,
      'X-Plex-Client-Identifier': s.clientId,
      'X-Plex-Product': s.product,
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Platform-Version': '53.0',
      'X-Plex-Device': 'LG Smart TV',
      'X-Plex-Device-Name': 'lgtv-tune',
      'X-Plex-Version': '0.0.1'
    };
  }

  function buildFullUrl(path, params) {
    var s = settings();
    var qs = new URLSearchParams();
    var identity = identityParams();
    Object.keys(identity).forEach(function (k) { qs.set(k, identity[k]); });
    Object.keys(params || {}).forEach(function (k) { qs.set(k, params[k]); });
    return s.serverUrl + path + '?' + qs.toString();
  }

  // Not cryptographic -- crypto.randomUUID needs Chrome 92+, unavailable
  // here. Good enough to tag one playback session's decision/start/timeline
  // calls as belonging together.
  function newSessionId() {
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  }

  // Empirically found: this TV's MSE (used by the hls.js fallback) fails on
  // copied eac3/ac3 audio -- hls.js reports an empty audio codec string and
  // the <video> element then errors with MEDIA_ERR_SRC_NOT_SUPPORTED, even
  // though the exact same eac3 track plays fine through native Direct Play
  // (a completely different, non-MSE code path). directStreamAudio=0 makes
  // Plex transcode audio to a safe codec (confirmed: mp3) instead of copying
  // it -- only needed for eac3/ac3 sources, so aac sources still get a clean
  // audio copy.
  function audioIsMseUnsafe(item) {
    // item.Media[0].audioCodec is NOT reliable for this -- it reflects
    // whatever a past transcode decision computed for this item (cached
    // server-side), not the source file's real codec. Found the hard way:
    // it read "mp3" here for a file whose actual audio is eac3, because an
    // earlier test had already decided to transcode it to mp3. The Part's
    // own Stream list is the source of truth.
    var part = item.Media && item.Media[0] && item.Media[0].Part && item.Media[0].Part[0];
    var streams = (part && part.Stream) || [];
    for (var i = 0; i < streams.length; i++) {
      if (streams[i].streamType === 2 && (streams[i].selected || streams[i].default)) {
        return streams[i].codec === 'eac3' || streams[i].codec === 'ac3';
      }
    }
    return false;
  }

  // protocol defaults to 'dash': empirically, this device's MSE can
  // correctly identify DASH's fMP4 (ISOBMFF) segments -- codec is read from
  // the init segment's own moov/stsd box, not inferred from a TS stream_type
  // byte -- and Plex's own universal transcoder picks aac for the fallback
  // audio under dash (confirmed via mitm-ing Plex Web's own requests), not
  // the mp3 it picks under hls. See [[lgtv-plex-hls-ts-vs-dash]] memory.
  function playbackParams(item, sessionId, directPlay, protocol) {
    return {
      path: item.key,
      mediaIndex: '0',
      partIndex: '0',
      protocol: protocol || 'dash',
      fastSeek: '1',
      directPlay: directPlay ? '1' : '0',
      directStream: '1',
      directStreamAudio: audioIsMseUnsafe(item) ? '0' : '1',
      subtitleSize: '100',
      audioBoost: '100',
      location: 'lan',
      autoAdjustQuality: '0',
      session: sessionId,
      'X-Plex-Session-Identifier': sessionId,
      'X-Plex-Client-Profile-Extra': CLIENT_PROFILE_EXTRA
    };
  }

  // Read-only: asks whether direct play works, without starting a transcode
  // session. The server's own call -- see Architecture Decision #4.
  function decide(item, sessionId) {
    var url = buildFullUrl('/video/:/transcode/universal/decision', playbackParams(item, sessionId, true, 'dash'));
    return withTimeout(fetch(url, { headers: { Accept: 'application/json' } }))
      .then(function (res) { return res.json(); });
  }

  function dashStartUrl(item, sessionId) {
    return buildFullUrl('/video/:/transcode/universal/start.mpd', playbackParams(item, sessionId, false, 'dash'));
  }

  // DASH segment/init URLs are relative paths inside the MPD
  // (session/<id>/<repId>/header, .../<n>.m4s) -- no token needed on these,
  // the session id itself (minted by the authenticated start.mpd call) is
  // the authorization. Resolve them against this instead of re-signing each one.
  function dashSegmentBaseUrl(sessionId) {
    var s = settings();
    return s.serverUrl + '/video/:/transcode/universal/session/' + sessionId + '/';
  }

  function stopTranscode(sessionId) {
    var url = buildFullUrl('/video/:/transcode/universal/stop', { session: sessionId });
    return fetch(url).catch(function () {});
  }

  // Drives the PMS "Now Playing" dashboard and Continue Watching -- without
  // this, even a correct Direct Play is invisible to the server (confirmed:
  // a raw <video> fetch alone created no session). Fire-and-forget by design;
  // a missed tick just means a slightly stale dashboard position, not a
  // playback problem, so failures aren't surfaced to the caller.
  function reportTimeline(item, sessionId, state, timeMs, durationMs) {
    var params = {
      ratingKey: item.ratingKey,
      key: item.key,
      state: state,
      time: String(Math.round(timeMs)),
      duration: String(Math.round(durationMs || item.duration || 0)),
      'X-Plex-Session-Identifier': sessionId
    };
    var url = buildFullUrl('/:/timeline', params);
    return fetch(url).catch(function () {});
  }

  // The raw original file, byte for byte -- true Direct Play. Only works if
  // the browser's <video> element can demux/decode the source container and
  // codecs itself; Plex does nothing here, just serves the file with range
  // support.
  function directPlayUrl(part) {
    var s = settings();
    var qs = new URLSearchParams();
    qs.set('X-Plex-Token', s.token);
    return s.serverUrl + part.key + '?' + qs.toString();
  }

  // Plex's photo-transcode endpoint, for a grid-sized poster instead of the
  // full-resolution original. thumbPath is the relative path Plex gives each
  // item (e.g. "/library/metadata/123/thumb/456") -- it goes in as a nested
  // query param, not a path segment.
  function posterUrl(thumbPath, width, height) {
    if (!thumbPath) return '';
    var s = settings();
    var qs = new URLSearchParams();
    qs.set('url', thumbPath);
    qs.set('width', width);
    qs.set('height', height);
    qs.set('minSize', '1');
    qs.set('upscale', '1');
    qs.set('X-Plex-Token', s.token);
    return s.serverUrl + '/photo/:/transcode?' + qs.toString();
  }

  window.PlexApi = {
    getJson: getJson,
    getLibraryItems: getLibraryItems,
    getMetadata: getMetadata,
    getChildren: getChildren,
    posterUrl: posterUrl,
    directPlayUrl: directPlayUrl,
    newSessionId: newSessionId,
    decide: decide,
    dashStartUrl: dashStartUrl,
    dashSegmentBaseUrl: dashSegmentBaseUrl,
    stopTranscode: stopTranscode,
    reportTimeline: reportTimeline
  };
})();
