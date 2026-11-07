// Browser tests for the pinned issue + visual countdown demo. They open the real page in Chromium.
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
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'pinned-demo-shots');
mkdirSync(SHOTS, { recursive: true });
const MIN = 60000;

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
    console.log(`  FAIL ${name}\n       ${String(error.stack || error.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

// ---- helpers
let browser;
async function open({ width = 1366, height = 860, hash = '', mobile = false, baseAgoMin = null, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
  // Block web fonts so tests are fast and offline; everything else must be local.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  if (clock) await page.clock.install();
  await page.addInitScript(([ago, MIN]) => {
    window.__network = 0;
    const count = () => { window.__network += 1; };
    const realFetch = window.fetch;
    window.fetch = (...args) => { count(); return realFetch.apply(window, args); };
    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) { count(); return realOpen.apply(this, args); };
    window.WebSocket = class { constructor() { count(); throw new Error('blocked'); } };
    if (ago !== null && !sessionStorage.getItem('seeded')) {
      localStorage.setItem('zk-pinned-demo-base', String(Date.now() - ago * MIN));
      sessionStorage.setItem('seeded', '1');
    }
  }, [baseAgoMin, MIN]);
  await page.goto(`${BASE}/${hash}`);
  return { page, context, problems, requests };
}
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const text = (page, selector) => page.locator(selector).first().innerText();
const shot = (page, name, fullPage = true) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
const pin = (page) => page.locator('.pin');
const pinnedNumber = (page) => page.locator('[data-pin]').getAttribute('data-pin');
const level = (page) => page.locator('.pin [data-clock]').getAttribute('data-level');
const dialog = (page) => page.locator('dialog[open]');
const toast = (page, expected) => page.locator('#toasts .toast', { hasText: expected }).waitFor();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function eventually(check, ms = 4000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { return await check(); } catch (error) { last = error; await new Promise((r) => setTimeout(r, 40)); }
  }
  throw last;
}
async function goTo(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h, hash);
}

// Every control on screen must be wired to something that exists.
const audit = (page) =>
  page.evaluate(() => {
    const known = new Set(window.ZKDemo.actions);
    const problems = [];
    for (const el of document.querySelectorAll('button, a[href], [data-action]')) {
      if (el.matches('a[href]')) {
        const href = el.getAttribute('href');
        if (!/^#\/(ideas|delivered|issues\/(open|in-progress|closed|possibly-delivered)|issue\/\d+)$/.test(href)) problems.push(`link goes nowhere: ${href}`);
        const n = href.match(/issue\/(\d+)/);
        if (n && !document.body.innerHTML.includes(`#${n[1]}`)) problems.push(`link to unknown issue ${n[1]}`);
      } else if (!el.dataset.action) problems.push(`control with no action: ${el.textContent.trim() || el.tagName}`);
      else if (!known.has(el.dataset.action)) problems.push(`unknown action: ${el.dataset.action}`);
    }
    return problems;
  });

// =================================================================================================
browser = await chromium.launch();
console.log('Pinned issue + visual countdown');

await scenario('opens on In Progress with the issue that needs you pinned above the list', async () => {
  const { page, problems } = await open({ height: 860 });
  assert.match(await text(page, '.tab[aria-current="page"]'), /In Progress/);
  assert.match(await text(page, '.rail a[aria-current="page"]'), /In progress/);
  const box = pin(page);
  assert.equal(await box.count(), 1);
  const body = await box.innerText();
  for (const part of ['Needs you', 'Learners drop off before the first lesson', '#219', 'Zedu · Your App', 'Nova', 'your agent', 'Nova wrote a plan and needs your approval before starting', 'In progress · Plan review', '1 of 3 waiting on you']) {
    assert.ok(body.includes(part), `pinned box shows "${part}"`);
  }
  assert.equal(await page.locator('.pin h2 a').getAttribute('href'), '#/issue/219');
  // It sits directly above the list and is visible without scrolling.
  const pinBox = await box.boundingBox();
  const tableBox = await page.locator('.table').boundingBox();
  assert.ok(pinBox.y + pinBox.height <= tableBox.y, 'pinned box is above the issue list');
  assert.ok(pinBox.y < 860, 'pinned box starts above the fold');
  assert.equal(await page.locator('.row').count(), 5, 'the normal In progress list is still there');
  assert.equal(await page.locator('.row', { hasText: 'Waiting on you' }).count(), 3);
  assert.deepEqual(problems, []);
  await shot(page, '01-in-progress-desktop', false);
  await page.context().close();
});

