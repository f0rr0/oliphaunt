import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

assert.equal(import.meta.main, true);
const [first, firstTree, firstName, second, secondTree, secondName] = process.argv.slice(2);
assert.equal(process.argv.length, 8);
assert.equal(firstName, 'MODULE.bazel');
assert.equal(secondName, firstName);
assert.notEqual(firstTree, secondTree);
const copies = [path.join(firstTree, firstName), path.join(secondTree, secondName)];
for (const [index, original] of [first, second].entries()) {
  // Directory runfiles may project each regular output through a symlink.
  // Its target must be a distinct copied file, rather than the authored source.
  const actual = realpathSync(copies[index]);
  assert(lstatSync(actual).isFile());
  assert.notEqual(actual, realpathSync(original));
  assert.deepEqual(readFileSync(copies[index]), readFileSync(original));
}
assert.notDeepEqual(readFileSync(copies[0]), readFileSync(copies[1]));
console.log(
  'Declared Bun sources: distinct external MODULE.bazel files retain their repository identity.',
);
