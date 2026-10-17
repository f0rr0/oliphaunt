import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { decorate } from './native-entry-helper.mts';

assert.equal(import.meta.main, true, 'authored runner must execute as main');
const [source, generated, literal, forwarded] = process.argv.slice(2);
assert.equal(process.argv.length, 6);
assert.equal(forwarded, 'forwarded');
assert.ok(source && generated && isAbsolute(source) && isAbsolute(generated));
assert.equal(literal, '$literal `&"\' space\n');
assert.deepEqual(JSON.parse(readFileSync(generated, 'utf8')), {
  value: decorate(readFileSync(source, 'utf8')),
});
assert.equal(process.env.OLIPHAUNT_NATIVE_ENTRY_FIXTURE, 'literal value');
assert.ok(isAbsolute(process.env.OLIPHAUNT_NATIVE_ENTRY_RUNFILES ?? ''));