await scenario('the countdown has no numbers, has an accessible explanation, and starts from the real deadline', async () => {
  const { page } = await open();
  const clock = page.locator('.pin [data-clock]');
  const visible = await clock.innerText();
  const label = await clock.locator('svg').getAttribute('aria-label');
  const title = await clock.getAttribute('title');
  const svgText = await clock.locator('svg').textContent();
  for (const [what, value] of [['visible text', visible], ['aria-label', label], ['tooltip', title], ['svg text', svgText]]) {
    assert.doesNotMatch(value, /\d/, `${what} must not contain digits: ${value}`);
  }
  assert.equal(await clock.locator('svg').getAttribute('role'), 'img');
  assert.match(label, /Plan review window for Nova’s plan: deadline approaching\. If the window runs out, Ziki releases the award/);
  // Fresh demo: the plan was awarded 85 of 120 minutes ago, so about 29% is left: yellow.
  assert.equal(await level(page), 'yellow');
  assert.match(visible, /Deadline approaching/);
  await page.context().close();
});

await scenario('each urgency state: green, yellow, orange, red and overdue, with words as well as colour', async () => {
  const { page } = await open();
  const seen = [];
  const expected = { Green: ['green', 'Plenty of time', 'rgb(34, 160, 90)'], Yellow: ['yellow', 'Deadline approaching', 'rgb(224, 176, 0)'], Orange: ['orange', 'Getting close', 'rgb(240, 122, 26)'], Red: ['red', 'Almost out of time', 'rgb(220, 58, 42)'], Overdue: ['overdue', 'Overdue', null] };
  for (const [name, [lvl, word, stroke]] of Object.entries(expected)) {
    await btn(page, name).click();
    assert.equal(await btn(page, name).getAttribute('aria-pressed'), 'true');
    assert.equal(await level(page), lvl);
    assert.match(await text(page, '.pin [data-clock] .word'), new RegExp(word));
    const arc = page.locator('.pin .arc');
    const offset = Number(await arc.getAttribute('stroke-dashoffset'));
    seen.push(offset);
    if (stroke) assert.equal(await arc.evaluate((el) => getComputedStyle(el).stroke), stroke);
    await page.waitForTimeout(1050); // let the ring finish its transition before the screenshot
    await pin(page).screenshot({ path: join(SHOTS, `02-state-${lvl}.png`) });
  }
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], 'the ring drains as the deadline gets closer');
  // Overdue is clearly different: an exclamation mark, a note, and no automatic action.
  assert.equal(await page.locator('.pin .ring .mark').textContent(), '!');
  assert.match(await text(page, '.overdue-note'), /This box only reminds you; it does not release anything/);
  assert.equal(await pinnedNumber(page), '219', 'an overdue request stays pinned; nothing is released by the demo');
  assert.equal(await btn(page, 'Review plan').isVisible(), true, 'you can still act');
  await btn(page, 'Real time').click();
  assert.equal(await level(page), 'yellow');
  await page.context().close();
});

await scenario('a refresh keeps counting from the stored deadline instead of restarting', async () => {
  // The demo was first opened 30 minutes ago: the plan window (awarded 85 min before that) is nearly gone.
  const { page } = await open({ baseAgoMin: 30 });
  assert.equal(await level(page), 'red');
  await page.reload();
  assert.equal(await level(page), 'red', 'still red after a refresh');
  const before = await page.evaluate(() => localStorage.getItem('zk-pinned-demo-base'));
  await page.reload();
  assert.equal(await page.evaluate(() => localStorage.getItem('zk-pinned-demo-base')), before, 'the anchor timestamp is not replaced');
  await page.context().close();

  const later = await open({ baseAgoMin: 40 });
  assert.equal(await level(later.page), 'overdue', 'past the window it shows overdue');
  await later.context.close();
});

await scenario('the indicator updates on its own as time passes, and keeps one timer', async () => {
  const { page } = await open({ clock: true });
  assert.equal(await level(page), 'yellow');
  await page.clock.runFor(16 * MIN);
  await eventually(async () => assert.equal(await level(page), 'orange'));
  await page.clock.runFor(10 * MIN);
  await eventually(async () => assert.equal(await level(page), 'red'));
  await page.clock.runFor(10 * MIN);
  await eventually(async () => assert.equal(await level(page), 'overdue'));
  assert.equal(await page.evaluate(() => window.ZKDemo.timers()), 1);
  for (let i = 0; i < 3; i += 1) await btn(page, 'Reset demo').click();
  assert.equal(await page.evaluate(() => window.ZKDemo.timers()), 1, 'reset replaces the timer instead of stacking another');
  await page.context().close();
});

