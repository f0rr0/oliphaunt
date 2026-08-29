/**
 * Select direct managed directory storage for Bun.
 *
 * Bun operates on the real PGDATA below the same trusted, exclusively owned
 * local-root format and fail-closed owner lock as the Node.js host.
 */
export { directory } from './node.js';
