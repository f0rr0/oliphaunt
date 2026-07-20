import { execFileSync } from 'node:child_process';

import { moonCommand } from '../dev/moon-command.mjs';

export function moonBin() {
  return moonCommand();
}

export function runMoon(args, options = {}) {
  return execFileSync(moonBin(), args, {
    encoding: 'utf8',
    env: {...process.env},
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}
