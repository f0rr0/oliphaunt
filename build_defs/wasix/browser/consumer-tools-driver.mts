import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from 'vite';

const transformed = await transformWithEsbuild('export const answer: number = 42;', 'probe.ts');
assert(transformed.code.includes('answer = 42'));
assert(!transformed.code.includes(': number'));
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  assert(server.middlewares);
} finally {
  await server.close();
}
console.log('Locked Vite closure loaded and actual native esbuild transformed TypeScript');
