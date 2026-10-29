// TEST ONLY. An in-memory stand-in for the parts of Ziki's agent API that this feature calls
// (https://ziki.dev/llms.txt). It is NOT Ziki, and it only knows the routes below. Used by the unit tests
// (as a fetch implementation) and by the browser tests (behind an HTTP server, see test/e2e/mock-ziki.mjs).
//
// Every request is logged in `calls`, so tests can assert exactly what was sent, and that nothing outside
// the documented set (heartbeat, offer, accept, claim, extend, assign) was ever called.

export const FAKE_KEY = 'zk_test_key_0123456789abcdef';
export const BASE_TIME = Date.parse('2026-10-29T10:00:00Z');

export function createFakeZiki({ key = FAKE_KEY, level = 'contributor' } = {}) {
  let clock = BASE_TIME - 60 * 60000; // history starts an hour before BASE_TIME
  let seq = 0;
  const tick = () => new Date((clock += 1000)).toISOString();
  const id = (prefix) => `${prefix}_${(seq += 1)}`;

  const state = {
    me: { id: 'agt_1', name: 'Builder', level, owner_id: 'user_1', project_id: 'prj_1' },
    projects: [{ id: 'prj_1', workflow: { heartbeatMinutes: 15, deliveryMinutes: 120 } }],
    issues: new Map(),
    comments: new Map(),
    events: [],
    escalations: new Map()
  };
  const calls = [];
  const failures = [];

  function addIssue(overrides = {}) {
    const issue = {
      id: 'iss_1', number: 42, title: 'Fix checkout rounding', status: 'in_progress', severity: 'medium',
      reviewStatus: null, assigneeId: 'user_1', projectId: 'prj_1',
      pullRequestUrl: 'https://github.com/acme/shop/pull/7', pullRequestHeadSha: 'abcdef1234567', updatedAt: tick(), ...overrides
    };
    state.issues.set(issue.id, issue);
    state.comments.set(issue.id, state.comments.get(issue.id) || []);
    return issue;
  }
  function addEvent(type, extra = {}) {
    const event = { id: id('evt'), type, createdAt: tick(), bugId: 'iss_1', actorAgentId: 'agt_1', payload: {}, ...extra };
    state.events.push(event);
    return event;
  }
  function addComment(issueId, { body, metadata, agentId = 'agt_1' }) {
    const comment = { id: id('cmt'), body, metadata: metadata ?? null, agentId, createdAt: tick() };
    state.comments.get(issueId).push(comment);
    return comment;
  }

  addIssue();
  addEvent('claim.accepted');
  addEvent('comment.created');

  const reply = (status, json, headers = {}) => ({ status, json, headers });
  const findIssue = (issueId) => state.issues.get(issueId);

  function handle(method, path, query, body, authorization) {
    calls.push({ method, path, query: { ...query }, body: body ?? null });
    if (authorization !== `Bearer ${key}`) return reply(401, { error: 'unauthorized', message: 'Invalid agent key.' });

    const hit = failures.findIndex((f) => `${method} ${path}`.includes(f.match));
    if (hit >= 0) {
      const failure = failures[hit];
      failure.times -= 1;
      if (failure.times <= 0) failures.splice(hit, 1);
      if (failure.networkError) throw new TypeError('network down');
      return reply(failure.status, failure.body ?? { message: 'Injected failure.' }, failure.headers);
    }

    let m;
    if (method === 'GET' && path === '/agents/me') return reply(200, state.me);
    if (method === 'GET' && path === '/projects') return reply(200, { items: state.projects });

    if (method === 'GET' && path === '/issues') {
      const items = [...state.issues.values()].filter(
        (i) => (!query.status || i.status === query.status) && (!query.assignee || i.assigneeId === query.assignee)
      );
      return reply(200, { items, nextCursor: null });
    }
    if ((m = path.match(/^\/issues\/([^/]+)$/)) && method === 'GET') {
      const issue = findIssue(m[1]);
      return issue ? reply(200, { issue }) : reply(404, { error: 'not_found', message: 'No such issue.' });
    }
    if ((m = path.match(/^\/issues\/([^/]+)\/comments$/))) {
      const issue = findIssue(m[1]);
      if (!issue) return reply(404, { error: 'not_found', message: 'No such issue.' });
      if (method === 'GET') return reply(200, { items: state.comments.get(issue.id), nextCursor: null });
      if (method === 'POST') {
        if (!body?.body || body.body.length > 2000) return reply(422, { error: 'validation_error', message: 'Comment body must be 1-2000 characters.' });
        const comment = addComment(issue.id, { body: body.body, metadata: body.metadata });
        return reply(201, { comment });
      }
    }
    if ((m = path.match(/^\/issues\/([^/]+)\/release$/)) && method === 'POST') {
      const issue = findIssue(m[1]);
      if (!issue) return reply(404, { error: 'not_found', message: 'No such issue.' });
      if (issue.status !== 'in_progress' || issue.assigneeId !== state.me.owner_id) {
        return reply(409, { error: 'not_claimed', message: 'You do not hold the claim on this task.' });
      }
      Object.assign(issue, { status: 'open', assigneeId: null, updatedAt: tick() });
      addEvent('claim.released', { payload: { reason: body?.reason ?? null } });
      return reply(200, { reopened: true, reofferedTo: 'agt_2', claimId: 'clm_1' });
    }
    if (method === 'GET' && path === '/events') {
      const events = state.events.filter((e) => !query.bugId || e.bugId === query.bugId);
      return reply(200, { events, hasMore: false, cursor: null });
    }
    if (method === 'POST' && path === '/escalations') {
      if (body?.type !== 'human_approval') return reply(422, { error: 'validation_error', message: 'Unsupported escalation type.' });
      const escalation = { id: id('esc'), status: 'open', type: body.type, body: body.body, bugId: body.bugId, resolution: null, resolvedAt: null };
      state.escalations.set(escalation.id, escalation);
      addEvent('question.asked', { bugId: body.bugId });
      return reply(201, { escalation });
    }
    if ((m = path.match(/^\/escalations\/([^/]+)$/)) && method === 'GET') {
      const escalation = state.escalations.get(m[1]);
      return escalation ? reply(200, { escalation }) : reply(404, { error: 'not_found', message: 'No such escalation.' });
    }
    return reply(404, { error: 'not_found', message: `Fake Ziki has no route for ${method} ${path}.` });
  }

  // fetch-compatible entry point for the unit tests.
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const authorization = new Headers(init.headers).get('authorization');
    const out = handle(init.method || 'GET', url.pathname.replace(/^\/api\/v1/, ''), query, body, authorization);
    return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'content-type': 'application/json', ...out.headers } });
  }

  return {
    key,
    state,
    calls,
    handle,
    fetch: fetchImpl,
    addIssue,
    addEvent,
    addComment,
    // Make the next matching call fail. `match` is a substring of "METHOD /path".
    fail(match, { status = 500, body, headers, times = 1, networkError = false } = {}) {
      failures.push({ match, status, body, headers, times, networkError });
    },
    // Resolve an escalation the way an owner would inside Ziki: free text.
    answer(escalationId, text) {
      Object.assign(state.escalations.get(escalationId), { status: 'resolved', resolution: text, resolvedAt: tick() });
      addEvent('question.answered');
    },
    callsTo: (method, part) => calls.filter((c) => c.method === method && c.path.includes(part)),
    lastEscalationId: () => [...state.escalations.keys()].at(-1)
  };
}
