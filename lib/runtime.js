// Builds the handlers once per server instance from environment variables.
import { loadConfig } from './config.js';
import { createHandlers } from './handlers.js';

let cached;

export function getHandlers() {
  cached ??= createHandlers({ config: loadConfig(process.env) });
  return cached;
}
