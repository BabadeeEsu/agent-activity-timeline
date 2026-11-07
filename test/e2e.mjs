// Browser tests for the pinned-box countdown demo. They open the real page in Chromium.
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
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'pinned-countdown-shots');
mkdirSync(SHOTS, { recursive: true });
const MIN = 60000;

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

let browser;
async function open({ width = 1600, height = 900, mobile = false, baseAgoMin = null, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('request', (r) => requests.push(r.url()));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  if (clock) await page.clock.install();
  await page.addInitScript(([ago, MIN]) => {
    window.__network = 0;
    const count = () => { window.__network += 1; };
    const realFetch = window.fetch;
    window.fetch = (...args) => { count(); return realFetch.apply(window, args); };
    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) { count(); return realOpen.apply(this, args); };
    if (ago !== null && !sessionStorage.getItem('seeded')) {
      localStorage.setItem('zk-pinned-demo-base', String(Date.now() - ago * MIN));
      sessionStorage.setItem('seeded', '1');
    }
  }, [baseAgoMin, MIN]);
  await page.goto(`${BASE}/`);
  return { page, context, problems, requests };
}
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const level = (page, id) => page.locator(`[data-clock="${id}"]`).getAttribute('data-level');
const word = (page, id) => page.locator(`[data-clock="${id}"] .word`).innerText();
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

browser = await chromium.launch();
console.log('Pinned box countdown');

await scenario('the page matches Ziki’s In Progress tab and only the pinned box has a countdown', async () => {
  const { page, problems } = await open();
  assert.match(await page.locator('.tab.on').innerText(), /In Progress\s*1128/);
  assert.match(await page.locator('.rail .on').innerText(), /1110\s*Open/);
  const pin = page.locator('.pin');
  assert.match(await pin.locator('.pin-head').innerText(), /Your issues\s*2\s*SAMPLE/);
  assert.equal(await pin.locator('.prow').count(), 2);
  assert.match(await pin.innerText(), /Sample: Login form overlaps the footer on narrow screens[\s\S]*BabadeeEsu’s Claude/);
  assert.match(await pin.innerText(), /Sample: Export button does nothing on the reports page[\s\S]*Ziki Frontend Bug Hunter/);
  // The list below is unchanged: same issues, same status, same importance, and no countdown.
  const rows = await page.locator('.table .row').allInnerTexts();
  assert.equal(rows.length, 4);
  for (const [i, [title, number, imp]] of [['Kebab menu', '#2', '44'], ['Hero avatar row', '#7', '38'], ['Signing Out of Workspace', '#90', '37'], ['Footer Facebook icon', '#148', '34']].entries()) {
    assert.ok(rows[i].includes(title) && rows[i].includes(number) && rows[i].includes(imp) && rows[i].includes('Ready for bids'), `row ${i + 1}: ${rows[i]}`);
  }
  assert.equal(await page.locator('.table [data-clock]').count(), 0, 'no countdown in the list');
  assert.equal(await page.locator('[data-clock]').count(), 2, 'one countdown per pinned row');
  const pinBox = await pin.boundingBox();
  const tableBox = await page.locator('.table').boundingBox();
  assert.ok(pinBox.y + pinBox.height <= tableBox.y, 'the pinned box sits above the list');
  assert.deepEqual(problems, []);
  await page.screenshot({ path: join(SHOTS, '01-desktop.png') });
  await page.context().close();
});

