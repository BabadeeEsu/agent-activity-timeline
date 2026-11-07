# Pinned issue countdown: interactive demo

A proposal demo for [Ziki](https://ziki.dev). It shows Ziki's **In Progress** tab as it is today, with one change: in the pinned **Your issues** box, the numeric time under each agent becomes a **colour countdown** with no numbers.

Everything else on the page (header, tabs, status list, toolbar and the issue list) is a static copy of the current page, so reviewers can see exactly where the change sits. Clicking those parts only says they are not part of the demo. Nothing here is connected to Ziki.

## The countdown

- A small ring empties as the deadline gets closer and changes colour:
  - **green**: plenty of time;
  - **yellow**: deadline approaching;
  - **orange**: getting close;
  - **red**: almost out of time;
  - **overdue**: red with a "!", a dashed ring and a light red row.
- A word under the agent's name says the same thing, so colour is never the only signal. The ring has an accessible label and a tooltip.
- No digits appear anywhere in the indicator.
- It counts to the deadline's real timestamp, stored in the browser, so a refresh continues the countdown instead of restarting it. It updates on its own, and it does nothing when time runs out: no claim is released and nothing is cancelled.
- The colour thresholds are a proposal: more than half the window left is green, more than a quarter yellow, more than a tenth orange, then red.

## Demo controls (dark bar at the top)

- **Play countdown** runs a full window in about 20 seconds so you can watch the colours change.
- **Green / Yellow / Orange / Red / Overdue** jump straight to a state. **Real time** goes back.
- **About** explains the demo. **Reset** restarts the example deadlines from now.

## Run and test

It is a static site with no build step. Run `python3 -m http.server 8000` and open <http://localhost:8000>, or open `index.html` directly.

`npm test` runs the browser tests. They need [Playwright](https://playwright.dev) with Chromium available to Node. They cover:
- that the page matches the current tab and the list below is unchanged;
- that the indicator contains no numbers;
- every colour, and the play-through order;
- refresh accuracy, automatic updates and timer clean-up;
- the static parts and reset;
- that no network calls are made;
- layouts from wide desktop down to a 320px phone.

Earlier proposals are kept on the `agent-work-recovery` branch.
