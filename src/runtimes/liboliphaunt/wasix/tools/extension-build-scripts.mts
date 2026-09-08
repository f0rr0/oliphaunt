import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../../..');
const { extensions } = JSON.parse(
  readFileSync(path.join(root, 'src/extensions/generated/extensions.catalog.json'), 'utf8'),
);
for (const name of extensions.map((row) => row['sql-name']).sort()) {
  const recipe = path.join(root, 'src/extensions/external', name, 'targets/wasix.toml');
  if (!existsSync(recipe)) continue;
  const target = Bun.TOML.parse(readFileSync(recipe, 'utf8'));
  if (target.build_kind !== 'autotools') continue;
  assert(
    typeof target.build_script === 'string' && target.build_script.length > 0,
    `${name} has no WASIX build script`,
  );
  console.log(target.build_script);
}
