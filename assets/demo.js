/* Pinned issue + visual deadline countdown: an interactive proposal demo for Ziki.
 * Everything here is example data kept in this page. Nothing is sent anywhere.
 *
 * The data mirrors what Ziki's published agent API documents (ziki.dev/llms.txt):
 *  - question:   an agent's question to its owner about an issue it holds. Ziki reminds the owner
 *                after 30 minutes and releases the claim if there is no answer within the project's
 *                cap (4 hours by default). Deadline = asked time + cap.
 *  - plan:       plan review on a complex issue ("In progress · Plan review"). Only the owner approves
 *                it or sends it back; the window (2 hours by default) restarts on each send-back.
 *  - escalation: a typed escalation (question, blocker, scope change, human approval…). No deadline
 *                is documented, so no countdown is shown.
 */
(function () {
  'use strict';

  var MIN = 60000;
  var KEY_BASE = 'zk-pinned-demo-base';
  var STALE_AFTER = 6 * 60 * MIN; // an example clock older than this starts over

  function readStore(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function writeStore(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, String(v)); } catch (e) { /* storage unavailable: the demo still works */ } }

  // The example deadlines are fixed timestamps anchored to when this browser first opened the demo,
  // so a refresh continues the same countdown instead of restarting it.
  function loadBase() {
    var saved = Number(readStore(KEY_BASE));
    var now = Date.now();
    if (!saved || !isFinite(saved) || saved > now + MIN || now - saved > STALE_AFTER) {
      writeStore(KEY_BASE, now);
      return now;
    }
    return saved;
  }

  var AGENTS = {
    nova: { name: 'Nova', tone: 'ok' },
    atlas: { name: 'Atlas', tone: 'info' },
    kite: { name: 'Kite', tone: 'warn' },
    orbit: { name: 'Orbit', tone: '' },
    pixel: { name: 'Pixel', tone: 'bad' }
  };

  // Times are minutes relative to the demo's anchor (negative = before it).
  var ISSUES = [
    { n: 219, list: 'in-progress', title: 'Learners drop off before the first lesson', kind: 'Feature', area: 'Web', agent: 'nova', bids: 3, comments: 6, importance: 41, updated: -12,
      desc: 'About a third of new learners join a community but never open the first lesson. Find where they leave and fix the biggest friction point.',
      request: { type: 'plan', start: -85, window: 120,
        summary: 'Measure where learners leave, then fix the biggest friction point behind a flag.',
        steps: ['Measure where learners leave between sign-up and the first lesson', 'List the top three friction points', 'Pick the highest-impact one (you confirm which)', 'Ship the smallest change behind a flag', 'Compare before and after'],
        estimate: 'About 4 hours', risk: 'Medium', confidence: 'Medium' },
      log: [{ who: 'nova', text: 'Nova submitted a plan for review', at: -80 }, { who: 'orbit', text: 'Orbit awarded Nova’s bid', at: -85 }] },
    { n: 214, list: 'in-progress', title: 'Thread replies lose code formatting on mobile', kind: 'Bug', area: 'Mobile', agent: 'atlas', bids: 2, comments: 9, importance: 36, updated: -50,
      desc: 'Code blocks in thread replies show as plain text on phones. Desktop is fine.',
      request: { type: 'question', start: -50, window: 240,
        body: 'Should code blocks in thread replies keep their syntax colours on mobile, or switch to plain monospace to save space?' },
      log: [{ who: 'atlas', text: 'Atlas asked you a question', at: -50 }, { who: 'atlas', text: 'Atlas found the cause in the mobile message renderer', at: -64 }] },
    { n: 207, list: 'in-progress', title: 'Search misses messages in archived channels', kind: 'Bug', area: 'Web', agent: 'kite', bids: 4, comments: 12, importance: 33, updated: -20,
      desc: 'Searching a community does not return messages from channels that were archived.',
      request: { type: 'escalation', label: 'Scope change', start: -20,
        body: 'Indexing archived channels needs a new database index on messages. That is a schema change beyond this issue. Should I go ahead, or keep the fix to the search query only?' },
      log: [{ who: 'kite', text: 'Kite escalated a scope change to you', at: -20 }] },
    { n: 223, list: 'in-progress', title: 'Unread badge stays after reading a channel', kind: 'Bug', area: 'Web', agent: 'orbit', bids: 2, comments: 4, importance: 29, updated: -6,
      desc: 'The unread count on the sidebar does not clear until the page is refreshed.',
      log: [{ who: 'orbit', text: 'Orbit pushed a fix to its branch', at: -6 }] },
    { n: 201, list: 'in-progress', title: 'Invite links expire a day early', kind: 'Bug', area: 'Web', agent: 'pixel', bids: 1, comments: 3, importance: 22, updated: -31,
      desc: 'Invite links say they last seven days but stop working after six.',
      log: [{ who: 'pixel', text: 'Pixel is testing the time zone fix', at: -31 }] },

    { n: 231, list: 'open', title: 'Kebab menu in the DM header does nothing on tablets', kind: 'Bug', area: 'Web', bids: 0, comments: 5, importance: 44, updated: -14, status: 'Ready for bids', desc: 'Tapping “More options” in a direct message header has no effect on tablets.' },
    { n: 228, list: 'open', title: 'Lesson cards overflow on small phones', kind: 'Design', area: 'Mobile', bids: 0, comments: 2, importance: 31, updated: -300, status: 'Ready for bids', desc: 'Long lesson titles push the card wider than the screen.' },
    { n: 226, list: 'open', title: 'Footer social icon opens a broken link', kind: 'Bug', area: 'Web', bids: 1, comments: 1, importance: 18, updated: -900, status: 'Ready for bids', desc: 'The footer icon points to an old page.' },
    { n: 190, list: 'closed', title: 'Duplicate welcome email on sign-up', kind: 'Bug', area: 'Web', bids: 2, comments: 7, importance: 27, updated: -2900, status: 'Closed', desc: 'New members received the welcome email twice.' },
    { n: 196, list: 'possibly-delivered', title: 'Emoji picker hides behind the keyboard', kind: 'Bug', area: 'Mobile', bids: 3, comments: 6, importance: 25, updated: -1500, status: 'Possibly delivered', desc: 'On some phones the emoji picker opens under the keyboard.' },
    { n: 188, list: 'delivered', title: 'Dark mode for the lesson reader', kind: 'Feature', area: 'Web', bids: 5, comments: 18, importance: 52, updated: -4300, status: 'On prod', desc: 'Lessons can be read in dark mode.' },
    { n: 182, list: 'delivered', title: 'Faster loading for large communities', kind: 'Performance', area: 'Web', bids: 4, comments: 11, importance: 47, updated: -7200, status: 'On staging', desc: 'Community pages load faster when there are many channels.' },
    { n: 240, list: 'ideas', title: 'Let teachers schedule announcements', kind: 'Idea', area: 'Web', bids: 0, comments: 4, importance: 12, updated: -45, status: '3 verdicts', desc: 'Teachers want to write an announcement now and post it later.' },
    { n: 238, list: 'ideas', title: 'Weekly progress digest for learners', kind: 'Idea', area: 'Web', bids: 0, comments: 2, importance: 9, updated: -600, status: '2 verdicts', desc: 'A short weekly summary of what each learner finished.' }
  ];
  var BY_N = {};
  ISSUES.forEach(function (i) { BY_N[i.n] = i; });

  var LISTS = {
    'open': 'Open', 'in-progress': 'In progress', 'closed': 'Closed', 'possibly-delivered': 'Possibly delivered'
  };
  var RAIL = ['open', 'in-progress', 'closed', 'possibly-delivered'];

  // Urgency is the share of the response window left. These cut-offs are this proposal's, not Ziki's.
  var LEVELS = {
    green: { word: 'Plenty of time', min: 0.5 },
    yellow: { word: 'Deadline approaching', min: 0.25 },
    orange: { word: 'Getting close', min: 0.1 },
    red: { word: 'Almost out of time', min: 0 },
    overdue: { word: 'Overdue', min: -Infinity }
  };
  var PREVIEW_SHARE = { green: 0.75, yellow: 0.4, orange: 0.18, red: 0.05, overdue: -0.1 };

  var base = loadBase();
  var state;
  var timer = null;
  var epoch = 0;

  function fresh() {
    var s = { offset: 0, preview: 'live', req: {}, log: {}, compose: null, draft: '', error: '', planMode: 'view', planNote: '', focus: null, flash: null };
    ISSUES.forEach(function (i) {
      if (i.request) s.req[i.n] = { pending: true, start: i.request.start, round: 1, outcome: null };
      s.log[i.n] = (i.log || []).map(function (e) { return { who: e.who, text: e.text, at: base + e.at * MIN }; });
    });
    return s;
  }

  // ------------------------------------------------------------------ helpers
  function now() { return Date.now() + state.offset; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function agentName(n) { return AGENTS[BY_N[n].agent].name; }
  function avatar(who, size) {
    if (who === 'you') return '<span class="avatar you ' + (size || '') + '" aria-hidden="true">Y</span>';
    var a = AGENTS[who];
    return '<span class="avatar ' + a.tone + ' ' + (size || '') + '" aria-hidden="true">' + a.name.charAt(0) + '</span>';
  }
  function ago(ts) {
    var m = Math.round((now() - ts) / MIN);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
    var d = Math.round(m / 1440);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }
  function toast(text) {
    var box = document.getElementById('toasts');
    box.innerHTML = '<div class="toast">' + esc(text) + '</div>';
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { box.innerHTML = ''; }, 4200);
  }
  function addLog(n, who, text) { state.log[n].unshift({ who: who, text: text, at: now() }); }

  function deadlineOf(n) {
    var def = BY_N[n].request;
    var r = state.req[n];
    if (!def || !def.window) return null;
    return { start: base + r.start * MIN, end: base + (r.start + def.window) * MIN };
  }
  function urgency(n) {
    var d = deadlineOf(n);
    if (!d) return null;
    var share = (d.end - now()) / (d.end - d.start);
    var level = 'overdue';
    if (share > 0) {
      level = share > LEVELS.green.min ? 'green' : share > LEVELS.yellow.min ? 'yellow' : share > LEVELS.orange.min ? 'orange' : 'red';
    }
    return { share: Math.max(0, Math.min(1, share)), level: level };
  }

  // Which issue to pin: the earliest real response deadline first, then the oldest request without one.
  // (Ziki documents no ordering for this; the rule is part of the proposal.)
  function waiting() {
    return ISSUES.filter(function (i) { return i.request && state.req[i.n].pending; }).sort(function (a, b) {
      var da = deadlineOf(a.n), db = deadlineOf(b.n);
      if (da && db) return da.end - db.end;
      if (da) return -1;
      if (db) return 1;
      return state.req[a.n].start - state.req[b.n].start;
    });
  }

  // ------------------------------------------------------------------ routing
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var m = h.match(/^issue\/(\d+)$/);
    if (m && BY_N[m[1]]) return { view: 'issue', n: Number(m[1]) };
    if (h === 'ideas') return { view: 'list', tab: 'ideas', list: 'ideas' };
    if (h === 'delivered') return { view: 'list', tab: 'delivered', list: 'delivered' };
    m = h.match(/^issues\/([a-z-]+)$/);
    if (m && LISTS[m[1]]) return { view: 'list', tab: 'progress', list: m[1] };
    return { view: 'list', tab: 'progress', list: 'in-progress' };
  }
  function count(list) { return ISSUES.filter(function (i) { return i.list === list; }).length; }

  // ------------------------------------------------------------------ views
  function tabs(active) {
    var progressCount = RAIL.reduce(function (s, l) { return s + count(l); }, 0);
    function tab(id, href, label, n) {
      return '<a class="tab" href="' + href + '"' + (active === id ? ' aria-current="page"' : '') + '><span>' + label + '<span class="n">' + n + '</span></span><span class="dot" aria-hidden="true"></span></a>';
    }
    return '<nav class="tabs" aria-label="Issue stages">' +
      tab('ideas', '#/ideas', 'Ideas', count('ideas')) +
      tab('progress', '#/issues/in-progress', 'In Progress', progressCount) +
      tab('delivered', '#/delivered', 'Delivered', count('delivered')) + '</nav>';
  }

  function rail(active) {
    var needs = waiting().length;
    return '<ul class="rail" aria-label="Status">' + RAIL.map(function (l) {
      return '<li><a href="#/issues/' + l + '"' + (active === l ? ' aria-current="page"' : '') + '><span class="cnt">' + count(l) + '</span><span>' + LISTS[l] +
        (l === 'in-progress' && needs ? '<span class="needs-dot" title="Needs your decision"></span><span class="sr"> (needs your decision)</span>' : '') + '</span></a></li>';
    }).join('') + '</ul>';
  }

  function statusCell(i) {
    if (i.list === 'open') return '<span class="status ok">' + hammer() + ' Ready for bids</span>';
    if (i.list !== 'in-progress') return '<span class="status plain">' + esc(i.status) + '</span>';
    var r = state.req[i.n];
    if (r && r.pending) return '<span class="status wait">● Waiting on you</span>';
    if (r && r.outcome === 'sent-back') return '<span class="status plain">Plan sent back</span>';
    return '<span class="status plain">In progress</span>';
  }
  function hammer() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4l6 6-3 3-6-6zM11 7L3 15l3 3 8-8"/></svg>';
  }

  function table(list) {
    var rows = ISSUES.filter(function (i) { return i.list === list; }).sort(function (a, b) { return b.importance - a.importance; });
    return '<div class="table" role="table" aria-label="' + esc(list === 'ideas' ? 'Ideas' : list === 'delivered' ? 'Delivered issues' : LISTS[list] + ' issues') + '">' +
      '<div class="thead" role="row"><span role="columnheader">Bids</span><span role="columnheader">Issue</span><span role="columnheader">Status</span><span class="imp" role="columnheader">Importance</span><span role="columnheader"><span class="sr">Agent</span></span></div>' +
      rows.map(function (i) {
        return '<div class="row' + (state.flash === i.n ? ' flash' : '') + '" role="row" data-row="' + i.n + '">' +
          '<span class="bids" role="cell"><b>✋ ' + i.bids + '</b>BIDS</span>' +
          '<span class="issue" role="cell"><a href="#/issue/' + i.n + '">' + esc(i.title) + '</a><span class="sub"><span>#' + i.n + '</span><span>' + esc(i.kind) + '</span><span>💬 ' + i.comments + '</span><span>' + esc(i.area) + '</span><span>' + ago(base + i.updated * MIN) + '</span></span></span>' +
          '<span role="cell">' + statusCell(i) + '</span>' +
          '<span class="imp-n" role="cell"><span class="sr">Importance </span>' + i.importance + '</span>' +
          '<span role="cell">' + (i.agent ? avatar(i.agent) : '<span class="avatar" aria-hidden="true">·</span>') + '</span></div>';
      }).join('') + '</div>';
  }

  // The visual countdown. No numbers are written anywhere in it.
  function clock(n) {
    var def = BY_N[n].request;
    var u = urgency(n);
    if (!u) return '<div class="clock" data-clock="none"><p class="no">No response deadline on this request</p></div>';
    var label = clockLabel(n, u);
    return '<div class="clock u-' + u.level + '" data-clock="' + n + '" data-level="' + u.level + '" title="' + esc(label) + '">' +
      '<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="' + esc(label) + '">' +
      '<circle class="track" cx="32" cy="32" r="27"></circle>' +
      '<circle class="arc" cx="32" cy="32" r="27" pathLength="100" stroke-dasharray="100" stroke-dashoffset="' + (100 - u.share * 100).toFixed(2) + '"></circle>' +
      '<circle class="face" cx="32" cy="32" r="19"></circle>' + glyph(u.level) + '</svg>' +
      '<span class="word">' + LEVELS[u.level].word + '</span><span class="what">' + (def.type === 'plan' ? 'Plan review window' : 'Time to answer') + '</span></div>';
  }
  function glyph(level) {
    if (level === 'overdue') return '<text class="mark" x="32" y="39" text-anchor="middle">!</text>';
    return '<line class="hand" x1="32" y1="32" x2="32" y2="22"></line><line class="hand" x1="32" y1="32" x2="39" y2="35"></line>';
  }
  function clockLabel(n, u) {
    var def = BY_N[n].request;
    var who = agentName(n);
    var what = def.type === 'plan' ? 'Plan review window for ' + who + '’s plan' : 'Time to answer ' + who + '’s question';
    var why = def.type === 'plan'
      ? 'If the window runs out, Ziki releases the award and the issue goes back to Open.'
      : 'If it runs out, Ziki releases ' + who + '’s claim because the owner did not answer.';
    if (u.level === 'overdue') why = 'The window has passed. Ziki’s own check releases the claim; this reminder does nothing on its own.';
    return what + ': ' + LEVELS[u.level].word.toLowerCase() + '. ' + why;
  }

  function needText(n) {
    var def = BY_N[n].request;
    var who = agentName(n);
    if (def.type === 'plan') return '<strong>' + who + ' wrote a plan and needs your approval before starting.</strong><span class="quote">' + esc(def.summary) + '</span>';
    if (def.type === 'question') return '<strong>' + who + ' asked you a question and is waiting for your answer.</strong><q>' + esc(def.body) + '</q>';
    return '<strong>' + who + ' needs a decision from you: ' + esc(def.label.toLowerCase()) + '.</strong><q>' + esc(def.body) + '</q>';
  }
  function stepLabel(n) {
    var t = BY_N[n].request.type;
    return t === 'plan' ? 'In progress · Plan review' : t === 'question' ? 'Question from your agent' : 'Escalation · ' + BY_N[n].request.label;
  }

  function actionButtons(n, where) {
    var def = BY_N[n].request;
    var who = agentName(n);
    var primary = def.type === 'plan'
      ? '<button class="btn primary" type="button" data-action="open-plan" data-n="' + n + '">Review plan</button>'
      : def.type === 'question'
        ? '<button class="btn primary" type="button" data-action="compose" data-mode="answer" data-n="' + n + '" data-where="' + where + '">Answer ' + who + '</button>'
        : '<button class="btn primary" type="button" data-action="compose" data-mode="reply" data-n="' + n + '" data-where="' + where + '">Reply to ' + who + '</button>';
    var note = '<button class="btn" type="button" data-action="compose" data-mode="note" data-n="' + n + '" data-where="' + where + '">Send a note to ' + who + '</button>';
    var open = where === 'pin' ? '<a class="btn quiet" href="#/issue/' + n + '">Open issue</a>' : '';
    return '<div class="actions">' + primary + note + open + '</div>';
  }

  function composer(n, where) {
    var c = state.compose;
    if (!c || c.n !== n || c.where !== where) return '';
    var who = agentName(n);
    var cfg = {
      answer: { label: 'Your answer to ' + who, send: 'Send answer', hint: 'Answers cannot be edited after they are sent. ' + who + ' continues as soon as it reads it.' },
      reply: { label: 'Your decision for ' + who, send: 'Send and resolve', hint: 'This resolves the escalation and ' + who + ' sees your reply.' },
      note: { label: 'Note to ' + who, send: 'Send note', hint: 'A steer note reaches ' + who + ' on its next heartbeat. It does not answer the request above.' }
    }[c.mode];
    return '<div class="compose" data-compose="' + n + '"><label for="compose-' + where + '">' + cfg.label + '</label>' +
      '<textarea id="compose-' + where + '" data-input="draft" rows="3">' + esc(state.draft) + '</textarea>' +
      (state.error ? '<p class="err" role="alert">' + esc(state.error) + '</p>' : '') +
      '<p class="hint">' + cfg.hint + '</p>' +
      '<div class="row-btns"><button class="btn primary" type="button" data-action="send" data-n="' + n + '">' + cfg.send + '</button>' +
      '<button class="btn" type="button" data-action="cancel-compose">Cancel</button></div></div>';
  }

  function overdueNote(n) {
    var u = urgency(n);
    if (!u || u.level !== 'overdue') return '';
    return '<p class="overdue-note">The response window has passed. Under Ziki’s current rules the claim is released when its next check runs. This box only reminds you; it does not release anything.</p>';
  }

  function pinned() {
    var list = waiting();
    if (!list.length) { state.lastPinned = null; return '<p class="calm" data-pin="none">Nothing in progress needs your decision right now.</p>'; }
    var i = list[0];
    var others = list.slice(1);
    var entering = state.lastPinned !== i.n; // animate only when a different issue is pinned
    state.lastPinned = i.n;
    return '<section class="pin' + (entering ? ' enter' : '') + '" aria-labelledby="pin-title" data-pin="' + i.n + '">' +
      '<div class="pin-top"><span class="chip needs">Needs you</span><span>' + esc(stepLabel(i.n)) + '</span>' +
      (list.length > 1 ? '<span>· 1 of ' + list.length + ' waiting on you</span>' : '') + '</div>' +
      '<div class="pin-body"><div>' +
      '<h2 id="pin-title"><a href="#/issue/' + i.n + '">' + esc(i.title) + '</a></h2>' +
      '<p class="pin-meta"><span>#' + i.n + '</span><span>Zedu · Your App</span><span class="who">' + avatar(i.agent, 'sm') + agentName(i.n) + ' <span class="chip">your agent</span></span></p>' +
      '<p class="need">' + needText(i.n) + '</p></div>' + clock(i.n) + '</div>' +
      overdueNote(i.n) + actionButtons(i.n, 'pin') + composer(i.n, 'pin') +
      (others.length ? '<p class="more">Also waiting on you: ' + others.map(function (o) { return '<a href="#/issue/' + o.n + '">#' + o.n + ' ' + esc(o.title) + '</a>'; }).join(', ') + '</p>' : '') +
      '</section>';
  }

  function listView(r) {
    var body;
    if (r.tab === 'progress') {
      body = '<div class="card board">' + rail(r.list) + '<div class="main">' + (r.list === 'in-progress' ? pinned() : '') + table(r.list) + '</div></div>';
    } else {
      body = '<div class="card board" style="grid-template-columns:1fr"><div class="main">' + table(r.list) + '</div></div>';
    }
    return tabs(r.tab) + body;
  }

  function backTarget(i) {
    if (i.list === 'ideas') return { href: '#/ideas', label: 'Ideas' };
    if (i.list === 'delivered') return { href: '#/delivered', label: 'Delivered' };
    return { href: '#/issues/' + i.list, label: LISTS[i.list] };
  }

  function issueView(n) {
    var i = BY_N[n];
    var back = backTarget(i);
    var r = state.req[n];
    var waitingPanel = '';
    if (r && r.pending) {
      waitingPanel = '<section class="panel waiting" aria-labelledby="wait-title"><h2 id="wait-title">Waiting on you</h2>' +
        '<div class="pin-body"><p class="need" style="margin-top:0">' + needText(n) + '</p>' + clock(n) + '</div>' +
        overdueNote(n) + actionButtons(n, 'issue') + composer(n, 'issue') + '</section>';
    } else if (i.agent && i.list === 'in-progress') {
      waitingPanel = '<section class="panel"><h2>' + agentName(n) + ' is working on this</h2><p class="note">Nothing here needs your decision.</p>' +
        '<div class="actions"><button class="btn" type="button" data-action="compose" data-mode="note" data-n="' + n + '" data-where="issue">Send a note to ' + agentName(n) + '</button></div>' + composer(n, 'issue') + '</section>';
    }
    var log = state.log[n] || [];
    return '<div class="card issue-page">' +
      '<a class="back" href="' + back.href + '">← ' + back.label + '</a>' +
      '<div class="issue-head"><h1 tabindex="-1" data-title>#' + n + ' ' + esc(i.title) + '</h1>' + statusCell(i) + '</div>' +
      '<p class="pin-meta"><span>Zedu · Your App</span><span>' + esc(i.kind) + '</span><span>' + esc(i.area) + '</span>' +
      (i.agent ? '<span class="who">' + avatar(i.agent, 'sm') + agentName(n) + '</span>' : '') + '</p>' +
      '<p class="desc">' + esc(i.desc) + '</p>' + waitingPanel +
      (log.length ? '<section class="panel"><h2>Activity</h2><ul class="log">' + log.map(function (e) {
        return '<li>' + avatar(e.who, 'sm') + '<span>' + esc(e.text) + '<br><span class="when">' + ago(e.at) + '</span></span></li>';
      }).join('') + '</ul></section>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ dialogs
  var dlg = document.getElementById('dlg');
  function showDialog(html) {
    dlg.innerHTML = '<div class="dlg-in">' + html + '</div>';
    if (!dlg.open) dlg.showModal();
    var x = dlg.querySelector('.dlg-x');
    if (x) x.focus();
  }
  function closeDialog() { if (dlg.open) dlg.close(); state.planMode = 'view'; state.planNote = ''; state.error = ''; }
  function head(title) { return '<div class="dlg-head"><h2 id="dlg-title">' + title + '</h2><button class="dlg-x" type="button" data-action="close-dialog" aria-label="Close">×</button></div>'; }

  function planDialog(n) {
    var def = BY_N[n].request;
    var r = state.req[n];
    var who = agentName(n);
    var sendBackLeft = 3 - r.round;
    var body = '<div class="dlg-body"><p>' + who + ' was awarded <strong>#' + n + ' ' + esc(BY_N[n].title) + '</strong>. Only you can approve its plan.</p>' +
      '<p class="quote" style="padding:10px 12px;background:var(--bg);border-radius:10px">' + esc(def.summary) + '</p>' +
      '<div><strong>Steps</strong><ol class="steps">' + def.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' +
      '<dl class="facts"><div><dt>Estimate</dt><dd>' + esc(def.estimate) + '</dd></div><div><dt>Risk</dt><dd>' + esc(def.risk) + '</dd></div><div><dt>Confidence</dt><dd>' + esc(def.confidence) + '</dd></div></dl>' +
      (state.planMode === 'send-back'
        ? '<div class="compose" style="margin:0"><label for="plan-note">What should ' + who + ' change?</label><textarea id="plan-note" data-input="plan-note" rows="3">' + esc(state.planNote) + '</textarea>' +
          (state.error ? '<p class="err" role="alert">' + esc(state.error) + '</p>' : '') +
          '<p class="hint">' + who + ' revises and resubmits. The review window starts again.</p></div>'
        : '') +
      '<p class="note">Simulated. Approving or sending back only changes this demo.</p></div>';
    var foot = state.planMode === 'send-back'
      ? '<div class="dlg-foot"><button class="btn" type="button" data-action="plan-mode" data-mode="view">Back</button><button class="btn primary" type="button" data-action="send-back" data-n="' + n + '">Send back</button></div>'
      : '<div class="dlg-foot">' + (sendBackLeft > 0 ? '<button class="btn" type="button" data-action="plan-mode" data-mode="send-back">Send back with a note</button>' : '') +
        '<button class="btn primary" type="button" data-action="approve-plan" data-n="' + n + '">Approve plan</button></div>';
    showDialog(head(who + '’s plan for #' + n) + body + foot);
  }

  function aboutDialog() {
    showDialog(head('About this demo') + '<div class="dlg-body">' +
      '<p>When an agent needs a person, the issue is pinned at the top of <strong>In Progress</strong>, above the usual list, with a colour countdown instead of numbers.</p>' +
      '<ul class="legend">' +
      '<li><i style="background:var(--u-green)"></i>Green: plenty of time</li>' +
      '<li><i style="background:var(--u-yellow)"></i>Yellow: the deadline is approaching</li>' +
      '<li><i style="background:var(--u-orange)"></i>Orange: the deadline is getting close</li>' +
      '<li><i style="background:var(--u-red)"></i>Red: almost out of time, or overdue (shown with “!”)</li></ul>' +
      '<p>A countdown only appears when Ziki has a real response deadline: an agent’s question to you, or a plan waiting for your review. Escalations have no deadline, so they show none.</p>' +
      '<p>Use <strong>Preview urgency</strong> in the dark bar to see each colour. It moves this demo’s clock only.</p>' +
      '<p class="note">All issues, agents and replies are examples. Nothing is saved or sent, and nothing here touches real Ziki. Deadlines are stored in this browser, so a refresh continues the same countdown. “Reset demo” starts over.</p>' +
      '</div><div class="dlg-foot"><button class="btn primary" type="button" data-action="close-dialog">Got it</button></div>');
  }

  // ------------------------------------------------------------------ render
  var app = document.getElementById('app');
  function render() {
    var r = route();
    // Keep typing undisturbed if something re-renders while a text box has focus.
    var active = document.activeElement;
    var typing = active && app.contains(active) && active.dataset.input ? { input: active.dataset.input, start: active.selectionStart, end: active.selectionEnd } : null;
    app.innerHTML = r.view === 'issue' ? issueView(r.n) : listView(r);
    if (typing && !state.focus) {
      var box = app.querySelector('[data-input="' + typing.input + '"]');
      if (box) { box.focus(); box.setSelectionRange(typing.start, typing.end); }
    }
    document.querySelectorAll('[data-action="preview"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.level === state.preview)); });
    if (state.focus) {
      var el = app.querySelector(state.focus);
      state.focus = null;
      if (el) el.focus();
    }
    if (dlg.open && dlg.dataset.plan) planDialog(Number(dlg.dataset.plan));
  }

  // Refresh only the clocks, so the ring animates smoothly between states.
  function tick() {
    var top = waiting()[0];
    var shown = app.querySelector('[data-pin]');
    if (shown && top && shown.getAttribute('data-pin') !== String(top.n)) return render();
    app.querySelectorAll('[data-clock]').forEach(function (el) {
      var n = Number(el.getAttribute('data-clock'));
      if (!n) return;
      var u = urgency(n);
      if (!u) return;
      var wasOverdue = el.getAttribute('data-level') === 'overdue';
      if ((u.level === 'overdue') !== wasOverdue) return render();
      var label = clockLabel(n, u);
      el.className = 'clock u-' + u.level;
      el.setAttribute('data-level', u.level);
      el.setAttribute('title', label);
      el.querySelector('.ring').setAttribute('aria-label', label);
      el.querySelector('.arc').setAttribute('stroke-dashoffset', (100 - u.share * 100).toFixed(2));
      el.querySelector('.word').textContent = LEVELS[u.level].word;
    });
  }
  function startTimer() {
    stopTimer();
    timer = setInterval(tick, 15000);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  // ------------------------------------------------------------------ actions
  function after(ms, fn) {
    var e = epoch;
    setTimeout(function () { if (e === epoch) { fn(); render(); } }, ms);
  }
  function resolveRequest(n, outcome) {
    state.req[n].pending = false;
    state.req[n].outcome = outcome;
    state.compose = null; state.draft = ''; state.error = '';
    state.flash = n;
    var next = waiting()[0];
    state.focus = route().view === 'issue' ? '[data-title]' : next ? '#pin-title a' : '[data-pin]';
    var e = epoch;
    setTimeout(function () {
      if (e !== epoch) return;
      state.flash = null;
      var row = app.querySelector('.row.flash');
      if (row) row.classList.remove('flash');
    }, 1500);
  }

  var actions = {
    reset: function () {
      epoch += 1;
      writeStore(KEY_BASE, null);
      base = loadBase();
      state = fresh();
      closeDialog();
      history.replaceState(null, '', location.pathname + location.search);
      render();
      startTimer();
      toast('Demo reset. The example deadlines start again from now.');
    },
    about: aboutDialog,
    'close-dialog': function () { delete dlg.dataset.plan; closeDialog(); },
    preview: function (d) {
      state.preview = d.level;
      if (d.level === 'live') { state.offset = 0; render(); toast('Showing real time again.'); return; }
      var target = waiting().filter(function (i) { return deadlineOf(i.n); })[0];
      if (!target) { state.preview = 'live'; state.offset = 0; render(); toast('No request waiting on you has a deadline, so there is no countdown to preview.'); return; }
      var dl = deadlineOf(target.n);
      state.offset = Math.round(dl.end - PREVIEW_SHARE[d.level] * (dl.end - dl.start) - Date.now());
      render();
      toast('Preview: ' + LEVELS[d.level].word.toLowerCase() + '. Only this demo’s clock moved.');
    },
    compose: function (d) {
      state.compose = { n: Number(d.n), mode: d.mode, where: d.where };
      state.draft = ''; state.error = '';
      state.focus = '[data-compose] textarea';
      render();
    },
    'cancel-compose': function () { state.compose = null; state.draft = ''; state.error = ''; render(); },
    send: function (d) {
      var n = Number(d.n);
      var c = state.compose;
      var text = state.draft.trim();
      if (!text) { state.error = 'Write something first.'; state.focus = '[data-compose] textarea'; render(); return; }
      var who = agentName(n);
      if (c.mode === 'note') {
        addLog(n, 'you', 'You sent ' + who + ' a note: “' + text + '”');
        state.compose = null; state.draft = ''; state.error = '';
        render();
        toast('Note sent to ' + who + ' (simulated). The request above still needs you.');
        return;
      }
      if (c.mode === 'answer') {
        addLog(n, 'you', 'You answered ' + who + ': “' + text + '”');
        resolveRequest(n, 'answered');
        render();
        toast('Answer sent to ' + who + ' (simulated).');
        after(1200, function () { addLog(n, BY_N[n].agent, who + ' read your answer and carried on'); });
        return;
      }
      addLog(n, 'you', 'You resolved ' + who + '’s escalation: “' + text + '”');
      resolveRequest(n, 'resolved');
      render();
      toast('Escalation resolved (simulated). ' + who + ' sees your reply.');
    },
    'open-plan': function (d) { dlg.dataset.plan = d.n; state.planMode = 'view'; state.planNote = ''; state.error = ''; planDialog(Number(d.n)); },
    'plan-mode': function (d) { state.planMode = d.mode; state.error = ''; planDialog(Number(dlg.dataset.plan)); var t = dlg.querySelector('textarea'); if (t) t.focus(); },
    'approve-plan': function (d) {
      var n = Number(d.n);
      delete dlg.dataset.plan; closeDialog();
      addLog(n, 'you', 'You approved ' + agentName(n) + '’s plan');
      resolveRequest(n, 'approved');
      render();
      toast('Plan approved (simulated). ' + agentName(n) + ' starts work.');
    },
    'send-back': function (d) {
      var n = Number(d.n);
      var note = state.planNote.trim();
      if (!note) { state.error = 'Say what should change.'; planDialog(n); dlg.querySelector('textarea').focus(); return; }
      var who = agentName(n);
      delete dlg.dataset.plan; closeDialog();
      addLog(n, 'you', 'You sent ' + who + '’s plan back: “' + note + '”');
      resolveRequest(n, 'sent-back');
      render();
      toast('Plan sent back (simulated). ' + who + ' is revising it.');
      after(2000, function () {
        var r = state.req[n];
        r.round += 1;
        r.start = (now() - base) / MIN;
        r.pending = true;
        r.outcome = null;
        addLog(n, BY_N[n].agent, who + ' resubmitted the plan with your changes');
        toast(who + ' resubmitted its plan. The review window started again.');
      });
    }
  };
  window.ZKDemo = {
    actions: Object.keys(actions),
    timers: function () { return timer ? 1 : 0; }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el.dataset); }
  });
  document.addEventListener('input', function (e) {
    if (e.target.dataset.input === 'draft') state.draft = e.target.value;
    if (e.target.dataset.input === 'plan-note') state.planNote = e.target.value;
  });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) { delete dlg.dataset.plan; closeDialog(); } });
  dlg.addEventListener('close', function () { delete dlg.dataset.plan; });
  window.addEventListener('hashchange', function () {
    if (dlg.open) { delete dlg.dataset.plan; closeDialog(); }
    state.compose = null; state.draft = ''; state.error = '';
    if (route().view === 'issue') state.focus = '[data-title]';
    render();
    window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopTimer(); else { tick(); startTimer(); }
  });
  window.addEventListener('pagehide', stopTimer);

  state = fresh();
  render();
  startTimer();
})();
