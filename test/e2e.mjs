// Browser tests for the reviewer experience. They open the real page in Chromium and click through it.
//   npm test            (Playwright is expected on NODE_PATH; nothing is added to package.json)
// Screenshots go to $SHOT_DIR (default: the OS temp folder). They are not committed.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'awr-demo-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- a tiny static server for index.html and assets/ only
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!/^(index\.html|assets\/[\w.-]+)$/.test(file)) { res.statusCode = 404; return res.end('Not found'); }
  try {
    res.setHeader('content-type', types[file.slice(file.lastIndexOf('.'))]);
    return res.end(await readFile(join(ROOT, file)));
  } catch {
    res.statusCode = 404;
    return res.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- tiny runner
const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
  }
}

// ---- helpers
let browser;
async function open({ width = 1280, height = 860, hash = '', mobile = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
  await page.addInitScript(() => {
    window.__network = 0;
    const count = () => { window.__network += 1; };
    const realFetch = window.fetch;
    window.fetch = (...args) => { count(); return realFetch.apply(window, args); };
    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) { count(); return realOpen.apply(this, args); };
    window.WebSocket = class { constructor() { count(); throw new Error('blocked'); } };
  });
  await page.goto(`${BASE}/${hash}`);
  return { page, context, problems, requests };
}
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const text = (page, selector) => page.locator(selector).innerText();
const shot = (page, name, fullPage = true) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
const chipOf = (page, id) => text(page, `a.item[data-key="task-${id}"]`);
const dialog = (page) => page.locator('dialog[open]');
const toast = (page, expected) => page.locator('#toasts .toast', { hasText: expected }).waitFor();
const banner = (page, expected) => page.locator('[data-banner]', { hasText: expected }).waitFor();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// Routing renders on the browser's hashchange event, so state after a click is checked until it settles.
async function eventually(check, label = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { return await check(); } catch (error) { last = error; await new Promise((r) => setTimeout(r, 40)); }
  }
  throw last ?? new Error(`${label} never became true`);
}

