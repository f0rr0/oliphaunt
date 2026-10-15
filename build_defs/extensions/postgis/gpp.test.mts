/** Exercise the pinned execution tool with PostGIS's upstream SQLPP string mode. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const [gpp] = process.argv.slice(2);
assert(gpp, 'required: declared GPP executable');
function run(args: string[], input?: string) {
  const result = Bun.spawnSync([resolve(gpp), ...args], {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().replaceAll('\r\n', '\n');
}

assert.equal(run(['--version']).split('\n')[0], 'GPP 2.28');
assert.equal(
  run(['-C', '-s', "'"], "#define TYPE text\nSELECT TYPE, 'TYPE';\n"),
  "\nSELECT text, 'text';\n",
);
