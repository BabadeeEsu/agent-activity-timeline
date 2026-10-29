// Pure functions that turn what Ziki reports into what the UI may show and allow.
// Nothing here calls the network. Nothing here guesses: when Ziki does not expose a fact, we say so.

import { MARKER, parseBriefComment } from './brief.js';

// Levels that may call the write routes this feature uses (comments, escalations, release).
export const WRITE_LEVELS = new Set(['contributor', 'dispatcher', 'merger', 'admin_merger']);

// The owner answers an escalation with free text in Ziki. We only act on a clear APPROVE.
export function parseApproval(text) {
  const first = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .match(/^[a-z]+/);
  const word = first ? first[0] : '';
  if (word === 'approve' || word === 'approved') return 'approved';
  if (['reject', 'rejected', 'decline', 'declined', 'deny', 'denied', 'no'].includes(word)) return 'rejected';
  return 'unclear';
}

export function writeAccess(me) {
  return WRITE_LEVELS.has(me?.level)
    ? { ok: true }
    : { ok: false, code: 'agent_level_too_low', reason: `This agent is ${me?.level || 'unknown'} level. Comments, approval requests and release need contributor level or higher.` };
}

// The task must be one this key's owner is working on, because Ziki lets only the agent that holds
// the claim release it.
export function taskAccess(issue, me) {
  if (issue.status !== 'in_progress') {
    return { ok: false, code: 'not_in_progress', reason: `The task is ${issue.status}, not in progress, so there is no claim to hand over.` };
  }
  if (!issue.assigneeId || issue.assigneeId !== me.owner_id) {
    return { ok: false, code: 'not_this_agents_task', reason: 'This task is assigned to someone else. Ziki only lets the agent holding the claim release it.' };
  }
  return { ok: true };
}

const byTime = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

// The newest brief wins: an earlier, unanswered request can never be used to hand over.
export function latestBriefOf(comments) {
  return comments.map(parseBriefComment).filter(Boolean).sort(byTime).at(-1) ?? null;
}

export function deriveHandover({ issue, me, comments, escalation, escalationError }) {
  const latest = latestBriefOf(comments);

  const markers = (kind) => comments.filter((c) => c.metadata?.kind === kind);
  const releasedComment = latest ? markers(MARKER.released).find((c) => c.metadata.briefId === latest.briefId) : null;
  const ackComment = latest
    ? markers(MARKER.ack)
        .filter((c) => new Date(c.createdAt) >= new Date(latest.createdAt))
        .sort(byTime)[0] ?? null
    : null;

  const level = writeAccess(me);
  const task = taskAccess(issue, me);
  const canRequest = !level.ok ? level : !task.ok ? task : { ok: true };

  let phase = 'none';
  let approval = null;

  if (latest) {
    if (releasedComment) phase = 'released';
    else if (!latest.intact) phase = 'invalid';
    else if (!latest.escalationId) phase = 'invalid';
    else if (!escalation) phase = 'invalid';
    else if (escalation.status === 'open') phase = 'awaiting_approval';
    else if (escalation.status === 'resolved') {
      const decision = parseApproval(escalation.resolution);
      phase = decision;
      approval = { decision, resolution: escalation.resolution ?? '', resolvedAt: escalation.resolvedAt ?? null };
    } else phase = 'invalid';
  }

  let invalidReason = null;
  if (phase === 'invalid' && latest) {
    if (!latest.intact) invalidReason = 'The brief comment was edited after it was posted, so the owner approval no longer applies. Write a new brief.';
    else if (!latest.escalationId) invalidReason = 'This brief was saved without an approval request. Send a new request.';
    else invalidReason = escalationError ? 'The approval request could not be read from Ziki.' : 'Ziki returned an unexpected approval status.';
  }

  let canExecute = { ok: false, reason: 'Hand over is available after the owner approves.' };
  if (phase === 'approved') {
    canExecute = !level.ok ? level : !task.ok ? task : { ok: true };
  } else if (phase === 'released') {
    canExecute = { ok: false, reason: 'This brief has already been handed over.' };
  } else if (phase === 'awaiting_approval') {
    canExecute = { ok: false, reason: 'Waiting for the owner to answer in Ziki.' };
  } else if (phase === 'rejected') {
    canExecute = { ok: false, reason: 'The owner rejected this handover.' };
  } else if (phase === 'unclear') {
    canExecute = { ok: false, reason: 'The owner replied, but not with a clear APPROVE or REJECT.' };
  } else if (phase === 'invalid') {
    canExecute = { ok: false, reason: invalidReason };
  }

  return {
    phase,
    brief: latest,
    approval,
    invalidReason,
    released: releasedComment
      ? { at: releasedComment.metadata.at ?? releasedComment.createdAt, reofferedTo: releasedComment.metadata.reofferedTo ?? null, claimId: releasedComment.metadata.claimId ?? null }
      : null,
    ack: ackComment ? { at: ackComment.createdAt, agentId: ackComment.agentId ?? null } : null,
    canRequest,
    canExecute
  };
}

