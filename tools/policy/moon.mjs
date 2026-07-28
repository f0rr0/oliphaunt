import { moonCommand } from '../dev/moon-command.mjs';
import { captureCommandOutput } from '../dev/capture-command-output.mjs';

export function moonBin() {
  return moonCommand();
}

export function runMoon(args, options = {}) {
  const {
    encoding: _encoding = 'utf8',
    maxBuffer = 32 * 1024 * 1024,
    ...captureOptions
  } = options;
  const result = captureCommandOutput(moonBin(), args, {
    env: {...process.env},
    label: `${moonBin()} ${args.join(' ')}`,
    maxOutputBytes: maxBuffer,
    ...captureOptions,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      result.error?.message
        ?? (result.stderr.trim() || result.stdout.trim() || `Moon exited ${result.status}`),
    );
  }
  return result.stdout;
}
