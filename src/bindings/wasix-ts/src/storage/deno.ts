/**
 * Select raw-PGDATA incremental directory storage for Deno.
 *
 * Deno uses the same portable on-disk format and crash-safe lease protocol as
 * the Node.js host. The application must grant read and write permissions for
 * the selected directory.
 */
export { directory } from './node.js';
