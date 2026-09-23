import path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '../..');

export function uniqueValueFlag(args, flag) {
  let found = false;
  let selected = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== flag && !argument.startsWith(`${flag}=`)) continue;
    if (found) {
      throw new Error(`${flag} must be provided at most once`);
    }
    found = true;
    if (argument === flag) {
      if (index + 1 >= args.length) {
        throw new Error(`${flag} requires a value`);
      }
      const next = args[index + 1];
      if (next === flag || next.startsWith(`${flag}=`)) {
        throw new Error(`${flag} must be provided at most once`);
      }
      selected = next;
      index += 1;
    } else {
      selected = argument.slice(flag.length + 1);
    }
  }
  return selected;
}

export function fail(tool, message, exitCode = 1) {
  console.error(`${tool}: ${message}`);
  process.exit(exitCode);
}
