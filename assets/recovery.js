// <zk-work-recovery> — Agent Work Recovery.
//
// One custom element, no dependencies, rendered in the light DOM so it picks up the host page's
// --zk-* design tokens. It only talks to its own server routes (api-base, default /api). Those routes
// hold the Ziki agent key; nothing secret ever reaches this file.
//
// Three actions, nothing else:
//   1. Approve handover    — send the continuation brief and ask the owner to approve (saved in Ziki)
//   2. Hand over           — after approval, release the task so Ziki re-offers it
//   3. Recover a stalled task — read-only facts from Ziki, plus the options Ziki really supports

const REQUIRED = ['reason', 'completed', 'remaining', 'nextSteps'];

const FIELDS = [
  { key: 'reason', label: 'Why is this being handed over?', hint: 'One line.', rows: 2, wide: true },
  { key: 'completed', label: 'Completed so far', hint: 'What is done, and where to find it.', rows: 3, wide: true },
  { key: 'remaining', label: 'Remaining work', hint: 'What the next agent still has to do.', rows: 3, wide: true },
  { key: 'references', label: 'Files, branches and pull requests', hint: 'One per line.', rows: 3, wide: true },
  { key: 'tests', label: 'Test results', hint: 'Optional. What was run, and the outcome.', rows: 2 },
  { key: 'blockers', label: 'Known blockers', hint: 'Optional.', rows: 2 },
  { key: 'nextSteps', label: 'Next steps for the receiving agent', hint: 'Where to start.', rows: 2 },
  { key: 'needsApproval', label: 'Needs a human decision', hint: 'Optional.', rows: 2 }
];

// ---- tiny safe-HTML helpers: every interpolated value is escaped unless wrapped by html`` or raw() ----
class Raw {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const part = (value) => {
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
};
const html = (strings, ...values) => new Raw(strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? part(values[i]) : ''), ''));
const BUSY = html`aria-busy="true"`; // attributes must be passed as html``, plain strings are escaped

