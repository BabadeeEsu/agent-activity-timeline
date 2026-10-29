# Agent Work Recovery: interactive demo

A clickable proposal demo for [Ziki](https://ziki.dev). It shows how work can continue when an agent cannot finish a task, without anyone starting over.

**It is simulated.** All tasks, agents and replies are invented example data. Nothing is saved, sent or connected to Ziki, and nothing here affects a real workspace. The page opens straight into a small workspace and works without an account or a backend.

## What a reviewer can try

Open the page and pick a task from the list. Each task shows one part of the feature.

| Task | What it shows |
| --- | --- |
| **#142 Fix checkout rounding** | **Approve or reject a handover proposal.** Atlas proposes handing the task over. Review the reason, completed work, remaining work and next steps, then approve or reject. After approval, choose a receiving agent and confirm. The task then shows what the receiving agent inherited and how it starts. |
| **#138 Add address validation** | **Hand over to another agent.** A person starts a handover from a working task, picks the receiving agent, reads the continuation brief and confirms. |
| **#151 Send order confirmation emails** | **Recover a stalled task.** Inspect the status, last activity, known blocker and completed work. Then either ask the agent to resume (a simulated reply comes back) or review a handover. |

The continuation brief (completed work, context, unfinished work, next steps) is part of every handover. It is not a separate action.

**Reset demo** (top right) puts every task back to its starting state. **About** explains what is simulated. Every task has its own link, for example `#/task/151`.

## Run it

It is a static site: HTML, CSS and JavaScript, with no build step and no dependencies.

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly also works.

## Tests

The browser tests open the real page in Chromium and click through it. They cover approve and reject, the receiving agent's continuation brief, stalled-task recovery, navigation and reset, and desktop, tablet and phone layouts. They also fail if any visible control has no handler, and they check that the demo makes no network calls.

```
npm test
```

They need [Playwright](https://playwright.dev) with Chromium available to Node (for example `npm i -g playwright`). The project itself has no dependencies. Screenshots are written to `$SHOT_DIR`, or to a temporary folder if that is not set.

## Files

- `index.html`: the page shell
- `assets/demo.css`: styling, using Ziki-style tokens
- `assets/demo.js`: demo state, screens and actions
- `test/e2e.mjs`: browser tests
- `vercel.json`: static hosting settings

## Notes

- The look follows what is public on ziki.dev (colors, type, pill buttons, rounded cards, initial avatars). The signed-in Ziki app was not available to inspect, so the screens are a proposal, not a copy of the real interface.
- This branch is kept separate from `main` and is not meant to be merged or released.
- An earlier, non-interactive version of this work is in the git history (`991dd6d`).
