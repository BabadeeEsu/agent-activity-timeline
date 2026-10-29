// Browser tests: the real UI and the real server code, in Chromium, against the test-only fake Ziki.
//   npm run test:e2e        (Playwright is expected on NODE_PATH; nothing is added to package.json)
// Screenshots go to $SHOT_DIR (default: the OS temp folder). They are not committed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY } from '../support/fake-ziki.js';
import { startMockZiki } from './mock-ziki.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'awr-shots');
mkdirSync(SHOTS, { recursive: true });

const MOCK_PORT = 4010;
const APP_PORT = 4011;
const BARE_PORT = 4012;
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PASSPHRASE = 'correct horse battery';
const SESSION_SECRET = 's'.repeat(40);

// ---- processes
const children = [];
function startApp(port, env) {
  const child = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => String(chunk).includes('dev server') && resolve(child));
  });
}
const stopAll = () => children.forEach((c) => c.kill());

const mock = (action, body) => fetch(`${MOCK}/__mock/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const mockCalls = () => fetch(`${MOCK}/__mock/calls`).then((r) => r.json());
const releases = async () => (await mockCalls()).filter((c) => c.method === 'POST' && c.path.endsWith('/release'));
const writes = async () => (await mockCalls()).filter((c) => c.method === 'POST');

// ---- tiny runner
const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
  }
}

// ---- helpers
let browser;
async function open({ width = 1280, height = 900, signedIn = true, url = APP } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && pageErrors.push(m.text()));
  await page.goto(url);
  if (signedIn) await signIn(page);
  return { page, context, pageErrors };
}
async function signIn(page, passphrase = PASSPHRASE) {
  await page.locator('#zrk-passphrase').fill(passphrase);
  await page.locator('[data-form="signin"] button[type="submit"]').click();
}
const text = (page, selector) => page.locator(selector).innerText();
const see = (page, selector, expected, timeout = 5000) => page.locator(selector).filter({ hasText: expected }).first().waitFor({ timeout });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const confirmDialog = async (page) => {
  await page.locator('dialog.zrk-dialog[open]').waitFor();
  const body = await text(page, 'dialog.zrk-dialog[open]');
  await page.locator('dialog.zrk-dialog[open] button[value="ok"]').click();
  await page.locator('dialog.zrk-dialog').waitFor({ state: 'detached' });
  return body;
};

const BRIEF = {
  reason: 'I am out of budget for this task.',
  completed: 'Rounding helper and tests are done on branch fix/rounding.',
  remaining: 'Wire the helper into checkout and update the cart total.',
  references: 'branch fix/rounding\nPR https://github.com/acme/shop/pull/7',
  tests: '12 passing, 0 failing',
  nextSteps: 'Start in cart.ts, then run the checkout tests.'
};
async function fillBrief(page, values = BRIEF) {
  for (const [key, value] of Object.entries(values)) await page.locator(`#zrk-f-${key}`).fill(value);
}
async function sendRequest(page) {
  await fillBrief(page);
  await page.locator('[data-form="brief"] button[type="submit"]').click();
  await confirmDialog(page);
  await see(page, '#zrk-approve', 'Waiting for the owner');
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// =================================================================================================
async function main() {
  await startMockZiki({ port: MOCK_PORT });
  await startApp(APP_PORT, { ZIKI_BASE_URL: MOCK, ZIKI_AGENT_KEY: FAKE_KEY, RECOVERY_ACCESS_TOKEN: PASSPHRASE, RECOVERY_SESSION_SECRET: SESSION_SECRET });
  await startApp(BARE_PORT, {});
  browser = await chromium.launch();
  console.log('Browser tests');

  await scenario('not configured: says which settings are missing and offers nothing else', async () => {
    const { page } = await open({ signedIn: false, url: `http://127.0.0.1:${BARE_PORT}` });
    await see(page, '.zrk-center', 'Not set up yet');
    const body = await text(page, 'zk-work-recovery');
    for (const name of ['ZIKI_AGENT_KEY', 'RECOVERY_ACCESS_TOKEN', 'RECOVERY_SESSION_SECRET']) assert.ok(body.includes(name), name);
    assert.equal(await page.locator('input, textarea').count(), 0);
    await shot(page, '01-not-configured');
    await page.context().close();
  });

  await scenario('sign-in: wrong passphrase is refused, right one opens the app', async () => {
    await mock('reset');
    const { page } = await open({ signedIn: false });
    await signIn(page, 'wrong one');
    await see(page, '[role="alert"]', 'That passphrase is not correct');
    await shot(page, '02-sign-in-error');
    await signIn(page);
    await see(page, '#zrk-agent', 'Builder');
    assert.match(await text(page, '#zrk-agent'), /Level:\s*contributor/);
    await page.context().close();
  });

  await scenario('task view: three actions, real status, no fabricated heartbeat', async () => {
    await mock('reset');
    const { page, pageErrors } = await open();
    await see(page, '#zrk-tasks', '#42 Fix checkout rounding');
    await see(page, '#zrk-detail', 'Approve handover');
    for (const heading of ['Approve handover', 'Hand over to another agent', 'Recover a stalled task']) assert.ok((await text(page, '#zrk-detail')).includes(heading), heading);
    assert.equal(await page.locator('.zrk-btn.is-primary').count(), 2, 'one primary per action card: send the request, hand over');
    const recover = await text(page, '#zrk-recover');
    assert.match(recover, /Last heartbeat\s*Not available/);
    assert.match(recover, /Ask the agent to resume\s*Not supported/);
    assert.match(recover, /What this view cannot tell you/);
    assert.match(await text(page, '#zrk-handover'), /Not available yet\s*Hand over is available after the owner approves/);
    assert.equal(await page.locator('[data-action="execute"]').isDisabled(), true);
    assert.deepEqual(pageErrors, []);
    await shot(page, '03-task-desktop');
    await page.context().close();
  });

  await scenario('empty state when no task is in progress', async () => {
    await mock('reset', { noIssues: true });
    const { page } = await open();
    await see(page, '#zrk-tasks', 'No tasks in progress');
    await see(page, '#zrk-detail', 'There is nothing to show');
    await shot(page, '04-empty');
    await page.context().close();
  });

  await scenario('validation: an empty brief is stopped before anything is sent', async () => {
    await mock('reset');
    const { page } = await open();
    await see(page, '#zrk-approve', 'Ask owner to approve');
    await page.locator('[data-form="brief"] button[type="submit"]').click();
    await see(page, '#zrk-e-completed', 'Required.');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal((await writes()).length, 0);

    await page.locator('#zrk-f-reason').fill('x'.repeat(200));
    await page.locator('[data-form="brief"] button[type="submit"]').click();
    await see(page, '#zrk-e-reason', 'under 140');
    await shot(page, '05-validation');
    await page.context().close();
  });

  await scenario('the live counter warns before a brief is too long for Ziki', async () => {
    await mock('reset');
    const { page } = await open();
    await see(page, '[data-total]', 'Brief size');
    const before = Number((await text(page, '[data-total]')).match(/about (\d+)/)[1]);
    await page.locator('#zrk-f-completed').fill('x'.repeat(300));
    const after = Number((await text(page, '[data-total]')).match(/about (\d+)/)[1]);
    assert.equal(after - before, 300);
    assert.match(await text(page, '[data-count="completed"]'), /300 \/ 300/);
    await page.context().close();
  });

  await scenario('full flow: approve, survive a refresh, owner approves, hand over, brief persists', async () => {
    await mock('reset');
    const { page, pageErrors } = await open();
    await see(page, '#zrk-approve', 'Ask owner to approve');
    assert.match(await page.locator('#zrk-f-references').inputValue(), /pull\/7/, 'the linked PR is prefilled');

    // Cancelling the confirmation sends nothing.
    await fillBrief(page);
    await page.locator('[data-form="brief"] button[type="submit"]').click();
    await page.locator('dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('dialog.zrk-dialog').waitFor({ state: 'detached' });
    assert.equal((await writes()).length, 0, 'Escape cancels');

    // Send for real.
    await page.locator('[data-form="brief"] button[type="submit"]').click();
    const dialog = await confirmDialog(page);
    assert.match(dialog, /Nothing is handed over yet/);
    await see(page, '#zrk-approve', 'Waiting for the owner');
    await see(page, '#zrk-toast', 'Approval request sent');
    assert.equal(await page.locator('[data-action="execute"]').isDisabled(), true, 'still locked while waiting');
    const sent = await writes();
    assert.deepEqual(sent.map((c) => c.path), ['/escalations', '/issues/iss_1/comments']);
    assert.equal(sent[0].body.type, 'human_approval');
    await shot(page, '06-awaiting');

    // A page refresh keeps the state, because it lives in Ziki.
    await page.reload();
    await see(page, '#zrk-approve', 'Waiting for the owner');
    await page.locator('summary', { hasText: 'Saved brief' }).click();
    assert.match(await text(page, '#zrk-approve pre'), /Wire the helper into checkout/);
    assert.equal(await page.locator('[data-action="execute"]').isDisabled(), true);

    // The owner replies inside Ziki; the page picks it up on refresh.
    await mock('answer', { text: 'APPROVE, go ahead' });
    await page.locator('#zrk-tasks [data-action="refresh"]').click();
    await see(page, '#zrk-approve', 'Approved by the owner');
    await see(page, '#zrk-approve', 'APPROVE, go ahead');
    assert.equal(await page.locator('[data-action="execute"]').isDisabled(), false);
    await shot(page, '07-approved');

    // Hand over.
    await page.locator('[data-action="execute"]').click();
    const handDialog = await confirmDialog(page);
    assert.match(handDialog, /APPROVE, go ahead/);
    assert.match(handDialog, /Ziki chooses that agent, not you/);
    await see(page, '#zrk-handover', 'Task released');
    await see(page, '#zrk-handover', 'No acknowledgement yet');
    assert.equal((await releases()).length, 1);
    await shot(page, '08-handed-over');

    // The result survives a refresh too, and the list no longer shows a task nobody holds.
    await page.reload();
    await see(page, '#zrk-handover', 'Task released');
    await see(page, '#zrk-tasks', 'No tasks in progress');
    assert.equal((await releases()).length, 1, 'refreshing never releases again');
    assert.deepEqual(pageErrors, []);
    await page.context().close();
  });

  await scenario('rejection and unclear replies keep the task where it is', async () => {
    for (const [answer, expected] of [['REJECT, not now', 'The owner rejected this handover'], ['let me think about it', 'without a clear APPROVE or REJECT']]) {
      await mock('reset');
      const { page } = await open();
      await sendRequest(page);
      await mock('answer', { text: answer });
      await page.locator('#zrk-tasks [data-action="refresh"]').click();
      await see(page, '#zrk-approve', expected);
      assert.equal(await page.locator('[data-action="execute"]').isDisabled(), true, answer);
      await see(page, '#zrk-approve', 'Ask owner to approve'); // a new brief can be written
      assert.equal((await releases()).length, 0);
      await shot(page, `09-${answer.startsWith('REJECT') ? 'rejected' : 'unclear'}`);
      await page.context().close();
    }
  });

  await scenario('API failures are shown clearly and never look like success', async () => {
    const cases = [
      { fail: { match: 'POST /issues/iss_1/release', status: 429, headers: { 'retry-after': '30' }, body: { error: 'rate_limited' } }, title: 'Too many requests', text: '30 seconds' },
      { fail: { match: 'POST /issues/iss_1/release', status: 500 }, title: 'Ziki is not responding', text: 'Try again' },
      { fail: { match: 'POST /issues/iss_1/release', status: 403, body: { error: 'insufficient_level', message: 'Needs contributor level.' } }, title: 'Permission denied', text: 'Needs contributor level' },
      { fail: { match: 'POST /issues/iss_1/release', status: 409, body: { error: 'not_claimed', message: 'You do not hold the claim.' } }, title: 'Ziki could not do that now', text: 'You do not hold the claim' }
    ];
    for (const c of cases) {
      await mock('reset');
      const { page } = await open();
      await sendRequest(page);
      await mock('answer', { text: 'APPROVE' });
      await page.locator('#zrk-tasks [data-action="refresh"]').click();
      await see(page, '#zrk-approve', 'Approved by the owner');
      await mock('fail', c.fail);
      await page.locator('[data-action="execute"]').click();
      await confirmDialog(page);
      await see(page, '#zrk-handover [role="alert"]', c.title);
      assert.ok((await text(page, '#zrk-handover [role="alert"]')).includes(c.text), c.title);
      assert.ok(!(await text(page, '#zrk-handover')).includes('Task released'), 'a failure is never shown as success');
      assert.equal(await page.locator('[data-action="execute"]').isDisabled(), false, 'the user can try again');
      if (c.title === 'Too many requests') await shot(page, '10-error-rate-limit');
      await page.context().close();
    }
  });

  await scenario('an expired or rejected agent key is explained, not hidden', async () => {
    await mock('reset');
    await mock('fail', { match: 'GET /agents/me', status: 401, times: 1 });
    const { page } = await open();
    await see(page, '#zrk-tasks', 'Ziki rejected the server’s agent key');
    await shot(page, '11-key-rejected');
    await page.context().close();
  });

  await scenario('observer-level agents see why they cannot request a handover', async () => {
    await mock('reset', { level: 'observer' });
    const { page } = await open();
    await see(page, '#zrk-approve', 'Handover cannot be requested');
    assert.match(await text(page, '#zrk-approve'), /contributor level or higher/);
    assert.equal(await page.locator('[data-form="brief"]').count(), 0);
    assert.equal((await writes()).length, 0);
    await page.context().close();
  });

  await scenario('recovery options: handover shortcut works, resume is honestly unsupported', async () => {
    await mock('reset');
    const { page } = await open({ height: 700 });
    await see(page, '#zrk-recover', 'Start the handover');
    await page.locator('#zrk-recover [data-action="start-handover"]').click();
    await page.waitForFunction(() => document.activeElement?.id === 'zrk-f-reason');
    assert.equal(await page.locator('#zrk-recover button', { hasText: /resume/i }).count(), 0, 'no resume button exists');
    await page.context().close();
  });

  await scenario('a lost session sends the user back to sign-in without leaking data', async () => {
    await mock('reset');
    const { page, context } = await open();
    await see(page, '#zrk-tasks', '#42');
    await context.clearCookies();
    await page.locator('#zrk-tasks [data-action="refresh"]').click();
    await see(page, '.zrk-center', 'Your session ended');
    assert.ok(!(await text(page, 'zk-work-recovery')).includes('Fix checkout rounding'));
    await context.close();
  });

  await scenario('secrets never reach the browser', async () => {
    await mock('reset');
    const { page, context } = await open();
    const bodies = [];
    page.on('response', async (r) => r.url().includes('/api/') && bodies.push(await r.text().catch(() => '')));
    await see(page, '#zrk-approve', 'Ask owner to approve');
    await sendRequest(page);
    await page.reload();
    await see(page, '#zrk-approve', 'Waiting for the owner');

    const html = await page.content();
    const storage = await page.evaluate(() => JSON.stringify({ cookie: document.cookie, local: { ...localStorage }, session: { ...sessionStorage } }));
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'zrk_session');
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Strict');
    for (const haystack of [html, storage, ...bodies]) {
      for (const secret of [FAKE_KEY, PASSPHRASE, SESSION_SECRET]) assert.ok(!haystack.includes(secret), 'secret exposed to the page');
    }
    for (const asset of ['/assets/recovery.js', '/assets/recovery.css', '/']) {
      const source = await (await fetch(`${APP}${asset}`)).text();
      for (const secret of [FAKE_KEY, PASSPHRASE, SESSION_SECRET]) assert.ok(!source.includes(secret));
    }
    await context.close();
  });

  await scenario('responsive: phone and tablet layouts have no sideways scroll and usable controls', async () => {
    for (const [name, width, height] of [['phone', 390, 844], ['small-phone', 320, 640], ['tablet', 768, 1024]]) {
      await mock('reset');
      const { page } = await open({ width, height });
      await see(page, '#zrk-approve', 'Ask owner to approve');
      assert.ok((await overflow(page)) <= 0, `${name}: horizontal overflow ${await overflow(page)}px`);

      const smallTargets = await page.evaluate(() =>
        [...document.querySelectorAll('zk-work-recovery button, zk-work-recovery a[href]')]
          .filter((el) => el.offsetParent && !el.closest('.sr-only'))
          .filter((el) => el.tagName === 'BUTTON' && el.getBoundingClientRect().height < 40)
          .map((el) => el.textContent.trim())
      );
      assert.deepEqual(smallTargets, [], `${name}: buttons under 40px tall`);

      if (width < 860) {
        const columns = await page.evaluate(() => getComputedStyle(document.querySelector('.zrk-grid')).gridTemplateColumns.split(' ').length);
        assert.equal(columns, 1, `${name}: single column`);
      }
      await fillBrief(page);
      await page.locator('[data-form="brief"] button[type="submit"]').click();
      await page.locator('dialog[open]').waitFor();
      const box = await page.locator('dialog[open]').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${name}: dialog fits the screen`);
      await shot(page, `12-${name}-dialog`);
      await page.keyboard.press('Escape');
      await shot(page, `12-${name}`);
      await page.context().close();
    }
  });
}

try {
  await main();
} finally {
  await browser?.close();
  stopAll();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser scenarios passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
