/**
 * Select snapshot-backed directory storage for Bun.
 *
 * Bun uses the same portable on-disk format and crash-safe lease protocol as
 * the Node.js host.
 */
export { directory } from './node.js';
