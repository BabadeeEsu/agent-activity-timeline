# Agent Work Recovery: concept for Ziki

A one-page visual proposal. It shows how work could continue when one agent hands a task to another.

**This is a concept, not a working feature.** It has no backend, no login, no Ziki API connection and no dependencies. The buttons and the example are illustrations.

## The idea

Three simple actions:

1. **Human-approved handover.** An agent proposes handing off its task. A person approves or rejects.
2. **Agent handover.** The task and its progress pass to another agent, which continues from where the first one stopped.
3. **Recover a stalled task.** When a task looks stuck, a person can recover it or start a handover.

A small example shows what the next agent receives: work completed, work remaining, relevant context and recommended next steps.

## View it

Open `index.html` in a browser. It is a single static file. Colours and type use Ziki's design tokens (`--zk-*`) with Ziki's published values as fallbacks.

## Notes

- Only the branch `agent-work-recovery` carries this page. `main` is unchanged.
- A working version of the idea (server, tests, UI) was built earlier and is kept in this branch's history at commit `991dd6d`. It was removed from the tip to keep the proposal simple.
