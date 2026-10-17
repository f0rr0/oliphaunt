import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { WASIX_RUNTIME_NPM_PACKAGE } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import { packageRuntimeNpm, type RuntimeNpmSpec } from './npm.mts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-native-runtime-npm-'));
  roots.push(root);
  const portableAssets = path.join(root, 'portable');
  await mkdir(portableAssets);
  const module = Buffer.from('\0asm\x01\0\0\0');
  const runtime = zstdCompressSync(
    Buffer.from(await new Bun.Archive({ 'oliphaunt/bin/postgres': module }).bytes()),
  );
  await writeFile(path.join(portableAssets, 'oliphaunt.wasix.tar.zst'), runtime);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        'format-version': 2,
        'source-fingerprint': 'independent fixture',
        runtime: {
          archive: 'oliphaunt.wasix.tar.zst',
          sha256: sha(runtime),
          size: runtime.length,
          'module-sha256': sha(module),
          'postgres-version': '18.4',
          link: { exports: [] },
        },
        'runtime-support': [],
        extensions: [],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(portableAssets, 'manifest.json'), manifest);
  const notices = Object.fromEntries(
    [
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md',
      'src/third-party/postgres/COPYRIGHT',
      'src/third-party/postgres/source.toml',
      'src/third-party/icu/LICENSE',
      'src/third-party/icu/source.toml',
    ].map((file) => [file, path.resolve(file)]),
  );
  const spec: RuntimeNpmSpec = {
    version: '7.8.9',
    packageName: WASIX_RUNTIME_NPM_PACKAGE,
    portableAssets,
    notices,
  };
  return { root, spec, runtime, manifest };
}

test('runtime npm preserves physical assets and deterministic framing read by an independent archive consumer', async () => {
  const { root, spec, runtime, manifest } = await fixture();
  const first = path.join(root, 'first.tgz');
  const second = path.join(root, 'second.tgz');
  packageRuntimeNpm(spec, first);
  packageRuntimeNpm(spec, path.relative(process.cwd(), second));
  expect(await readFile(first)).toEqual(await readFile(second));
  const files = await new Bun.Archive(await readFile(first)).files();
  const read = async (name: string) => {
    const file = files.get(`package/${name}`);
    if (!file) throw new Error(`independent archive consumer found no ${name}`);
    return Buffer.from(await file.arrayBuffer());
  };
  expect(await read('assets/manifest.json')).toEqual(manifest);
  expect(await read('assets/oliphaunt.wasix.tar.zst')).toEqual(runtime);
  expect(JSON.parse((await read('package.json')).toString())).toMatchObject({
    name: WASIX_RUNTIME_NPM_PACKAGE,
    version: spec.version,
    type: 'module',
  });
  expect((await read('index.js')).toString()).toContain(spec.version);
  expect(await read('LICENSE')).toEqual(await readFile('LICENSE'));
});

test('runtime npm rejects mismatched names, stale bytes, missing notices and unsafe notice paths', async () => {
  const { root, spec } = await fixture();
  const output = path.join(root, 'invalid.tgz');
  expect(() => packageRuntimeNpm({ ...spec, packageName: '@oliphaunt/wrong' }, output)).toThrow(
    'Canonical release package name disagrees',
  );
  expect(() =>
    packageRuntimeNpm({ ...spec, notices: { ...spec.notices, '../outside': 'LICENSE' } }, output),
  ).toThrow('Unsafe declared notice destination');
  expect(() => packageRuntimeNpm({ ...spec, notices: {} }, output)).toThrow();
  await writeFile(path.join(spec.portableAssets, 'oliphaunt.wasix.tar.zst'), 'changed bytes');
  expect(() => packageRuntimeNpm(spec, output)).toThrow('does not match manifest.runtime.sha256');
});
