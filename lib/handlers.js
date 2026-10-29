// Web-standard request handlers: (Request) => Response.
//
// The same handlers run on Vercel (through lib/node-adapter.js) and can be mounted in a Next.js
// route handler inside Ziki without changes (see docs/INTEGRATION.md).
//
// Ziki calls made here, all from Ziki's agent API reference (https://ziki.dev/llms.txt):
//   reads : GET /agents/me, /projects, /issues, /issues/{id}, /issues/{id}/comments, /events, /escalations/{id}
//   writes: POST /escalations (type human_approval), POST /issues/{id}/comments, POST /issues/{id}/release
// Nothing else is called. In particular this code never sends heartbeats, never extends a claim,
// and never tries to assign a task to a chosen agent, because the API has no route for that.

import { briefBudget, buildBrief, escalationText, FIELD_LIMITS, MARKER, REFERENCE_LIMITS, releasedCommentText } from './brief.js';
import { publicStatus } from './config.js';
import { deriveHandover, deriveRecovery, latestBriefOf } from './recovery-state.js';
import { clearedCookie, issueSession, passphraseMatches, sessionCookie, verifySession } from './session.js';
import { createZikiClient, ZikiError } from './ziki-client.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const reply = (status, body, headers = {}) => {
  const out = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const [name, value] of Object.entries(headers)) out.set(name, value);
  return new Response(JSON.stringify(body), { status, headers: out });
};

// Map anything that can go wrong into a message a person can act on. Raw upstream bodies are never echoed.
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof ZikiError) {
    const { status, code, message, retryAfter } = error;
    if (status === 0) return new ApiError(error.code === 'timeout' ? 504 : 502, 'ziki_unavailable', `${message} Try again in a moment.`);
    if (status === 401) return new ApiError(502, 'ziki_key_rejected', 'Ziki rejected the agent key (invalid, malformed or revoked). Ask a Ziki admin for a new key and update ZIKI_AGENT_KEY.');
    if (status === 403) {
      if (code === 'insufficient_level' || /level/i.test(message)) return new ApiError(403, 'agent_level_too_low', `Ziki refused: ${message}`);
      if (code === 'project_forbidden') return new ApiError(403, 'project_forbidden', `Ziki refused: ${message}`);
      return new ApiError(403, 'forbidden', `Ziki refused this action: ${message}`);
    }
    if (status === 404) return new ApiError(404, 'not_found', 'Ziki could not find that item, or this key cannot see it.');
    if (status === 409 || status === 410) return new ApiError(409, 'conflict', `Ziki says: ${message}`);
    if (status === 429) {
      const seconds = Number(retryAfter) || null;
      return new ApiError(429, 'rate_limited', seconds ? `Ziki’s rate limit was reached. Try again in ${seconds} seconds.` : 'Ziki’s rate limit was reached. Try again shortly.', { retryAfter: seconds });
    }
    if (status >= 500) return new ApiError(502, 'ziki_unavailable', 'Ziki had a problem handling that. Try again in a moment.');
    return new ApiError(502, 'ziki_error', `Ziki answered with an error: ${message}`);
  }
  return new ApiError(500, 'internal', 'Something went wrong on the server.');
}

function errorResponse(error) {
  const api = toApiError(error);
  const headers = api.extra?.retryAfter ? { 'retry-after': String(api.extra.retryAfter) } : {};
  return reply(api.status, { error: { code: api.code, message: api.message, ...api.extra } }, headers);
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 20000) throw new ApiError(413, 'too_large', 'That request is too large.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'bad_json', 'The request body must be a JSON object.');
}

const cleanId = (value) => {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new ApiError(400, 'bad_issue_id', 'That is not a valid issue id.');
  return id;
};

async function collect(pageFn, listKey, nextFn, maxPages = 10) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await pageFn(cursor);
    items.push(...(result?.[listKey] ?? []));
    cursor = nextFn(result);
    if (!cursor) return { items, truncated: false };
  }
  return { items, truncated: true };
}

