import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Private packagers run with the pinned Bun toolchain. Consumers receive plain
// JavaScript and do not need Bun or a TypeScript loader.
export function releaseJavaScript(source: string): Buffer {
  const code = new Bun.Transpiler({ loader: 'ts', target: 'node' })
    .transformSync(readFileSync(source, 'utf8'))
    .replace(/(["'])([^"'\n]+)\.mts\1/g, '$1$2.mjs$1')
    .replace(/(["'])([^"'\n]+)\.cts\1/g, '$1$2.cjs$1');
  return Buffer.from(code);
}

export function emitJavaScript(source: string, destination: string): void {
  writeFileSync(destination, releaseJavaScript(source), { mode: 0o644 });
}

export async function bundleJavaScript(source: string): Promise<Buffer> {
  const result = await Bun.build({
    entrypoints: [source],
    root: path.dirname(source),
    target: 'node',
    format: 'esm',
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`Cannot bundle ${source}: ${result.logs.join('\n')}`);
  }
  return Buffer.from(await result.outputs[0].arrayBuffer());
}

if (import.meta.main) {
  const [source, destination, ...extra] = process.argv.slice(2);
  if (!source || !destination || extra.length)
    throw new Error('usage: emit-javascript.mts SOURCE DESTINATION');
  emitJavaScript(source, destination);
}
