import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { packWasixToolsNpmCarrier } from './wasix-tools-npm-carrier.mts';

test('packages tool bytes with an independent version and preserves runtime compatibility', async () => {
  const root = process.env.OLIPHAUNT_WASIX_TOOLS_TEST_ROOT;
  if (!root) throw new Error('Run bash postgres-tools/wasix/tools/test-packaging.sh');
  const payload = path.join(root, 'payload');
  mkdirSync(path.join(payload, 'bin'), { recursive: true });
  const manifest = {
    schema: 'postgres-tools-wasix-portable-v1',
    version: '7.8.9',
    runtimeVersion: '1.2.3',
    sourceFingerprint: 'fixture',
    pgDump: null,
    psql: null,
  };
  for (const [key, name] of [
    ['pgDump', 'pg_dump'],
    ['psql', 'psql'],
  ]) {
    const bytes = Buffer.from(name);
    const member = `bin/${name}.wasix.wasm`;
    writeFileSync(path.join(payload, member), bytes);
    manifest[key] = {
      name,
      path: member,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }
  writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify(manifest));
  const archive = path.join(root, 'tools.tar.gz');
  const writeArchive = () =>
    writeFileSync(
      archive,
      canonicalGzipSync(
        createDeterministicTar(payload, '.', {
          fail: (message) => {
            throw new Error(message);
          },
        }),
      ),
    );
  writeArchive();
  const args = {
    version: '7.8.9',
    portableReleaseArchive: archive,
    packageDir: path.join(root, 'package'),
    tarballRoot: path.join(root, 'tarballs'),
  };
  const packed = packWasixToolsNpmCarrier(args);
  const metadata = JSON.parse(readFileSync(path.join(packed.packageDir, 'package.json'), 'utf8'));
  expect(metadata.version).toBe('7.8.9');
  expect(metadata.oliphaunt.runtimeVersion).toBe('1.2.3');
  expect(Object.values(metadata.optionalDependencies)).toEqual(Array(4).fill('7.8.9'));
  const descriptor = (await import(pathToFileURL(path.join(packed.packageDir, 'index.js')).href))
    .default;
  expect(readFileSync(new URL(descriptor.pgDump.source), 'utf8')).toBe('pg_dump');
  expect(descriptor.runtimeVersion).toBe('1.2.3');
  expect(descriptor.pgDump.aot).toBeUndefined();
  const target =
    process.platform === 'linux'
      ? `linux-${process.arch}-gnu`
      : process.platform === 'darwin'
        ? `darwin-${process.arch}`
        : `win32-${process.arch}-msvc`;
  const aotPackage = path.join(
    packed.packageDir,
    'node_modules/@oliphaunt',
    `liboliphaunt-wasix-tools-${target}`,
  );
  mkdirSync(path.join(aotPackage, 'assets'), { recursive: true });
  writeFileSync(
    path.join(aotPackage, 'package.json'),
    JSON.stringify({
      name: `@oliphaunt/liboliphaunt-wasix-tools-${target}`,
      version: '7.8.9',
      exports: { './package.json': './package.json' },
    }),
  );
  writeFileSync(
    path.join(aotPackage, 'assets/manifest.json'),
    JSON.stringify({
      artifacts: [
        { name: 'tool:pg_dump', path: 'pg_dump.bin.zst' },
        { name: 'tool:psql', path: 'psql.bin.zst' },
      ],
    }),
  );
  writeFileSync(path.join(aotPackage, 'assets/pg_dump.bin.zst'), 'target-code');
  cpSync(packed.packageDir, path.join(root, 'consumer'), { recursive: true });
  writeFileSync(path.join(payload, 'bin/pg_dump.wasix.wasm'), 'altered');
  writeArchive();
  expect(() => packWasixToolsNpmCarrier(args)).toThrow('differs from its manifest');
  expect(() => packWasixToolsNpmCarrier({ ...args, version: '../escape' })).toThrow(
    'semantic version',
  );
});
