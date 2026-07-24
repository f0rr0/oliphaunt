#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };
let command;
let args;

if (process.platform === 'darwin') {
  env.OLIPHAUNT_BUILD_EXTENSIONS ??= '0';
  command = 'bash';
  args = ['src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh'];
} else if (process.platform === 'linux') {
  command = 'bash';
  args = ['src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh'];
} else if (process.platform === 'win32') {
  command = 'pwsh';
  args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1',
  ];
} else {
  console.error(`unsupported liboliphaunt release runtime host: ${process.platform}`);
  process.exit(2);
}

const result = spawnSync(command, args, { stdio: 'inherit', env });
if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
