# Agent Work Recovery

A small, working feature for [Ziki](https://ziki.dev): hand an agent's task over safely, or see what Ziki actually knows about a task that has gone quiet.

It replaces the earlier "Agent Activity Timeline" prototype. Three actions, nothing else:

1. **Approve handover.** Write a continuation brief and ask the task's owner to approve. The brief is saved on the issue in Ziki, so it survives refreshes and a change of agent.
2. **Hand over to another agent.** Only after the owner has approved, release the task so Ziki offers it to the next eligible agent. The saved brief tells that agent to verify the state in Ziki before continuing.
3. **Recover a stalled task.** Read-only facts from Ziki (status, recorded activity, open questions, Ziki's timers), the recovery options Ziki really supports, and an explicit list of what cannot be known.

Nothing here is simulated. Where Ziki has no API for something, the page says so and the button does not exist. See [docs/BACKEND_REQUIREMENTS.md](docs/BACKEND_REQUIREMENTS.md).

## What works with Ziki's API today

| Action | Works now | How |
| --- | --- | --- |
| Ask the owner to approve | Yes | Creates a Ziki escalation of type `human_approval`; saves the brief as an issue comment |
| Owner approves or rejects | Yes, **inside Ziki** | The owner replies to the escalation. Only a reply starting with APPROVE counts |
| Hand over | Yes, with a limit | `POST /issues/{id}/release`. Ziki picks the next agent itself |
| Choose which agent receives it | **No** | Ziki's API has no such call |
| Show real task status and activity | Yes | Issue, events, comments, project workflow |
| Show last heartbeat or claim deadline | **No** | Ziki does not expose them |
| Ask a running agent to resume | **No** | Ziki has no such command |

## How it is built

- `index.html`, `assets/recovery.js`, `assets/recovery.css`: one custom element, `<zk-work-recovery>`, no dependencies. Colours and fonts come from Ziki's `--zk-*` tokens, with Ziki's published values as fallbacks.
- `lib/`: server logic as web-standard `(Request) => Response` handlers. It holds the Ziki agent key; the browser never sees it.
- `api/`: thin Vercel functions that wrap those handlers.
- `test/`: unit tests (`node:test`) and browser tests (Playwright) against a **test-only** fake Ziki in `test/support/fake-ziki.js`.

Access is a stopgap: a passphrase sets a signed, HttpOnly, SameSite=Strict cookie. Inside Ziki this should be replaced by Ziki's own sign-in (see [docs/INTEGRATION.md](docs/INTEGRATION.md)).

## Run it

Needs Node 20 or newer. No install step: there are no dependencies.

```bash
cp .env.example .env                              # fill in the values; .env is git-ignored
node --env-file=.env scripts/dev-server.mjs       # http://127.0.0.1:3000  (Node 20.6 or newer)
```

Or export the variables in your shell and run `npm run dev`.

Without the three required variables the page says which ones are missing and does nothing else.

## Test

```bash
npm test            # unit tests, no network needed
npm run test:e2e    # real browser against the fake Ziki; needs Playwright on NODE_PATH
```

The tests never contact ziki.dev. **This has not been run against the real Ziki API**; see the final notes in [docs/INTEGRATION.md](docs/INTEGRATION.md#what-has-and-has-not-been-verified).

## Deploy on Vercel

`vercel.json` is unchanged. The project deploys from this repository.

1. In the Vercel project, open **Settings > Environment Variables** and add `ZIKI_AGENT_KEY`, `RECOVERY_ACCESS_TOKEN` and `RECOVERY_SESSION_SECRET` (and `ZIKI_PROJECT_ID` if the key covers several projects). Add them to Preview first.
2. Push a branch. Vercel builds a preview. Open it, sign in with the passphrase, and check that your in-progress tasks appear.
3. Only then add the variables to Production and merge to the production branch.

Deploying this repository updates this Vercel site only. It does **not** change ziki.dev.
