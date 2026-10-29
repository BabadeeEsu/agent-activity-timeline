import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrief, MARKER } from '../../lib/brief.js';
import { deriveHandover, deriveRecovery, latestBriefOf, parseApproval, taskAccess, writeAccess } from '../../lib/recovery-state.js';

const me = { id: 'agt_1', name: 'Builder', level: 'contributor', owner_id: 'user_1' };
const issue = { id: 'iss_1', number: 42, title: 'Fix checkout rounding', status: 'in_progress', assigneeId: 'user_1' };
const snapshot = { status: 'in_progress', capturedAt: '2026-10-29T10:00:00.000Z' };
const input = { reason: 'Out of budget', completed: 'Helper', remaining: 'Wire it', nextSteps: 'Start in cart.ts' };

function briefComment({ at = '2026-10-29T10:00:00Z', escalationId = 'esc_1', tweak = (body) => body, extra = {} } = {}) {
  const built = buildBrief({ issue, fromAgent: me, input: { ...input, ...extra }, snapshot });
  return { id: `cmt_${at}`, body: tweak(built.body), metadata: { ...built.metadata, ...(escalationId ? { escalationId } : {}) }, createdAt: at, agentId: 'agt_1' };
}
const resolved = (resolution) => ({ id: 'esc_1', status: 'resolved', resolution, resolvedAt: '2026-10-29T10:05:00Z' });

test('only a clear APPROVE counts as approval', () => {
  for (const text of ['APPROVE', 'approve', 'Approved.', '  approve — go ahead', '"Approve"', 'APPROVE: hand to Sam']) assert.equal(parseApproval(text), 'approved', text);
  for (const text of ['REJECT', 'reject: not now', 'Declined', 'deny', 'no', 'No way']) assert.equal(parseApproval(text), 'rejected', text);
  for (const text of ['', null, undefined, 'maybe', 'I do not approve', 'please approve later', 'ok', 'yes', 'go ahead', 'not approved']) assert.equal(parseApproval(text), 'unclear', String(text));
});

test('write access needs contributor level or higher', () => {
  for (const level of ['contributor', 'dispatcher', 'merger', 'admin_merger']) assert.equal(writeAccess({ level }).ok, true, level);
  for (const level of ['observer', 'unknown', undefined]) {
    const result = writeAccess({ level });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'agent_level_too_low');
  }
});

test('only an in-progress task held by this key’s owner can be handed over', () => {
  assert.equal(taskAccess(issue, me).ok, true);
  assert.equal(taskAccess({ ...issue, status: 'open' }, me).code, 'not_in_progress');
  assert.equal(taskAccess({ ...issue, assigneeId: 'someone_else' }, me).code, 'not_this_agents_task');
  assert.equal(taskAccess({ ...issue, assigneeId: null }, me).code, 'not_this_agents_task');
});

test('the newest brief wins', () => {
  const older = briefComment({ at: '2026-10-29T10:00:00Z', escalationId: 'esc_old' });
  const newer = briefComment({ at: '2026-10-29T11:00:00Z', escalationId: 'esc_new', extra: { completed: 'More done' } });
  assert.equal(latestBriefOf([newer, older]).escalationId, 'esc_new');
  assert.equal(latestBriefOf([]), null);
});

test('handover phases follow what Ziki reports, nothing more', () => {
  const comment = briefComment();
  const derive = (extra = {}) => deriveHandover({ issue, me, comments: [comment], escalation: null, ...extra });

  assert.equal(deriveHandover({ issue, me, comments: [], escalation: null }).phase, 'none');
  assert.equal(derive({ escalation: { id: 'esc_1', status: 'open' } }).phase, 'awaiting_approval');

  const approved = derive({ escalation: resolved('APPROVE, go ahead') });
  assert.equal(approved.phase, 'approved');
  assert.equal(approved.canExecute.ok, true);
  assert.equal(approved.approval.resolution, 'APPROVE, go ahead');

  const rejected = derive({ escalation: resolved('REJECT') });
  assert.equal(rejected.phase, 'rejected');
  assert.equal(rejected.canExecute.ok, false);

  const unclear = derive({ escalation: resolved('let me think about it') });
  assert.equal(unclear.phase, 'unclear');
  assert.equal(unclear.canExecute.ok, false);
});