await scenario('approve a plan: the next issue that needs you is pinned', async () => {
  const { page, problems } = await open();
  await btn(page, 'Review plan').click();
  const d = dialog(page);
  await d.waitFor();
  const body = await d.innerText();
  for (const part of ['Nova’s plan for #219', 'Only you can approve its plan', 'Measure where learners leave', 'Pick the highest-impact one', 'Estimate', 'Risk', 'Confidence', 'Simulated']) {
    assert.ok(body.includes(part), `plan shows "${part}"`);
  }
  await shot(page, '03-plan-dialog', false);
  await btn(page, 'Approve plan').click();
  await d.waitFor({ state: 'detached' });
  await toast(page, 'Plan approved');
  assert.equal(await pinnedNumber(page), '214');
  assert.match(await pin(page).innerText(), /Atlas asked you a question and is waiting for your answer/);
  assert.match(await pin(page).innerText(), /1 of 2 waiting on you/);
  assert.match(await text(page, '.row[data-row="219"]'), /In progress/);
  assert.doesNotMatch(await text(page, '.row[data-row="219"]'), /Waiting on you/);
  await page.locator('.pin h2 a').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.pin') !== null), true, 'focus moves to the newly pinned issue');
  assert.deepEqual(problems, []);
  await page.context().close();
});

await scenario('send a plan back with a note: it leaves, then returns with a fresh window', async () => {
  const { page } = await open();
  await btn(page, 'Review plan').click();
  await btn(page, 'Send back with a note').click();
  await btn(page, 'Send back').click();
  assert.match(await dialog(page).innerText(), /Say what should change/, 'a note is required');
  await dialog(page).locator('textarea').fill('Start with the sign-up step only.');
  await btn(page, 'Send back').click();
  await toast(page, 'Plan sent back');
  assert.equal(await pinnedNumber(page), '214');
  assert.match(await text(page, '.row[data-row="219"]'), /Plan sent back/);
  await eventually(async () => assert.equal(await pinnedNumber(page), '219'), 5000);
  assert.equal(await level(page), 'green', 'the review window started again');
  await goTo(page, '#/issue/219');
  await eventually(async () => assert.match(await text(page, '.log'), /Nova resubmitted the plan with your changes[\s\S]*You sent Nova’s plan back: “Start with the sign-up step only\.”/));
  await page.context().close();
});

await scenario('answer a question: an empty answer is refused, a real one resolves it', async () => {
  const { page } = await open();
  await btn(page, 'Review plan').click();
  await btn(page, 'Approve plan').click();
  await btn(page, 'Answer Atlas').click();
  const box = page.locator('.pin textarea');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
  assert.match(await pin(page).innerText(), /Answers cannot be edited after they are sent/);
  await btn(page, 'Send answer').click();
  assert.match(await text(page, '.pin .err'), /Write something first/);
  await box.fill('Keep the colours, they help people read code.');
  await btn(page, 'Send answer').click();
  await toast(page, 'Answer sent to Atlas');
  assert.equal(await pinnedNumber(page), '207');
  await goTo(page, '#/issue/214');
  await eventually(async () => assert.match(await text(page, '.log'), /You answered Atlas: “Keep the colours, they help people read code\.”/));
  await eventually(async () => assert.match(await text(page, '.log'), /Atlas read your answer and carried on/), 3000);
  await page.context().close();
});

