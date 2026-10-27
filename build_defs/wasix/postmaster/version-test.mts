import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [binary, manifest, role] = Bun.argv.slice(2);
assert(binary && manifest && (role === 'executor' || role === 'compiler'));
const canonical = Bun.TOML.parse(readFileSync(manifest, 'utf8')) as any;
const candidates = canonical.bin.filter((row: any) => row.name.endsWith(`postmaster-${role}`));
assert.equal(candidates.length, 1);
const result = Bun.spawnSync([binary, '--version'], { env: process.env });
assert.equal(result.exitCode, 0, result.stderr.toString());
const version = result.stdout.toString().trim();
const expected = `${candidates[0].name} ${canonical.package.version}`;
assert(role === 'compiler' ? version.startsWith(`${expected} `) : version === expected, version);
const invalid = Bun.spawnSync([binary, '--version', 'extra'], { env: process.env });
assert.notEqual(invalid.exitCode, 0, 'The actual product CLI must reject extra version arguments');
console.log(version);
