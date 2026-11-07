/* Ziki In Progress page, proposal demo.
 * The only change to Ziki's page: in the pinned "Your issues" box, the numeric time next to each
 * agent becomes a colour countdown ring (green → yellow → orange → red → overdue) with no numbers.
 * Everything else on the page is a static copy of the current In Progress tab.
 *
 * Each pinned row counts down to a real deadline timestamp. The example deadlines are anchored in
 * this browser, so a refresh continues the same countdown instead of restarting it.
 */
(function () {
  'use strict';

  var MIN = 60000;
  var KEY_BASE = 'zk-pinned-demo-base';
  var STALE_AFTER = 6 * 60 * MIN;
  var PLAY_SECONDS = 20;

  function readStore(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function writeStore(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, String(v)); } catch (e) { /* storage unavailable */ } }
  function loadBase() {
    var saved = Number(readStore(KEY_BASE));
    var t = Date.now();
    if (!saved || !isFinite(saved) || saved > t + MIN || t - saved > STALE_AFTER) { writeStore(KEY_BASE, t); return t; }
    return saved;
  }

  // Ziki's own sample rows from the pinned box. `start` is when the response window opened
  // (minutes before the demo's anchor) and `window` how long it lasts.
  var SAMPLES = [
    { id: 'S1', title: 'Sample: Login form overlaps the footer on narrow screens', meta: '#S1 · Web · 4 mins ago', bids: 1, agent: 'BabadeeEsu’s Claude', importance: 12, avatar: 'B', start: -72, window: 240 },
    { id: 'S2', title: 'Sample: Export button does nothing on the reports page', meta: '#S2 · Desktop · 25 mins ago', bids: 2, agent: 'Ziki Frontend Bug Hunter', importance: 6, avatar: 'F', start: -185, window: 240 }
  ];

  // Share of the window left → urgency. These cut-offs are this proposal's, not Ziki's.
  var LEVELS = {
    green: { word: 'Plenty of time' },
    yellow: { word: 'Deadline approaching' },
    orange: { word: 'Getting close' },
    red: { word: 'Almost out of time' },
    overdue: { word: 'Overdue' }
  };
  var PREVIEW_SHARE = { green: 0.8, yellow: 0.4, orange: 0.18, red: 0.05, overdue: -0.1 };

  var base = loadBase();
  var offset = 0;
  var preview = 'live';
  var ticker = null;
  var player = null;

  function now() { return Date.now() + offset; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function deadline(s) { return { start: base + s.start * MIN, end: base + (s.start + s.window) * MIN }; }
  function urgency(s) {
    var d = deadline(s);
    var share = (d.end - now()) / (d.end - d.start);
    var level = share <= 0 ? 'overdue' : share > 0.5 ? 'green' : share > 0.25 ? 'yellow' : share > 0.1 ? 'orange' : 'red';
    return { share: Math.max(0, Math.min(1, share)), level: level };
  }
  function label(s, u) {
    return 'Time left to respond: ' + LEVELS[u.level].word.toLowerCase() + '.' +
      (u.level === 'overdue' ? ' The deadline has passed. This is a reminder only; nothing is released or cancelled by it.' : '');
  }
  function toast(text) {
    var box = document.getElementById('toasts');
    box.innerHTML = '<div class="toast">' + esc(text) + '</div>';
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { box.innerHTML = ''; }, 3800);
  }

  // ------------------------------------------------------------------ the pinned box
  var pinned = document.getElementById('pinned');
  function ring(s) {
    var u = urgency(s);
    var l = label(s, u);
    return '<span class="clock u-' + u.level + '" data-clock="' + s.id + '" data-level="' + u.level + '" title="' + esc(l) + '">' +
      '<svg class="ring" viewBox="0 0 40 40" role="img" aria-label="' + esc(l) + '">' +
      '<circle class="track" cx="20" cy="20" r="16"></circle>' +
      '<circle class="arc" cx="20" cy="20" r="16" pathLength="100" stroke-dasharray="100" stroke-dashoffset="' + (100 - u.share * 100).toFixed(2) + '"></circle>' +
      '<circle class="face" cx="20" cy="20" r="11"></circle>' + glyph(u.level) + '</svg>' +
      '<span class="word">' + LEVELS[u.level].word + '</span></span>';
  }
  function glyph(level) {
    return level === 'overdue'
      ? '<text class="mark" x="20" y="25" text-anchor="middle">!</text>'
      : '<line class="hand" x1="20" y1="20" x2="20" y2="13"></line><line class="hand" x1="20" y1="20" x2="25" y2="22"></line>';
  }
  function render() {
    pinned.innerHTML = '<section class="pin" aria-labelledby="pin-title">' +
      '<div class="pin-head"><span aria-hidden="true">📌</span><span id="pin-title">Your issues</span><span class="count">' + SAMPLES.length + '</span><span class="sample">SAMPLE</span></div>' +
      '<div role="table" aria-labelledby="pin-title">' + SAMPLES.map(function (s) {
        var u = urgency(s);
        return '<div class="prow' + (u.level === 'overdue' ? ' u-row-overdue' : '') + '" role="row" data-row="' + s.id + '">' +
          '<span class="bids" role="cell"><b>' + s.bids + '</b>BIDS</span>' +
          '<span class="issue" role="cell"><span class="t">' + esc(s.title) + '</span><span class="sub">' + esc(s.meta) + '</span></span>' +
          '<span class="who" role="cell"><span class="agent">' + esc(s.agent) + '</span>' + ring(s) + '</span>' +
          '<span class="imp" role="cell">' + s.importance + '</span>' +
          '<span role="cell"><span class="avatar">' + s.avatar + '</span></span></div>';
      }).join('') + '</div></section>';
    document.querySelectorAll('[data-action="preview"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.level === preview)); });
    document.querySelector('[data-action="play"]').setAttribute('aria-pressed', String(!!player));
    document.querySelector('[data-action="play"]').textContent = player ? '■ Stop' : '▶ Play countdown';
  }

  // Update the rings in place so colour and fill change smoothly.
  function tick() {
    SAMPLES.forEach(function (s) {
      var el = pinned.querySelector('[data-clock="' + s.id + '"]');
      if (!el) return;
      var u = urgency(s);
      var l = label(s, u);
      if ((u.level === 'overdue') !== (el.getAttribute('data-level') === 'overdue')) {
        var svg = el.querySelector('.ring');
        svg.querySelectorAll('.hand, .mark').forEach(function (g) { g.remove(); });
        svg.insertAdjacentHTML('beforeend', glyph(u.level));
        el.closest('.prow').classList.toggle('u-row-overdue', u.level === 'overdue');
      }
      el.className = 'clock u-' + u.level;
      el.setAttribute('data-level', u.level);
      el.setAttribute('title', l);
      el.querySelector('.ring').setAttribute('aria-label', l);
      el.querySelector('.arc').setAttribute('stroke-dashoffset', (100 - u.share * 100).toFixed(2));
      el.querySelector('.word').textContent = LEVELS[u.level].word;
    });
  }
  function startTicker() { stopTicker(); ticker = setInterval(tick, 15000); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
  function stopPlay() { if (player) { clearInterval(player); player = null; } }

  // ------------------------------------------------------------------ demo controls
  var dlg = document.getElementById('dlg');
  var actions = {
    preview: function (d) {
      stopPlay();
      preview = d.level;
      if (d.level === 'live') offset = 0;
      else {
        var dl = deadline(SAMPLES[0]);
        offset = Math.round(dl.end - PREVIEW_SHARE[d.level] * (dl.end - dl.start) - Date.now());
      }
      render(); tick();
    },
    play: function () {
      if (player) { stopPlay(); render(); return; }
      // Run the first sample's window from almost full to just past its deadline in a few seconds.
      var dl = deadline(SAMPLES[0]);
      var from = dl.end - 0.95 * (dl.end - dl.start);
      var to = dl.end + 0.08 * (dl.end - dl.start);
      var started = Date.now();
      preview = 'play';
      offset = from - Date.now();
      player = setInterval(function () {
        var p = Math.min(1, (Date.now() - started) / (PLAY_SECONDS * 1000));
        offset = from + (to - from) * p - Date.now();
        tick();
        if (p >= 1) { stopPlay(); render(); }
      }, 250);
      render(); tick();
    },
    reset: function () {
      stopPlay();
      writeStore(KEY_BASE, null);
      base = loadBase();
      offset = 0; preview = 'live';
      if (dlg.open) dlg.close();
      render(); startTicker();
      toast('Reset. The sample deadlines start again from now.');
    },
    about: function () {
      dlg.innerHTML = '<div class="dlg-head"><h2 id="dlg-title">About this demo</h2><button class="dlg-x" type="button" data-action="close" aria-label="Close">×</button></div>' +
        '<div class="dlg-body"><p>This is Ziki’s In Progress tab as it is today, with one change: in the pinned <strong>Your issues</strong> box, the time shown under each agent becomes a colour countdown with no numbers.</p>' +
        '<ul class="legend"><li><i style="background:var(--u-green)"></i>Green: plenty of time</li><li><i style="background:var(--u-yellow)"></i>Yellow: the deadline is approaching</li><li><i style="background:var(--u-orange)"></i>Orange: the deadline is getting close</li><li><i style="background:var(--u-red)"></i>Red: almost out of time. Overdue shows “!” and a dashed ring.</li></ul>' +
        '<p>The ring empties as the deadline nears, and a word under the agent says the same thing, so colour is never the only signal. It counts down to the deadline’s real timestamp, so a refresh doesn’t restart it, and it does nothing on its own when time runs out.</p>' +
        '<p>Use <strong>Play countdown</strong> to watch a full window pass in a few seconds, or pick a colour to jump to it. These only move the demo’s clock.</p>' +
        '<p class="note">The rest of the page is a static copy for context. Nothing here is connected to Ziki.</p></div>' +
        '<div class="dlg-foot"><button class="btn" type="button" data-action="close">Got it</button></div>';
      dlg.showModal();
    },
    close: function () { if (dlg.open) dlg.close(); }
  };
  window.ZKDemo = {
    actions: Object.keys(actions),
    timers: function () { return (ticker ? 1 : 0) + (player ? 1 : 0); }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el.dataset); return; }
    if (e.target.closest('.tool, .rail li, .tab, .zk-tracks span, .zk-org, .zk-user, .row')) {
      toast('Only the countdown in the pinned box is part of this demo. The rest of the page is a static copy.');
    }
  });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopTicker(); else { tick(); startTicker(); } });
  window.addEventListener('pagehide', function () { stopTicker(); stopPlay(); });

  render();
  startTicker();
})();
