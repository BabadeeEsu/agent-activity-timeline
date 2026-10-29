// Local server: serves the static page and the same api/*.js functions Vercel runs.
//   ZIKI_AGENT_KEY=... RECOVERY_ACCESS_TOKEN=... RECOVERY_SESSION_SECRET=... node scripts/dev-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const files = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/assets/recovery.css': 'assets/recovery.css',
  '/assets/recovery.js': 'assets/recovery.js'
};

export async function startDevServer({ port = 3000 } = {}) {
  const routes = {
    '/api/session': (await import('../api/session.js')).default,
    '/api/tasks': (await import('../api/tasks.js')).default,
    '/api/task': (await import('../api/task.js')).default,
    '/api/handover/request': (await import('../api/handover/request.js')).default,
    '/api/handover/execute': (await import('../api/handover/execute.js')).default
  };

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (routes[pathname]) return routes[pathname](req, res);
    if (files[pathname]) {
      const extension = files[pathname].slice(files[pathname].lastIndexOf('.'));
      res.setHeader('content-type', types[extension]);
      res.end(await readFile(new URL(files[pathname], `file://${root}/`)));
      return undefined;
    }
    res.statusCode = 404;
    res.end('Not found');
    return undefined;
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  await startDevServer({ port });
  console.log(`Agent Work Recovery dev server: http://127.0.0.1:${port}`);
}
