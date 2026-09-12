/**
 * Select native Rust-owned directory storage for Bun.
 *
 * Bun uses the same managed-root format and OS advisory lock as Node.js.
 */
export { directory } from './node.js';