const issueSummary = (issue, baseUrl) => ({
  id: issue.id,
  number: issue.number,
  title: issue.title,
  status: issue.status,
  severity: issue.severity ?? null,
  reviewStatus: issue.reviewStatus ?? null,
  assigneeId: issue.assigneeId ?? null,
  pullRequestUrl: issue.pullRequestUrl ?? null,
  pullRequestHeadSha: issue.pullRequestHeadSha ?? null,
  updatedAt: issue.updatedAt ?? null,
  url: `${baseUrl}/issues/${issue.number}`
});

const agentSummary = (me) => ({ id: me.id, name: me.name, level: me.level, ownerId: me.owner_id });

export function createHandlers({ config, fetchImpl = fetch, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const client = () => createZikiClient({ baseUrl: config.baseUrl, key: config.zikiKey, fetchImpl });
  const isSecure = (request) => new URL(request.url).protocol === 'https:';

  function requireConfigured() {
    if (!config.ready) {
      throw new ApiError(503, 'not_configured', 'Agent Work Recovery is not configured on the server.', { missing: config.missing, problems: config.problems });
    }
  }

  // Same-site checks for anything that changes state.
  function requireSameSiteWrite(request) {
    if (request.headers.get('x-requested-with') !== 'zk-recovery') {
      throw new ApiError(403, 'bad_request_origin', 'This request did not come from the app.');
    }
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      throw new ApiError(403, 'bad_request_origin', 'This request came from a different site.');
    }
  }

  function guard(request, { write }) {
    requireConfigured();
    if (!verifySession(config, request.headers.get('cookie'), now())) throw new ApiError(401, 'not_signed_in', 'Sign in to continue.');
    if (write) requireSameSiteWrite(request);
  }

  const route = (method, { write = false } = {}, fn) => async (request) => {
    try {
      if (request.method !== method) throw new ApiError(405, 'method_not_allowed', `Use ${method} for this route.`);
      guard(request, { write });
      return await fn(request);
    } catch (error) {
      if (!(error instanceof ApiError) && !(error instanceof ZikiError)) console.error('recovery: unexpected error', error?.name);
      return errorResponse(error);
    }
  };

  function resolveProjectId(me) {
    const id = config.projectId || me.project_id || (Array.isArray(me.projects) && me.projects.length === 1 ? me.projects[0].id : '');
    if (!id) throw new ApiError(400, 'project_required', 'This agent key is not limited to one project. Set ZIKI_PROJECT_ID.');
    return id;
  }

  // Everything the UI and the write routes need to know about one task, read live from Ziki.
  async function loadTask(z, me, id) {
    const projectId = resolveProjectId(me);
    const { issue } = await z.getIssue(id, { projectId });

    const [comments, events, projects] = await Promise.all([
      collect((after) => z.listComments(issue.id, { projectId, after }), 'items', (r) => r.nextCursor),
      collect((after) => z.events({ bugId: issue.id, projectId, after }), 'events', (r) => (r.hasMore ? r.cursor : null)),
      z.projects().then((r) => r.items ?? []).catch(() => [])
    ]);

    const latest = latestBriefOf(comments.items);
    let escalation = null;
    let escalationError = null;
    if (latest?.escalationId) {
      try {
        escalation = (await z.getEscalation(latest.escalationId)).escalation ?? null;
      } catch (error) {
        escalationError = error;
      }
    }

    return {
      projectId,
      issue,
      comments: comments.items,
      events: events.items,
      project: projects.find((p) => p.id === issue.projectId) ?? null,
      escalation,
      escalationError,
      truncated: { comments: comments.truncated, events: events.truncated }
    };
  }

  const handover = (t, me) => deriveHandover({ issue: t.issue, me, comments: t.comments, escalation: t.escalation, escalationError: t.escalationError });

  // ---- session -----------------------------------------------------------------------------------------
  const session = async (request) => {
    try {
      if (request.method === 'GET') {
        const authenticated = config.ready && verifySession(config, request.headers.get('cookie'), now());
        return reply(200, { ...publicStatus(config), authenticated });
      }
      if (request.method === 'POST') {
        requireConfigured();
        requireSameSiteWrite(request);
        const { passphrase } = await readJson(request);
        if (!passphraseMatches(config, passphrase)) {
          await delay(500);
          throw new ApiError(401, 'bad_passphrase', 'That passphrase is not correct.');
        }
        const issued = issueSession(config, now());
        return reply(200, { authenticated: true }, { 'set-cookie': sessionCookie(issued.value, { maxAge: issued.maxAge, secure: isSecure(request) }) });
      }
      if (request.method === 'DELETE') {
        requireSameSiteWrite(request);
        return reply(200, { authenticated: false }, { 'set-cookie': clearedCookie({ secure: isSecure(request) }) });
      }
      throw new ApiError(405, 'method_not_allowed', 'Use GET, POST or DELETE.');
    } catch (error) {
      return errorResponse(error);
    }
  };

  // ---- tasks this agent's owner is working on -------------------------------------------------------------
  const tasks = route('GET', {}, async () => {
    const z = client();
    const me = await z.me();
    const projectId = resolveProjectId(me);
    const page = await z.listIssues({ projectId, status: 'in_progress', assignee: me.owner_id, limit: 50 });
    return reply(200, {
      agent: agentSummary(me),
      projectId,
      items: (page.items ?? []).map((issue) => issueSummary(issue, config.baseUrl)),
      hasMore: Boolean(page.nextCursor)
    });
  });

  // ---- one task: status, handover state, recovery facts -----------------------------------------------------
  const task = route('GET', {}, async (request) => {
    const id = cleanId(new URL(request.url).searchParams.get('id'));
    const z = client();
    const me = await z.me();
    const t = await loadTask(z, me, id);
    const state = handover(t, me);
    return reply(200, {
      agent: agentSummary(me),
      issue: issueSummary(t.issue, config.baseUrl),
      handover: state,
      recovery: deriveRecovery({ issue: t.issue, me, events: t.events, comments: t.comments, project: t.project, handover: state, now: now() }),
      prefill: {
        references: t.issue.pullRequestUrl ? [`PR ${t.issue.pullRequestUrl}`] : [],
        limits: { fields: FIELD_LIMITS, references: REFERENCE_LIMITS },
        budget: briefBudget({
          issue: t.issue,
          fromAgent: { id: me.id, name: me.name },
          snapshot: { status: t.issue.status, reviewStatus: t.issue.reviewStatus ?? null, pullRequestUrl: t.issue.pullRequestUrl ?? null, pullRequestHeadSha: t.issue.pullRequestHeadSha ?? null, capturedAt: new Date(now()).toISOString() }
        })
      },
      truncated: t.truncated
    });
  });

  // ---- A. ask the owner to approve a handover (also saves the continuation brief) -----------------------------
  const handoverRequest = route('POST', { write: true }, async (request) => {
    const input = await readJson(request);
    if (input.confirm !== true) throw new ApiError(400, 'confirmation_required', 'Confirm the request before it is sent.');
    const id = cleanId(input.issueId);

    const z = client();
    const me = await z.me();
    const t = await loadTask(z, me, id);
    const state = handover(t, me);
    if (!state.canRequest.ok) {
      throw new ApiError(state.canRequest.code === 'agent_level_too_low' ? 403 : 409, state.canRequest.code, state.canRequest.reason);
    }

    const built = buildBrief({
      issue: t.issue,
      fromAgent: { id: me.id, name: me.name },
      input: input.brief,
      snapshot: {
        status: t.issue.status,
        reviewStatus: t.issue.reviewStatus ?? null,
        pullRequestUrl: t.issue.pullRequestUrl ?? null,
        pullRequestHeadSha: t.issue.pullRequestHeadSha ?? null,
        capturedAt: new Date(now()).toISOString()
      }
    });
    if (!built.ok) throw new ApiError(422, 'invalid_brief', 'The brief needs changes before it can be sent.', { fields: built.errors });

    const issueUrl = `${config.baseUrl}/issues/${t.issue.number}`;
    const { escalation } = await z.createEscalation({
      body: escalationText({ issue: t.issue, issueUrl, agentName: me.name || me.id, reason: built.fields.reason, briefId: built.briefId }),
      type: 'human_approval',
      bugId: t.issue.id
    });

    let comment;
    try {
      ({ comment } = await z.postComment(t.issue.id, {
        projectId: t.projectId,
        body: built.body,
        metadata: { ...built.metadata, escalationId: escalation.id }
      }));
    } catch (error) {
      const api = toApiError(error);
      throw new ApiError(502, 'brief_not_saved', `The owner was asked to approve, but the brief could not be saved (${api.message}) Send the request again. The earlier request stays open in Ziki until the owner answers it.`, { escalationId: escalation.id });
    }

    return reply(201, { briefId: built.briefId, escalationId: escalation.id, commentId: comment?.id ?? null });
  });

  // ---- B. hand the task over: release it so Ziki re-offers it to the next eligible agent ------------------------
  const handoverExecute = route('POST', { write: true }, async (request) => {
    const input = await readJson(request);
    if (input.confirm !== true) throw new ApiError(400, 'confirmation_required', 'Confirm the handover before it is sent.');
    const id = cleanId(input.issueId);

    const z = client();
    const me = await z.me();
    const t = await loadTask(z, me, id);
    const state = handover(t, me);

    if (!state.brief || state.brief.briefId !== String(input.briefId ?? '')) {
      throw new ApiError(409, 'brief_superseded', 'A newer brief exists for this task. Review it and approve that one instead.');
    }
    if (state.phase === 'released') throw new ApiError(409, 'already_handed_over', 'This brief has already been handed over.');
    if (!state.canExecute.ok) {
      const code = state.phase === 'approved' ? state.canExecute.code ?? 'not_allowed' : { awaiting_approval: 'awaiting_approval', rejected: 'rejected', unclear: 'approval_unclear', invalid: 'brief_invalid' }[state.phase] ?? 'no_approval';
      throw new ApiError(code === 'agent_level_too_low' ? 403 : 409, code, state.canExecute.reason);
    }

    const owner = String(state.approval.resolution).replace(/\s+/g, ' ').slice(0, 200);
    const result = await z.release(t.issue.id, {
      projectId: t.projectId,
      reason: `Handover approved by the owner. Brief ${state.brief.briefId} is on this issue. Owner reply: "${owner}"`.slice(0, 500)
    });

    const at = new Date(now()).toISOString();
    let markerSaved = true;
    try {
      await z.postComment(t.issue.id, {
        projectId: t.projectId,
        body: releasedCommentText({ briefId: state.brief.briefId, at, reofferedTo: result?.reofferedTo ?? null }),
        metadata: { kind: MARKER.released, briefId: state.brief.briefId, claimId: result?.claimId ?? null, reofferedTo: result?.reofferedTo ?? null, at }
      });
    } catch {
      markerSaved = false; // the release itself succeeded; Ziki's own claim.released event is the record
    }

    return reply(200, {
      released: true,
      reopened: result?.reopened ?? null,
      reofferedTo: result?.reofferedTo ?? null,
      claimId: result?.claimId ?? null,
      markerSaved
    });
  });

  const actions = { session, tasks, task, 'handover-request': handoverRequest, 'handover-execute': handoverExecute };

  // Single entry point for hosts that route by action name (for example a Next.js catch-all route).
  const handle = (request, action) => (actions[action] ? actions[action](request) : reply(404, { error: { code: 'not_found', message: 'Unknown route.' } }));

  return { ...actions, handle };
}
