(function () {
  'use strict';

  var WEBOS_BACK_KEYCODE = 461; // event.key reports "Unidentified" for this one
  // on webOS -- keyCode is the only reliable way to catch it, per LG's own docs.

  var statusEl = document.getElementById('status');
  var listEl = document.getElementById('libraries');
  var gridEl = document.getElementById('grid');
  var serverUrl = window.APP_CONFIG.serverUrl;

  var GRID_COLUMNS = 5;
  var libraries = [];
  var items = [];
  var focusedIndex = 0;
  var screen = 'libraries'; // 'libraries' | 'grid' | 'player'

  // A show's grid drills into seasons, a season's grid drills into episodes --
  // gridStack holds the parent level(s) so Back can pop one at a time instead
  // of dropping straight to the library list. currentGridTitle is whichever
  // level is currently rendered (library name, show title, or season title).
  var gridStack = [];
  var currentGridTitle = '';

  var currentItem = null;
  var currentSessionId = null;
  var timelineInterval = null;
  var TIMELINE_INTERVAL_MS = 10000;

  // webOS delivers relaunch params to an *already-running* app via this DOM
  // event (not PalmSystem.launchParams and not a URL query string -- both
  // came back empty on this device/app-type combo, confirmed by devlog).
  document.addEventListener('webOSRelaunch', function (e) {
    window.PlexPlayer.devlog('app:webOSRelaunch', { detail: JSON.stringify(e.detail || {}) });
    var testPlay = e.detail && e.detail.testPlay;
    var testOpenShow = e.detail && e.detail.testOpenShow;
    var testSeek = e.detail && e.detail.testSeek;
    var testPause = e.detail && e.detail.testPause;
    if (testSeek !== undefined && testSeek !== null) {
      // Debug-only: exercises seekTo directly, since there's no way to
      // simulate a physical remote's arrow-key press from here.
      window.PlexPlayer.seekTo(Number(testSeek));
    } else if (testPause) {
      window.PlexPlayer.togglePause();
    } else if (testPlay) {
      screen = 'player';
      listEl.style.display = 'none';
      gridEl.style.display = 'none';
      window.PlexApi.getMetadata(testPlay).then(
        function (data) { playItemFull(data.MediaContainer.Metadata[0]); },
        function (err) { setStatus('[' + (err.kind || 'error') + '] ' + err.message, true); }
      );
    } else if (testOpenShow) {
      // Debug-only, mirrors testPlay above: drives the show/season drill-down
      // (scripts/launch_test.py --show <ratingKey>) without needing the
      // physical remote to click into the grid.
      listEl.style.display = 'none';
      gridStack = [];
      openChildren({ ratingKey: testOpenShow, title: 'DEBUG ' + testOpenShow });
    }
  });

  if (window.PlexPlayer) {
    window.PlexPlayer.devlog('app:boot', {
      hasPalmSystem: !!window.PalmSystem,
      hasMediaSource: !!window.MediaSource,
      ua: navigator.userAgent,
      href: window.location.href,
      search: window.location.search
    });
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'status status--error' : 'status';
  }

  // This app never intends to scroll the page itself (a fixed 1920x1080
  // kiosk view, not a document) -- but the browser's scroll position is a
  // property of the whole page, not reset just because innerHTML changed.
  // Found the hard way: focusCard()'s scrollIntoView (needed for navigating
  // a long list) can, from a stale non-zero scroll position left over from a
  // previous screen, scroll a freshly-rendered grid's first row flush to the
  // very top of the viewport -- taking the header/status text and the top of
  // that row's own focus border with it, off-screen. Call this on every
  // screen change so no screen ever inherits scroll state from another.
  var contentScrollEl = document.getElementById('content-scroll');
  function resetScroll() {
    contentScrollEl.scrollTop = 0;
  }

  function hasSecrets() {
    var s = window.PLEX_SECRETS;
    return Boolean(s && s.token && s.token.indexOf('PASTE_') !== 0);
  }

  // ---- Library list screen ----

  var LIBRARY_TYPE_LABELS = { movie: 'Movies', show: 'TV Shows', artist: 'Music', photo: 'Photos' };

  function renderLibraries(container) {
    resetScroll();
    libraries = (container && container.Directory) || [];
    listEl.innerHTML = '';
    libraries.forEach(function (dir, i) {
      var panel = document.createElement('div');
      panel.className = 'panel';

      var title = document.createElement('div');
      title.className = 'panel__title';
      title.textContent = dir.title;
      panel.appendChild(title);

      var type = document.createElement('div');
      type.className = 'panel__type';
      type.textContent = LIBRARY_TYPE_LABELS[dir.type] || dir.type;
      panel.appendChild(type);

      panel.addEventListener('click', function () { openLibrary(i); });
      panel.addEventListener('mouseenter', function () { focusLibraryRow(i); });
      listEl.appendChild(panel);
    });
    if (!libraries.length) {
      setStatus('Connected to ' + serverUrl + ', but it has no libraries yet');
      return;
    }
    setStatus((libraries.length === 1 ? '1 library' : libraries.length + ' libraries') + ' on ' + serverUrl);
    focusLibraryRow(0);
  }

  function focusLibraryRow(i) {
    focusedIndex = i;
    Array.prototype.forEach.call(listEl.children, function (el, idx) {
      el.classList.toggle('focused', idx === i);
    });
  }

  function openLibrary(i) {
    var lib = libraries[i];
    if (!lib) return;
    gridStack = [];
    setStatus('Loading ' + lib.title + '...');
    window.PlexApi.getLibraryItems(lib.key).then(
      function (data) { renderGrid(lib.title, (data.MediaContainer && data.MediaContainer.Metadata) || []); },
      function (err) { setStatus('[' + (err.kind || 'error') + '] ' + err.message, true); }
    );
  }

  // A show/season item has no Media/Part of its own -- only its children
  // (seasons/episodes) do. Fetch them and push the current level onto
  // gridStack so Back can return to it instead of dropping to the library list.
  function openChildren(item) {
    setStatus('Loading ' + item.title + '...');
    window.PlexApi.getChildren(item.ratingKey).then(
      function (data) {
        var kids = (data.MediaContainer && data.MediaContainer.Metadata) || [];
        if (window.PlexPlayer) {
          window.PlexPlayer.devlog('app:openChildren:result', {
            title: item.title, count: kids.length, firstType: kids[0] && kids[0].type
          });
        }
        gridStack.push({ title: currentGridTitle, items: items, focusedIndex: focusedIndex });
        renderGrid(item.title, kids);
      },
      function (err) { setStatus('[' + (err.kind || 'error') + '] ' + err.message, true); }
    );
  }

  // ---- Poster grid screen ----
  // Reused for every level of a show's hierarchy (library -> seasons ->
  // episodes), not just a library's top-level items -- title is whatever
  // label fits the current level, not necessarily a library name.

  function renderGrid(title, newItems) {
    resetScroll();
    currentGridTitle = title;
    items = newItems || [];
    gridEl.innerHTML = '';
    var loaded = 0;
    var failed = 0;

    items.forEach(function (item, i) {
      var card = document.createElement('div');
      card.className = 'card';

      var posterSrc = window.PlexApi.posterUrl(item.thumb, 300, 450);
      var img = document.createElement('img');
      img.alt = item.title;
      img.addEventListener('load', function () {
        loaded++;
        // Never overwrite a diagnostic once one's shown -- a later success
        // elsewhere in the grid would otherwise scroll it off screen before
        // it's readable.
        if (!failed) setStatus(title + ' -- ' + loaded + '/' + items.length + ' posters loaded');
      });
      img.addEventListener('error', function () {
        failed++;
        if (failed > 1) return; // keep the first diagnostic on screen, not the Nth
        // <img> onerror carries no HTTP status -- fetch() the same URL
        // purely to surface one, so the real failure reason shows up on
        // screen instead of needing devtools.
        setStatus('[poster #' + i + ' failed] ' + posterSrc, true);
        fetch(posterSrc).then(
          function (res) { setStatus('[poster #' + i + ' fetch] HTTP ' + res.status + ' ' + res.headers.get('content-type'), true); },
          function (err) { setStatus('[poster #' + i + ' fetch threw] ' + err.message, true); }
        );
      });
      img.src = posterSrc;
      card.appendChild(img);

      var label = document.createElement('div');
      label.className = 'card__title';
      // Episode titles don't indicate order on their own -- number them so
      // the list is navigable instead of a wall of same-looking cards.
      label.textContent = (item.type === 'episode' && item.index != null)
        ? (item.index + '. ' + item.title)
        : item.title;
      card.appendChild(label);

      card.addEventListener('click', function () { selectItem(i); });
      card.addEventListener('mouseenter', function () { focusCard(i); });
      gridEl.appendChild(card);
    });

    screen = 'grid';
    listEl.style.display = 'none';
    gridEl.style.display = 'flex'; // not 'grid' -- unsupported on this TV's engine, see index.html

    if (!items.length) {
      setStatus(title + ' is empty');
      return;
    }
    setStatus(title + ' -- ' + items.length + ' items');
    focusCard(0);
  }

  function focusCard(i) {
    if (i < 0 || i >= items.length) return;
    focusedIndex = i;
    Array.prototype.forEach.call(gridEl.children, function (el, idx) {
      el.classList.toggle('focused', idx === i);
    });
    gridEl.children[i].scrollIntoView({ block: 'nearest' });
  }

  function selectItem(i) {
    var item = items[i];
    if (!item) return;
    if (item.type === 'show' || item.type === 'season') {
      openChildren(item);
    } else {
      playItem(item);
    }
  }

  // ---- Playback (Task 5) ----
  // Server-side decision, per Architecture Decision #4: ask Plex's own
  // /video/:/transcode/universal/decision whether this item's current
  // selection (codecs, container, which audio track) can play as-is, and
  // only fall back to the HLS/hls.js transcode pipeline when it says no.
  // Never guess client-side which codecs this TV can handle.

  function playItem(gridItem) {
    screen = 'player';
    listEl.style.display = 'none';
    gridEl.style.display = 'none';
    setStatus('Loading ' + gridItem.title + '...');

    // Library-listing items (from the grid) don't include per-stream detail
    // (container/codec only) -- fetching full metadata here, same as the
    // debug relaunch path already did, means audioIsMseUnsafe and the HDR
    // checks always see real Stream data regardless of how playItem was
    // reached, and picks up anything changed since the grid was rendered.
    window.PlexApi.getMetadata(gridItem.ratingKey).then(
      function (data) { playItemFull(data.MediaContainer.Metadata[0]); },
      function (err) {
        setStatus('[' + (err.kind || 'error') + '] ' + err.message, true);
        screen = 'grid';
        gridEl.style.display = 'flex';
      }
    );
  }

  function playItemFull(item) {
    var part = item.Media && item.Media[0] && item.Media[0].Part && item.Media[0].Part[0];
    if (!part) { setStatus('No media part found for ' + item.title, true); screen = 'grid'; gridEl.style.display = 'flex'; return; }

    var sessionId = window.PlexApi.newSessionId();
    setStatus('Deciding playback for ' + item.title + '...');
    window.PlexPlayer.devlog('app:decide:start', { title: item.title, ratingKey: item.ratingKey });

    window.PlexApi.decide(item, sessionId).then(
      function (data) {
        var md = data.MediaContainer && data.MediaContainer.Metadata && data.MediaContainer.Metadata[0];
        var decidedPart = md && md.Media && md.Media[0] && md.Media[0].Part && md.Media[0].Part[0];
        var canDirectPlay = !!(decidedPart && decidedPart.decision === 'directplay');
        window.PlexPlayer.devlog('app:decide:result', {
          title: item.title,
          canDirectPlay: canDirectPlay,
          partDecision: decidedPart && decidedPart.decision,
          directPlayDecisionText: data.MediaContainer && data.MediaContainer.directPlayDecisionText
        });
        startPlayback(item, part, sessionId, canDirectPlay);
      },
      function (err) {
        // Decision call itself failed (network/timeout) -- direct play is
        // always a safe fallback since it doesn't depend on the decision
        // pipeline at all, just the browser's own codec support.
        window.PlexPlayer.devlog('app:decide:failed', { title: item.title, message: err && err.message });
        setStatus('[decision failed, trying direct play] ' + (err && err.message || err), true);
        startPlayback(item, part, sessionId, true);
      }
    );
  }

  // Plex's own "continue watching" position (ms). Skipped if there's
  // nothing meaningful to resume (barely started) or if it's close enough
  // to the end to count as finished -- avoids silently resuming into the
  // last few seconds/credits instead of just starting over.
  function resumeOffsetSeconds(item) {
    var offsetMs = item.viewOffset || 0;
    var durationMs = item.duration || 0;
    if (offsetMs < 10000) return 0;
    if (durationMs && durationMs - offsetMs < 60000) return 0;
    return offsetMs / 1000;
  }

  function startPlayback(item, part, sessionId, canDirectPlay) {
    // Normal remote-control use can't reach this with a session still active
    // (the player screen eats every key but Back, and Back already calls
    // stopPlayback) -- but the debug relaunch path can, by design, jump
    // straight into a new playItemFull while one is already running. Found
    // the hard way: two real ffmpeg transcodes left running server-side from
    // back-to-back debug test launches that never went through Back. Stop
    // whatever was running first regardless of how we got here.
    if (currentSessionId && currentSessionId !== sessionId) {
      window.PlexApi.stopTranscode(currentSessionId);
    }
    currentItem = item;
    currentSessionId = sessionId;
    if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }

    var startAtSeconds = resumeOffsetSeconds(item);
    if (canDirectPlay) {
      setStatus('Direct Play: ' + item.title);
      window.PlexPlayer.playDirectUrl(window.PlexApi.directPlayUrl(part), item.title, startAtSeconds, item.duration);
    } else {
      setStatus('Direct Stream/Transcode: ' + item.title);
      window.PlexPlayer.playDash(
        window.PlexApi.dashStartUrl(item, sessionId),
        window.PlexApi.dashSegmentBaseUrl(sessionId),
        item.title,
        startAtSeconds,
        item.duration
      );
    }
    reportTick('playing');
    timelineInterval = setInterval(function () { reportTick('playing'); }, TIMELINE_INTERVAL_MS);
  }

  // Keeps PMS's "Now Playing" dashboard and Continue Watching aware of this
  // session -- without this, even a fully correct Direct Play is invisible
  // to the server (confirmed: a raw <video> fetch with no timeline calls
  // created no dashboard session at all).
  function reportTick(state) {
    if (!currentItem || !currentSessionId) return;
    var t = window.PlexPlayer.getCurrentTime();
    var d = window.PlexPlayer.getDuration() || currentItem.duration || 0;
    window.PlexApi.reportTimeline(currentItem, currentSessionId, state, t, d);
  }

  function stopPlayback(finalState) {
    if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }
    if (currentSessionId) {
      reportTick(finalState || 'stopped');
      window.PlexApi.stopTranscode(currentSessionId);
    }
    window.PlexPlayer.stop();
    currentItem = null;
    currentSessionId = null;
  }

  // Registered once (not per playItem call) so repeated playback doesn't
  // accumulate duplicate listeners -- state lives in currentItem/currentSessionId.
  if (window.PlexPlayer) {
    window.PlexPlayer.onEvent(function (evt) {
      if (evt === 'pause') reportTick('paused');
      else if (evt === 'playing') reportTick('playing');
      else if (evt === 'ended') { stopPlayback('stopped'); backToGrid(); }
      else if (evt === 'error') {
        var failedTitle = currentItem && currentItem.title;
        stopPlayback('stopped');
        setStatus('Playback error on ' + failedTitle, true);
        backToGrid();
      }
    });
  }

  function backToGrid() {
    resetScroll();
    screen = 'grid';
    gridEl.style.display = 'flex';
    focusCard(focusedIndex);
  }

  // Debug-only entry point: launch the app with
  // luna-send-pub ... applicationManager/launch '{"id":"...","params":{"testPlay":"<ratingKey>"}}'
  // to drive playback tests without physical remote access to the grid.
  // See scripts/launch_test.py. Not a user-facing feature.
  function debugTestPlayFromLaunchParams() {
    try {
      var testPlay = null;

      if (window.PalmSystem && window.PalmSystem.launchParams) {
        var raw = typeof window.PalmSystem.launchParams === 'function'
          ? window.PalmSystem.launchParams()
          : window.PalmSystem.launchParams;
        window.PlexPlayer.devlog('debug:launchparams-raw', { raw: raw, type: typeof window.PalmSystem.launchParams });
        if (raw) {
          var params = JSON.parse(raw);
          testPlay = params.testPlay || null;
        }
      }

      if (!testPlay && window.location.search) {
        // webOS web apps (type: "web") can receive relaunch params appended
        // to the page URL instead of (or in addition to) PalmSystem.launchParams
        // -- try this path too since the former wasn't reliable on this device.
        var qs = new URLSearchParams(window.location.search);
        testPlay = qs.get('testPlay');
      }

      if (!testPlay) return false;
      setStatus('DEBUG: loading ratingKey ' + testPlay + ' from launch params...');
      screen = 'player';
      listEl.style.display = 'none';
      gridEl.style.display = 'none';
      window.PlexApi.getMetadata(testPlay).then(
        function (data) {
          playItemFull(data.MediaContainer.Metadata[0]);
        },
        function (err) { setStatus('[' + (err.kind || 'error') + '] ' + err.message, true); }
      );
      return true;
    } catch (e) {
      setStatus('[debug launch params] ' + e.message, true);
      return false;
    }
  }

  function backToLibraries() {
    resetScroll();
    screen = 'libraries';
    gridStack = [];
    gridEl.style.display = 'none';
    listEl.style.display = '';
    focusLibraryRow(focusedIndex < libraries.length ? focusedIndex : 0);
  }

  // ---- 5-way navigation ----
  // Index arithmetic, not a geometric spatial-nav library: the grid has a
  // known, fixed column count, so +-1 and +-GRID_COLUMNS is simpler and more
  // predictable than proximity-guessing between arbitrary DOM rects.

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === WEBOS_BACK_KEYCODE) {
      if (screen === 'player') { stopPlayback('stopped'); backToGrid(); }
      else if (screen === 'grid') {
        if (gridStack.length) {
          var prev = gridStack.pop();
          renderGrid(prev.title, prev.items);
          focusCard(prev.focusedIndex);
        } else {
          backToLibraries();
        }
      }
      e.preventDefault();
      return;
    }

    if (screen === 'player') {
      // Matches Plex Web's own skip amounts (confirmed by watching its real
      // UI earlier this project): back 10s, forward 30s -- asymmetric on
      // purpose, a forward skip (recap/intro) is more common than needing to
      // rewind far.
      if (e.key === 'Enter') { window.PlexPlayer.togglePause(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { window.PlexPlayer.seekRelative(-10); reportTick('playing'); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { window.PlexPlayer.seekRelative(30); reportTick('playing'); e.preventDefault(); }
      return;
    }

    if (screen === 'libraries') {
      // Panels sit in a left-to-right row now (used to be a vertical list,
      // where only Up/Down made sense) -- Right/Left is the primary way to
      // move between them; Up/Down kept as harmless aliases for muscle
      // memory and for whenever enough libraries exist to wrap to a 2nd row.
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { focusLibraryRow(Math.min(focusedIndex + 1, libraries.length - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { focusLibraryRow(Math.max(focusedIndex - 1, 0)); e.preventDefault(); }
      else if (e.key === 'Enter') { openLibrary(focusedIndex); e.preventDefault(); }
      return;
    }

    // screen === 'grid'
    if (e.key === 'ArrowRight') { focusCard(Math.min(focusedIndex + 1, items.length - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { focusCard(Math.max(focusedIndex - 1, 0)); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { focusCard(Math.min(focusedIndex + GRID_COLUMNS, items.length - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { focusCard(Math.max(focusedIndex - GRID_COLUMNS, 0)); e.preventDefault(); }
    else if (e.key === 'Enter') { selectItem(focusedIndex); e.preventDefault(); }
  });

  // ---- boot ----

  if (!hasSecrets()) {
    setStatus('No Plex token in config.local.js yet: run scripts/get-plex-token.py, then rebuild', true);
  } else if (!debugTestPlayFromLaunchParams()) {
    setStatus('Connecting to ' + serverUrl + '...');
    window.PlexApi.getJson('/library/sections').then(
      function (data) { renderLibraries(data.MediaContainer); },
      function (err) { setStatus('[' + (err.kind || 'error') + '] ' + err.message, true); }
    );
  }
})();