await scenario('an escalation without a deadline is pinned with no countdown, and can be resolved', async () => {
  const { page } = await open();
  await btn(page, 'Review plan').click();
  await btn(page, 'Approve plan').click();
  await btn(page, 'Answer Atlas').click();
  await page.locator('.pin textarea').fill('Keep the colours.');
  await btn(page, 'Send answer').click();
  assert.equal(await pinnedNumber(page), '207');
  assert.match(await pin(page).innerText(), /Kite needs a decision from you: scope change/);
  assert.equal(await page.locator('.pin .ring').count(), 0, 'no countdown ring');
  assert.equal(await page.locator('.pin [data-clock="none"]').innerText(), 'No response deadline on this request');
  await btn(page, 'Overdue').click();
  await toast(page, 'no countdown to preview');
  assert.equal(await page.locator('.pin .ring').count(), 0, 'previewing cannot invent a countdown');
  await pin(page).screenshot({ path: join(SHOTS, '04-no-deadline.png') });
  await btn(page, 'Reply to Kite').click();
  await page.locator('.pin textarea').fill('Keep it to the search query for now.');
  await btn(page, 'Send and resolve').click();
  await toast(page, 'Escalation resolved');
  assert.equal(await pin(page).count(), 0);
  assert.equal(await text(page, '[data-pin="none"]'), 'Nothing in progress needs your decision right now.');
  assert.equal(await page.locator('.row', { hasText: 'Waiting on you' }).count(), 0);
  assert.equal(await page.locator('.rail .needs-dot').count(), 0);
  await page.context().close();
});

await scenario('a steer note reaches the agent but does not answer the request', async () => {
  const { page } = await open();
  await btn(page, 'Send a note to Nova').click();
  assert.match(await pin(page).innerText(), /It does not answer the request above/);
  await page.locator('.pin textarea').fill('Please check mobile sign-ups too.');
  await btn(page, 'Send note').click();
  await toast(page, 'Note sent to Nova');
  assert.equal(await pinnedNumber(page), '219', 'still pinned');
  await btn(page, 'Send a note to Nova').click();
  await btn(page, 'Cancel').click();
  assert.equal(await page.locator('.pin textarea').count(), 0);
  await page.locator('.pin h2 a').click();
  await eventually(async () => assert.match(await text(page, '.log'), /You sent Nova a note: “Please check mobile sign-ups too\.”/));
  await page.context().close();
});