await scenario('the countdown shows no numbers and explains itself in words', async () => {
  const { page } = await open();
  for (const id of ['S1', 'S2']) {
    const clock = page.locator(`[data-clock="${id}"]`);
    for (const value of [await clock.innerText(), await clock.getAttribute('title'), await clock.locator('svg').getAttribute('aria-label'), await clock.locator('svg').textContent()]) {
      assert.doesNotMatch(value, /\d/, `no digits: ${value}`);
    }
    assert.equal(await clock.locator('svg').getAttribute('role'), 'img');
    assert.match(await clock.locator('svg').getAttribute('aria-label'), /^Time left to respond: /);
  }
  // The rows' other text (bids, importance) is Ziki's and stays; only the old elapsed time is gone.
  assert.doesNotMatch(await page.locator('.pin .who').first().innerText(), /\dh|\dm/);
  // Fresh demo: S1 has most of its window left, S2 is well into its own.
  assert.equal(await level(page, 'S1'), 'green');
  assert.equal(await word(page, 'S1'), 'Plenty of time');
  assert.equal(await level(page, 'S2'), 'orange');
  assert.equal(await word(page, 'S2'), 'Getting close');
  await page.context().close();
});

await scenario('each colour: green, yellow, orange, red and overdue', async () => {
  const { page } = await open();
  const expect = { Green: ['green', 'Plenty of time', 'rgb(34, 160, 90)'], Yellow: ['yellow', 'Deadline approaching', 'rgb(224, 176, 0)'], Orange: ['orange', 'Getting close', 'rgb(240, 122, 26)'], Red: ['red', 'Almost out of time', 'rgb(220, 58, 42)'], Overdue: ['overdue', 'Overdue', null] };
  const offsets = [];
  for (const [name, [lvl, w, stroke]] of Object.entries(expect)) {
    await btn(page, name).click();
    assert.equal(await btn(page, name).getAttribute('aria-pressed'), 'true');
    assert.equal(await level(page, 'S1'), lvl);
    assert.equal(await word(page, 'S1'), w);
    const arc = page.locator('[data-clock="S1"] .arc');
    offsets.push(Number(await arc.getAttribute('stroke-dashoffset')));
    if (stroke) assert.equal(await arc.evaluate((el) => getComputedStyle(el).stroke), stroke);
    await page.waitForTimeout(1050);
    await page.locator('.pin').screenshot({ path: join(SHOTS, `02-${lvl}.png`) });
  }
  for (let i = 1; i < offsets.length; i += 1) assert.ok(offsets[i] >= offsets[i - 1], 'the ring empties as the deadline nears');
  assert.equal(await page.locator('[data-clock="S1"] .mark').textContent(), '!');
  assert.match(await page.locator('[data-clock="S1"] svg').getAttribute('aria-label'), /This is a reminder only; nothing is released or cancelled by it/);
  assert.equal(await page.locator('.prow[data-row="S1"]').getAttribute('class'), 'prow u-row-overdue');
  assert.equal(await page.locator('.prow').count(), 2, 'overdue rows stay; nothing is removed');
  await btn(page, 'Real time').click();
  assert.equal(await level(page, 'S1'), 'green');
  await page.context().close();
});

await scenario('Play countdown runs through every colour in order, then stops', async () => {
  const { page } = await open({ clock: true });
  await btn(page, '▶ Play countdown').click();
  assert.equal(await btn(page, '■ Stop').getAttribute('aria-pressed'), 'true');
  const seen = [];
  for (let s = 0; s < 22; s += 1) {
    const l = await level(page, 'S1');
    if (seen[seen.length - 1] !== l) seen.push(l);
    await page.clock.runFor(1000);
  }
  assert.deepEqual(seen, ['green', 'yellow', 'orange', 'red', 'overdue']);
  await eventually(async () => assert.equal(await btn(page, '▶ Play countdown').getAttribute('aria-pressed'), 'false'));
  assert.equal(await page.evaluate(() => window.ZKDemo.timers()), 1, 'only the normal ticker remains');
  // Stop part-way.
  await btn(page, '▶ Play countdown').click();
  await page.clock.runFor(3000);
  await btn(page, '■ Stop').click();
  assert.equal(await page.evaluate(() => window.ZKDemo.timers()), 1);
  await page.context().close();
});

