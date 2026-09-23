import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeterministicTar } from './cargo-source-package.mts';
import { canonicalGzipSync } from './portable-archive.mts';
import { stageLocalNpmTarball } from './local-npm-tarball.mts';

test('npm and Bun consume the same staged carrier bytes from a path with spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'local npm carrier '));
  try {
    const source = join(root, 'source');
    mkdirSync(join(source, 'prebuilds'), { recursive: true });
    const manifest = { name: '@fixture/carrier', version: '1.0.0' };
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
    const payload = Buffer.from([0, 1, 2, 255]);
    writeFileSync(join(source, 'prebuilds', 'addon.node'), payload);
    const archive = join(root, 'carrier-1.0.0.tgz');
    writeFileSync(archive, canonicalGzipSync(createDeterministicTar(source, 'package', {})));
    for (const manager of ['npm', 'bun']) {
      const consumer = join(root, manager);
      mkdirSync(consumer);
      const dependency = stageLocalNpmTarball(archive, consumer);
      assert.equal(dependency, 'file:./carrier-1.0.0.tgz');
      assert.deepEqual(readFileSync(join(consumer, 'carrier-1.0.0.tgz')), readFileSync(archive));
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({
          name: 'consumer',
          private: true,
          dependencies: { [manifest.name]: dependency },
        }),
      );
      const result = spawnSync(manager, ['install', '--ignore-scripts'], {
        cwd: consumer,
        encoding: 'utf8',
        timeout: 60_000,
        shell: process.platform === 'win32' && manager === 'npm',
        env: { ...process.env, NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' },
      });
      assert.equal(
        result.status,
        0,
        `${manager}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
      );
      assert.deepEqual(
        readFileSync(join(consumer, 'node_modules/@fixture/carrier/prebuilds/addon.node')),
        payload,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
