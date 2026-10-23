import assert from 'node:assert/strict';
import path from 'node:path';

const [binary, ...args] = process.argv.slice(2);
assert(binary && process.env.TEST_TMPDIR, 'isolated Rust test needs its binary and test directory');
const result = Bun.spawnSync([binary, ...args], {
  env: {
    ...process.env,
    OLIPHAUNT_RUNTIME_CACHE_DIR: path.join(process.env.TEST_TMPDIR, 'native-cache'),
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(result.exitCode);
