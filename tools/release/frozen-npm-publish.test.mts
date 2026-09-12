import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  frozenNpmIntegrity,
  inspectNpmExactVersion,
  inspectNpmVersionState,
  prepareFrozenNpmPublication,
  reconcileFrozenNpmPublication,
} from './frozen-npm-publish.mts';
import { isRegistryPublicationDeferredError } from './registry-publication-deferral.mts';

const temporaryDirectories = [];

function tarball() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-frozen-npm-'));
  temporaryDirectories.push(root);
  const file = path.join(root, 'fixture-1.2.3.tgz');
  writeFileSync(file, 'immutable npm fixture\n');
  return file;
}

function publishedResponse(integrity) {
  return Response.json({ name: '@oliphaunt/fixture', version: '1.2.3', dist: { integrity } });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('frozen npm registry publication', () => {
  test('classifies exact versions and rejects immutable SRI conflicts', async () => {
    const file = tarball();
    const expectedIntegrity = frozenNpmIntegrity(file);
    const urls = [];
    const state = await inspectNpmExactVersion({
      packageName: '@oliphaunt/fixture',
      version: '1.2.3',
      expectedIntegrity,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async (url, options) => {
        urls.push(url);
        expect(options.headers.Accept).toBe('application/json');
        return publishedResponse(expectedIntegrity);
      },
    });
    expect(state.published).toBe(true);
    expect(urls).toEqual(['https://registry.npmjs.org/%40oliphaunt%2Ffixture/1.2.3']);

    await expect(
      inspectNpmExactVersion({
        packageName: '@oliphaunt/fixture',
        version: '1.2.3',
        expectedIntegrity,
        deadlineEpochSeconds: 2_000,
        nowImpl: () => 1_000_000,
        fetchImpl: async () => publishedResponse('sha512-conflicting'),
      }),
    ).rejects.toThrow(/immutable npm version.*conflicts/u);
  });

  test('inventories npm exact versions so resumptions omit public carriers', async () => {
    const calls = [];
    const inventory = await inspectNpmVersionState({
      plan: [
        { ecosystem: 'cargo', name: 'not-npm', version: '1.0.0' },
        { ecosystem: 'npm', name: '@oliphaunt/missing', version: '1.0.0' },
        { ecosystem: 'npm', name: '@oliphaunt/pending', version: '1.0.0' },
        { ecosystem: 'npm', name: '@oliphaunt/published', version: '1.0.0' },
      ],
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      concurrency: 1,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.includes('published')) return publishedResponse('sha512-present');
        if (url === 'https://registry.npmjs.org/%40oliphaunt%2Fpending') {
          return Response.json({ name: '@oliphaunt/pending' });
        }
        return new Response('', { status: 404 });
      },
    });

    expect(inventory).toEqual({
      selectedIdentities: [
        { name: '@oliphaunt/missing', version: '1.0.0' },
        { name: '@oliphaunt/pending', version: '1.0.0' },
        { name: '@oliphaunt/published', version: '1.0.0' },
      ],
      publishedIdentities: [{ name: '@oliphaunt/published', version: '1.0.0' }],
      pendingVersions: [{ name: '@oliphaunt/pending', version: '1.0.0' }],
      missingNames: ['@oliphaunt/missing'],
    });
    expect(calls.every(({ options }) => options.headers.Accept === 'application/json')).toBe(true);
    expect(calls.map(({ url }) => url)).toContain(
      'https://registry.npmjs.org/%40oliphaunt%2Fpending',
    );
  });

  test('native admission distinguishes existing names, exact versions, and bounded new publication', async () => {
    const file = tarball();
    const options = {
      packageName: '@oliphaunt/fixture',
      version: '1.2.3',
      tarball: file,
      deadlineEpochSeconds: 2000,
      nowImpl: () => 1_000_000,
    };
    const existing = await prepareFrozenNpmPublication({
      ...options,
      fetchImpl: async () => publishedResponse(frozenNpmIntegrity(file)),
    });
    expect(existing.skipped).toBe(true);
    expect(existing.timeout).toBe(0);
    await expect(
      prepareFrozenNpmPublication({
        ...options,
        identityCreationOnly: true,
        fetchImpl: async (url) =>
          url.endsWith('/1.2.3')
            ? new Response('', { status: 404 })
            : Response.json({ name: options.packageName }),
      }),
    ).rejects.toThrow('package name already exists');
    const admitted = await prepareFrozenNpmPublication({
      ...options,
      identityCreationOnly: true,
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    expect(admitted.skipped).toBe(false);
    expect(admitted.timeout).toBe(120000);
    expect(admitted.expectedIntegrity).toBe(frozenNpmIntegrity(file));
  });

  test('native post-upload reconciliation requires exact frozen SRI and never hides changed local bytes', async () => {
    const file = tarball();
    const options = {
      packageName: '@oliphaunt/fixture',
      version: '1.2.3',
      tarball: file,
      deadlineEpochSeconds: 2000,
      nowImpl: () => 1_000_000,
    };
    const prepared = await prepareFrozenNpmPublication({
      ...options,
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    expect(
      (
        await reconcileFrozenNpmPublication(prepared, {
          nowImpl: options.nowImpl,
          fetchImpl: async () => publishedResponse(prepared.expectedIntegrity),
        })
      ).published,
    ).toBe(true);
    await expect(
      reconcileFrozenNpmPublication(prepared, {
        nowImpl: options.nowImpl,
        fetchImpl: async () => publishedResponse('sha512-wrong'),
      }),
    ).rejects.toThrow('conflicts');
    await expect(
      reconcileFrozenNpmPublication(prepared, {
        nowImpl: options.nowImpl,
        fetchImpl: async () => new Response('', { status: 404 }),
        attempts: 2,
        delayMilliseconds: 0,
        sleepImpl: async () => {},
      }),
    ).rejects.toThrow('did not become visible');
    writeFileSync(file, 'different bytes');
    await expect(
      reconcileFrozenNpmPublication(prepared, {
        fetchImpl: () => {
          throw new Error('unexpected read');
        },
      }),
    ).rejects.toThrow('changed after publication admission');
  });

  test('native admission rejects unsafe registries and defers before insufficient mutation time', async () => {
    const options = {
      packageName: '@oliphaunt/fixture',
      version: '1.2.3',
      tarball: tarball(),
      deadlineEpochSeconds: 1030,
      nowImpl: () => 1_000_000,
    };
    for (const registry of [
      'http://registry.npmjs.org',
      'https://example.invalid',
      'https://registry.npmjs.org/path',
    ])
      await expect(
        prepareFrozenNpmPublication({
          ...options,
          registry,
          fetchImpl: () => {
            throw new Error('unexpected registry read');
          },
        }),
      ).rejects.toThrow('canonical public registry');
    try {
      await prepareFrozenNpmPublication({
        ...options,
        fetchImpl: async () => new Response('', { status: 404 }),
      });
      throw new Error('unexpected admission');
    } catch (cause) {
      expect(isRegistryPublicationDeferredError(cause)).toBe(true);
    }
  });
});
