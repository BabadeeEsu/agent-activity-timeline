import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createZikiClient, ZikiError } from '../../lib/ziki-client.js';

const KEY = 'zk_test_key_0123456789abcdef';

function recorder(respond = () => new Response('{}', { status: 200 })) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(url), init });
    return respond(url, init);
  };
  return { seen, client: createZikiClient({ baseUrl: 'https://ziki.test', key: KEY, fetchImpl, timeoutMs: 50 }) };
}

test('every call is authenticated with the key in the Authorization header only', async () => {
  const { seen, client } = recorder();
  await client.me();
  await client.listIssues({ projectId: 'prj_1', status: 'in_progress', assignee: 'user_1' });
  for (const { url, init } of seen) {
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!url.href.includes(KEY), 'key must never be in a URL');
    assert.ok(url.pathname.startsWith('/api/v1/'));
  }
  assert.equal(seen[1].url.search, '?projectId=prj_1&status=in_progress&assignee=user_1&limit=50');
});

test('writes use the documented shapes', async () => {
  const { seen, client } = recorder();
  await client.postComment('iss_1', { projectId: 'prj_1', body: 'hello', metadata: { kind: 'x' } });
  await client.createEscalation({ body: 'please approve', type: 'human_approval', bugId: 'iss_1' });
  await client.release('iss_1', { projectId: 'prj_1', reason: 'approved' });
  await client.release('iss_1', { projectId: 'prj_1' });

  const [comment, escalation, release, bare] = seen;
  assert.equal(comment.init.method, 'POST');
  assert.equal(comment.url.pathname, '/api/v1/issues/iss_1/comments');
  assert.deepEqual(JSON.parse(comment.init.body), { body: 'hello', type: 'comment', metadata: { kind: 'x' }, projectId: 'prj_1' });
  assert.equal(comment.url.search, '', 'projectId travels in the body for comments');

  assert.equal(escalation.url.pathname, '/api/v1/escalations');
  assert.deepEqual(JSON.parse(escalation.init.body), { body: 'please approve', type: 'human_approval', bugId: 'iss_1' });

  assert.equal(release.url.pathname, '/api/v1/issues/iss_1/release');
  assert.equal(release.url.searchParams.get('projectId'), 'prj_1');
  assert.deepEqual(JSON.parse(release.init.body), { reason: 'approved' });
  assert.deepEqual(JSON.parse(bare.init.body), {});
});

test('issue ids are encoded so they cannot change the route', async () => {
  const { seen, client } = recorder();
  await client.getIssue('a/../b?x=1', { projectId: 'prj_1' });
  assert.equal(seen[0].url.pathname, '/api/v1/issues/a%2F..%2Fb%3Fx%3D1');
});

test('HTTP errors carry status, code, message and Retry-After', async () => {
  const { client } = recorder(() => new Response(JSON.stringify({ error: 'rate_limited', message: 'Slow down' }), { status: 429, headers: { 'retry-after': '30' } }));
  await assert.rejects(client.me(), (error) => {
    assert.ok(error instanceof ZikiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.message, 'Slow down');
    assert.equal(error.retryAfter, '30');
    return true;
  });
});

test('network failures and timeouts become status 0 errors', async () => {
  const offline = recorder(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.client.me(), (error) => error.status === 0 && error.code === 'network');

  const slow = createZikiClient({
    baseUrl: 'https://ziki.test', key: KEY, timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  });
  await assert.rejects(slow.me(), (error) => error.status === 0 && error.code === 'timeout');
});

test('error messages never echo the key or an upstream body wholesale', async () => {
  const { client } = recorder(() => new Response(JSON.stringify({ message: 'x'.repeat(2000) }), { status: 500 }));
  await assert.rejects(client.me(), (error) => {
    assert.ok(error.message.length <= 300);
    assert.ok(!error.message.includes(KEY) && !String(error.stack).includes(KEY));
    return true;
  });

  const offline = recorder(() => { throw new TypeError(`connect failed for Bearer ${KEY}`); });
  await assert.rejects(offline.client.me(), (error) => !error.message.includes(KEY));
});

test('only the documented routes exist on the client', () => {
  const { client } = recorder();
  assert.deepEqual(Object.keys(client).sort(), ['createEscalation', 'events', 'getEscalation', 'getIssue', 'listComments', 'listIssues', 'me', 'postComment', 'projects', 'release']);
});
