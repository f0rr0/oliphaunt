import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requiredCoreRuntimePaths, requiredRuntimeTools } from './native-runtime-payload.mts';

const runtime = path.join(process.argv[2], 'runtime');
const target = 'linux-x64-gnu';
for (const tool of requiredRuntimeTools(target)) {
  const file = path.join(runtime, 'bin', tool);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
}
for (const relativePath of requiredCoreRuntimePaths(target, runtime)) {
  const file = path.join(runtime, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${relativePath}\n`);
}