test('nothing can be executed unless approved', () => {
  const comment = briefComment();
  for (const escalation of [{ id: 'esc_1', status: 'open' }, resolved('REJECT'), resolved('hmm'), null]) {
    assert.equal(deriveHandover({ issue, me, comments: [comment], escalation }).canExecute.ok, false);
  }
  assert.equal(deriveHandover({ issue, me, comments: [], escalation: null }).canExecute.ok, false);
});

test('a brief edited after posting, or saved without a request, is invalid even if an approval exists', () => {
  const edited = briefComment({ tweak: (body) => body.replace('Wire it', 'Delete the repository') });
  const state = deriveHandover({ issue, me, comments: [edited], escalation: resolved('APPROVE') });
  assert.equal(state.phase, 'invalid');
  assert.equal(state.canExecute.ok, false);
  assert.match(state.invalidReason, /edited after it was posted/);

  const noRequest = deriveHandover({ issue, me, comments: [briefComment({ escalationId: null })], escalation: null });
  assert.equal(noRequest.phase, 'invalid');

  const unreadable = deriveHandover({ issue, me, comments: [briefComment()], escalation: null, escalationError: new Error('404') });
  assert.equal(unreadable.phase, 'invalid');
  assert.match(unreadable.invalidReason, /could not be read/);
});

test('approval does not survive a lost claim or a lowered level', () => {
  const comments = [briefComment()];
  const escalation = resolved('APPROVE');
  assert.equal(deriveHandover({ issue: { ...issue, status: 'open', assigneeId: null }, me, comments, escalation }).canExecute.code, 'not_in_progress');
  assert.equal(deriveHandover({ issue, me: { ...me, level: 'observer' }, comments, escalation }).canExecute.code, 'agent_level_too_low');
});

test('release and acknowledgement are read from the markers on the issue', () => {
  const brief = briefComment();
  const briefId = brief.metadata.briefId;
  const released = { id: 'cmt_r', body: 'done', createdAt: '2026-10-29T10:10:00Z', metadata: { kind: MARKER.released, briefId, at: '2026-10-29T10:10:00Z', reofferedTo: 'agt_2' } };
  const state = deriveHandover({ issue: { ...issue, status: 'open', assigneeId: null }, me, comments: [brief, released], escalation: resolved('APPROVE') });
  assert.equal(state.phase, 'released');
  assert.equal(state.released.reofferedTo, 'agt_2');
  assert.equal(state.ack, null);

  const early = { id: 'cmt_a0', body: 'old', createdAt: '2026-10-29T09:00:00Z', metadata: { kind: MARKER.ack } };
  const ack = { id: 'cmt_a1', body: 'checked', createdAt: '2026-10-29T10:20:00Z', agentId: 'agt_2', metadata: { kind: MARKER.ack } };
  const withAck = deriveHandover({ issue: { ...issue, status: 'open' }, me, comments: [brief, released, early, ack], escalation: resolved('APPROVE') });
  assert.equal(withAck.ack.agentId, 'agt_2');
});

test('observer-level keys cannot request a handover', () => {
  const state = deriveHandover({ issue, me: { ...me, level: 'observer' }, comments: [], escalation: null });
  assert.equal(state.canRequest.ok, false);
  assert.equal(state.canRequest.code, 'agent_level_too_low');
});

// ---- recovery ----
const NOW = Date.parse('2026-10-29T12:00:00Z');
const handover = deriveHandover({ issue, me, comments: [], escalation: null });
const event = (type, at, extra = {}) => ({ id: type + at, type, createdAt: at, actorAgentId: 'agt_1', ...extra });

