import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const [executable, module, artifact, expected] = Bun.argv.slice(2);
assert.equal(Bun.argv.length, 6);
const child = Bun.spawn([resolve(executable), resolve(module), resolve(artifact)], {
  env: { LC_ALL: 'C', TEST_TMPDIR: process.env.TEST_TMPDIR },
  stdout: 'pipe',
  stderr: 'pipe',
});
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
const status = await child.exited;
console.log(await stdout);
console.error(await stderr);
assert.equal(status, 0, 'The actual compiled primitive probe failed');
assert((await stdout).includes(expected), 'The primitive probe did not confirm its invariants');
