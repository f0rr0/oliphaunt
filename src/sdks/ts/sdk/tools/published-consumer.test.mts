import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  publishedConsumerDependencies,
  publishedConsumerInventory,
  preparePublishedConsumerEnvironment,
  verifyPublishedConsumerInstall,
} from './published-consumer.mts';

test('published lookup falls back only for absent versions and rejects invalid public metadata', async () => {
  const originalFetch = globalThis.fetch;
  const dependencies = publishedConsumerDependencies();
  try {
    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.equal(await publishedConsumerInventory(['oliphaunt-js']), null);
    for (const mutation of [
      { name: 'wrong-package' },
      { version: '999.0.0' },
      { dist: { integrity: 'bad', tarball: 'https://registry.npmjs.org/package.tgz' } },
      {
        dist: {
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
          tarball: 'https://private.example/package.tgz',
        },
      },
    ]) {
      globalThis.fetch = async (url) => {
        const name = decodeURIComponent(new URL(url).pathname.slice(1));
        const version = dependencies[name];
        return Response.json({
          versions: {
            [version]: {
              name,
              version,
              dist: {
                integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
                tarball: 'https://registry.npmjs.org/package.tgz',
              },
              ...mutation,
            },
          },
        });
      };
      await assert.rejects(
        publishedConsumerInventory(['oliphaunt-js']),
        /invalid published npm dependency metadata/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('published install isolates credentials, scoped configuration and injected runtime options', () => {
  const destination = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-published-environment-'));
  try {
    const env = preparePublishedConsumerEnvironment(destination, {
      PATH: '/bin',
      HOME: '/private-home',
      XDG_CONFIG_HOME: '/private-config',
      NPM_TOKEN: 'secret',
      NODE_AUTH_TOKEN: 'secret',
      npm_config_userconfig: '/private-npmrc',
      NPM_CONFIG_REGISTRY: 'https://private.example',
      BUN_CONFIG: '/private-bunfig',
      BUN_INSTALL: '/private-bun',
      NODE_OPTIONS: '--require /private-hook.js',
    });
    assert.equal(env.PATH, '/bin');
    for (const name of [
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'npm_config_userconfig',
      'BUN_CONFIG',
      'BUN_INSTALL',
      'NODE_OPTIONS',
    ])
      assert.equal(env[name], undefined);
    assert.equal(env.HOME, path.join(destination, 'install-home'));
    assert.equal(env.XDG_CONFIG_HOME, env.HOME);
    assert.equal(
      readFileSync(env.NPM_CONFIG_USERCONFIG, 'utf8'),
      'registry=https://registry.npmjs.org/\nalways-auth=false\n',
    );
    assert.equal(
      readFileSync(env.NPM_CONFIG_GLOBALCONFIG, 'utf8'),
      readFileSync(env.NPM_CONFIG_USERCONFIG, 'utf8'),
    );
    assert(!readFileSync(path.join(destination, 'install-environment'), 'utf8').includes('secret'));
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test('installed published dependencies must retain the candidate pins and registry integrity', () => {
  const destination = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-published-consumer-'));
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(import.meta.dir, '../package.json'), 'utf8'),
    );
    const writePackage = (name, data) => {
      const directory = path.join(destination, 'node_modules', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify(data));
    };
    writePackage('@oliphaunt/ts', manifest);
    const inventory = Object.entries(publishedConsumerDependencies(manifest)).map(
      ([name, version]) => ({
        name,
        version,
        integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        tarball: `https://registry.npmjs.org/${name}/-/package.tgz`,
      }),
    );
    const lock = {
      packages: Object.fromEntries(
        inventory.map((row) => [row.name, [`${row.name}@${row.version}`, '', {}, row.integrity]]),
      ),
    };
    for (const row of inventory) writePackage(row.name, { name: row.name, version: row.version });
    const writeLock = () => writeFileSync(path.join(destination, 'bun.lock'), JSON.stringify(lock));
    writeLock();
    verifyPublishedConsumerInstall(destination, inventory);
    const first = inventory[0];
    lock.packages[first.name][3] = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
    writeLock();
    assert.throws(
      () => verifyPublishedConsumerInstall(destination, inventory),
      /integrity mismatch/,
    );
    lock.packages[first.name][3] = first.integrity;
    lock.packages[first.name][1] = 'https://private.example/package.tgz';
    writeLock();
    assert.throws(
      () => verifyPublishedConsumerInstall(destination, inventory),
      /integrity mismatch/,
    );
    lock.packages[first.name][1] = '';
    writeLock();
    writePackage(first.name, { name: first.name, version: '999.0.0' });
    assert.throws(
      () => verifyPublishedConsumerInstall(destination, inventory),
      /identity\/integrity mismatch/,
    );
    assert.throws(
      () => verifyPublishedConsumerInstall(destination, inventory.slice(1)),
      /does not match the candidate SDK/,
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
