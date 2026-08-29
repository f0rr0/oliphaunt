/**
 * Select direct managed directory storage for Deno.
 *
 * Deno operates on the real PGDATA below the same trusted, exclusively owned
 * local-root format and fail-closed owner lock as the Node.js host. The
 * application must grant read and write permissions for the selected
 * directory.
 */
export { directory } from './node.js';
