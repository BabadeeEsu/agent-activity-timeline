// Agent Work Recovery: interactive proposal demo.
//
// Everything here is simulated. There is no network access, no account, no storage: state lives in
// memory and resets when the page is reloaded or "Reset demo" is pressed. Example people, tasks and
// agents are invented.
(() => {
  'use strict';

  // ------------------------------------------------------------------ example data
  const AGENTS = {
    atlas: { name: 'Atlas', role: 'Builder agent', tone: 'info' },
    nova: { name: 'Nova', role: 'Builder agent', tone: 'ok' },
    kite: { name: 'Kite', role: 'Builder agent', tone: 'warn' },
    orbit: { name: 'Orbit', role: 'Reviewer agent', tone: 'plain' }
  };

  const TASKS = {
    142: {
      title: 'Fix checkout rounding',
      summary: 'Cart totals are off by one cent when a discount and tax apply together.',
      agent: 'atlas', startPhase: 'proposal', updated: '4 min ago', pr: 'PR #87 (draft)',
      completed: ['Rounding helper written (rounds per line, not per order)', '12 unit tests passing', 'Pull request #87 opened on branch fix/rounding'],
      remaining: ['Use the helper in the checkout total', 'Update the cart summary to match', 'Run the full checkout test suite'],
      context: ['Tax must round per line item, not per order', 'Branch fix/rounding, PR #87 (draft)', 'Test code SAVE10 reproduces the bug'],
      next: ['Start in cart/total.ts', 'Re-run the checkout tests', 'Mark PR #87 ready for review'],
      verify: 'Branch fix/rounding and PR #87 match the brief',
      proposal: { reason: 'I am close to my run budget and cannot finish this safely. Another agent can pick it up from the notes below.', when: '4 min ago' },
      briefSource: 'Written by Atlas',
      candidates: [
        { id: 'nova', rec: true, avail: 'Available', why: 'Wrote this project’s checkout tests' },
        { id: 'orbit', avail: 'Available', why: 'Reviews code changes' }
      ],
      log: [
        { who: 'atlas', title: 'Atlas proposed a handover', desc: 'Nearing the run budget', when: '4 min ago' },
        { who: 'atlas', title: 'Atlas pushed 3 commits to fix/rounding', when: '38 min ago' },
        { who: 'atlas', title: 'Atlas started this task', when: '2 h ago' }
      ]
    },
    138: {
      title: 'Add address validation',
      summary: 'Checkout accepts malformed postcodes, which later fail at shipping.',
      agent: 'nova', startPhase: 'working', updated: '25 min ago', pr: 'No pull request yet',
      completed: ['Postcode rules for 4 countries', 'Error message copy approved'],
      remaining: ['Connect validation to the checkout form', 'Add tests for blank and invalid addresses'],
      context: ['Uses the shared form components', 'Design approved in the task thread'],
      next: ['Start in checkout/AddressForm.tsx', 'Reuse the existing error styles'],
      verify: 'The postcode rules file matches the brief',
      briefSource: 'Prepared from Nova’s recorded progress',
      candidates: [
        { id: 'orbit', rec: true, avail: 'Available', why: 'Knows the shared form components' },
        { id: 'atlas', avail: 'Busy, finishing #142', why: 'Has worked in the checkout code' }
      ],
      log: [
        { who: 'nova', title: 'Nova added postcode rules for 4 countries', when: '25 min ago' },
        { who: 'nova', title: 'Nova started this task', when: '1 h ago' }
      ]
    },
    151: {
      title: 'Send order confirmation emails',
      summary: 'Customers should get an email as soon as an order is placed.',
      agent: 'kite', startPhase: 'stalled', updated: '3 h 20 min ago', pr: 'No pull request yet',
      completed: ['Email template built and approved', 'Order data connected to the template'],
      remaining: ['Connect to the mail provider', 'Send one test email', 'Handle failed sends'],
      context: ['The mail provider allows 5 requests per minute on the current plan', 'Template lives in emails/confirmation.tsx'],
      next: ['Add a retry with a delay between attempts', 'Send one test email before continuing'],
      verify: 'The template and order data match the brief',
      blocker: 'The mail provider returned “429 rate limited” on the last 3 attempts.',
      lastActivity: 'Kite commented “Retrying the mail provider…”',
      lastWhen: '3 h 20 min ago',
      stalledFor: '3 h 20 min',
      resumeReply: 'Resuming. I will retry the mail provider with a delay between attempts.',
      briefSource: 'Assembled from Kite’s recorded work, because Kite is not responding',
      candidates: [
        { id: 'orbit', rec: true, avail: 'Available', why: 'Free right now' },
        { id: 'nova', avail: 'Busy, working on #138', why: 'Knows the checkout flow' }
      ],
      log: [
        { who: 'kite', title: 'Kite commented “Retrying the mail provider…”', when: '3 h 20 min ago' },
        { who: 'kite', title: 'Kite connected order data to the template', when: '4 h ago' },
        { who: 'kite', title: 'Kite started this task', when: '5 h ago' }
      ]
    }
  };
  const IDS = ['142', '138', '151'];

  const PHASES = {
    working: { label: 'In progress', tone: 'info' },
    proposal: { label: 'Handover proposed', tone: 'warn' },
    approved: { label: 'Handover approved', tone: 'ok' },
    rejected: { label: 'Proposal rejected', tone: 'plain' },
    handed: { label: 'Handed over', tone: 'ok' },
    stalled: { label: 'Stalled', tone: 'bad' },
    resumed: { label: 'Resumed', tone: 'ok' }
  };

  // ------------------------------------------------------------------ state
  let epoch = 0;
  function fresh() {
    epoch += 1;
    const tasks = {};
    for (const id of IDS) {
      const d = TASKS[id];
      tasks[id] = { phase: d.startPhase, assignee: d.agent, prev: null, updated: d.updated, continued: false, log: d.log.map((e) => ({ ...e })) };
    }
    return { epoch, tasks, dialog: null, busy: null, focus: null };
  }
  let state = fresh();

  const $ = (selector, root = document) => root.querySelector(selector);
  const app = $('#app');
  const dlg = $('#dlg');
  const narrow = window.matchMedia('(max-width: 859px)');

  // ------------------------------------------------------------------ small helpers
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const items = (list) => list.map((x) => `<li>${esc(x)}</li>`).join('');
  const chip = (phase) => `<span class="chip ${PHASES[phase].tone}">${PHASES[phase].label}</span>`;
  const avatar = (who, size = '') => {
    if (who === 'you') return `<span class="avatar you ${size}" aria-hidden="true">Y</span>`;
    const a = AGENTS[who];
    return `<span class="avatar ${a.tone} ${size}" aria-hidden="true">${a.name[0]}</span>`;
  };
  const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m0 0l-5-5m5 5l-5 5"/></svg>';

  function toast(message) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    box.append(el);
    while (box.children.length > 1) box.firstChild.remove(); // one message at a time keeps the screen calm
    setTimeout(() => el.remove(), 4000);
  }
  const log = (id, who, title, desc) => {
    const t = state.tasks[id];
    t.log.unshift({ who, title, desc, when: 'just now' });
    t.updated = 'just now';
  };

  // ------------------------------------------------------------------ routing: #/task/142
  function selectedId() {
    const match = location.hash.match(/^#\/task\/(\d+)$/);
    if (match && TASKS[match[1]]) return match[1];
    return narrow.matches ? null : IDS[0];
  }

  // ------------------------------------------------------------------ views
  function renderList(selected) {
    return `<nav class="card list" aria-label="Tasks"><h2>Tasks</h2><ul>${IDS.map((id) => {
      const t = state.tasks[id];
      const a = AGENTS[t.assignee];
      return `<li><a class="item" href="#/task/${id}" data-key="task-${id}"${selected === id ? ' aria-current="page"' : ''}>
        <span class="item-title">#${id} ${esc(TASKS[id].title)}</span>
        <span class="item-row">${avatar(t.assignee, 'sm')}<span>${a.name}</span>${chip(t.phase)}</span></a></li>`;
    }).join('')}</ul></nav>`;
  }

  function head(id) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const a = AGENTS[t.assignee];
    const canHandOver = t.phase === 'working' || t.phase === 'resumed';
    return `<section class="card head">
      <a class="back" href="#/" data-key="back">&larr; All tasks</a>
      <div class="head-row"><h1 id="task-title" tabindex="-1" data-title>#${id} ${esc(d.title)}</h1>${chip(t.phase)}</div>
      <p class="sub">${esc(d.summary)}</p>
      <div class="meta"><span class="who">${avatar(t.assignee)}${a.name}<span class="tag">${a.role}</span></span><span>Updated ${esc(t.updated)}</span><span>${esc(d.pr)}</span></div>
      ${canHandOver ? `<div class="actions"><button class="btn" type="button" data-action="open-handover" data-id="${id}" data-origin="initiated" data-key="handover">Hand over to another agent</button></div>` : ''}
    </section>`;
  }

  function banner(id) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const from = AGENTS[t.prev || t.assignee]?.name;
    const to = AGENTS[t.assignee].name;
    const make = (tone, title, text, button) => `<section class="banner ${tone}" data-banner tabindex="-1" aria-label="${esc(title)}"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>${button || ''}</section>`;
    switch (t.phase) {
      case 'proposal':
        return make('warn', `${to} proposed a handover`, `${to} wants to stop work on this task and pass it on. Review the proposal to approve or reject it.`,
          `<button class="btn primary" type="button" data-action="open-proposal" data-id="${id}" data-key="proposal">Review proposal</button>`);
      case 'approved':
        return make('ok', 'Handover approved', `Next, choose which agent continues and check the continuation brief.`,
          `<button class="btn primary" type="button" data-action="open-handover" data-id="${id}" data-origin="approved" data-key="choose">Choose receiving agent</button>`);
      case 'rejected':
        return make('plain', 'Proposal rejected', `${to} keeps the task and continues working on it.`,
          `<button class="btn" type="button" data-action="open-proposal" data-id="${id}" data-key="proposal">Review proposal again</button>`);
      case 'handed':
        return make('ok', `Handed over to ${to}`, `${to} received the continuation brief and continues from where ${from} stopped.`);
      case 'resumed':
        return make('ok', `${to} resumed work`, `Simulated reply from ${to}: “${d.resumeReply}”`);
      default:
        return '';
    }
  }

  function progress(id) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const live = t.continued && t.phase === 'handed';
    return `<section class="card"><h2>Progress</h2><div class="cols">
      <div><h3>Done</h3><ul>${d.completed.map((x) => `<li class="tick">${esc(x)}</li>`).join('')}</ul></div>
      <div><h3>Still to do</h3><ul>${d.remaining.map((x, i) => `<li class="circle${live && i === 0 ? ' is-active' : ''}">${esc(x)}${live && i === 0 ? `<span class="tag live">${AGENTS[t.assignee].name} is on it</span>` : ''}</li>`).join('')}</ul></div>
    </div></section>`;
  }

  function activity(id) {
    const t = state.tasks[id];
    return `<section class="card"><h2>Activity</h2><ul class="log">${t.log.map((e) => `<li>${avatar(e.who, 'sm')}<div><b>${esc(e.title)}</b>${e.desc ? `<span class="desc">${esc(e.desc)}</span>` : ''}<span class="when">${esc(e.when)}</span></div></li>`).join('')}</ul></section>`;
  }

  function stalled(id) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const name = AGENTS[t.assignee].name;
    const busy = state.busy && state.busy.id === id;
    return `<section class="card" aria-labelledby="stall-title">
      <header class="head-row"><h2 id="stall-title">This task looks stalled</h2><span class="chip bad">No progress for ${esc(d.stalledFor)}</span></header>
      <dl class="facts">
        <dt>Status</dt><dd>Stalled. ${name} has not reported progress for ${esc(d.stalledFor)}.</dd>
        <dt>Last activity</dt><dd>${esc(d.lastActivity)} · ${esc(d.lastWhen)}</dd>
        <dt>Known blocker</dt><dd>${esc(d.blocker)}</dd>
        <dt>Completed work</dt><dd>${esc(d.completed.map((x, i) => (i ? x[0].toLowerCase() + x.slice(1) : x)).join('; '))}.</dd>
      </dl>
      <h3 class="sec">Recovery options</h3>
      <div class="opts">
        <div class="opt"><h3>Ask ${name} to resume</h3><p>${name} keeps the task and everything it has already done.</p>
          <button class="btn primary" type="button" data-action="request-resume" data-id="${id}" data-key="resume"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? 'Sending request…' : 'Request resume'}</button></div>
        <div class="opt"><h3>Review a handover</h3><p>Pass the task to another agent with a continuation brief. Best if ${name} is not responding.</p>
          <button class="btn" type="button" data-action="open-handover" data-id="${id}" data-origin="recovery" data-key="review-handover"${busy ? ' disabled' : ''}>Review handover</button></div>
      </div>
    </section>`;
  }

  function continuation(id) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const from = AGENTS[t.prev];
    const to = AGENTS[t.assignee];
    const skipped = d.completed.length;
    return `<section class="card cont" aria-labelledby="cont-title">
      <header class="head-row"><h2 id="cont-title">What ${to.name} inherited</h2><span class="flow">${avatar(t.prev, 'sm')}${from.name}${arrow}${avatar(t.assignee, 'sm')}${to.name}</span></header>
      <p class="sub">${to.name} starts from the continuation brief, so finished work is not repeated.</p>
      <div class="cols">
        <div><p class="col-head">${avatar(t.prev, 'sm')} Inherited from ${from.name}</p>
          <div class="block"><h3>Completed work</h3><ul>${items(d.completed)}</ul></div>
          <div class="block"><h3>Context</h3><ul>${items(d.context)}</ul></div></div>
        <div><p class="col-head">${avatar(t.assignee, 'sm')} ${to.name} continues with</p>
          <div class="block"><h3>Unfinished work</h3><ul>${items(d.remaining)}</ul></div>
          <div class="block"><h3>Recommended next steps</h3><ol>${items(d.next)}</ol></div></div>
      </div>
      ${t.continued
        ? `<div class="steps" data-steps tabindex="-1"><h3>${to.name}’s first steps</h3><ul>
            <li class="tick">Read the continuation brief</li>
            <li class="tick">Checked the current state in Ziki: ${esc(d.verify)}</li>
            <li class="tick">Skipped ${skipped} finished items instead of repeating them</li>
            <li class="circle is-active">Started: ${esc(d.remaining[0])}</li></ul></div>`
        : `<div class="actions" style="margin-top:16px"><button class="btn" type="button" data-action="simulate-continue" data-id="${id}" data-key="continue">See ${to.name}’s first steps</button></div>`}
    </section>`;
  }

  function renderDetail(id) {
    const t = state.tasks[id];
    return `<main class="detail" id="detail" aria-label="Task details">${head(id)}${banner(id)}${t.phase === 'stalled' ? stalled(id) : ''}${t.phase === 'handed' ? continuation(id) : ''}<div class="two">${progress(id)}${activity(id)}</div></main>`;
  }

  function render() {
    const selected = selectedId();
    app.dataset.view = narrow.matches ? (selected ? 'detail' : 'list') : 'both';
    const keep = document.activeElement && app.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    app.innerHTML = renderList(selected) + (selected ? renderDetail(selected) : '');
    const wanted = state.focus;
    const target = wanted ? $(wanted, app) : keep ? $(`[data-key="${keep}"]`, app) : null;
    state.focus = null;
    // Scroll to something we moved focus to on purpose; leave the page alone when just restoring focus.
    if (target && !target.disabled) target.focus({ preventScroll: !wanted });
  }

  // ------------------------------------------------------------------ dialogs
  const block = (title, body, wide) => `<section class="block${wide ? ' wide' : ''}"><h3>${title}</h3>${body}</section>`;

  function proposalDialog(id) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const a = AGENTS[t.assignee];
    return `<div class="dlg-in">
      <div class="dlg-head"><h2 id="dlg-title">Handover proposal</h2><button class="btn quiet dlg-x" type="button" data-action="close-dialog" aria-label="Close" data-key="x">&times;</button></div>
      <p class="lead">${avatar(t.assignee)}<span><strong>${a.name}</strong> proposes handing over <strong>#${id} ${esc(d.title)}</strong> · ${esc(d.proposal.when)}</span></p>
      <div class="grid">
        ${block('Reason', `<p>${esc(d.proposal.reason)}</p>`, true)}
        ${block('Completed work', `<ul>${items(d.completed)}</ul>`)}
        ${block('Remaining work', `<ul>${items(d.remaining)}</ul>`)}
        ${block('Recommended next steps', `<ol>${items(d.next)}</ol>`, true)}
      </div>
      <p class="sim">Simulated. Your choice only changes this demo; nothing is sent to Ziki.</p>
      <div class="dlg-foot">
        <button class="btn danger" type="button" data-action="reject" data-id="${id}">Reject</button>
        <button class="btn primary" type="button" data-action="approve" data-id="${id}">Approve handover</button>
      </div></div>`;
  }

  function handoverDialog({ id, origin, agent }) {
    const d = TASKS[id];
    const t = state.tasks[id];
    const out = AGENTS[t.assignee];
    const to = AGENTS[agent];
    const intro = {
      approved: `You approved ${out.name}’s proposal. Choose who continues.`,
      initiated: 'You are starting this handover, so your confirmation is the approval.',
      recovery: `You are starting this handover because ${out.name} looks stalled. Your confirmation is the approval.`
    }[origin];
    return `<div class="dlg-in">
      <div class="dlg-head"><h2 id="dlg-title">Hand over #${id} · ${esc(d.title)}</h2><button class="btn quiet dlg-x" type="button" data-action="close-dialog" aria-label="Close" data-key="x">&times;</button></div>
      <p class="lead">${esc(intro)}</p>
      <div class="route">
        <div><span class="label">Outgoing agent</span><div class="agent-card out">${avatar(t.assignee)}<span><span class="name">${out.name}</span><span class="sub">${out.role} · stops after handover</span></span></div></div>
        ${arrow}
        <fieldset class="pick"><legend class="label">Receiving agent</legend>
          ${d.candidates.map((c) => {
            const a = AGENTS[c.id];
            const on = c.id === agent;
            return `<label class="agent-card agent-opt${on ? ' is-on' : ''}"><input type="radio" name="agent" value="${c.id}" data-action="select-agent"${on ? ' checked' : ''}>${avatar(c.id)}<span><span class="name">${a.name}${c.rec ? '<span class="badge">Recommended</span>' : ''}</span><span class="sub">${a.role} · ${esc(c.avail)}</span><span class="sub">${esc(c.why)}</span></span></label>`;
          }).join('')}
        </fieldset>
      </div>
      <div class="brief-title"><h3>Continuation brief</h3><span>${esc(d.briefSource)}. ${to.name} will check the current state before continuing.</span></div>
      <div class="grid">
        ${block('Completed work', `<ul>${items(d.completed)}</ul>`)}
        ${block('Context', `<ul>${items(d.context)}</ul>`)}
        ${block('Unfinished work', `<ul>${items(d.remaining)}</ul>`)}
        ${block('Recommended next steps', `<ol>${items(d.next)}</ol>`)}
      </div>
      <p class="sim">Simulated. Confirming only changes this demo; nothing is sent to Ziki.</p>
      <div class="dlg-foot">
        <button class="btn" type="button" data-action="close-dialog">Cancel</button>
        <button class="btn primary" type="button" data-action="confirm-handover" data-key="confirm">Confirm handover to ${to.name}</button>
      </div></div>`;
  }

  function aboutDialog() {
    return `<div class="dlg-in">
      <div class="dlg-head"><h2 id="dlg-title">About this demo</h2><button class="btn quiet dlg-x" type="button" data-action="close-dialog" aria-label="Close" data-key="x">&times;</button></div>
      <div class="grid">
        ${block('What it is', '<p>A proposal for Agent Work Recovery: a way to hand a task from one agent to another, or recover a stalled one, without losing the work already done.</p>', true)}
        ${block('Try these', '<ul><li><strong>#142</strong>: review an agent’s handover proposal</li><li><strong>#138</strong>: hand a task to another agent</li><li><strong>#151</strong>: recover a stalled task</li></ul>')}
        ${block('What is simulated', '<p>All tasks, agents and replies are examples. Nothing is saved or sent, and nothing here touches real Ziki. Use “Reset demo” to start over.</p>')}
      </div>
      <div class="dlg-foot"><button class="btn primary" type="button" data-action="close-dialog">Got it</button></div></div>`;
  }

  function showDialog(content, focusSelector) {
    dlg.innerHTML = content;
    if (!dlg.open) dlg.showModal();
    const target = focusSelector && $(focusSelector, dlg);
    if (target) target.focus();
  }
  function closeDialog() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => { state.dialog = null; });
  dlg.addEventListener('click', (event) => { if (event.target === dlg) closeDialog(); });

  // ------------------------------------------------------------------ actions (every control in the demo is listed here)
  const actions = {
    reset() {
      closeDialog();
      state = fresh();
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      render();
      window.scrollTo(0, 0);
      toast('Demo reset. All tasks are back to their starting state.');
    },
    about() {
      state.dialog = { kind: 'about' };
      showDialog(aboutDialog());
    },
    'close-dialog': closeDialog,

    // A. human-approved handover
    'open-proposal'({ id }) {
      state.dialog = { kind: 'proposal', id };
      showDialog(proposalDialog(id));
    },
    approve({ id }) {
      const a = AGENTS[state.tasks[id].assignee].name;
      state.tasks[id].phase = 'approved';
      log(id, 'you', `You approved ${a}’s handover proposal`, 'Next: choose the receiving agent');
      state.focus = '[data-banner]';
      closeDialog();
      render();
      toast(`Handover approved. ${a} will stop once a new agent is chosen.`);
    },
    reject({ id }) {
      const a = AGENTS[state.tasks[id].assignee].name;
      state.tasks[id].phase = 'rejected';
      log(id, 'you', `You rejected ${a}’s handover proposal`, `${a} keeps the task`);
      state.focus = '[data-banner]';
      closeDialog();
      render();
      toast(`Proposal rejected. ${a} keeps working on the task.`);
    },

    // B. agent handover
    'open-handover'({ id, origin }) {
      const rec = TASKS[id].candidates.find((c) => c.rec) || TASKS[id].candidates[0];
      state.dialog = { kind: 'handover', id, origin, agent: rec.id };
      showDialog(handoverDialog(state.dialog));
    },
    'select-agent'(data, el) {
      if (!state.dialog || state.dialog.kind !== 'handover') return;
      state.dialog.agent = el.value;
      showDialog(handoverDialog(state.dialog), `input[value="${el.value}"]`);
    },
    'confirm-handover'() {
      const { id, agent } = state.dialog;
      const t = state.tasks[id];
      const from = AGENTS[t.assignee].name;
      const to = AGENTS[agent].name;
      t.prev = t.assignee;
      t.assignee = agent;
      t.phase = 'handed';
      t.continued = false;
      log(id, 'you', `You handed this task over from ${from} to ${to}`, 'Continuation brief attached');
      log(id, agent, `${to} received the continuation brief`, `Starting from where ${from} stopped`);
      state.focus = '[data-banner]';
      closeDialog();
      render();
      toast(`Handed over. ${to} now owns the task and has the brief.`);
    },
    'simulate-continue'({ id }) {
      const t = state.tasks[id];
      const d = TASKS[id];
      const to = AGENTS[t.assignee].name;
      t.continued = true;
      log(id, t.assignee, `${to} read the continuation brief`);
      log(id, t.assignee, `${to} checked the current state in Ziki`, d.verify);
      log(id, t.assignee, `${to} skipped ${d.completed.length} finished items`, 'Already done, so not repeated');
      log(id, t.assignee, `${to} started: ${d.remaining[0]}`);
      state.focus = '[data-steps]';
      render();
      toast(`${to} continues without repeating finished work.`);
    },

    // C. recover a stalled task
    'request-resume'({ id }) {
      if (state.busy) return;
      const ep = state.epoch;
      state.busy = { id };
      render();
      setTimeout(() => {
        if (state.epoch !== ep) return; // the demo was reset meanwhile
        const t = state.tasks[id];
        const name = AGENTS[t.assignee].name;
        state.busy = null;
        t.phase = 'resumed';
        log(id, 'you', `You asked ${name} to resume`);
        log(id, t.assignee, `${name} resumed work`, `“${TASKS[id].resumeReply}” (simulated reply)`);
        state.focus = '[data-banner]';
        render();
        toast(`${name} resumed (simulated reply).`);
      }, 1100);
    }
  };
  window.ZKDemo = { actions: Object.keys(actions) }; // read by the browser tests to catch controls with no handler

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.matches('input') || el.disabled) return; // radios are handled on "change"
    const fn = actions[el.dataset.action];
    if (fn) fn(el.dataset, el);
  });
  document.addEventListener('change', (event) => {
    const el = event.target.closest('input[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset, el);
  });

  window.addEventListener('hashchange', () => {
    closeDialog();
    state.focus = '[data-title]';
    render();
    window.scrollTo(0, 0);
  });
  narrow.addEventListener('change', render);

  render();
})();
