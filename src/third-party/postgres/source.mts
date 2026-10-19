import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = Bun.TOML.parse(
  readFileSync(new URL('./source.toml', import.meta.url), 'utf8'),
).postgresql;
const fields = ['version', 'sha256', 'url'].map((key) => {
  const value = source[key];
  assert(
    typeof value === 'string' && value && !/[\t\r\n]/.test(value),
    `invalid PostgreSQL ${key}`,
  );
  return value;
});
console.log(fields.join('\t'));
