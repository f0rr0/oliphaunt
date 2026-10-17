import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { nestedValue } from '@oliphaunt/ts-query/protocol';

const require = createRequire(import.meta.url);
assert.equal(nestedValue, 42);
assert.equal(require('@oliphaunt/ts-query/protocol').nestedValue, 42);
for (const format of ['module', 'commonjs']) {
  const declaration = new URL(
    `./node_modules/@oliphaunt/ts-query/dist/${format}/nested/value.d.ts`,
    import.meta.url,
  );
  assert.match(readFileSync(declaration, 'utf8'), /export declare const nestedValue: number;/);
}