// ---- small formatters ----
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  } catch {
    /* not a URL */
  }
  return null;
};
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const span = (minutes) => (minutes < 1 ? 'under a minute' : minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`);
const ago = (iso) => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  return minutes < 1 ? 'just now' : `${span(minutes)} ago`;
};

const ERROR_TITLES = {
  agent_level_too_low: 'Permission denied',
  project_forbidden: 'Permission denied',
  forbidden: 'Permission denied',
  bad_request_origin: 'Request blocked',
  rate_limited: 'Too many requests',
  ziki_unavailable: 'Ziki is not responding',
  ziki_key_rejected: 'Ziki rejected the server’s agent key',
  not_found: 'Not found',
  conflict: 'Ziki could not do that now',
  brief_superseded: 'A newer brief exists',
  already_handed_over: 'Already handed over',
  invalid_brief: 'The brief needs changes',
  brief_not_saved: 'The brief was not saved',
  network: 'Cannot reach the server'
};
const describeError = (error) => ({
  title: ERROR_TITLES[error?.code] || (error?.status === 409 ? 'Cannot do that right now' : 'Something went wrong'),
  message: error?.message || 'Try again in a moment.'
});

class ApiFail extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class ZkWorkRecovery extends HTMLElement {
  constructor() {
    super();
    this.state = {
      screen: 'loading', // loading | unconfigured | signin | ready | failed
      config: { missing: [], problems: [] },
      signinError: null,
      agent: null,
      tasks: [],
      hasMore: false,
      tasksLoading: false,
      tasksError: null,
      selectedId: null,
      detail: null,
      detailLoading: false,
      detailError: null,
      busy: { request: false, execute: false },
      requestError: null,
      executeError: null,
      executeResult: null,
      fieldErrors: {},
      showForm: false,
      notice: '',
      loadedAt: 0
    };
    this.drafts = new Map();
    this.detailToken = 0;
  }

  get apiBase() {
    return (this.getAttribute('api-base') || '/api').replace(/\/$/, '');
  }

  connectedCallback() {
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('input', (e) => this.onInput(e));
    this.addEventListener('submit', (e) => this.onSubmit(e));
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && this.state.screen === 'ready' && this.state.selectedId && Date.now() - this.state.loadedAt > 15000) {
        this.loadDetail(this.state.selectedId, { silent: true });
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
    this.paint();
    this.boot();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  // ---------------------------------------------------------------- server calls
  async api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'zk-recovery' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${this.apiBase}${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiFail(0, 'network', 'Check your connection and try again.');
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* non-JSON body */
    }
    if (!response.ok) {
      const err = data?.error || {};
      const failure = new ApiFail(response.status, err.code || 'error', err.message || 'The server could not complete that request.', err);
      if (response.status === 401 && err.code === 'not_signed_in') this.signedOut('Your session ended. Sign in again.');
      throw failure;
    }
    return data;
  }

  signedOut(message) {
    this.detailToken += 1;
    Object.assign(this.state, { screen: 'signin', signinError: message || null, detail: null, tasks: [], agent: null });
    this.paint();
  }

  async boot() {
    try {
      const status = await this.api('/session');
      if (!status.configured) {
        this.state.config = { missing: status.missing || [], problems: status.problems || [] };
        this.state.screen = 'unconfigured';
        return this.paint();
      }
      if (!status.authenticated) {
        this.state.screen = 'signin';
        return this.paint();
      }
      this.state.screen = 'ready';
      this.paint();
      await this.loadTasks({ initial: true });
    } catch (error) {
      if (this.state.screen === 'signin') return;
      this.state.screen = 'failed';
      this.state.bootError = error;
      this.paint();
    }
  }

  async loadTasks({ initial = false } = {}) {
    this.state.tasksLoading = true;
    this.state.tasksError = null;
    this.paintTasks();
    try {
      const data = await this.api('/tasks');
      Object.assign(this.state, { agent: data.agent, tasks: data.items, hasMore: data.hasMore });
      this.paintAgent();
      if (initial && !this.state.selectedId) {
        // A task named by the host page (task-id) or by the URL (#task=...) is opened even if it is no longer
        // in the in-progress list, so a finished handover can still be read after a refresh.
        const fromHash = this.hasAttribute('chrome') ? decodeURIComponent((location.hash.match(/task=([^&]+)/) || [])[1] || '') : '';
        const wanted = this.getAttribute('task-id') || fromHash;
        const pick = wanted || data.items[0]?.id || null;
        if (pick) this.select(pick);
      }
    } catch (error) {
      if (this.state.screen === 'signin') return;
      this.state.tasksError = error;
    } finally {
      this.state.tasksLoading = false;
      this.paintTasks();
    }
  }

  async loadDetail(id, { silent = false } = {}) {
    const token = ++this.detailToken;
    if (!silent) {
      this.state.detail = null;
      this.state.detailLoading = true;
    }
    this.state.detailError = null;
    this.paintDetail();
    try {
      const data = await this.api(`/task?id=${encodeURIComponent(id)}`);
      if (token !== this.detailToken) return;
      this.state.detail = data;
      this.state.loadedAt = Date.now();
    } catch (error) {
      if (token !== this.detailToken || this.state.screen === 'signin') return;
      this.state.detailError = error;
    } finally {
      if (token === this.detailToken) {
        this.state.detailLoading = false;
        this.paintDetail();
      }
    }
  }

  select(id, { updateHash = true } = {}) {
    Object.assign(this.state, { selectedId: id, requestError: null, executeError: null, executeResult: null, fieldErrors: {}, showForm: false, notice: '' });
    if (updateHash && this.hasAttribute('chrome')) history.replaceState(null, '', `#task=${encodeURIComponent(id)}`);
    this.paintTasks();
    return this.loadDetail(id);
  }

  // ---------------------------------------------------------------- drafts (kept in this tab only)
  draftFor(issueId, prefill) {
    if (this.drafts.has(issueId)) return this.drafts.get(issueId);
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(`zrk-draft:${issueId}`) || 'null');
    } catch {
      /* storage unavailable */
    }
    const draft = { reason: '', completed: '', remaining: '', references: (prefill?.references || []).join('\n'), tests: '', blockers: '', nextSteps: '', needsApproval: '', ...(saved || {}) };
    this.drafts.set(issueId, draft);
    return draft;
  }

  saveDraft(issueId) {
    try {
      sessionStorage.setItem(`zrk-draft:${issueId}`, JSON.stringify(this.drafts.get(issueId)));
    } catch {
      /* storage unavailable */
    }
  }

  clearDraft(issueId) {
    this.drafts.delete(issueId);
    try {
      sessionStorage.removeItem(`zrk-draft:${issueId}`);
    } catch {
      /* storage unavailable */
    }
  }

  // Approximate size of the saved brief, shown while typing. The server checks the exact length.
  briefSize(prefill, draft) {
    const len = (text) => String(text || '').trim().length;
    const lines = String(draft.references || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const refs = lines.length ? lines.reduce((sum, l) => sum + l.length + 2, 0) + (lines.length - 1) : 15;
    return (
      prefill.budget.overhead + len(draft.reason) + len(draft.completed) + len(draft.remaining) + len(draft.nextSteps) +
      (len(draft.blockers) || 4) + (len(draft.needsApproval) || 4) + (len(draft.tests) || 12) + refs
    );
  }

  // ---------------------------------------------------------------- events
  onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !this.contains(target) || target.disabled) return;
    const { action, id } = target.dataset;
    if (action === 'select-task') this.select(id);
    else if (action === 'refresh') {
      this.state.notice = '';
      this.loadTasks();
      if (this.state.selectedId) this.loadDetail(this.state.selectedId, { silent: Boolean(this.state.detail) });
    } else if (action === 'signout') this.signOut();
    else if (action === 'reload') location.reload();
    else if (action === 'toggle-form') {
      this.state.showForm = !this.state.showForm;
      this.paintDetail();
    } else if (action === 'start-handover') {
      this.state.showForm = true;
      this.paintDetail();
      this.querySelector('#zrk-approve')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.querySelector('#zrk-f-reason')?.focus({ preventScroll: true });
    } else if (action === 'execute') this.execute();
  }

  onInput(event) {
    const field = event.target.closest('[data-field]');
    if (!field || !this.state.detail) return;
    const issueId = this.state.detail.issue.id;
    const draft = this.drafts.get(issueId) || this.draftFor(issueId, this.state.detail.prefill);
    draft[field.dataset.field] = field.value;
    this.saveDraft(issueId);
    this.updateCounters();
  }

  onSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.form === 'signin') this.signIn(new FormData(form).get('passphrase'));
    else if (form.dataset.form === 'brief') this.requestApproval();
  }

  async signIn(passphrase) {
    this.state.signinError = null;
    const button = this.querySelector('[data-form="signin"] button[type="submit"]');
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Signing in…';
    }
    try {
      await this.api('/session', { method: 'POST', body: { passphrase: String(passphrase || '') } });
      this.state.screen = 'ready';
      this.paint();
      await this.loadTasks({ initial: true });
    } catch (error) {
      this.state.signinError = error.message;
      this.paint();
      this.querySelector('#zrk-passphrase')?.focus();
    }
  }

  async signOut() {
    try {
      await this.api('/session', { method: 'DELETE' });
    } catch {
      /* the cookie expires on its own */
    }
    this.signedOut(null);
  }

  // ---------------------------------------------------------------- action A: ask the owner to approve
  validateDraft(detail) {
    const draft = this.draftFor(detail.issue.id, detail.prefill);
    const { fields, references } = detail.prefill.limits;
    const errors = {};
    for (const { key } of FIELDS) {
      const value = String(draft[key] || '').trim();
      if (key === 'references') {
        const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > references.count) errors.references = `List at most ${references.count} items (currently ${lines.length}).`;
        else if (lines.some((l) => l.length > references.each)) errors.references = `Keep each line under ${references.each} characters.`;
      } else if (REQUIRED.includes(key) && !value) errors[key] = 'Required.';
      else if (value.length > fields[key]) errors[key] = `Keep this under ${fields[key]} characters (currently ${value.length}).`;
    }
    if (!Object.keys(errors).length && this.briefSize(detail.prefill, draft) > detail.prefill.budget.limit) {
      errors._brief = `The brief is too long for Ziki’s ${detail.prefill.budget.limit}-character comment limit. Shorten the longest fields.`;
    }
    return errors;
  }

  async requestApproval() {
    const detail = this.state.detail;
    if (!detail || this.state.busy.request) return;
    this.state.requestError = null;
    this.state.fieldErrors = this.validateDraft(detail);
    if (Object.keys(this.state.fieldErrors).length) {
      this.paintDetail();
      this.querySelector('.has-error textarea, #zrk-brief-error')?.focus();
      return;
    }

    const ok = await this.confirm({
      title: 'Ask the owner to approve this handover?',
      body: html`<p>This creates an approval request in Ziki and saves the brief as a comment on #${detail.issue.number}.</p><p><strong>Nothing is handed over yet.</strong> The task stays with ${detail.agent.name || 'the current agent'} until the owner approves and you complete step 2.</p>`,
      confirmLabel: 'Send approval request'
    });
    if (!ok) return;

    this.state.busy.request = true;
    this.paintDetail();
    try {
      const draft = this.draftFor(detail.issue.id, detail.prefill);
      await this.api('/handover/request', { method: 'POST', body: { issueId: detail.issue.id, confirm: true, brief: draft } });
      this.clearDraft(detail.issue.id);
      Object.assign(this.state, { notice: 'Approval request sent. The brief is saved on the issue in Ziki.', showForm: false });
      this.state.busy.request = false;
      await this.loadDetail(detail.issue.id, { silent: true });
      this.focusStatus();
    } catch (error) {
      if (this.state.screen === 'signin') return;
      this.state.busy.request = false;
      this.state.requestError = error;
      if (error.code === 'invalid_brief' && error.extra?.fields) this.state.fieldErrors = error.extra.fields;
      if (error.code === 'brief_not_saved') await this.loadDetail(detail.issue.id, { silent: true });
      else this.paintDetail();
    }
  }

  // ---------------------------------------------------------------- action B: hand over
  async execute() {
    const detail = this.state.detail;
    if (!detail || this.state.busy.execute || detail.handover.phase !== 'approved') return;
    const { brief, approval } = detail.handover;

    const ok = await this.confirm({
      title: 'Hand this task over now?',
      body: html`<p>The owner approved with:</p><blockquote class="zrk-quote">${approval.resolution}</blockquote><p>This releases #${detail.issue.number} so Ziki offers it to the next eligible agent. <strong>Ziki chooses that agent, not you.</strong> The saved brief (${brief.briefId}) stays on the issue.</p><p>This cannot be undone from here.</p>`,
      confirmLabel: 'Hand over'
    });
    if (!ok) return;

    Object.assign(this.state, { executeError: null, executeResult: null });
    this.state.busy.execute = true;
    this.paintDetail();
    try {
      const result = await this.api('/handover/execute', { method: 'POST', body: { issueId: detail.issue.id, briefId: brief.briefId, confirm: true } });
      this.state.executeResult = result;
      this.state.busy.execute = false;
      this.state.notice = 'Handed over. Ziki released the task.';
      await this.loadDetail(detail.issue.id, { silent: true });
      this.loadTasks();
      this.focusStatus();
    } catch (error) {
      if (this.state.screen === 'signin') return;
      this.state.busy.execute = false;
      this.state.executeError = error;
      if (['brief_superseded', 'already_handed_over', 'awaiting_approval', 'rejected', 'approval_unclear', 'brief_invalid', 'conflict'].includes(error.code)) {
        await this.loadDetail(detail.issue.id, { silent: true });
      } else this.paintDetail();
    }
  }

  focusStatus() {
    this.querySelector('#zrk-toast')?.focus();
  }

  // ---------------------------------------------------------------- confirmation dialog
  confirm({ title, body, confirmLabel }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'zrk-dialog';
      dialog.setAttribute('aria-labelledby', 'zrk-dialog-title');
      dialog.innerHTML = html`<h2 id="zrk-dialog-title">${title}</h2>${body}<form method="dialog"><button class="zrk-btn" value="cancel">Cancel</button><button class="zrk-btn is-primary" value="ok">${confirmLabel}</button></form>`.toString();
      dialog.addEventListener('close', () => {
        const approved = dialog.returnValue === 'ok';
        dialog.remove();
        resolve(approved);
      });
      this.append(dialog);
      dialog.showModal();
    });
  }

  // ---------------------------------------------------------------- painting
  paint() {
    const { screen } = this.state;
    const chrome = this.hasAttribute('chrome');
    const top = chrome
      ? html`<div class="zrk-top"><div class="zrk-brand">Ziki <small>Agent Work Recovery</small></div><span class="zrk-spacer"></span>${screen === 'ready' ? html`<button class="zrk-btn is-quiet" data-action="signout">Sign out</button>` : ''}</div>`
      : '';

    let body;
    if (screen === 'loading') {
      body = html`<div class="zrk-center" role="status" aria-live="polite"><div class="zrk-skeleton" style="width:60%"></div><div class="zrk-skeleton"></div><div class="zrk-skeleton" style="width:80%"></div><span class="sr-only">Loading</span></div>`;
    } else if (screen === 'unconfigured') {
      const { missing, problems } = this.state.config;
      body = html`<div class="zrk-center zrk-card"><h1 class="zrk-title">Not set up yet</h1><p class="zrk-sub">Agent Work Recovery needs server settings before it can talk to Ziki.</p>
        ${missing.length ? html`<p><strong>Missing:</strong></p><ul class="zrk-points">${missing.map((name) => html`<li><code>${name}</code></li>`)}</ul>` : ''}
        ${problems.length ? html`<p><strong>Needs fixing:</strong></p><ul class="zrk-points">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
        <p class="zrk-sub">Add them as environment variables on the server, then reload. See the README.</p></div>`;
    } else if (screen === 'signin') {
      body = html`<div class="zrk-center zrk-card"><h1 class="zrk-title">Sign in</h1><p class="zrk-sub">Enter the access passphrase to manage handovers for this workspace’s agent.</p>
        ${this.state.signinError ? html`<div class="zrk-callout is-bad" role="alert"><b>Could not sign in</b>${this.state.signinError}</div>` : ''}
        <form class="zrk-form" data-form="signin"><div class="zrk-field"><label for="zrk-passphrase">Access passphrase</label><input id="zrk-passphrase" name="passphrase" type="password" autocomplete="current-password" required></div>
        <div class="zrk-actions"><button class="zrk-btn is-primary" type="submit">Sign in</button></div></form></div>`;
    } else if (screen === 'failed') {
      const e = describeError(this.state.bootError);
      body = html`<div class="zrk-center zrk-card"><h1 class="zrk-title">${e.title}</h1><p class="zrk-sub">${e.message}</p><div class="zrk-actions"><button class="zrk-btn" data-action="reload">Reload</button></div></div>`;
    } else {
      body = html`<div class="zrk-wrap">
        <h1 class="zrk-title">Agent Work Recovery</h1>
        <p class="zrk-lede">Hand a task to another agent with a saved brief, or see what Ziki actually knows about a stalled one.</p>
        <div class="zrk-agent" id="zrk-agent"></div>
        <div class="zrk-grid"><aside class="zrk-tasks" aria-label="Tasks" id="zrk-tasks"></aside><main class="zrk-detail" id="zrk-detail"></main></div></div>`;
    }

    this.querySelectorAll(':scope > .zrk-top, :scope > .zrk-center, :scope > .zrk-wrap').forEach((n) => n.remove());
    this.insertAdjacentHTML('afterbegin', `${top}${body}`);
    if (screen === 'ready') {
      this.paintAgent();
      this.paintTasks();
      this.paintDetail();
    }
    if (screen === 'signin') this.querySelector('#zrk-passphrase')?.focus();
  }

  paintAgent() {
    const el = this.querySelector('#zrk-agent');
    const { agent } = this.state;
    if (!el) return;
    el.innerHTML = agent
      ? html`<span>Acting as <strong>${agent.name || agent.id}</strong></span><span>Level: <strong>${agent.level}</strong></span><span>Handovers are made as this agent. Approval comes from its owner, inside Ziki.</span>`.toString()
      : '';
  }

  paintTasks() {
    const el = this.querySelector('#zrk-tasks');
    if (!el) return;
    const { tasks, tasksLoading, tasksError, selectedId, hasMore } = this.state;
    let list;
    if (tasksLoading && !tasks.length) list = html`<div class="zrk-empty" role="status"><div class="zrk-skeleton"></div><div class="zrk-skeleton" style="width:70%"></div></div>`;
    else if (tasksError) {
      const e = describeError(tasksError);
      list = html`<div class="zrk-empty" role="alert"><b>${e.title}</b><p>${e.message}</p></div>`;
    } else if (!tasks.length) {
      list = html`<div class="zrk-empty"><b>No tasks in progress</b><p>Ziki shows no in-progress tasks assigned to this agent’s owner. Tasks appear here once an agent has claimed them.</p></div>`;
    } else {
      list = html`<ul class="zrk-tasklist">${tasks.map((t) => html`<li><button class="zrk-task" data-action="select-task" data-id="${t.id}" ${t.id === selectedId ? html`aria-current="true"` : ''}><b>#${t.number} ${t.title}</b><small>${t.severity ? `${t.severity} · ` : ''}updated ${ago(t.updatedAt) || 'recently'}</small></button></li>`)}</ul>${hasMore ? html`<p class="zrk-empty">Showing the first ${tasks.length} tasks.</p>` : ''}`;
    }
    el.innerHTML = html`<h2>In progress</h2>${list}<div style="padding:8px 10px;border-top:1px solid var(--zrk-divider)"><button class="zrk-btn is-quiet" data-action="refresh" ${tasksLoading ? BUSY : ''}>${tasksLoading ? 'Refreshing…' : 'Refresh'}</button></div>`.toString();
  }

  // Keep the caret where it was when a region is re-drawn.
  keepFocus(container, draw) {
    const active = document.activeElement;
    const id = active && container.contains(active) ? active.id : '';
    const start = id ? active.selectionStart : null;
    const end = id ? active.selectionEnd : null;
    draw();
    if (id) {
      const again = container.querySelector(`#${CSS.escape(id)}`);
      if (again) {
        again.focus({ preventScroll: true });
        if (start !== null && again.setSelectionRange) again.setSelectionRange(start, end);
      }
    }
  }

  paintDetail() {
    const el = this.querySelector('#zrk-detail');
    if (!el) return;
    this.keepFocus(el, () => {
      el.innerHTML = this.detailHtml().toString();
    });
    this.updateCounters();
  }

  detailHtml() {
    const { detail, detailLoading, detailError, selectedId, notice } = this.state;
    if (detailLoading && !detail) return html`<section class="zrk-card" role="status"><div class="zrk-skeleton" style="width:50%"></div><div class="zrk-skeleton"></div><div class="zrk-skeleton" style="width:75%"></div><span class="sr-only">Loading task</span></section>`;
    if (!detail) {
      if (detailError) {
        const e = describeError(detailError);
        return html`<section class="zrk-card" role="alert"><h2>${e.title}</h2><p class="zrk-sub">${e.message}</p><div class="zrk-actions"><button class="zrk-btn" data-action="refresh">Try again</button></div></section>`;
      }
      return html`<section class="zrk-card"><h2>${selectedId ? 'Loading…' : 'Select a task'}</h2><p class="zrk-sub">${this.state.tasks.length ? 'Choose a task on the left to see its handover and recovery options.' : 'There is nothing to show until an agent has a task in progress.'}</p></section>`;
    }

    const refreshError = detailError ? describeError(detailError) : null;
    return html`
      ${notice ? html`<div class="zrk-toast" id="zrk-toast" role="status" tabindex="-1">${notice}</div>` : ''}
      ${refreshError ? html`<div class="zrk-callout is-bad" role="alert"><b>Could not refresh from Ziki</b>${refreshError.message} What you see below may be out of date.</div>` : ''}
      ${this.headerCard(detail)}
      ${this.approveCard(detail)}
      ${this.handoverCard(detail)}
      ${this.recoverCard(detail)}`;
  }

  currentAgentText(detail) {
    const current = detail.recovery.currentAgent;
    if (!detail.recovery.claimed) return 'None, the task is not claimed';
    if (!current) return 'Not shown in Ziki’s recorded events';
    return current.isThisKey ? `${detail.agent.name || 'This agent'} (this key)` : `Agent ${String(current.id).slice(0, 8)}…`;
  }

  headerCard(detail) {
    const { issue, recovery, truncated } = detail;
    const link = safeUrl(issue.url);
    const last = recovery.lastActivity;
    return html`<section class="zrk-card zrk-taskhead" aria-label="Task">
      <div class="zrk-meta"><span class="zrk-badge ${issue.status === 'in_progress' ? 'is-info' : ''}">${String(issue.status).replace(/_/g, ' ')}</span>${issue.severity ? html`<span class="zrk-badge">${issue.severity}</span>` : ''}${link ? html`<a href="${link}" target="_blank" rel="noopener noreferrer">Open #${issue.number} in Ziki</a>` : ''}</div>
      <h1>#${issue.number} ${issue.title}</h1>
      <div class="zrk-meta"><span>Current agent: <b>${this.currentAgentText(detail)}</b></span><span>Last recorded activity: <b>${last ? `${last.label}, ${ago(last.at)}` : 'none recorded'}</b></span></div>
      ${truncated.comments || truncated.events ? html`<div class="zrk-callout is-warn"><b>Long history</b>Ziki returned more history than this page reads, so older entries are left out.</div>` : ''}
    </section>`;
  }

  // ---- card 1
  approveCard(detail) {
    const { handover } = detail;
    const { phase, brief, approval } = handover;
    const showForm = (['none', 'rejected', 'unclear', 'invalid'].includes(phase) || this.state.showForm) && handover.canRequest.ok && phase !== 'approved' && phase !== 'released';
    const quote = approval?.resolution ? html`<blockquote>${approval.resolution}</blockquote>` : '';

    let status = '';
    if (phase === 'awaiting_approval') {
      status = html`<div class="zrk-callout is-info" role="status"><b>Waiting for the owner</b>The request was sent ${brief?.createdAt ? ago(brief.createdAt) : ''}. The owner answers inside Ziki by replying APPROVE or REJECT. This page cannot approve on their behalf; refresh to check for a reply.</div>`;
    } else if (phase === 'approved') {
      status = html`<div class="zrk-callout is-ok" role="status"><b>Approved by the owner</b>${approval.resolvedAt ? `Answered ${ago(approval.resolvedAt)}.` : ''} ${quote}Continue with step 2.</div>`;
    } else if (phase === 'rejected') {
      status = html`<div class="zrk-callout is-bad" role="status"><b>The owner rejected this handover</b>The task stays with the current agent. ${quote}You can send a new brief if things have changed.</div>`;
    } else if (phase === 'unclear') {
      status = html`<div class="zrk-callout is-warn" role="status"><b>The owner replied without a clear APPROVE or REJECT</b>Nothing is handed over. ${quote}Ask for a reply that starts with APPROVE or REJECT, or send a new request.</div>`;
    } else if (phase === 'invalid') {
      status = html`<div class="zrk-callout is-warn" role="status"><b>This request can no longer be used</b>${handover.invalidReason}</div>`;
    } else if (phase === 'released') {
      status = html`<div class="zrk-callout is-ok" role="status"><b>Handed over</b>This brief was used to release the task${handover.released?.at ? ` ${ago(handover.released.at)}` : ''}.</div>`;
    }

    const blocked = !handover.canRequest.ok && !['approved', 'released'].includes(phase)
      ? html`<div class="zrk-callout is-warn" role="status"><b>Handover cannot be requested</b>${handover.canRequest.reason}</div>`
      : '';

    return html`<section class="zrk-card" id="zrk-approve" aria-labelledby="zrk-h-approve">
      <header><span class="zrk-step" aria-hidden="true">1</span><h2 id="zrk-h-approve">Approve handover</h2></header>
      <p class="zrk-sub">Describe where the work stands. The owner must approve before anything moves, and the brief is saved on the issue in Ziki.</p>
      ${status}${blocked}
      ${this.state.requestError ? this.errorCallout(this.state.requestError, 'requestError') : ''}
      ${brief ? this.briefView(brief) : ''}
      ${['awaiting_approval'].includes(phase) && handover.canRequest.ok ? html`<div class="zrk-actions"><button class="zrk-btn is-quiet" data-action="toggle-form" aria-expanded="${this.state.showForm}">${this.state.showForm ? 'Cancel new brief' : 'Replace with a new brief'}</button></div>` : ''}
      ${showForm ? this.briefForm(detail) : ''}
    </section>`;
  }

  briefView(brief) {
    return html`<details class="zrk-brief"><summary>Saved brief ${brief.briefId}${brief.createdAt ? ` · ${when(brief.createdAt)}` : ''}</summary>${brief.intact ? '' : html`<div class="zrk-callout is-warn"><b>Edited after posting</b>This text no longer matches what was approved.</div>`}<pre>${brief.body}</pre></details>`;
  }

  briefForm(detail) {
    const draft = this.draftFor(detail.issue.id, detail.prefill);
    const { fields, references } = detail.prefill.limits;
    const errors = this.state.fieldErrors;
    const busy = this.state.busy.request;
    const field = ({ key, label, hint, rows }) => html`<div class="zrk-field ${errors[key] ? 'has-error' : ''}">
      <label for="zrk-f-${key}">${label}${REQUIRED.includes(key) ? html` <span aria-hidden="true">*</span><span class="sr-only">(required)</span>` : ''}<span class="zrk-hint">${hint}</span></label>
      <textarea id="zrk-f-${key}" data-field="${key}" rows="${rows}" ${errors[key] ? html`aria-invalid="true" aria-describedby="zrk-e-${key}"` : ''}>${draft[key]}</textarea>
      <span class="zrk-count" data-count="${key}" data-max="${key === 'references' ? references.count : fields[key]}"></span>
      ${errors[key] ? html`<div class="zrk-error" id="zrk-e-${key}" role="alert">${errors[key]}</div>` : ''}</div>`;

    const [reason, completed, remaining, refs, tests, blockers, next, needs] = FIELDS.map(field);
    return html`<form class="zrk-form" data-form="brief" novalidate aria-label="Continuation brief">
      <div class="zrk-record"><b>Task:</b> #${detail.issue.number} ${detail.issue.title}<br><b>Current agent:</b> ${this.currentAgentText(detail)}<br><b>State in Ziki:</b> ${String(detail.issue.status).replace(/_/g, ' ')}${detail.issue.pullRequestUrl ? html` · PR linked` : ''} (captured when you send)</div>
      ${reason}${completed}${remaining}${refs}
      <div class="zrk-two">${tests}${blockers}</div>
      <div class="zrk-two">${next}${needs}</div>
      ${errors._brief ? html`<div class="zrk-callout is-bad" id="zrk-brief-error" role="alert" tabindex="-1"><b>The brief is too long</b>${errors._brief}</div>` : ''}
      <div class="zrk-total" data-total aria-live="polite"></div>
      <div class="zrk-actions"><button class="zrk-btn is-primary" type="submit" ${busy ? html`disabled ${BUSY}` : ''}>${busy ? 'Sending…' : 'Ask owner to approve'}</button></div>
    </form>`;
  }

  // Live counters: updated in place so typing never re-draws the form.
  updateCounters() {
    const detail = this.state.detail;
    if (!detail) return;
    const draft = this.drafts.get(detail.issue.id);
    if (!draft) return;
    for (const node of this.querySelectorAll('[data-count]')) {
      const key = node.dataset.count;
      const max = Number(node.dataset.max);
      const used = key === 'references' ? String(draft.references || '').split('\n').filter((l) => l.trim()).length : String(draft[key] || '').trim().length;
      node.textContent = `${used} / ${max}`;
      node.classList.toggle('is-over', used > max);
    }
    const total = this.querySelector('[data-total]');
    if (total) {
      const size = this.briefSize(detail.prefill, draft);
      const limit = detail.prefill.budget.limit;
      total.textContent = `Brief size: about ${size} of ${limit} characters (Ziki’s comment limit).`;
      total.classList.toggle('is-over', size > limit);
    }
  }

  // ---- card 2
  handoverCard(detail) {
    const { handover } = detail;
    const { phase } = handover;
    const result = this.state.executeResult;
    const busy = this.state.busy.execute;
    const can = phase === 'approved' && handover.canExecute.ok;

    let body;
    if (phase === 'released') {
      const reoffered = result ? result.reofferedTo : handover.released?.reofferedTo;
      body = html`<div class="zrk-callout is-ok" role="status"><b>Task released</b>${reoffered ? 'Ziki re-offered it to the next eligible agent.' : 'Ziki has not reported a new offer yet. It picks the next agent itself.'}${result && result.markerSaved === false ? ' The release went through, but the note on the issue could not be saved.' : ''}</div>
        ${handover.ack
          ? html`<div class="zrk-callout is-ok"><b>Receiving agent checked in</b>An agent left an acknowledgement ${ago(handover.ack.at)}.</div>`
          : html`<div class="zrk-callout"><b>No acknowledgement yet</b>The brief asks the receiving agent to verify the state in Ziki and comment before it continues. Nothing has been recorded so far.</div>`}`;
    } else {
      body = html`<p class="zrk-sub">Ziki’s API can release a task, but not pick who receives it. Releasing returns the task to the pool, and Ziki offers it to the next eligible agent. The saved brief on the issue tells that agent to verify the state before it continues.</p>
        ${can ? '' : html`<div class="zrk-callout" role="status"><b>Not available yet</b>${handover.canExecute.reason}</div>`}
        ${this.state.executeError ? this.errorCallout(this.state.executeError, 'executeError') : ''}
        <div class="zrk-actions"><button class="zrk-btn is-primary" data-action="execute" ${can && !busy ? '' : 'disabled'} ${busy ? BUSY : ''}>${busy ? 'Handing over…' : 'Hand over to another agent'}</button></div>`;
    }

    return html`<section class="zrk-card" id="zrk-handover" aria-labelledby="zrk-h-handover">
      <header><span class="zrk-step" aria-hidden="true">2</span><h2 id="zrk-h-handover">Hand over to another agent</h2></header>
      ${body}
    </section>`;
  }

  // ---- card 3
  recoverCard(detail) {
    const { recovery, issue, handover } = detail;
    const link = safeUrl(issue.url);
    const last = recovery.lastActivity;
    const t = recovery.thresholds;
    const timers = t && (t.heartbeatMinutes || t.deliveryMinutes)
      ? [t.heartbeatMinutes ? `released after ${t.heartbeatMinutes} min without a heartbeat` : '', t.deliveryMinutes ? `delivery window ${t.deliveryMinutes} min` : ''].filter(Boolean).join(' · ')
      : 'Not available';
    const badge = {
      handover: (o) => (o.available ? ['Available', 'is-ok'] : ['Not available', '']),
      answer_question: (o) => (o.available ? ['Needs the owner', 'is-warn'] : ['Nothing pending', '']),
      auto_release: (o) => (o.available ? ['Automatic', 'is-info'] : ['Not applicable', '']),
      resume: () => ['Not supported', 'is-warn']
    };

    return html`<section class="zrk-card" id="zrk-recover" aria-labelledby="zrk-h-recover">
      <header><span class="zrk-step" aria-hidden="true">3</span><h2 id="zrk-h-recover">Recover a stalled task</h2></header>
      <p class="zrk-sub">${recovery.headline} Only facts Ziki reports are shown. Whether the agent is still working cannot be read from the API.</p>
      <dl class="zrk-facts">
        <dt>Status in Ziki</dt><dd>${String(recovery.status).replace(/_/g, ' ')}${recovery.claimed ? ' · assigned' : ''}</dd>
        <dt>Current agent</dt><dd>${this.currentAgentText(detail)}</dd>
        <dt>Last recorded activity</dt><dd>${last ? html`${last.label}, ${ago(last.at)} <span title="${when(last.at)}">(${when(last.at)})</span>` : 'None recorded'}</dd>
        <dt>Last heartbeat</dt><dd>Not available — Ziki does not expose it</dd>
        <dt>Waiting on the owner</dt><dd>${recovery.waitingOnOwner ? 'Yes, a question or escalation is open' : 'No open question recorded'}</dd>
        <dt>Ziki’s timers</dt><dd>${timers}</dd>
      </dl>
      ${recovery.recentEvents.length ? html`<h3 style="font-size:14px;margin-bottom:4px">Recent events</h3><ul class="zrk-events">${recovery.recentEvents.map((e) => html`<li>${e.label} · <span title="${when(e.at)}">${ago(e.at)}</span></li>`)}</ul>` : html`<p class="zrk-sub">No events recorded for this task.</p>`}
      <h3 style="font-size:14px;margin-bottom:6px">Recovery options</h3>
      <ul class="zrk-options">${recovery.options.map((o) => {
        const [label, tone] = badge[o.id](o);
        return html`<li class="${o.available ? '' : 'is-off'}"><b>${o.label}<span class="zrk-badge ${tone}">${label}</span></b><span>${o.note}</span>
          ${o.id === 'handover' && o.available && !['approved', 'released'].includes(handover.phase) ? html`<button class="zrk-btn is-quiet" data-action="start-handover">Start the handover</button>` : ''}
          ${o.id === 'answer_question' && o.available && link ? html`<a href="${link}" target="_blank" rel="noopener noreferrer">Open in Ziki</a>` : ''}</li>`;
      })}</ul>
      <details class="zrk-limits" open><summary>What this view cannot tell you</summary><ul class="zrk-points">${recovery.limitations.map((l) => html`<li>${l}</li>`)}</ul></details>
    </section>`;
  }

  errorCallout(error, key) {
    const e = describeError(error);
    const fields = error.code === 'invalid_brief' && error.extra?.fields ? Object.values(error.extra.fields) : [];
    return html`<div class="zrk-callout is-bad" role="alert" data-error="${key}"><b>${e.title}</b>${e.message}${fields.length ? html`<ul class="zrk-points">${fields.map((f) => html`<li>${f}</li>`)}</ul>` : ''}</div>`;
  }
}

if (!customElements.get('zk-work-recovery')) customElements.define('zk-work-recovery', ZkWorkRecovery);
