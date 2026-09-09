#!/usr/bin/env node
import { copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Resolve only the compiler from the checkout. All SDK imports resolve through
// the staged package's own exports and declarations, as they do after installation.
const [packageDir, fixture] = process.argv.slice(2).map(value => path.resolve(value));
const compiler = createRequire(new URL('../../../sdks/js/package.json', import.meta.url)).resolve('typescript/bin/tsc');
const consumer = path.join(packageDir, 'consumer.mts');
copyFileSync(fixture, consumer);
try {
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,DOM,ESNext.Disposable', consumer], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`installed TypeScript consumer failed: ${fixture}`);
} finally {
  rmSync(consumer, { force: true });
}
