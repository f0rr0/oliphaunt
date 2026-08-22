/**
 * Select managed incremental directory storage for Bun.
 *
 * Bun uses the same portable on-disk format and fail-closed local owner lock
 * as the Node.js host.
 */
export { directory } from './node.js';