await scenario('a refresh continues from the real deadline instead of restarting', async () => {
  const { page } = await open({ baseAgoMin: 100 });
  // S1 opened 172 of 240 minutes ago → 28% left → yellow; S2 is past its deadline.
  assert.equal(await level(page, 'S1'), 'yellow');
  assert.equal(await level(page, 'S2'), 'overdue');
  const anchor = await page.evaluate(() => localStorage.getItem('zk-pinned-demo-base'));
  await page.reload();
  assert.equal(await level(page, 'S1'), 'yellow', 'still yellow after a refresh');
  assert.equal(await page.evaluate(() => localStorage.getItem('zk-pinned-demo-base')), anchor);
  await page.context().close();
});

await scenario('the ring updates on its own as time passes, with one timer', async () => {
  const { page } = await open({ clock: true });
  assert.equal(await level(page, 'S1'), 'green');
  await page.clock.runFor(60 * MIN);
  await eventually(async () => assert.equal(await level(page, 'S1'), 'yellow'));
  await page.clock.runFor(60 * MIN);
  await eventually(async () => assert.equal(await level(page, 'S1'), 'orange'));
  assert.equal(await page.evaluate(() => window.ZKDemo.timers()), 1);
  for (let i = 0; i < 3; i += 1) await btn(page, 'Reset').click();
  assert.equal(await page.evaluate(() => window.ZKDemo.timers()), 1, 'reset does not stack timers');
  assert.equal(await level(page, 'S1'), 'green');
  await page.context().close();
});

await scenario('About, reset, and the static parts of the page say what they are', async () => {
  const { page } = await open();
  await btn(page, 'About').click();
  assert.match(await page.locator('dialog[open]').innerText(), /with one change: in the pinned Your issues box/);
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await btn(page, 'About').click();
  await btn(page, 'Got it').click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });

  for (const target of ['.tool >> nth=0', '.rail li >> nth=1', '.tab >> nth=0', '.table .row >> nth=0']) {
    await page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
    await page.locator(target).click();
    await toast(page, 'Only the countdown in the pinned box is part of this demo');
  }
  await btn(page, 'Red').click();
  await btn(page, 'Reset').click();
  await toast(page, 'Reset');
  assert.equal(await btn(page, 'Real time').getAttribute('aria-pressed'), 'true');
  assert.equal(await level(page, 'S1'), 'green');

  const known = await page.evaluate(() => window.ZKDemo.actions);
  const used = await page.evaluate(() => [...document.querySelectorAll('[data-action]')].map((e) => e.dataset.action));
  for (const a of used) assert.ok(known.includes(a), `unknown action ${a}`);
  assert.equal(await page.locator('a[href]').count(), 0, 'no links that go nowhere');
  await page.context().close();
});

await scenario('nothing is sent anywhere', async () => {
  const { page, requests } = await open();
  await btn(page, 'Orange').click();
  await btn(page, 'Reset').click();
  assert.equal(await page.evaluate(() => window.__network), 0);
  assert.deepEqual(requests.filter((u) => !u.startsWith(BASE) && !/fonts\.(googleapis|gstatic)\.com/.test(u)), []);
  await page.context().close();
});

await scenario('layout: desktop to small phone, no sideways scroll, countdown visible', async () => {
  for (const [name, width, height] of [['wide', 1600, 900], ['laptop', 1280, 760], ['tablet', 768, 1024], ['phone', 390, 844], ['small-phone', 320, 640]]) {
    const { page, problems } = await open({ width, height, mobile: width < 700 });
    assert.ok((await overflow(page)) <= 0, `${name}: overflow ${await overflow(page)}px`);
    const pin = await page.locator('.pin').boundingBox();
    assert.ok(pin.x >= 0 && pin.x + pin.width <= width, `${name}: pinned box fits`);
    const ring = await page.locator('[data-clock="S1"] .ring').boundingBox();
    assert.ok(ring.width >= 36 && ring.y + ring.height <= height, `${name}: first countdown is visible without scrolling`);
    assert.ok(await page.locator('[data-clock="S1"] .word').isVisible(), `${name}: the word label is visible`);
    await page.screenshot({ path: join(SHOTS, `03-${name}.png`) });
    assert.deepEqual(problems, []);
    await page.context().close();
  }
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
