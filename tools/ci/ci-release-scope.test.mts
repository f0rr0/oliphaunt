import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [phase, directory, head] = process.argv.slice(2);
if (phase === 'bump' || phase === 'invalid') {
  const file = path.join(directory, '.release-please-manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (phase === 'invalid') manifest['unowned-product'] = '1.0.0';
  else {
    const config = JSON.parse(
      readFileSync(path.join(directory, 'release-please-config.json'), 'utf8'),
    );
    const owner = Object.entries(config.packages).find(
      ([, value]) => value.component === 'oliphaunt-js',
    )?.[0];
    assert.ok(owner, 'native TypeScript release owner must exist');
    manifest[owner] = '99.0.0';
  }
  writeFileSync(file, JSON.stringify(manifest));
} else if (phase === 'assert') {
  for (const event of ['pull_request', 'push']) {
    const output = readFileSync(path.join(directory, `${event}.out`), 'utf8');
    assert.match(output, /qualification_mode=selected-products/);
    assert(output.includes(`qualification_head_sha=${head}`));
    assert.match(output, /qualification_products=\["oliphaunt-js"\]/);
  }
  assert.match(
    readFileSync(path.join(directory, 'invalid.err'), 'utf8'),
    /changed unknown package path/,
  );
  console.log(
    'release PR and main select the same Git-derived product scope; unknown owner rejected',
  );
} else throw new Error('run through ci-release-scope.test.sh');
