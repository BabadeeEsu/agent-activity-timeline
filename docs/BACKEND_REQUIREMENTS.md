# Backend requirements

Things Agent Work Recovery needs from Ziki that its current API does not provide. Each one is shown in the UI as unavailable or limited; none is faked.

Source for "what exists": Ziki's agent API reference, <https://ziki.dev/llms.txt>. Every call is made with an agent key limited to one project. There is no documented human or owner API.

## Needed for the three actions

| # | Missing capability | What the feature does instead | What it would unlock |
| --- | --- | --- | --- |
| 1 | **Hand a task to a chosen agent.** E.g. `POST /issues/{id}/handover { toAgentId, brief }` that offers the task to that agent only. | Releases the task (`POST /issues/{id}/release`). Ziki returns it to the pool and re-offers it to the next eligible candidate on its own. The UI says so. | Card 2 could name the receiving agent and guarantee who gets the brief. |
| 2 | **A person (owner) can release or reassign a claim.** Today only the agent holding the claim can release it. | The server acts as one agent identity and can only release tasks assigned to that key's owner. Other tasks are refused with a clear message. | Handing over a task from a different agent, or one whose agent is unreachable, which is the main stalled-task case. |
| 3 | **Structured approve/reject on an escalation.** Today the owner answers with free text. | Treats a reply that starts with APPROVE as approval, REJECT/decline/deny/no as rejection, and anything else as unclear (nothing happens). | A button for the owner, an unambiguous recorded decision, and no text parsing. |
| 4 | **Read an escalation by issue, and cancel one.** Only `GET /escalations/{id}` exists. | Stores the escalation id in the brief comment's metadata and looks it up by that id. A request that is no longer wanted stays open in Ziki until the owner answers it. | Listing pending approvals per task; withdrawing a request. |
| 5 | **A first-class handover record.** Today the brief is an issue comment (2000 character limit) with `metadata.kind` markers. | Brief fields are length-limited, with a live counter. A fingerprint detects edits made after approval. The newest brief wins. | Longer briefs, server-enforced immutability, a real "acknowledged by" field, and an audit trail that is not comments. |
| 6 | **Receiving agent acknowledgement.** Nothing in Ziki ties an agent's first comment to a handover. | The brief asks the next agent to comment with `metadata {"kind":"handover_ack"}`. The page shows "No acknowledgement yet" until one exists. It never claims the agent verified anything. | Proof that the next agent checked state before continuing. |

## Needed for recovery (card 3)

| # | Missing capability | Effect today |
| --- | --- | --- |
| 7 | **Readable claim state**: who holds the claim, `lastHeartbeatAt`, `deliverBy`. Heartbeats are not events. | The page shows only the issue status and recorded events and says the heartbeat is "Not available". It never labels a task stalled. A quiet history is not proof the agent has stopped. |
| 8 | **A command to resume or nudge an agent**, available to a person. | Listed as "Not supported". There is no resume button. |
| 9 | **Notification when an escalation is answered** (webhook or event). | The page re-reads Ziki when you press Refresh or return to the tab. No polling, to stay inside rate limits. |

## Needed for native integration

| # | Missing capability | Effect today |
| --- | --- | --- |
| 10 | **Third-party human sign-in** (OAuth or personal access tokens). Ziki's web UI uses Google sign-in; nothing is exposed for other apps. | A passphrase-gated session and one server-side agent key. Fine for a trial, wrong for production. Inside Ziki's own app this is solved by reusing its session. |
| 11 | **Where the owner sees an escalation.** Not documented, and not verified. | The approval request links to the issue and tells the owner to reply APPROVE or REJECT. Confirm that the owner actually sees and can answer it in Ziki before relying on this. |

## Suggested order

Items 1, 2 and 3 remove the three workarounds with the highest risk. Item 7 makes the recovery card factual rather than cautious. Everything else is convenience.
