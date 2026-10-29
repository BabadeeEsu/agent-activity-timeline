// Thin client for Ziki's documented agent API (https://ziki.dev/llms.txt).
// Only routes that appear in that reference are implemented here. The key is added
// to the Authorization header on the server and is never returned or logged.

export class ZikiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ZikiError';
    this.status = status; // 0 for network errors and timeouts
    this.code = code;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

const short = (value, max = 300) => String(value ?? '').slice(0, max);

// 8 s per call keeps a short chain of calls inside Vercel's default 10 s function limit.
export function createZikiClient({ baseUrl, key, fetchImpl = fetch, timeoutMs = 8000 }) {
  async function request(method, path, { query, body } = {}) {
    const url = new URL(`${baseUrl}/api/v1${path}`);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }

    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new ZikiError(0, 'timeout', 'Ziki did not answer in time.');
      throw new ZikiError(0, 'network', 'Could not reach Ziki.');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const bodyCode = typeof data?.code === 'string' ? data.code : typeof data?.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : undefined;
      const message = short(data?.message || data?.error || response.statusText || 'Request failed');
      throw new ZikiError(response.status, bodyCode, message, { retryAfter: response.headers.get('retry-after') });
    }
    return data;
  }

  const enc = encodeURIComponent;

  return {
    me: () => request('GET', '/agents/me'),
    projects: () => request('GET', '/projects'),
    listIssues: ({ projectId, status, assignee, limit = 50, cursor }) =>
      request('GET', '/issues', { query: { projectId, status, assignee, limit, cursor } }),
    getIssue: (id, { projectId }) => request('GET', `/issues/${enc(id)}`, { query: { projectId } }),
    listComments: (id, { projectId, after, limit = 100 }) =>
      request('GET', `/issues/${enc(id)}/comments`, { query: { projectId, after, limit } }),
    events: ({ bugId, projectId, after }) => request('GET', '/events', { query: { bugId, projectId, after } }),
    getEscalation: (id) => request('GET', `/escalations/${enc(id)}`),
    createEscalation: ({ body, type, bugId }) => request('POST', '/escalations', { body: { body, type, bugId } }),
    postComment: (id, { projectId, body, type = 'comment', metadata }) =>
      request('POST', `/issues/${enc(id)}/comments`, { body: { body, type, metadata, projectId } }),
    release: (id, { projectId, reason }) =>
      request('POST', `/issues/${enc(id)}/release`, { query: { projectId }, body: reason ? { reason } : {} })
  };
}