test('recovery reports recorded facts and says what it cannot know', () => {
  const recovery = deriveRecovery({
    issue, me, handover, now: NOW,
    events: [event('claim.accepted', '2026-10-29T10:00:00Z'), event('comment.created', '2026-10-29T11:30:00Z')],
    comments: [],
    project: { workflow: { heartbeatMinutes: 15, deliveryMinutes: 120 } }
  });
  assert.equal(recovery.status, 'in_progress');
  assert.equal(recovery.claimed, true);
  assert.equal(recovery.lastActivity.label, 'Comment added');
  assert.equal(recovery.quietMinutes, 30);
  assert.deepEqual(recovery.thresholds, { heartbeatMinutes: 15, deliveryMinutes: 120 });
  assert.deepEqual(recovery.currentAgent, { id: 'agt_1', isThisKey: true });
  assert.equal(recovery.limitations.length, 3);
  assert.ok(recovery.limitations.some((l) => /heartbeat/i.test(l)));
  assert.ok(!('stalled' in recovery) && !('isStalled' in recovery), 'no stalled verdict is invented');
});

test('quiet time is not turned into a stalled verdict, and our own handover notes do not count as activity', () => {
  const note = { id: 'n1', createdAt: '2026-10-29T11:59:00Z', body: 'x', metadata: { kind: MARKER.brief } };
  const recovery = deriveRecovery({ issue, me, handover, now: NOW, events: [event('claim.accepted', '2026-10-29T08:00:00Z')], comments: [note], project: null });
  assert.equal(recovery.lastActivity.label, 'Claim accepted');
  assert.equal(recovery.quietMinutes, 240);
  assert.equal(recovery.thresholds, null);
  assert.match(recovery.headline, /in progress and assigned/);
});

test('no activity at all is reported as no activity', () => {
  const recovery = deriveRecovery({ issue, me, handover, now: NOW, events: [], comments: [], project: null });
  assert.equal(recovery.lastActivity, null);
  assert.equal(recovery.quietMinutes, null);
  assert.equal(recovery.currentAgent, null);
});

test('an open question is detected from events, and pauses are described, not assumed', () => {
  const waiting = deriveRecovery({ issue, me, handover, now: NOW, events: [event('question.asked', '2026-10-29T09:00:00Z')], comments: [], project: null });
  assert.equal(waiting.waitingOnOwner, true);
  assert.equal(waiting.options.find((o) => o.id === 'answer_question').available, true);

  const answered = deriveRecovery({ issue, me, handover, now: NOW, events: [event('question.asked', '2026-10-29T09:00:00Z'), event('question.answered', '2026-10-29T09:05:00Z')], comments: [], project: null });
  assert.equal(answered.waitingOnOwner, false);
});

test('resuming an agent is always listed as unsupported', () => {
  const recovery = deriveRecovery({ issue, me, handover, now: NOW, events: [], comments: [], project: null });
  const resume = recovery.options.find((o) => o.id === 'resume');
  assert.equal(resume.available, false);
  assert.match(resume.note, /Not supported/);
  assert.deepEqual(recovery.options.map((o) => o.id), ['handover', 'answer_question', 'auto_release', 'resume']);
});

test('a released, unclaimed task is described as such', () => {
  const open = { ...issue, status: 'open', assigneeId: null };
  const recovery = deriveRecovery({
    issue: open, me, handover: deriveHandover({ issue: open, me, comments: [], escalation: null }), now: NOW,
    events: [event('claim.accepted', '2026-10-29T08:00:00Z'), event('claim.released', '2026-10-29T11:00:00Z', { payload: { reason: 'Handover approved' } })], comments: [], project: null
  });
  assert.equal(recovery.claimed, false);
  assert.equal(recovery.currentAgent, null, 'a released task has no current agent, even though an older claim.accepted event exists');
  assert.match(recovery.headline, /Not currently claimed\. The last claim was released \(Handover approved\)/);
  assert.equal(recovery.options.find((o) => o.id === 'handover').available, false);
});