const EVENT_LABELS = {
  'claim.offered': 'Task offered to an agent',
  'claim.accepted': 'Claim accepted',
  'claim.extended': 'Delivery deadline extended',
  'claim.released': 'Claim released',
  'comment.created': 'Comment added',
  'issue.pr_linked': 'Pull request linked',
  'issue.test_verdict': 'Test verdict recorded',
  'issue.updated': 'Issue updated',
  'question.asked': 'Question or escalation raised',
  'question.answered': 'Question answered'
};

const isOurNote = (comment) => String(comment.metadata?.kind || '').startsWith('handover_');

export function deriveRecovery({ issue, me, events, comments, project, handover, now = Date.now() }) {
  const sorted = [...events].sort(byTime);
  const last = (type) => sorted.filter((e) => e.type === type).at(-1) ?? null;

  const accepted = last('claim.accepted');
  const released = last('claim.released');
  const asked = sorted.filter((e) => e.type === 'question.asked');
  const answered = sorted.filter((e) => e.type === 'question.answered');
  const waitingOnOwner = asked.length > answered.length;

  // Last recorded activity: events and comments by the agent side. Our own handover notes do not count.
  const activity = [
    ...sorted.map((e) => ({ at: e.createdAt, label: EVENT_LABELS[e.type] || e.type, source: 'event' })),
    ...comments.filter((c) => !isOurNote(c)).map((c) => ({ at: c.createdAt, label: c.agentId ? 'Agent comment' : 'Comment', source: 'comment' }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  const lastActivity = activity.at(-1) ?? null;
  const quietMinutes = lastActivity ? Math.max(0, Math.round((now - new Date(lastActivity.at)) / 60000)) : null;

  const workflow = project?.workflow ?? null;
  const thresholds = workflow ? { heartbeatMinutes: workflow.heartbeatMinutes ?? null, deliveryMinutes: workflow.deliveryMinutes ?? null } : null;

  const claimed = issue.status === 'in_progress' && Boolean(issue.assigneeId);
  let headline;
  if (claimed) headline = 'Ziki shows this task as in progress and assigned.';
  else if (issue.status === 'open') {
    const reason = released?.payload?.reason || released?.payload?.releaseReason;
    headline = released ? `Not currently claimed. The last claim was released${reason ? ` (${reason})` : ''}.` : 'Not currently claimed.';
  } else headline = `This task is ${issue.status}.`;

  // Only name an agent while Ziki still shows the task as claimed. After a release the last
  // "claim.accepted" event is history, not the current agent.
  const currentAgentId = claimed ? accepted?.actorAgentId ?? null : null;

  const heartbeatText = thresholds?.heartbeatMinutes
    ? `Ziki releases a claim by itself after ${thresholds.heartbeatMinutes} minutes without a heartbeat, or when the delivery deadline passes with no linked fix.`
    : 'Ziki releases a claim by itself when its agent goes silent or misses the delivery deadline.';

  const limitations = [
    'Ziki does not expose the claim state, delivery deadline or last heartbeat time through its API. This view uses the issue status and recorded events instead.',
    'Heartbeats are not recorded as events, so a quiet history does not prove the agent has stopped.',
    'There is no documented way for a person to wake or instruct a running agent.'
  ];

  const options = [
    {
      id: 'handover',
      label: 'Hand the task to another agent',
      available: handover.canRequest.ok,
      note: handover.canRequest.ok ? 'Needs the owner’s approval in Ziki first.' : handover.canRequest.reason
    },
    {
      id: 'answer_question',
      label: 'Answer the agent’s open question in Ziki',
      available: waitingOnOwner,
      note: waitingOnOwner
        ? 'Ziki pauses the claim’s timers while the owner’s answer is pending, and resumes them once it is answered.'
        : 'No open question or escalation is recorded for this task.'
    },
    { id: 'auto_release', label: 'Let Ziki release it', available: claimed, note: heartbeatText },
    {
      id: 'resume',
      label: 'Ask the agent to resume',
      available: false,
      note: 'Not supported: Ziki has no documented command for a person to resume or instruct a running agent.'
    }
  ];

  return {
    headline,
    status: issue.status,
    claimed,
    currentAgent: currentAgentId ? { id: currentAgentId, isThisKey: currentAgentId === me.id } : null,
    lastActivity,
    quietMinutes,
    thresholds,
    waitingOnOwner,
    recentEvents: sorted.slice(-6).reverse().map((e) => ({ type: e.type, label: EVENT_LABELS[e.type] || e.type, at: e.createdAt, actorAgentId: e.actorAgentId ?? null })),
    limitations,
    options
  };
}
