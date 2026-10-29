import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../lib/config.js';
import { createHandlers } from '../../lib/handlers.js';
import { BASE_TIME, createFakeZiki, FAKE_KEY } from '../support/fake-ziki.js';

const ENV = {
  ZIKI_AGENT_KEY: FAKE_KEY,
  RECOVERY_ACCESS_TOKEN: 'correct horse battery',
  RECOVERY_SESSION_SECRET: 's'.repeat(40),
  ZIKI_BASE_URL: 'https://ziki.test'
};
const BRIEF = { reason: 'Out of budget', completed: 'Rounding helper and tests', remaining: 'Wire into checkout', nextSteps: 'Start in cart.ts', references: ['branch fix/rounding'], tests: '12 passing' };

// A full app: handlers wired to a fake Ziki, with a signed-in cookie ready to use.
async function setup({ level, env = ENV } = {}) {
  const ziki = createFakeZiki({ level });
  const config = loadConfig(env);
  const handlers = createHandlers({ config, fetchImpl: ziki.fetch, now: () => BASE_TIME, delay: async () => {} });
  const responses = [];

  async function call(name, { method = 'GET', query = '', body, cookie, headers = {}, write } = {}) {
    const isWrite = write ?? method !== 'GET';
    const request = new Request(`https://app.test/api/${name}${query}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(isWrite ? { 'x-requested-with': 'zk-recovery', origin: 'https://app.test' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const response = await handlers[name](request);
    const text = await response.clone().text();
    responses.push({ text, headers: Object.fromEntries(response.headers) });
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null, text };
  }

  const login = await call('session', { method: 'POST', body: { passphrase: ENV.RECOVERY_ACCESS_TOKEN } });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const as = (name, options = {}) => call(name, { cookie, ...options });
  const req = (extra = {}) => as('handover-request', { method: 'POST', body: { issueId: 'iss_1', confirm: true, brief: BRIEF, ...extra } });
  const run = (extra = {}) => as('handover-execute', { method: 'POST', body: { issueId: 'iss_1', confirm: true, ...extra } });
  return { ziki, config, handlers, call, as, req, run, cookie, responses };
}

// Request approval, have the owner answer inside Ziki, and return the brief id.
async function approvedHandover(app, answer = 'APPROVE, go ahead') {
  const sent = await app.req();
  assert.equal(sent.status, 201, sent.text);
  app.ziki.answer(sent.json.escalationId, answer);
  return sent.json;
}

const writes = (ziki) => ziki.calls.filter((c) => c.method !== 'GET');

// ------------------------------------------------------------------ access
test('without configuration every route says what is missing and does nothing else', async () => {
  const handlers = createHandlers({ config: loadConfig({}), fetchImpl: () => assert.fail('must not call Ziki') });
  const response = await handlers.tasks(new Request('https://app.test/api/tasks'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'not_configured');
  assert.deepEqual(body.error.missing, ['ZIKI_AGENT_KEY', 'RECOVERY_ACCESS_TOKEN', 'RECOVERY_SESSION_SECRET']);
});

test('sign-in: wrong passphrase is refused, the right one sets an HttpOnly SameSite=Strict cookie', async () => {
  const { call } = await setup();
  const bad = await call('session', { method: 'POST', body: { passphrase: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'bad_passphrase');
  assert.equal(bad.headers.get('set-cookie'), null);

  const good = await call('session', { method: 'POST', body: { passphrase: ENV.RECOVERY_ACCESS_TOKEN } });
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie'), /^zrk_session=.+HttpOnly; SameSite=Strict; Secure$/);
});

test('every data route requires a session', async () => {
  const app = await setup();
  for (const [name, options] of [['tasks', {}], ['task', { query: '?id=iss_1' }], ['handover-request', { method: 'POST', body: { issueId: 'iss_1', confirm: true } }], ['handover-execute', { method: 'POST', body: { issueId: 'iss_1', confirm: true } }]]) {
    const response = await app.call(name, options);
    assert.equal(response.status, 401, name);
    assert.equal(response.json.error.code, 'not_signed_in');
  }
  assert.equal(app.ziki.calls.length, 0, 'no Ziki call is made for an unauthenticated visitor');
  assert.equal((await app.call('tasks', { cookie: 'zrk_session=1999999999.forged' })).status, 401);
});

test('state-changing routes reject requests that did not come from the app', async () => {
  const app = await setup();
  const noHeader = await app.as('handover-request', { method: 'POST', body: { issueId: 'iss_1', confirm: true, brief: BRIEF }, headers: { 'x-requested-with': '' } });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.error.code, 'bad_request_origin');

  const otherSite = await app.as('handover-execute', { method: 'POST', body: { issueId: 'iss_1', confirm: true }, headers: { origin: 'https://evil.test' } });
  assert.equal(otherSite.status, 403);
  assert.equal(writes(app.ziki).length, 0);

  assert.equal((await app.as('tasks', { method: 'POST', write: false })).status, 405);
});

test('the task id is validated before anything is sent to Ziki', async () => {
  const app = await setup();
  const bad = await app.as('task', { query: '?id=../../admin' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_issue_id');
  assert.equal(app.ziki.calls.length, 0);
});

// ------------------------------------------------------------------ reading
test('the task list is only this owner’s in-progress work', async () => {
  const app = await setup();
  app.ziki.addIssue({ id: 'iss_2', number: 43, title: 'Someone else', assigneeId: 'user_9' });
  app.ziki.addIssue({ id: 'iss_3', number: 44, title: 'Not started', status: 'open', assigneeId: null });
  const response = await app.as('tasks');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.items.map((i) => i.id), ['iss_1']);
  assert.equal(response.json.agent.name, 'Builder');
  assert.equal(response.json.items[0].url, 'https://ziki.test/issues/42');
  const listCall = app.ziki.callsTo('GET', '/issues').find((c) => c.path === '/issues');
  assert.equal(listCall.query.status, 'in_progress');
  assert.equal(listCall.query.assignee, 'user_1');
});

test('a task view returns real status, recorded activity, limits and no stalled verdict', async () => {
  const app = await setup();
  const { status, json } = await app.as('task', { query: '?id=iss_1' });
  assert.equal(status, 200);
  assert.equal(json.handover.phase, 'none');
  assert.equal(json.handover.canRequest.ok, true);
  assert.equal(json.recovery.status, 'in_progress');
  assert.equal(json.recovery.lastActivity.label, 'Comment added');
  assert.equal(json.recovery.thresholds.heartbeatMinutes, 15);
  assert.equal(json.recovery.limitations.length, 3);
  assert.equal(json.recovery.options.find((o) => o.id === 'resume').available, false);
  assert.deepEqual(json.prefill.references, ['PR https://github.com/acme/shop/pull/7']);
  assert.equal(json.prefill.budget.limit, 2000);
  assert.ok(!JSON.stringify(json).toLowerCase().includes('stalled":true'));
  assert.equal(writes(app.ziki).length, 0, 'viewing a task changes nothing in Ziki');
});

// ------------------------------------------------------------------ A. approval
test('a handover request needs an explicit confirmation', async () => {
  const app = await setup();
  const response = await app.req({ confirm: undefined });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'confirmation_required');
  assert.equal(writes(app.ziki).length, 0);
});

test('requesting approval asks the owner first, then saves the brief on the issue', async () => {
  const app = await setup();
  const response = await app.req();
  assert.equal(response.status, 201, response.text);

  const posts = writes(app.ziki);
  assert.deepEqual(posts.map((c) => `${c.method} ${c.path}`), ['POST /escalations', 'POST /issues/iss_1/comments']);
  const [escalation, comment] = posts;
  assert.equal(escalation.body.type, 'human_approval');
  assert.equal(escalation.body.bugId, 'iss_1');
  assert.match(escalation.body.body, /Reply APPROVE/);
  assert.equal(comment.body.projectId, 'prj_1');
  assert.ok(comment.body.body.length <= 2000);
  assert.equal(comment.body.metadata.kind, 'handover_brief');
  assert.equal(comment.body.metadata.briefId, response.json.briefId);
  assert.equal(comment.body.metadata.escalationId, response.json.escalationId);
  assert.ok(comment.body.body.includes('Wire into checkout'));
  assert.equal(app.ziki.callsTo('POST', 'release').length, 0, 'requesting approval never releases anything');

  const view = await app.as('task', { query: '?id=iss_1' });
  assert.equal(view.json.handover.phase, 'awaiting_approval', 'the brief survives a reload because Ziki stores it');
  assert.equal(view.json.handover.brief.briefId, response.json.briefId);
});

test('an invalid brief is rejected with field errors and sends nothing to Ziki', async () => {
  const app = await setup();
  const response = await app.req({ brief: { ...BRIEF, completed: '', reason: 'x'.repeat(500) } });
  assert.equal(response.status, 422);
  assert.equal(response.json.error.code, 'invalid_brief');
  assert.equal(response.json.error.fields.completed, 'Required.');
  assert.match(response.json.error.fields.reason, /under 140/);
  assert.equal(writes(app.ziki).length, 0);
});

test('observer-level keys get a clear permission error and nothing is written', async () => {
  const app = await setup({ level: 'observer' });
  const response = await app.req();
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'agent_level_too_low');
  assert.match(response.json.error.message, /contributor level or higher/);
  assert.equal(writes(app.ziki).length, 0);
});

test('a task that is not in progress, or belongs to someone else, cannot be handed over', async () => {
  const app = await setup();
  app.ziki.addIssue({ id: 'iss_2', number: 43, assigneeId: 'user_9' });
  app.ziki.addIssue({ id: 'iss_3', number: 44, status: 'open', assigneeId: null });
  assert.equal((await app.req({ issueId: 'iss_2' })).json.error.code, 'not_this_agents_task');
  assert.equal((await app.req({ issueId: 'iss_3' })).json.error.code, 'not_in_progress');
  assert.equal((await app.req({ issueId: 'iss_404' })).status, 404);
  assert.equal(writes(app.ziki).length, 0);
});

test('if the brief cannot be saved after the request is sent, the user is told exactly that', async () => {
  const app = await setup();
  app.ziki.fail('POST /issues/iss_1/comments', { status: 500 });
  const response = await app.req();
  assert.equal(response.status, 502);
  assert.equal(response.json.error.code, 'brief_not_saved');
  assert.ok(response.json.error.escalationId);
  assert.match(response.json.error.message, /could not be saved/);

  const view = await app.as('task', { query: '?id=iss_1' });
  assert.equal(view.json.handover.phase, 'none', 'no brief means no handover can be executed');
});

// ------------------------------------------------------------------ B. handover
test('handover is refused until the owner has approved', async () => {
  const app = await setup();
  const none = await app.run({ briefId: 'abcabcabcabc' });
  assert.equal(none.status, 409);
  assert.equal(none.json.error.code, 'brief_superseded');

  const sent = await app.req();
  const waiting = await app.run({ briefId: sent.json.briefId });
  assert.equal(waiting.status, 409);
  assert.equal(waiting.json.error.code, 'awaiting_approval');
  assert.equal(app.ziki.callsTo('POST', 'release').length, 0);
});

test('a rejected or unclear reply never allows a handover', async () => {
  for (const [answer, code] of [['REJECT, not now', 'rejected'], ['let me think', 'approval_unclear'], ['I do not approve', 'approval_unclear']]) {
    const app = await setup();
    const { briefId } = await approvedHandover(app, answer);
    const response = await app.run({ briefId });
    assert.equal(response.status, 409, answer);
    assert.equal(response.json.error.code, code, answer);
    assert.equal(app.ziki.callsTo('POST', 'release').length, 0, answer);
  }
});

test('handover needs its own confirmation even after approval', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  const response = await app.run({ briefId, confirm: false });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'confirmation_required');
  assert.equal(app.ziki.callsTo('POST', 'release').length, 0);
});

test('after approval the task is released once, with the brief id and the owner’s words as the reason', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app, 'APPROVE, go ahead');
  const response = await app.run({ briefId });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { released: true, reopened: true, reofferedTo: 'agt_2', claimId: 'clm_1', markerSaved: true });

  const releases = app.ziki.callsTo('POST', '/release');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].path, '/issues/iss_1/release');
  assert.equal(releases[0].query.projectId, 'prj_1');
  assert.ok(releases[0].body.reason.includes(briefId));
  assert.ok(releases[0].body.reason.includes('APPROVE, go ahead'));

  const marker = app.ziki.callsTo('POST', 'comments').at(-1);
  assert.equal(marker.body.metadata.kind, 'handover_released');
  assert.equal(marker.body.metadata.briefId, briefId);

  const view = await app.as('task', { query: '?id=iss_1' });
  assert.equal(view.json.handover.phase, 'released');
  assert.equal(view.json.handover.released.reofferedTo, 'agt_2');
  assert.equal(view.json.handover.ack, null, 'no receiving agent has confirmed yet, and the UI says so');
  assert.equal(view.json.issue.status, 'open');
});

test('the same approval cannot be used twice', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  assert.equal((await app.run({ briefId })).status, 200);
  const again = await app.run({ briefId });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'already_handed_over');
  assert.equal(app.ziki.callsTo('POST', '/release').length, 1);
});

test('a newer brief supersedes an older approval', async () => {
  const app = await setup();
  const first = await approvedHandover(app);
  const second = await app.req({ brief: { ...BRIEF, completed: 'Much more done now' } });
  assert.equal(second.status, 201);
  assert.notEqual(second.json.briefId, first.briefId);

  const stale = await app.run({ briefId: first.briefId });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'brief_superseded');

  const current = await app.run({ briefId: second.json.briefId });
  assert.equal(current.json.error.code, 'awaiting_approval', 'the new brief still needs its own approval');
  assert.equal(app.ziki.callsTo('POST', '/release').length, 0);
});

test('editing the brief comment after approval blocks the handover', async () => {
  const app = await setup();
  const { briefId, commentId } = await approvedHandover(app);
  const comment = app.ziki.state.comments.get('iss_1').find((c) => c.id === commentId);
  comment.body = comment.body.replace('Wire into checkout', 'Delete everything');
  const response = await app.run({ briefId });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'brief_invalid');
  assert.match(response.json.error.message, /edited after it was posted/);
  assert.equal(app.ziki.callsTo('POST', '/release').length, 0);
});

test('if the approval request cannot be read back from Ziki, nothing is handed over', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  app.ziki.fail('GET /escalations/', { status: 404 });
  const response = await app.run({ briefId });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'brief_invalid');
  assert.equal(app.ziki.callsTo('POST', '/release').length, 0);
});

test('if Ziki releases the task but the follow-up note fails, the handover still counts and the user is told', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  app.ziki.fail('POST /issues/iss_1/comments', { status: 500 });
  const response = await app.run({ briefId });
  assert.equal(response.status, 200);
  assert.equal(response.json.released, true);
  assert.equal(response.json.markerSaved, false);
});

// ------------------------------------------------------------------ API failures
test('Ziki failures are explained in plain terms, with the right status', async () => {
  const cases = [
    { fail: { status: 409, body: { error: 'not_claimed', message: 'You do not hold the claim.' } }, status: 409, code: 'conflict', text: /You do not hold the claim/ },
    { fail: { status: 403, body: { error: 'insufficient_level', message: 'Needs contributor level.' } }, status: 403, code: 'agent_level_too_low', text: /Needs contributor level/ },
    { fail: { status: 403, body: { error: 'project_forbidden', message: 'Key is for another project.' } }, status: 403, code: 'project_forbidden', text: /another project/ },
    { fail: { status: 401, body: { error: 'unauthorized', message: 'Revoked.' } }, status: 502, code: 'ziki_key_rejected', text: /rejected the agent key/ },
    { fail: { status: 500 }, status: 502, code: 'ziki_unavailable', text: /Try again/ },
    { fail: { networkError: true }, status: 502, code: 'ziki_unavailable', text: /Could not reach Ziki/ }
  ];
  for (const c of cases) {
    const app = await setup();
    const { briefId } = await approvedHandover(app);
    app.ziki.fail('POST /issues/iss_1/release', c.fail);
    const response = await app.run({ briefId });
    assert.equal(response.status, c.status, c.code);
    assert.equal(response.json.error.code, c.code);
    assert.match(response.json.error.message, c.text);
  }
});

test('rate limits are passed on with a retry time', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  app.ziki.fail('POST /issues/iss_1/release', { status: 429, headers: { 'retry-after': '30' }, body: { error: 'rate_limited' } });
  const response = await app.run({ briefId });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(response.json.error.retryAfter, 30);
  assert.match(response.json.error.message, /30 seconds/);
});

test('a wrong agent key shows up as a configuration problem, not a crash', async () => {
  const app = await setup({ env: { ...ENV, ZIKI_AGENT_KEY: 'zk_wrong_key_0123456789' } });
  const response = await app.as('tasks');
  assert.equal(response.status, 502);
  assert.equal(response.json.error.code, 'ziki_key_rejected');
});

// ------------------------------------------------------------------ guarantees
test('only documented Ziki routes are ever called, and never anything that moves a task to a chosen agent', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  await app.run({ briefId });
  await app.as('tasks');
  await app.as('task', { query: '?id=iss_1' });

  const allowed = [
    /^GET \/agents\/me$/, /^GET \/projects$/, /^GET \/issues$/, /^GET \/issues\/[^/]+$/, /^GET \/issues\/[^/]+\/comments$/,
    /^GET \/events$/, /^GET \/escalations\/[^/]+$/, /^POST \/escalations$/, /^POST \/issues\/[^/]+\/comments$/, /^POST \/issues\/[^/]+\/release$/
  ];
  for (const call of app.ziki.calls) {
    assert.ok(allowed.some((pattern) => pattern.test(`${call.method} ${call.path}`)), `unexpected call: ${call.method} ${call.path}`);
  }
  assert.ok(!app.ziki.calls.some((c) => /heartbeat|offer|accept|claim|extend|assign|reassign/i.test(c.path)));
});

test('the Ziki key, access passphrase and session secret never appear in any response', async () => {
  const app = await setup();
  const { briefId } = await approvedHandover(app);
  await app.run({ briefId });
  await app.as('tasks');
  await app.as('task', { query: '?id=iss_1' });
  await app.call('session');
  app.ziki.fail('GET /agents/me', { status: 401 });
  await app.as('tasks');
  await app.call('session', { method: 'POST', body: { passphrase: 'wrong' } });

  assert.equal(app.responses.length, 8, 'sign-in, request, handover, tasks, task, session, failed tasks, failed sign-in');
  for (const { text, headers } of app.responses) {
    const everything = text + JSON.stringify(headers).replace(/zrk_session=[^;"]+/g, 'zrk_session=<redacted>');
    for (const secret of [ENV.ZIKI_AGENT_KEY, ENV.RECOVERY_ACCESS_TOKEN, ENV.RECOVERY_SESSION_SECRET]) {
      assert.ok(!everything.includes(secret), 'a secret leaked into a response');
    }
  }
});

test('the handlers can be mounted by action name, as a Next.js route would', async () => {
  const app = await setup();
  const response = await app.handlers.handle(new Request('https://app.test/x', { headers: { cookie: app.cookie } }), 'tasks');
  assert.equal(response.status, 200);
  assert.equal((await app.handlers.handle(new Request('https://app.test/x'), 'nope')).status, 404);
});
