// Lets a Web-standard handler ((Request) => Response) run as a Vercel Node function.

const MAX_BODY = 65536;
const FORWARDED_HEADERS = ['cookie', 'content-type', 'origin', 'x-requested-with'];

export function nodeHandler(webHandler) {
  return async (req, res) => {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);

      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        if (req.headers[name]) headers.set(name, String(req.headers[name]));
      }

      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) {
            res.statusCode = 413;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end('{"error":{"code":"too_large","message":"That request is too large."}}');
            return;
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }

      const response = await webHandler(new Request(url, { method: req.method, headers, body }));

      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') res.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"error":{"code":"internal","message":"Something went wrong on the server."}}');
    }
  };
}
