import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, publicStatus } from '../../lib/config.js';
import { clearedCookie, issueSession, passphraseMatches, readCookie, SESSION_COOKIE, sessionCookie, verifySession } from '../../lib/session.js';

const env = {
  ZIKI_AGENT_KEY: 'zk_test_key_0123456789abcdef',
  RECOVERY_ACCESS_TOKEN: 'correct horse battery',
  RECOVERY_SESSION_SECRET: 's'.repeat(40)
};
const config = loadConfig(env);
const NOW = Date.parse('2026-10-29T10:00:00Z');

test('config reports exactly which settings are missing', () => {
  const none = loadConfig({});
  assert.equal(none.ready, false);
  assert.deepEqual(none.missing, ['ZIKI_AGENT_KEY', 'RECOVERY_ACCESS_TOKEN', 'RECOVERY_SESSION_SECRET']);
  assert.equal(config.ready, true);
  assert.equal(config.baseUrl, 'https://ziki.dev');
});

test('weak secrets and insecure Ziki URLs are rejected', () => {
  const weak = loadConfig({ ...env, RECOVERY_ACCESS_TOKEN: 'short', RECOVERY_SESSION_SECRET: 'tiny' });
  assert.equal(weak.ready, false);
  assert.equal(weak.problems.length, 2);

  assert.equal(loadConfig({ ...env, ZIKI_BASE_URL: 'http://ziki.dev' }).ready, false);
  assert.equal(loadConfig({ ...env, ZIKI_BASE_URL: 'not a url' }).ready, false);
  assert.equal(loadConfig({ ...env, ZIKI_BASE_URL: 'http://127.0.0.1:4010' }).ready, true);
  assert.equal(loadConfig({ ...env, ZIKI_BASE_URL: 'https://staging.ziki.dev/path/' }).baseUrl, 'https://staging.ziki.dev');
});

test('the public status never contains a secret', () => {
  const text = JSON.stringify(publicStatus(config)) + JSON.stringify(publicStatus(loadConfig({ ZIKI_AGENT_KEY: env.ZIKI_AGENT_KEY })));
  for (const secret of Object.values(env)) assert.ok(!text.includes(secret));
});

test('the passphrase check is exact', () => {
  assert.equal(passphraseMatches(config, 'correct horse battery'), true);
  for (const wrong of ['correct horse batter', 'Correct horse battery', '', undefined, null, 'correct horse battery ']) assert.equal(passphraseMatches(config, wrong), false);
});

test('a session cookie verifies, expires, and cannot be forged', () => {
  const { value, maxAge } = issueSession(config, NOW);
  const header = `other=1; ${SESSION_COOKIE}=${value}`;
  assert.equal(maxAge, 8 * 3600);
  assert.equal(verifySession(config, header, NOW + 1000), true);
  assert.equal(verifySession(config, header, NOW + 8 * 3600 * 1000 + 1000), false, 'expired');
  assert.equal(verifySession(config, '', NOW), false);
  assert.equal(verifySession(config, undefined, NOW), false);

  const [expires, signature] = value.split('.');
  assert.equal(verifySession(config, `${SESSION_COOKIE}=${Number(expires) + 99999}.${signature}`, NOW), false, 'extended expiry');
  assert.equal(verifySession(config, `${SESSION_COOKIE}=${expires}.${'A'.repeat(signature.length)}`, NOW), false, 'bad signature');
  assert.equal(verifySession(config, `${SESSION_COOKIE}=${expires}`, NOW), false, 'no signature');
  assert.equal(verifySession({ ...config, sessionSecret: 'z'.repeat(40) }, header, NOW + 1000), false, 'different secret');
});

test('cookie attributes keep the session out of scripts and cross-site requests', () => {
  const secure = sessionCookie('abc', { maxAge: 60, secure: true });
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Strict/);
  assert.match(secure, /Secure/);
  assert.match(secure, /Path=\/api/);
  assert.ok(!sessionCookie('abc', { maxAge: 60, secure: false }).includes('Secure'));
  assert.match(clearedCookie({ secure: true }), /Max-Age=0/);
  assert.equal(readCookie('a=1; b=2', 'b'), '2');
  assert.equal(readCookie('a=1', 'b'), null);
});