// Every control on screen must be wired to something that exists.
const audit = (page) =>
  page.evaluate(() => {
    const known = new Set(window.ZKDemo.actions);
    const problems = [];
    for (const el of document.querySelectorAll('button, a[href], input, [data-action]')) {
      if (el.matches('a[href]')) {
        const href = el.getAttribute('href');
        if (!/^#\/(task\/(142|138|151))?$/.test(href)) problems.push(`link goes nowhere: ${href}`);
      } else if (!el.dataset.action) problems.push(`control with no action: ${el.textContent.trim() || el.tagName}`);
      else if (!known.has(el.dataset.action)) problems.push(`unknown action: ${el.dataset.action}`);
      if (el.matches('button:disabled') && el.getAttribute('aria-busy') !== 'true') problems.push(`disabled button that is not busy: ${el.textContent.trim()}`);
    }
    return problems;
  });

async function approveProposal(page) {
  await btn(page, 'Review proposal').click();
  await btn(page, 'Approve handover').click();
  await banner(page, 'Handover approved');
}

// =================================================================================================
browser = await chromium.launch();
console.log('Reviewer experience');

await scenario('opens straight into a Ziki-style workspace, not a landing page', async () => {
  const { page, problems } = await open({ height: 800 });
  assert.equal(await page.locator('a.item').count(), 3, 'three example tasks');
  assert.match(await text(page, '.strip'), /Simulated demo with example data\. Nothing here is connected to Ziki/);
  assert.match(await text(page, '#detail'), /#142 Fix checkout rounding/);
  assert.match(await text(page, '#detail'), /Atlas proposed a handover/);
  assert.equal(await page.locator('form, input[type="text"], input[type="email"], textarea').count(), 0, 'no forms to fill in');
  // The main action is visible without scrolling.
  const box = await btn(page, 'Review proposal').boundingBox();
  assert.ok(box && box.y + box.height <= 800, 'Review proposal is above the fold');
  assert.deepEqual(problems, []);
  await shot(page, '01-start-desktop', false);
  await page.context().close();
});

await scenario('A. review a proposal and approve it', async () => {
  const { page, problems } = await open();
  await btn(page, 'Review proposal').click();
  const d = dialog(page);
  await d.waitFor();
  const body = await d.innerText();
  for (const part of ['Handover proposal', 'Atlas proposes handing over #142', 'Reason', 'Completed work', 'Remaining work', 'Recommended next steps', 'Rounding helper written', 'Use the helper in the checkout total', 'Start in cart/total.ts', 'Simulated']) {
    assert.ok(body.includes(part), `proposal shows "${part}"`);
  }
  assert.equal(await d.getByRole('button', { name: 'Approve handover' }).isVisible(), true);
  assert.equal(await d.getByRole('button', { name: 'Reject' }).isVisible(), true);

  await d.getByRole('button', { name: 'Approve handover' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  await toast(page, 'Handover approved');
  await banner(page, 'Handover approved');
  assert.match(await chipOf(page, 142), /Handover approved/);
  assert.match(await text(page, '.log li:first-child'), /You approved Atlas’s handover proposal/);
  assert.match(await text(page, '.meta .who'), /Atlas/, 'Atlas still holds the task until the handover is confirmed');
  assert.equal(await btn(page, 'Choose receiving agent').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Review proposal' }).count(), 0);
  assert.deepEqual(problems, []);
  await shot(page, '02-approved');
  await page.context().close();
});

await scenario('A. reject a proposal, then reconsider it', async () => {
  const { page } = await open();
  await btn(page, 'Review proposal').click();
  await btn(page, 'Reject').click();
  await toast(page, 'Proposal rejected');
  await banner(page, 'Proposal rejected');
  assert.match(await chipOf(page, 142), /Proposal rejected/);
  assert.match(await text(page, '[data-banner]'), /Atlas keeps the task/);
  assert.match(await text(page, '.log li:first-child'), /You rejected Atlas’s handover proposal/);
  assert.equal(await page.getByRole('button', { name: 'Choose receiving agent' }).count(), 0, 'no way forward after a rejection');
  await shot(page, '03-rejected');

  await btn(page, 'Review proposal again').click();
  await dialog(page).waitFor();
  await btn(page, 'Approve handover').click();
  await banner(page, 'Handover approved');
  assert.match(await chipOf(page, 142), /Handover approved/);
  await page.context().close();
});

await scenario('B. hand over to another agent: both agents, the brief, and what the receiver inherits', async () => {
  const { page, problems } = await open();
  await approveProposal(page);
  await btn(page, 'Choose receiving agent').click();
  const d = dialog(page);
  await d.waitFor();

  let body = await d.innerText();
  assert.match(body, /Outgoing agent\s+A\s+Atlas/i);
  assert.match(body, /Receiving agent\s+N\s+Nova\s*Recommended/i);
  for (const part of ['Continuation brief', 'Completed work', 'Context', 'Unfinished work', 'Recommended next steps', 'Tax must round per line item', 'Written by Atlas', 'You approved Atlas’s proposal']) {
    assert.ok(body.includes(part), `handover shows "${part}"`);
  }
  assert.equal(await d.getByLabel(/Nova/).isChecked(), true, 'the recommended agent is preselected');

  await d.getByLabel(/Orbit/).check();
  await d.getByRole('button', { name: 'Confirm handover to Orbit' }).waitFor();
  assert.match(await d.innerText(), /Orbit will check the current state/);
  await d.getByLabel(/Nova/).check();
  await shot(page, '04-handover-dialog', false);
  await d.getByRole('button', { name: 'Confirm handover to Nova' }).click();

  await dialog(page).waitFor({ state: 'detached' });
  await toast(page, 'Handed over');
  await banner(page, 'Handed over to Nova');
  assert.match(await chipOf(page, 142), /Nova\s+Handed over/);
  assert.match(await text(page, '.meta .who'), /Nova/);
  assert.equal(await page.getByRole('button', { name: 'Hand over to another agent' }).count(), 0);

  const card = await text(page, '.cont');
  for (const part of ['What Nova inherited', 'Inherited from Atlas', 'Nova continues with', 'Rounding helper written', '12 unit tests passing', 'Tax must round per line item', 'Use the helper in the checkout total', 'Start in cart/total.ts', 'finished work is not repeated']) {
    assert.ok(card.includes(part), `continuation shows "${part}"`);
  }

  await btn(page, 'See Nova’s first steps').click();
  const steps = await text(page, '[data-steps]');
  assert.match(steps, /Read the continuation brief/);
  assert.match(steps, /Checked the current state in Ziki: Branch fix\/rounding and PR #87 match the brief/);
  assert.match(steps, /Skipped 3 finished items instead of repeating them/);
  assert.match(steps, /Started: Use the helper in the checkout total/);
  assert.match(await text(page, '.circle.is-active:has-text("Nova is on it")'), /Use the helper in the checkout total/);
  assert.match(await text(page, '.log li:first-child'), /Nova started: Use the helper in the checkout total/);
  assert.deepEqual(await audit(page), []);
  assert.deepEqual(problems, []);
  await shot(page, '05-handed-over');
  await page.context().close();
});

await scenario('B. a person can start a handover without a proposal, and it is clear that their confirmation is the approval', async () => {
  const { page } = await open({ hash: '#/task/138' });
  assert.match(await text(page, '#detail'), /#138 Add address validation/);
  await btn(page, 'Hand over to another agent').click();
  const d = dialog(page);
  await d.waitFor();
  assert.match(await d.innerText(), /You are starting this handover, so your confirmation is the approval/);
  assert.match(await d.innerText(), /Outgoing agent\s+N\s+Nova/i);
  assert.match(await d.innerText(), /Receiving agent\s+O\s+Orbit\s*Recommended/i);
  assert.match(await d.innerText(), /Atlas[\s\S]*Busy, finishing #142/, 'a busy agent is shown as busy');
  await d.getByRole('button', { name: 'Confirm handover to Orbit' }).click();
  await banner(page, 'Handed over to Orbit');
  assert.match(await chipOf(page, 138), /Orbit\s+Handed over/);
  assert.match(await text(page, '.cont'), /Inherited from Nova/);
  await page.context().close();
});

await scenario('C. inspect a stalled task and recover it by asking the agent to resume', async () => {
  const { page, problems } = await open();
  await page.getByRole('link', { name: /#151/ }).click();
  await page.locator('#stall-title').waitFor();
  const facts = await text(page, '.facts');
  assert.match(facts, /Status\s+Stalled\. Kite has not reported progress for 3 h 20 min/);
  assert.match(facts, /Last activity\s+Kite commented “Retrying the mail provider…” · 3 h 20 min ago/);
  assert.match(facts, /Known blocker\s+The mail provider returned “429 rate limited”/);
  assert.match(facts, /Completed work\s+Email template built and approved; order data connected to the template\./);
  assert.match(await chipOf(page, 151), /Stalled/);
  await shot(page, '06-stalled');

  await btn(page, 'Request resume').click();
  const busy = page.getByRole('button', { name: 'Sending request…' });
  await busy.waitFor();
  assert.equal(await busy.isDisabled(), true, 'the button shows progress and cannot be pressed twice');
  await banner(page, 'Kite resumed work');
  assert.match(await text(page, '[data-banner]'), /Simulated reply from Kite: “Resuming\./);
  assert.match(await chipOf(page, 151), /Resumed/);
  const log = await text(page, '.log');
  assert.match(log, /You asked Kite to resume/);
  assert.match(log, /Kite resumed work[\s\S]*\(simulated reply\)/);
  assert.equal(await page.locator('#stall-title').count(), 0, 'the stalled panel is gone once resolved');
  assert.equal(await btn(page, 'Hand over to another agent').isVisible(), true, 'a handover is still possible');
  assert.deepEqual(await audit(page), []);
  assert.deepEqual(problems, []);
  await shot(page, '07-resumed');
  await page.context().close();
});

await scenario('C. a stalled task can instead go to a handover review', async () => {
  const { page } = await open({ hash: '#/task/151' });
  await btn(page, 'Review handover').click();
  const d = dialog(page);
  await d.waitFor();
  const body = await d.innerText();
  assert.match(body, /You are starting this handover because Kite looks stalled/);
  assert.match(body, /Assembled from Kite’s recorded work, because Kite is not responding/);
  assert.match(body, /Receiving agent\s+O\s+Orbit\s*Recommended/i);
  await d.getByRole('button', { name: 'Confirm handover to Orbit' }).click();
  await banner(page, 'Handed over to Orbit');
  assert.match(await chipOf(page, 151), /Orbit\s+Handed over/);
  assert.equal(await page.locator('#stall-title').count(), 0);
  assert.match(await text(page, '.cont'), /Inherited from Kite/);
  await page.context().close();
});

await scenario('navigation: links, back button, deep links, brand, and the About dialog', async () => {
  const { page } = await open();
  await page.getByRole('link', { name: /#138/ }).click();
  assert.equal(new URL(page.url()).hash, '#/task/138');
  await eventually(async () => {
    assert.match(await text(page, 'a.item[aria-current="page"]'), /#138/);
    assert.match(await text(page, '#detail'), /Add address validation/);
  });

  await page.getByRole('link', { name: /#151/ }).click();
  await eventually(async () => assert.match(await text(page, '#detail'), /Send order confirmation emails/));
  await page.goBack();
  await eventually(async () => assert.match(await text(page, '#detail'), /Add address validation/), 'the browser back button returns to the previous task');

  await page.getByRole('link', { name: 'ziki, demo home' }).click();
  await eventually(async () => assert.match(await text(page, '#detail'), /#142 Fix checkout rounding/));

  await btn(page, 'About').click();
  const d = dialog(page);
  await d.waitFor();
  assert.match(await d.innerText(), /What is simulated[\s\S]*Nothing is saved or sent, and nothing here touches real Ziki/);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  await btn(page, 'About').click();
  await dialog(page).waitFor();
  await page.mouse.click(4, 4); // outside the dialog
  await dialog(page).waitFor({ state: 'detached' });
  await btn(page, 'About').click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await dialog(page).waitFor({ state: 'detached' });

  // Closing a decision dialog without choosing changes nothing.
  await btn(page, 'Review proposal').click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  assert.match(await chipOf(page, 142), /Handover proposed/);
  await page.context().close();

  const deep = await open({ hash: '#/task/151' });
  assert.match(await text(deep.page, '#detail'), /Send order confirmation emails/, 'a shared link opens that task');
  await deep.context.close();
  const unknown = await open({ hash: '#/task/999' });
  assert.match(await text(unknown.page, '#detail'), /#142/, 'an unknown link falls back to the first task');
  await unknown.context.close();
});

await scenario('reset puts everything back, including a pending request', async () => {
  const { page } = await open();
  await approveProposal(page);
  await page.getByRole('link', { name: /#138/ }).click();
  await btn(page, 'Hand over to another agent').click();
  await btn(page, 'Confirm handover to Orbit').click();
  await banner(page, 'Handed over to Orbit');
  await page.getByRole('link', { name: /#151/ }).click();
  await btn(page, 'Request resume').click();
  await banner(page, 'Kite resumed work');

  await btn(page, 'Reset demo').click();
  await toast(page, 'Demo reset');
  assert.equal(new URL(page.url()).hash, '');
  assert.match(await chipOf(page, 142), /Atlas\s+Handover proposed/);
  assert.match(await chipOf(page, 138), /Nova\s+In progress/);
  assert.match(await chipOf(page, 151), /Kite\s+Stalled/);
  assert.equal(await page.locator('.log li').count(), 3, 'activity is back to the 3 starting entries');
  assert.equal(await btn(page, 'Review proposal').isVisible(), true);

  // Reset while a request is in flight: the late reply must not change the fresh demo.
  await page.getByRole('link', { name: /#151/ }).click();
  await btn(page, 'Request resume').click();
  await btn(page, 'Reset demo').click();
  await page.waitForTimeout(1600);
  assert.match(await chipOf(page, 151), /Stalled/);
  await page.getByRole('link', { name: /#151/ }).click();
  assert.equal(await btn(page, 'Request resume').isEnabled(), true);
  await page.context().close();
});

await scenario('every visible control is wired up, in every state', async () => {
  const { page } = await open();
  const all = [];
  const check = async (label) => (await audit(page)).forEach((p) => all.push(`${label}: ${p}`));
  await check('start');
  await btn(page, 'Review proposal').click(); await check('proposal dialog'); await btn(page, 'Reject').click(); await check('rejected');
  await btn(page, 'Review proposal again').click(); await btn(page, 'Approve handover').click(); await check('approved');
  await btn(page, 'Choose receiving agent').click(); await check('handover dialog'); await btn(page, 'Cancel').click();
  await page.getByRole('link', { name: /#138/ }).click(); await check('working task');
  await page.getByRole('link', { name: /#151/ }).click(); await check('stalled task');
  await btn(page, 'About').click(); await check('about'); await btn(page, 'Got it').click();
  assert.deepEqual(all, []);

  // Pressing every button and link on the first screen does something visible, never nothing.
  const fresh = await open();
  const labels = await fresh.page.locator('.top button, .top a, .list a, #detail button, #detail a').evaluateAll((els) => els.map((e) => e.textContent.trim()));
  assert.ok(labels.length >= 6);
  await fresh.context.close();
  await page.context().close();
});

await scenario('the demo is clearly simulated and never touches a network', async () => {
  const { page, requests } = await open();
  await approveProposal(page);
  await btn(page, 'Choose receiving agent').click();
  assert.match(await dialog(page).innerText(), /Simulated\. Confirming only changes this demo; nothing is sent to Ziki/);
  await btn(page, 'Confirm handover to Nova').click();
  await banner(page, 'Handed over to Nova');
  await page.getByRole('link', { name: /#151/ }).click();
  await btn(page, 'Request resume').click();
  await banner(page, 'Kite resumed work');

  assert.equal(await page.evaluate(() => window.__network), 0, 'no fetch, XHR or WebSocket calls');
  const outside = requests.filter((r) => !r.url.startsWith(BASE) && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(r.url));
  assert.deepEqual(outside, [], 'only the page itself and web fonts are requested');
  assert.ok(requests.filter((r) => r.url.startsWith(BASE)).every((r) => ['document', 'stylesheet', 'script'].includes(r.type)));
  assert.ok(!(await page.content()).match(/api\/v1|Bearer|ZIKI_/i), 'no API calls or keys in the page');
  await page.context().close();
});

await scenario('keyboard: the proposal opens, can be cancelled with Escape, and focus lands somewhere useful', async () => {
  const { page } = await open();
  await page.getByRole('button', { name: 'Review proposal' }).focus();
  await page.keyboard.press('Enter');
  await dialog(page).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close', 'focus starts on the safe control, not on Approve');
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  assert.match(await chipOf(page, 142), /Handover proposed/);

  await page.getByRole('button', { name: 'Review proposal' }).focus();
  await page.keyboard.press('Enter');
  await btn(page, 'Approve handover').focus();
  await page.keyboard.press('Enter');
  await banner(page, 'Handover approved');
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-banner')), true, 'focus moves to the new status');
  await page.context().close();
});

await scenario('layout: desktop shows list and detail side by side without sideways scroll', async () => {
  for (const [width, height] of [[1280, 800], [1024, 768]]) {
    const { page } = await open({ width, height });
    const list = await page.locator('.list').boundingBox();
    const detail = await page.locator('.detail').boundingBox();
    assert.ok(list.x + list.width <= detail.x, `${width}px: list sits beside the detail`);
    assert.ok((await overflow(page)) <= 0, `${width}px: horizontal overflow`);
    await page.context().close();
  }
});

await scenario('layout: phone and tablet show one view at a time and nothing overflows', async () => {
  for (const [name, width, height] of [['tablet', 768, 1024], ['phone', 390, 844], ['small-phone', 320, 640]]) {
    const { page, problems } = await open({ width, height, mobile: width < 700 });
    assert.equal(await page.locator('.detail').isVisible(), false, `${name}: starts on the task list`);
    assert.equal(await page.locator('.list').isVisible(), true);
    assert.ok((await overflow(page)) <= 0, `${name}: list overflow ${await overflow(page)}px`);
    await shot(page, `10-${name}-list`);

    await page.getByRole('link', { name: /#142/ }).click();
    await eventually(async () => assert.equal(await page.locator('.list').isVisible(), false, `${name}: detail replaces the list`));
    assert.ok((await overflow(page)) <= 0, `${name}: detail overflow`);

    const tooSmall = await page.evaluate(() => [...document.querySelectorAll('.top button, #detail button')].filter((el) => el.offsetParent && el.getBoundingClientRect().height < 40).map((el) => el.textContent.trim()));
    assert.deepEqual(tooSmall, [], `${name}: buttons under 40px tall`);
    await shot(page, `11-${name}-detail`);

    await btn(page, 'Review proposal').click();
    for (const step of ['proposal', 'handover']) {
      const box = await dialog(page).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${name}: ${step} dialog fits the width`);
      assert.ok(box.y >= 0 && box.y + box.height <= height + 0.5, `${name}: ${step} dialog fits the height`);
      const action = await dialog(page).locator('.dlg-foot .btn.primary').boundingBox();
      assert.ok(action.y + action.height <= height, `${name}: the ${step} action button stays on screen`);
      assert.ok((await overflow(page)) <= 0);
      await shot(page, `12-${name}-${step}`, false);
      if (step === 'proposal') {
        await btn(page, 'Approve handover').click();
        await btn(page, 'Choose receiving agent').click();
        await dialog(page).waitFor();
      }
    }
    await btn(page, 'Cancel').click();

    await page.getByRole('link', { name: '← All tasks' }).click();
    await eventually(async () => assert.equal(await page.locator('.list').isVisible(), true, `${name}: back to the list`));
    assert.deepEqual(problems, []);
    await page.context().close();
  }
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
