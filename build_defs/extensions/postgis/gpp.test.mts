/** Exercise the pinned execution tool with PostGIS's upstream SQLPP string mode. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [gpp] = process.argv.slice(2);
assert(gpp, 'required: declared GPP executable');
const normalize = (output: string) => output.replaceAll('\r\n', '\n');
function run(args: string[]) {
  const result = Bun.spawnSync([resolve(gpp), ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return normalize(result.stdout.toString());
}

assert.equal(run(['--version']).split('\n')[0], 'GPP 2.28');
const expected = "\nSELECT text, 'text';\n";
// A single CRLF conversion must not hide GPP/CRT double conversion.
const doubledCr = "\r\r\nSELECT text, 'text';\r\r\n";
assert.equal(normalize(doubledCr), "\r\nSELECT text, 'text';\r\n");
assert.notEqual(normalize(doubledCr), expected);

const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-gpp-'));
try {
  for (const [name, newline] of [
    ['lf', '\n'],
    ['crlf', '\r\n'],
  ]) {
    const input = join(directory, `${name}.sql.in`);
    const output = join(directory, `${name}.sql`);
    writeFileSync(input, `#define TYPE text${newline}SELECT TYPE, 'TYPE';${newline}`);
    run(['+z', '-C', '-s', "'", '-o', output, input]);
    assert.equal(normalize(readFileSync(output, 'utf8')), expected);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
