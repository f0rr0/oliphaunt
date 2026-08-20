/**
 * Select managed incremental directory storage for Deno.
 *
 * Deno uses the same portable on-disk format and fail-closed local owner lock
 * as the Node.js host. The application must grant read and write permissions
 * for the selected directory.
 */
export { directory } from './node.js';
