# Pinned issue and deadline countdown: interactive demo

A clickable proposal demo for [Ziki](https://ziki.dev). When an agent needs a person, the issue is pinned at the top of **In Progress**, above the usual list. A colour ring shows how urgent the response is, with no countdown numbers.

**It is simulated.** All issues, agents and replies are invented example data. Nothing is saved, sent or connected to Ziki, and nothing here affects a real workspace.

## What a reviewer can try

The page opens on **In Progress → In progress** in a workspace laid out like Ziki's issues page.

- **The pinned box** shows the issue that needs you: title, number, project, the agent working on it, what it needs in one sentence, and the actions. The title opens the issue.
- **The ring** fills and changes colour as the response deadline gets closer: green (plenty of time), yellow (approaching), orange (getting close) and red (almost out of time). Overdue is red with a “!” and a note. Each state also has a word label, and the ring has an accessible label that explains what happens at the deadline.
- **Preview urgency** in the dark demo bar moves the demo's clock so you can see each colour. It is not part of the feature.
- **Actions:**
  - **Plan review.** Approve the plan, or send it back with a note. When the agent resubmits, the window starts again.
  - **Question.** Answer it. An empty answer is refused.
  - **Escalation.** Reply and resolve it.
  - **Any agent.** Send a steer note. A note does not resolve the request.
  - When one request is handled, the next one is pinned. When none are left, a quiet line says so.
- **Other lists.** Ideas, Open, Closed, Possibly delivered and Delivered have no pinned box.
- **Reset demo** starts everything over.

## What it is based on

Ziki's published agent API ([ziki.dev/llms.txt](https://ziki.dev/llms.txt)) documents the data the feature would use:

| Request | Deadline used | Source in Ziki's docs |
| --- | --- | --- |
| An agent's question about an issue it holds | Asked time + the project's owner-wait cap (4 hours by default) | `POST /api/v1/questions`: Ziki reminds the owner after 30 minutes and releases the claim (`owner_unresponsive`) at the cap |
| A plan waiting for review ("In progress · Plan review") | The plan's `reviewBy` (2 hours by default, restarting on each send-back) | Plan review: only the owner approves or sends back |
| An escalation (question, blocker, scope change, human approval) | None documented, so **no countdown** | `POST /api/v1/escalations` |

The agent's own delivery deadline (`deliverBy`) is not used. It is the agent's deadline, not the person's.

**Proposals, not Ziki rules:**
- The pin order: earliest real deadline first, then the oldest request without one.
- The colour cut-offs: more than half the window left is green, more than a quarter yellow, more than a tenth orange, then red.

The countdown is only a reminder and does nothing on its own. Ziki's existing rules still release a claim when a window runs out, and the overdue state says so.

## Limits of this demo

- The signed-in Ziki app and its source code were not available, so this is a standalone page modelled on a screenshot of the In Progress tab and on the public docs. It does not read real issues.
- Example deadlines are anchored in the browser (`localStorage`), so a refresh continues the same countdown. If the demo was last opened more than 6 hours ago, the example clock starts over.
- Ziki documents no way for a person to release or decline an agent's assignment from this view, so there is no such button.

## Run it

It is a static site with no build step and no dependencies.

```
python3 -m http.server 8000
```

Open <http://localhost:8000>. Opening `index.html` directly also works.

## Tests

```
npm test
```

The browser tests need [Playwright](https://playwright.dev) with Chromium available to Node. They cover:
- the pinned content and its position above the list;
- no digits anywhere in the indicator;
- every urgency state, including overdue;
- refresh accuracy, and automatic updates with a single timer;
- approve and send back, answer, resolve, and steer notes;
- issues with no deadline;
- the box being absent from every other list;
- navigation and reset;
- every control being wired up, and no network calls;
- layouts from desktop down to a 320px phone.

## Files

- `index.html`: the page shell
- `assets/demo.css`: styling
- `assets/demo.js`: demo data, views and actions
- `test/e2e.mjs`: browser tests
- `vercel.json`: static hosting settings

The earlier Agent Work Recovery demo is still on the `agent-work-recovery` branch.
