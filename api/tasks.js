import { nodeHandler } from '../lib/node-adapter.js';
import { getHandlers } from '../lib/runtime.js';

export default nodeHandler((request) => getHandlers().tasks(request));
