// TEST ONLY. Serves test/support/fake-ziki.js over HTTP so the real server code and a real browser can run
// against it. It is not Ziki and must never be pointed at by a production deployment.
//
//   /api/v1/*        the fake agent API
//   /__mock/reset    POST {level?, noIssues?}  start over with a fresh fake
//   /__mock/answer   POST {text}               answer the newest approval request, as an owner would in Ziki
//   /__mock/fail     POST {match, status, ...} make the next matching call fail
//   /__mock/calls    GET                       every request the fake received

import { createServer } from 'node:http';
import { createFakeZiki } from '../support/fake-ziki.js';

export async function startMockZiki({ port }) {
  let fake = createFakeZiki();

  const readBody = (req) =>
    new Promise((resolve) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        try { resolve(text ? JSON.parse(text) : undefined); } catch { resolve(undefined); }
      });
    });
  const send = (res, status, json, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(json));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);

    if (url.pathname.startsWith('/__mock/')) {
      const action = url.pathname.slice('/__mock/'.length);
      if (action === 'reset') {
        fake = createFakeZiki({ level: body?.level });
        if (body?.noIssues) {
          fake.state.issues.clear();
          fake.state.comments.clear();
        }
        return send(res, 200, { ok: true });
      }
      if (action === 'answer') {
        fake.answer(fake.lastEscalationId(), body.text);
        return send(res, 200, { ok: true });
      }
      if (action === 'fail') {
        fake.fail(body.match, body);
        return send(res, 200, { ok: true });
      }
      if (action === 'calls') return send(res, 200, fake.calls);
      return send(res, 404, { error: 'unknown control route' });
    }

    try {
      const out = fake.handle(req.method, url.pathname.replace(/^\/api\/v1/, ''), Object.fromEntries(url.searchParams), body, req.headers.authorization);
      return send(res, out.status, out.json, out.headers);
    } catch {
      req.socket.destroy(); // an injected network failure
      return undefined;
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
