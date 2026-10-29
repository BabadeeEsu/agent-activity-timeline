// The continuation brief.
//
// Persistence: the brief is posted as an ordinary comment on the Ziki issue (POST /api/v1/issues/{id}/comments).
// Ziki stores it with the issue, so it survives page refreshes, server restarts and a change of agent.
// A short fingerprint (briefId) is derived from the text, so we can tell if the comment was edited
// after the owner approved it.

import { createHash } from 'node:crypto';

export const BRIEF_VERSION = 1;
export const COMMENT_LIMIT = 2000; // Ziki: comment body is 1-2000 characters

export const MARKER = {
  brief: 'handover_brief',
  released: 'handover_released',
  ack: 'handover_ack'
};

export const FIELD_LIMITS = {
  reason: 140,
  completed: 300,
  remaining: 260,
  blockers: 140,
  nextSteps: 220,
  needsApproval: 140,
  tests: 140
};
export const REFERENCE_LIMITS = { count: 5, each: 80 };

const ID_PLACEHOLDER = '{{BRIEF_ID}}';

const clean = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const oneLine = (value, max) => {
  const text = clean(value).replace(/\s*\n\s*/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function validateBriefInput(input = {}) {
  const errors = {};
  const value = {};

  const required = ['reason', 'completed', 'remaining', 'nextSteps'];
  const optional = { blockers: 'None', needsApproval: 'None', tests: 'Not recorded' };

  for (const field of [...required, ...Object.keys(optional)]) {
    let text = clean(input[field]);
    if (!text && required.includes(field)) {
      errors[field] = 'Required.';
      continue;
    }
    if (!text) text = optional[field];
    if (text.length > FIELD_LIMITS[field]) {
      errors[field] = `Keep this under ${FIELD_LIMITS[field]} characters (currently ${text.length}).`;
      continue;
    }
    value[field] = text;
  }

  const rawReferences = Array.isArray(input.references)
    ? input.references
    : String(input.references ?? '').split('\n');
  const references = rawReferences.map((line) => clean(line).replace(/\s*\n\s*/g, ' ')).filter(Boolean);
  if (references.length > REFERENCE_LIMITS.count) {
    errors.references = `List at most ${REFERENCE_LIMITS.count} files, branches or pull requests.`;
  } else if (references.some((line) => line.length > REFERENCE_LIMITS.each)) {
    errors.references = `Keep each line under ${REFERENCE_LIMITS.each} characters.`;
  } else {
    value.references = references;
  }

  return { ok: Object.keys(errors).length === 0, value, errors };
}

function renderBody({ issue, fromAgent, fields, snapshot, briefId }) {
  const refs = fields.references.length ? fields.references.map((line) => `- ${line}`).join('\n') : '- None recorded';
  const pr = snapshot.pullRequestUrl
    ? `${snapshot.pullRequestUrl}${snapshot.pullRequestHeadSha ? ` @${String(snapshot.pullRequestHeadSha).slice(0, 7)}` : ''}`
    : 'none linked';

  return [
    `HANDOVER BRIEF · ${briefId}`,
    `#${issue.number} ${oneLine(issue.title, 70)}`,
    `From: ${oneLine(fromAgent.name || fromAgent.id, 40)} · Why: ${fields.reason}`,
    '',
    'COMPLETED',
    fields.completed,
    '',
    'REMAINING',
    fields.remaining,
    '',
    'FILES · BRANCHES · PRS',
    refs,
    '',
    'TESTS',
    fields.tests,
    '',
    'BLOCKERS',
    fields.blockers,
    '',
    'NEXT STEPS',
    fields.nextSteps,
    '',
    'NEEDS HUMAN APPROVAL',
    fields.needsApproval,
    '',
    `STATE IN ZIKI (${snapshot.capturedAt})`,
    `status ${snapshot.status} · review ${snapshot.reviewStatus || 'none'} · PR ${pr}`,
    '',
    'RECEIVING AGENT: check this state in Ziki before you continue. Treat the notes above as unverified until you do. Then comment with metadata {"kind":"handover_ack"} saying what you checked.'
  ].join('\n');
}

const fingerprint = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export function buildBrief({ issue, fromAgent, input, snapshot }) {
  const checked = validateBriefInput(input);
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const draft = renderBody({ issue, fromAgent, fields: checked.value, snapshot, briefId: ID_PLACEHOLDER });
  const briefId = fingerprint(draft);
  const body = draft.replace(ID_PLACEHOLDER, briefId);

  if (body.length > COMMENT_LIMIT) {
    return {
      ok: false,
      errors: { _brief: `The brief is ${body.length - COMMENT_LIMIT} characters over Ziki's ${COMMENT_LIMIT}-character comment limit. Shorten the longest fields.` }
    };
  }

  return {
    ok: true,
    briefId,
    body,
    fields: checked.value,
    length: body.length,
    metadata: { kind: MARKER.brief, v: BRIEF_VERSION, briefId, issueId: issue.id, fromAgentId: fromAgent.id }
  };
}

// Characters the brief uses before any field text is added, so the form can show an approximate
// running total. The server still checks the exact length when the brief is built.
export function briefBudget({ issue, fromAgent, snapshot }) {
  const empty = { reason: '', completed: '', remaining: '', blockers: '', nextSteps: '', needsApproval: '', tests: '', references: [] };
  const withoutReferenceLine = renderBody({ issue, fromAgent, fields: empty, snapshot, briefId: '0'.repeat(12) }).length - '- None recorded'.length;
  return { limit: COMMENT_LIMIT, overhead: withoutReferenceLine };
}

export function verifyBriefBody(body, briefId) {
  if (typeof body !== 'string' || typeof briefId !== 'string') return false;
  return fingerprint(body.replace(briefId, ID_PLACEHOLDER)) === briefId;
}

// Turn a Ziki comment into a brief record, or null if it is not one of ours.
export function parseBriefComment(comment) {
  const meta = comment?.metadata;
  if (!meta || meta.kind !== MARKER.brief || typeof meta.briefId !== 'string') return null;
  return {
    commentId: comment.id,
    briefId: meta.briefId,
    escalationId: typeof meta.escalationId === 'string' ? meta.escalationId : null,
    body: comment.body,
    createdAt: comment.createdAt,
    agentId: comment.agentId ?? null,
    intact: verifyBriefBody(comment.body, meta.briefId)
  };
}

export function escalationText({ issue, issueUrl, agentName, reason, briefId }) {
  return [
    `Handover approval for #${issue.number} "${oneLine(issue.title, 80)}".`,
    `${oneLine(agentName, 40)} would hand this task to another agent. Reason: ${oneLine(reason, 140)}`,
    `Brief ${briefId} will appear as a comment on the issue: ${issueUrl}`,
    'Reply APPROVE to hand over now, or REJECT to keep the task where it is. Nothing happens until you reply.',
    '(Requested with Agent Work Recovery.)'
  ].join('\n');
}

export function releasedCommentText({ briefId, at, reofferedTo }) {
  return [
    `Handover complete. After owner approval (brief ${briefId}), this task was released at ${at}.`,
    reofferedTo ? 'Ziki re-offered it to the next eligible person.' : 'Ziki did not report a new offer yet.',
    'Receiving agent: see the brief above and check the state in Ziki before you continue.'
  ].join('\n');
}
