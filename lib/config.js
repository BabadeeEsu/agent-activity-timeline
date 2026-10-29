// Server-side configuration. Everything here comes from environment variables.
// Nothing in this file is ever sent to the browser except the NAMES of missing variables.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadConfig(env = process.env) {
  const missing = [];
  const problems = [];

  const read = (name) => {
    const value = (env[name] || '').trim();
    if (!value) missing.push(name);
    return value;
  };

  const zikiKey = read('ZIKI_AGENT_KEY');
  const accessToken = read('RECOVERY_ACCESS_TOKEN');
  const sessionSecret = read('RECOVERY_SESSION_SECRET');

  if (accessToken && accessToken.length < 12) problems.push('RECOVERY_ACCESS_TOKEN must be at least 12 characters');
  if (sessionSecret && sessionSecret.length < 32) problems.push('RECOVERY_SESSION_SECRET must be at least 32 characters');

  let baseUrl = (env.ZIKI_BASE_URL || 'https://ziki.dev').trim();
  try {
    const url = new URL(baseUrl);
    const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
    if (!allowed) problems.push('ZIKI_BASE_URL must use https');
    baseUrl = url.origin;
  } catch {
    problems.push('ZIKI_BASE_URL is not a valid URL');
  }

  return {
    ready: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    baseUrl,
    zikiKey,
    accessToken,
    sessionSecret,
    projectId: (env.ZIKI_PROJECT_ID || '').trim(),
    sessionHours: 8
  };
}

// The only configuration facts the browser may see.
export function publicStatus(config) {
  return { configured: config.ready, missing: config.missing, problems: config.problems };
}