await scenario('the pinned title opens the issue, which offers the same decision and a way back', async () => {
  const { page } = await open();
  await page.locator('.pin h2 a').click();
  await eventually(async () => assert.match(await text(page, 'h1'), /#219 Learners drop off before the first lesson/));
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-title')), true);
  assert.match(await text(page, '.panel.waiting'), /Waiting on you[\s\S]*Nova wrote a plan/);
  assert.equal(await page.locator('.panel.waiting [data-clock="219"]').count(), 1);
  assert.match(await text(page, '.log'), /Nova submitted a plan for review/);
  await shot(page, '05-issue-page');
  await btn(page, 'Review plan').click();
  await btn(page, 'Approve plan').click();
  await eventually(async () => assert.match(await text(page, '.log'), /You approved Nova’s plan/));
  assert.equal(await page.locator('.panel.waiting').count(), 0);
  await page.getByRole('link', { name: '← In progress' }).click();
  await eventually(async () => assert.equal(await pinnedNumber(page), '214'));

  // An issue nobody is waiting on has no countdown.
  await goTo(page, '#/issue/223');
  await eventually(async () => assert.match(await text(page, 'h1'), /#223/));
  assert.equal(await page.locator('[data-clock]').count(), 0);
  assert.match(await text(page, '.panel'), /Orbit is working on this[\s\S]*Nothing here needs your decision/);
  await page.context().close();
});

await scenario('the pinned box appears only on In Progress → In progress, never on Ideas, Open, Closed, Possibly delivered or Delivered', async () => {
  const { page } = await open();
  for (const [hash, label] of [['#/ideas', 'Ideas'], ['#/issues/open', 'Open'], ['#/issues/closed', 'Closed'], ['#/issues/possibly-delivered', 'Possibly delivered'], ['#/delivered', 'Delivered']]) {
    await goTo(page, hash);
    await eventually(async () => assert.equal(await page.locator('[data-pin]').count(), 0, `${label} has no pinned box`));
    assert.equal(await page.locator('[data-clock]').count(), 0, `${label} has no countdown`);
    assert.ok((await page.locator('.row').count()) > 0, `${label} still lists its issues`);
  }
  await goTo(page, '#/issues/open');
  assert.match(await text(page, '.row'), /Ready for bids/);
  await shot(page, '06-open-no-pin', false);
  await page.locator('.rail a[href="#/issues/in-progress"]').click();
  await eventually(async () => assert.equal(await pin(page).count(), 1));
  await page.context().close();
});

await scenario('navigation and reset', async () => {
  const { page } = await open();
  await page.getByRole('link', { name: /Ideas/ }).click();
  await eventually(async () => assert.match(await text(page, '.tab[aria-current="page"]'), /Ideas/));
  await page.getByRole('link', { name: /Let teachers schedule announcements/ }).click();
  await eventually(async () => assert.match(await text(page, 'h1'), /#240/));
  await page.getByRole('link', { name: '← Ideas' }).click();
  await eventually(async () => assert.match(await text(page, '.tab[aria-current="page"]'), /Ideas/));
  await page.goBack();
  await eventually(async () => assert.match(await text(page, 'h1'), /#240/), 3000);
  await page.getByRole('link', { name: 'Ziki, back to In progress' }).click();
  await eventually(async () => assert.equal(await pin(page).count(), 1));

  await btn(page, 'About').click();
  assert.match(await dialog(page).innerText(), /A countdown only appears when Ziki has a real response deadline/);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });

  await btn(page, 'Review plan').click();
  await btn(page, 'Approve plan').click();
  await btn(page, 'Orange').click();
  await btn(page, 'Reset demo').click();
  await toast(page, 'Demo reset');
  assert.equal(await pinnedNumber(page), '219');
  assert.equal(await level(page), 'yellow');
  assert.equal(await btn(page, 'Real time').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.row', { hasText: 'Waiting on you' }).count(), 3);
  await page.context().close();
});

await scenario('every visible control is wired up, in every state, and nothing is sent anywhere', async () => {
  const { page, requests } = await open();
  const all = [];
  const check = async (label) => (await audit(page)).forEach((p) => all.push(`${label}: ${p}`));
  await check('start');
  await btn(page, 'Review plan').click(); await check('plan dialog');
  await btn(page, 'Send back with a note').click(); await check('send back'); await btn(page, 'Back').click();
  await btn(page, 'Approve plan').click(); await check('question pinned');
  await btn(page, 'Answer Atlas').click(); await check('composer'); await btn(page, 'Cancel').click();
  for (const hash of ['#/ideas', '#/issues/open', '#/issues/closed', '#/issues/possibly-delivered', '#/delivered', '#/issue/207', '#/issue/223', '#/issue/231']) {
    await goTo(page, hash); await check(hash);
  }
  await btn(page, 'About').click(); await check('about'); await btn(page, 'Got it').click();
  assert.deepEqual(all, []);
  assert.equal(await page.evaluate(() => window.__network), 0, 'no fetch, XHR or WebSocket calls');
  const outside = requests.filter((r) => !r.url.startsWith(BASE) && !/fonts\.(googleapis|gstatic)\.com/.test(r.url));
  assert.deepEqual(outside, []);
  await page.context().close();
});

await scenario('layout: desktop, tablet and phones without sideways scroll, with the pinned box first', async () => {
  for (const [name, width, height] of [['desktop', 1366, 860], ['laptop', 1024, 768], ['tablet', 768, 1024], ['phone', 390, 844], ['small-phone', 320, 640]]) {
    const { page, problems } = await open({ width, height, mobile: width < 700 });
    assert.ok((await overflow(page)) <= 0, `${name}: page overflow ${await overflow(page)}px`);
    const box = await pin(page).boundingBox();
    const table = await page.locator('.table').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `${name}: pinned box fits the width`);
    assert.ok(box.y + box.height <= table.y, `${name}: pinned box sits above the list`);
    const clock = await page.locator('.pin .ring').boundingBox();
    assert.ok(clock.y < height, `${name}: the countdown is visible without scrolling`);
    const small = await page.evaluate(() => [...document.querySelectorAll('.pin .btn')].filter((el) => el.getBoundingClientRect().height < 39.5).map((el) => `${el.textContent.trim()} (${el.getBoundingClientRect().height}px)`));
    assert.deepEqual(small, [], `${name}: buttons under 40px tall`);
    await shot(page, `07-${name}`, false);
    await btn(page, 'Review plan').click();
    const d = await dialog(page).boundingBox();
    assert.ok(d.y >= 0 && d.y + d.height <= height + 0.5 && d.x >= 0 && d.x + d.width <= width + 0.5, `${name}: plan dialog fits`);
    const approve = await btn(page, 'Approve plan').boundingBox();
    assert.ok(approve.y + approve.height <= height, `${name}: Approve plan is on screen`);
    await btn(page, 'Approve plan').click();
    await btn(page, 'Answer Atlas').click();
    assert.ok((await overflow(page)) <= 0, `${name}: composer overflow`);
    if (width < 700) await shot(page, `08-${name}-answer`, false);
    assert.deepEqual(problems, []);
    await page.context().close();
  }
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
