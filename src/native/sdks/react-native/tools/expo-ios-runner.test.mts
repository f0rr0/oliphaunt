import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDeterministicTar } from '../../../../../tools/packaging/archive-directory.mts';

const [phase, root] = process.argv.slice(2);
const seedName = (profile) => `@oliphaunt/seed-native-ios-datum64-${profile}`;
const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
if (phase === 'prepare') {
  for (const [name, metadata] of Object.entries({
    standard: { name: seedName('standard'), version: '1.2.3' },
    icu: { name: seedName('icu'), version: '1.2.3', dependencies: { '@oliphaunt/icu': '1.2.3' } },
    data: { name: '@oliphaunt/icu', version: '1.2.3' },
    wrong: { name: '@oliphaunt/icu', version: '9.9.9' },
  })) {
    const source = path.join(root, name);
    mkdirSync(path.join(source, 'package'), { recursive: true });
    writeFileSync(path.join(source, 'package/package.json'), JSON.stringify(metadata));
    writeFileSync(path.join(root, `${name}.tgz`), gzipSync(await createDeterministicTar(source)));
  }
  for (const name of ['workspace.json', 'example.json', 'single.json']) {
    writeFileSync(path.join(root, name), JSON.stringify({ dependencies: { unrelated: '1.0.0' } }));
  }
} else {
  const profile = phase === 'standard' ? 'standard' : 'icu';
  const example = read(phase === 'single' ? 'single.json' : 'example.json');
  const workspace = read(phase === 'single' ? 'single.json' : 'workspace.json');
  const expected = {
    [seedName(profile)]: `file:${path.join(root, `${profile}.tgz`)}`,
    ...(profile === 'icu' ? { '@oliphaunt/icu': `file:${path.join(root, 'data.tgz')}` } : {}),
  };
  assert.deepEqual(workspace.overrides, expected);
  assert.deepEqual(example.dependencies, { unrelated: '1.0.0', ...expected });
}
