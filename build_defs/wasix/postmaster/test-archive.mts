import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';

const [rootArg, outputArg, membersArg] = Bun.argv.slice(2);
assert(rootArg && outputArg && membersArg?.startsWith('--tree-files='));
assert.equal(Bun.argv.length, 5);
const root = resolve(rootArg),
  output = resolve(outputArg);
const files = readFileSync(membersArg.slice('--tree-files='.length), 'utf8').trim().split('\n');
assert(files.length > 0 && new Set(files).size === files.length);
const stage = mkdtempSync(join(dirname(output), '.postmaster-test-carrier-'));
try {
  for (const source of files) {
    const name = relative(root, resolve(source));
    assert(name && !name.startsWith('../') && !name.includes('\\') && name !== '..');
    // Process-wrapper inputs use a single symlink to the declared output File.
    // Accept that presentation while rejecting a source artifact that itself
    // points onward to another file or contains a special filesystem entry.
    const input = lstatSync(source).isSymbolicLink()
      ? resolve(dirname(source), readlinkSync(source))
      : source;
    const stat = lstatSync(input);
    assert(stat.isFile(), `Declared carrier member is not regular: ${source}`);
    const destination = join(stage, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(input), { flag: 'wx' });
    chmodSync(destination, stat.mode & 0o777);
  }
  await archiveDirectory(stage, output);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
