import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  briefBudget, buildBrief, COMMENT_LIMIT, escalationText, FIELD_LIMITS, MARKER, parseBriefComment,
  REFERENCE_LIMITS, validateBriefInput, verifyBriefBody
} from '../../lib/brief.js';

const issue = { id: 'iss_1', number: 42, title: 'Fix checkout rounding' };
const fromAgent = { id: 'agt_1', name: 'Builder' };
const snapshot = { status: 'in_progress', reviewStatus: null, pullRequestUrl: 'https://github.com/acme/shop/pull/7', pullRequestHeadSha: 'abcdef1234567', capturedAt: '2026-10-29T10:00:00.000Z' };
const input = { reason: 'Out of budget', completed: 'Rounding helper and tests', remaining: 'Wire into checkout', nextSteps: 'Start in cart.ts', references: ['branch fix/rounding', 'PR #7'] };

test('required fields are enforced and optional ones get plain defaults', () => {
  const bad = validateBriefInput({});
  assert.equal(bad.ok, false);
  for (const field of ['reason', 'completed', 'remaining', 'nextSteps']) assert.equal(bad.errors[field], 'Required.');

  const good = validateBriefInput(input);
  assert.equal(good.ok, true);
  assert.equal(good.value.blockers, 'None');
  assert.equal(good.value.tests, 'Not recorded');
  assert.equal(good.value.needsApproval, 'None');
});

test('field and reference limits are enforced', () => {
  const tooLong = validateBriefInput({ ...input, reason: 'x'.repeat(FIELD_LIMITS.reason + 1) });
  assert.match(tooLong.errors.reason, /under 140/);

  const manyRefs = validateBriefInput({ ...input, references: Array.from({ length: REFERENCE_LIMITS.count + 1 }, (_, i) => `ref ${i}`) });
  assert.match(manyRefs.errors.references, /at most 5/);

  const longRef = validateBriefInput({ ...input, references: ['r'.repeat(REFERENCE_LIMITS.each + 1)] });
  assert.match(longRef.errors.references, /under 80/);

  assert.deepEqual(validateBriefInput({ ...input, references: 'a\n\n b \n' }).value.references, ['a', 'b']);
});

test('a built brief fits Ziki’s comment limit, carries its fingerprint, and is deterministic', () => {
  const built = buildBrief({ issue, fromAgent, input, snapshot });
  assert.equal(built.ok, true);
  assert.ok(built.length <= COMMENT_LIMIT);
  assert.equal(built.body.length, built.length);
  assert.match(built.briefId, /^[0-9a-f]{12}$/);
  assert.ok(built.body.startsWith(`HANDOVER BRIEF · ${built.briefId}`));
  assert.deepEqual(built.metadata, { kind: MARKER.brief, v: 1, briefId: built.briefId, issueId: 'iss_1', fromAgentId: 'agt_1' });

  assert.equal(buildBrief({ issue, fromAgent, input, snapshot }).briefId, built.briefId);
  assert.notEqual(buildBrief({ issue, fromAgent, input: { ...input, completed: 'Something else' }, snapshot }).briefId, built.briefId);
});

test('the brief states every section the receiving agent needs, and tells it to verify first', () => {
  const { body } = buildBrief({ issue, fromAgent, input, snapshot });
  for (const heading of ['COMPLETED', 'REMAINING', 'FILES · BRANCHES · PRS', 'TESTS', 'BLOCKERS', 'NEXT STEPS', 'NEEDS HUMAN APPROVAL', 'STATE IN ZIKI']) {
    assert.ok(body.includes(heading), heading);
  }
  assert.ok(body.includes('- branch fix/rounding'));
  assert.ok(body.includes('#42 Fix checkout rounding'));
  assert.match(body, /RECEIVING AGENT: check this state in Ziki before you continue/);
  assert.ok(body.includes('handover_ack'));
});

test('edits after posting are detected', () => {
  const built = buildBrief({ issue, fromAgent, input, snapshot });
  assert.equal(verifyBriefBody(built.body, built.briefId), true);
  assert.equal(verifyBriefBody(built.body.replace('Wire into checkout', 'Wire into nothing'), built.briefId), false);
  assert.equal(verifyBriefBody(undefined, built.briefId), false);

  const comment = { id: 'cmt_1', body: built.body, metadata: { ...built.metadata, escalationId: 'esc_1' }, createdAt: '2026-10-29T10:00:01Z', agentId: 'agt_1' };
  assert.equal(parseBriefComment(comment).intact, true);
  assert.equal(parseBriefComment(comment).escalationId, 'esc_1');
  assert.equal(parseBriefComment({ ...comment, body: `${built.body}\nEDITED` }).intact, false);
  assert.equal(parseBriefComment({ ...comment, metadata: { kind: 'something_else' } }), null);
  assert.equal(parseBriefComment({ ...comment, metadata: null }), null);
});

test('a brief that cannot fit is refused with a clear message, never silently cut', () => {
  const worst = Object.fromEntries(Object.entries(FIELD_LIMITS).map(([k, n]) => [k, 'z'.repeat(n)]));
  worst.references = Array.from({ length: REFERENCE_LIMITS.count }, () => 'r'.repeat(REFERENCE_LIMITS.each));
  const result = buildBrief({ issue: { ...issue, title: 't'.repeat(200) }, fromAgent: { id: 'a', name: 'n'.repeat(60) }, input: worst, snapshot });
  assert.equal(result.ok, false);
  assert.match(result.errors._brief, /characters over Ziki's 2000-character comment limit/);
});

test('the size budget used by the form matches the real brief length', () => {
  const { overhead } = briefBudget({ issue, fromAgent, snapshot });
  const built = buildBrief({ issue, fromAgent, input: { reason: 'abc', completed: 'defg', remaining: 'hi', nextSteps: 'jkl', references: ['one', 'two'], tests: 'ok' }, snapshot });
  const refs = ('one'.length + 2) + ('two'.length + 2) + 1; // "- one\n- two"
  const estimate = overhead + 3 + 4 + 2 + 3 + 'ok'.length + 'None'.length + 'None'.length + refs;
  assert.equal(estimate, built.length);

  const bare = buildBrief({ issue, fromAgent, input: { reason: 'a', completed: 'b', remaining: 'c', nextSteps: 'd' }, snapshot });
  assert.equal(overhead + 4 + 'None'.length * 2 + 'Not recorded'.length + '- None recorded'.length, bare.length);
});

test('the approval request tells the owner exactly how to answer and what happens', () => {
  const text = escalationText({ issue, issueUrl: 'https://ziki.dev/issues/42', agentName: 'Builder', reason: 'Out of budget', briefId: 'abc123abc123' });
  assert.match(text, /Reply APPROVE to hand over now, or REJECT to keep the task where it is\. Nothing happens until you reply\./);
  assert.ok(text.includes('abc123abc123'));
  assert.ok(text.includes('https://ziki.dev/issues/42'));
});
