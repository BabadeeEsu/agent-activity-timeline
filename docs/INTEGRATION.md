# Integrating into Ziki

This repository is a prototype of the feature. **Deploying it does not change ziki.dev.** The Vercel project here is a separate site. Putting Agent Work Recovery inside Ziki means adding the pieces below to Ziki's own codebase, which I did not have access to.

## What was inspected

Public information only: <https://ziki.dev> and <https://ziki.dev/llms.txt>.

- Frontend: Next.js (App Router) with Tailwind v4.
- Design tokens: `--zk-*` CSS variables. Headings use Manrope; body text uses DM Sans.
- Agent API: `/api/v1/...`, bearer agent keys, each limited to one project.
- Owner actions happen in Ziki's web UI behind Google sign-in. No human API is documented.
- Deployment of ziki.dev: not visible from outside.

Not inspected: Ziki's source repository, its component library, its server-side auth, its database. Anything below that depends on those is a proposal, not a verified fact.

## The pieces

| Piece | File | Where it goes in Ziki |
| --- | --- | --- |
| UI | `assets/recovery.js`, `assets/recovery.css` | Import once on the issue page or an admin page. One custom element, no dependencies. |
| Server logic | `lib/handlers.js`, `lib/brief.js`, `lib/recovery-state.js`, `lib/ziki-client.js` | A server module. Web-standard `Request`/`Response`, Node runtime (uses `node:crypto`). |
| Not needed inside Ziki | `lib/session.js`, `lib/config.js`, `lib/node-adapter.js`, `api/*`, `scripts/` | Replaced by Ziki's own session and configuration. |

## 1. Mount the handlers in a Next.js route

```ts
// app/api/work-recovery/[...path]/route.ts
import { getHandlers } from '@/lib/work-recovery/runtime';

const run = async (request: Request, { params }: { params: Promise<{ path: string[] }> }) =>
  (await getHandlers()).handle(request, (await params).path.join('-'));

export { run as GET, run as POST, run as DELETE };
export const runtime = 'nodejs';
```

`path` of `handover/request` becomes the action `handover-request`. The five actions are `session`, `tasks`, `task`, `handover-request` and `handover-execute`.

## 2. Use Ziki's sign-in instead of the passphrase

The handlers authorise through one function, `guard()` in `lib/handlers.js`. Replace its cookie check with Ziki's session check, and use the signed-in person's identity and permissions to decide who may request or execute a handover.

Remove the sign-in screen by deleting the `signin` branch in `recovery.js`, or leave it: it only shows when `/session` reports `authenticated: false`.

## 3. Use real Ziki data and authorisation

Today `lib/ziki-client.js` calls Ziki over HTTP with an agent key. Inside Ziki, replace it with direct calls to Ziki's own services. The functions the handlers use are listed at the top of `lib/handlers.js`. With direct access, the backend items in [BACKEND_REQUIREMENTS.md](BACKEND_REQUIREMENTS.md) (owner release, choosing the receiving agent, structured approval, claim state) can be implemented natively, and the matching workarounds removed.

## 4. Render the element

```tsx
<zk-work-recovery api-base="/api/work-recovery" task-id={issue.id} />
```

- `task-id` opens that issue directly. Without it the first in-progress task is selected.
- `chrome` adds the page header used on the standalone site. Leave it off inside Ziki.
- Colours inherit Ziki's `--zk-*` tokens. If a token is missing, the fallback is Ziki's published value.

## 5. Configuration

Inside Ziki there is no `RECOVERY_*` configuration. The agent key (`ZIKI_AGENT_KEY`) is only needed while this runs outside Ziki.

## What has and has not been verified

Verified, by automated tests:

- The approval gate, request order (approval request first, then the saved brief), double-use protection, superseded briefs, tampered briefs, permission errors, rate limits, upstream failures, and that no secret reaches the browser.
- The UI in a real browser at 1280, 768, 390 and 320 px: no sideways scroll, controls at least 40 px tall, single column below 860 px.
- That only documented Ziki routes are called, and never a heartbeat, offer, accept, claim, extend or assign route.

**Not verified:**

- Anything against the real Ziki API. All tests use a fake that I wrote from the public API reference. The response shapes (for example the fields of an escalation, or what `reofferedTo` contains) are taken from that reference and could differ in practice.
- That Ziki shows the approval request to the owner in a place they will see and can answer.
- Behaviour on ziki.dev. The feature has not been added to Ziki.
- The Vercel deployment, until the environment variables are set and a preview is opened.
