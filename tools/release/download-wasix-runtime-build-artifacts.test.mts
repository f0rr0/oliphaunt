import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AOT_TARGET_TRIPLES } from '../../runtimes/liboliphaunt-wasix/tools/wasix-cargo-artifact-contract.mts';

const mode = process.argv[2];
if (mode === 'targets') {
  for (const id of Object.keys(AOT_TARGET_TRIPLES)) console.log(id);
} else {
  const commands = readFileSync(process.argv[3], 'utf8');
  const count = 1 + Object.keys(AOT_TARGET_TRIPLES).length;
  if (mode === 'failed') {
    assert.doesNotMatch(commands, /unpack|import-download/);
  } else if (mode === 'public') {
    assert.equal(commands.split('\nunpack\n').length - 1, count);
    assert.match(commands, /import-download/);
  } else {
    const sha = 'b'.repeat(40);
    assert.equal(commands.split(`CI\n${sha}\n`).length - 1, count);
    assert.ok(!commands.includes('a'.repeat(40)));
    const run = mode === 'selected' ? '777' : '30358387218';
    assert.equal(commands.split(`--run-id\n${run}\n--job\nBuilds\n`).length - 1, count);
    if (mode === 'selected') assert.ok(commands.includes(`--commit\n${sha}\n--status\nsuccess`));
    const install = commands.slice(commands.indexOf('import-download\n'));
    for (const [id, triple] of Object.entries(AOT_TARGET_TRIPLES)) {
      assert.ok(commands.includes(`--artifact\nliboliphaunt-wasix-runtime-aot-${id}\n`));
      assert.ok(install.includes(`--target-triple\n${triple}\n`));
    }
  }
}
