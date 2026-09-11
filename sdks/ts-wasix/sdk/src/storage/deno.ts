/**
 * Select native Rust-owned directory storage for Deno.
 *
 * Deno uses the same managed-root format and OS advisory lock as Node.js. The
 * application must grant read and write permissions for the selected directory.
 */
export { directory } from './node.js';
