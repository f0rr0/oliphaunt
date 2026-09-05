#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import process from 'node:process';

const target = process.env.OLIPHAUNT_CI_TARGET ?? '';
const targets = {
  darwin: {allowed: ['macos-arm64'], command: 'bash', args: ['tools/release/package-liboliphaunt-macos-assets.sh']},
  linux: {allowed: ['linux-arm64-gnu', 'linux-x64-gnu'], command: 'bash', args: ['tools/release/package-liboliphaunt-linux-assets.sh']},
  win32: {
    allowed: ['windows-x64-msvc'],
    command: 'pwsh',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/release/package-liboliphaunt-windows-assets.ps1'],
  },
};
const plan = targets[process.platform];
if (!plan?.allowed.includes(target)) {
  console.error(`cannot package native runtime target ${JSON.stringify(target)} on ${process.platform}`);
  process.exit(2);
}
const result = spawnSync(plan.command, plan.args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS: `target/liboliphaunt/desktop-release-assets/${target}`,
    OLIPHAUNT_RELEASE_BUILD_RUNTIME: '0',
    OLIPHAUNT_RELEASE_FETCH_ASSETS: '0',
  },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
