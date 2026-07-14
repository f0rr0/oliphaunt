import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function moonBin() {
  if (process.env.MOON_BIN) {
    return process.env.MOON_BIN;
  }

  for (const candidate of [
    path.join(homedir(), '.proto/bin/moon'),
    path.join(homedir(), '.proto/shims/moon'),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'moon';
}

export function runMoon(args, options = {}) {
  return execFileSync(moonBin(), args, {
    encoding: 'utf8',
    env: {...process.env},
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}
