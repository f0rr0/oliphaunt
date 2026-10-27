import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertExactReleaseAssetNames,
  requestBoundedGithubJson,
  requestReleaseAssetProof,
  requestReleaseControlBytes,
} from './verify_github_release_attestations.mts';

describe('GitHub release HTTP boundaries', () => {
  test('rejects unexpected assets for a non-extension release', () => {
    expect(() =>
      assertExactReleaseAssetNames({
        product: 'liboliphaunt-native',
        tag: 'liboliphaunt-native-v1.2.3',
        expectedNames: ['liboliphaunt-1.2.3-runtime-resources-ios-datum64.tar.gz'],
        actualNames: [
          'liboliphaunt-1.2.3-runtime-resources-ios-datum64.tar.gz',
          'stale-unlocked-binary.tar.gz',
        ],
      }),
    ).toThrow(
      'liboliphaunt-native GitHub release liboliphaunt-native-v1.2.3 asset set mismatch ' +
        '(unexpected: stale-unlocked-binary.tar.gz)',
    );
  });

  test('bounds and times the release metadata request without redirects', async () => {
    let request;
    const value = await requestBoundedGithubJson(
      'https://api.github.com/repos/f0rr0/oliphaunt/releases/tags/test',
      {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return Response.json({ assets: [] });
        },
        timeoutMs: 1_000,
      },
    );
    expect(value).toEqual({ assets: [] });
    expect(request.options.redirect).toBe('error');
    expect(request.options.signal).toBeInstanceOf(AbortSignal);
  });

  test('rejects oversized release metadata before JSON parsing', async () => {
    await expect(
      requestBoundedGithubJson('https://api.github.com/repos/f0rr0/oliphaunt/releases/tags/test', {
        fetchImpl: async () =>
          new Response('{}', {
            headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
          }),
      }),
    ).rejects.toThrow('GitHub API response exceeds 8388608 bytes');
  });

  test('streams an asset into an exact size and sha256 proof', async () => {
    const bytes = Buffer.from('exact release asset bytes\n');
    let request;
    const proof = await requestReleaseAssetProof(
      'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
      'asset.tar.zst',
      bytes.length,
      {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return new Response(bytes);
        },
        timeoutMs: 1_000,
      },
    );
    expect(proof).toEqual({
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(request.options.redirect).toBe('follow');
    expect(request.options.signal).toBeInstanceOf(AbortSignal);
  });

  test('retains the authenticated stream once after exact size and digest checks', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'github-retained-asset-'));
    try {
      const retainedPath = path.join(directory, 'asset.tar.zst');
      const chunks = [Buffer.from('exact '), Buffer.from('release asset bytes\n')];
      const bytes = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let fetches = 0;
      const proof = await requestReleaseAssetProof(
        'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
        'asset.tar.zst',
        bytes.length,
        {
          retainedPath,
          expectedSha256: sha256,
          fetchImpl: async () => {
            fetches += 1;
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (const chunk of chunks) controller.enqueue(chunk);
                  controller.close();
                },
              }),
            );
          },
        },
      );
      expect(proof).toEqual({ bytes: bytes.length, sha256, path: retainedPath });
      expect(fetches).toBe(1);
      expect(await readFile(proof.path)).toEqual(bytes);
      expect((await lstat(proof.path)).mode & 0o222).toBe(0);
      expect(await readdir(directory)).toEqual(['asset.tar.zst']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('removes every partial retained file when the download or proof fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'github-retained-failure-'));
    try {
      let cancelled = 0;
      const scenarios = [
        {
          label: 'overruns size',
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from('123'));
                  controller.enqueue(Buffer.from('45'));
                },
                cancel() {
                  cancelled += 1;
                },
              }),
            ),
          error: 'exceeds expected size 4',
        },
        {
          label: 'underruns size',
          fetchImpl: async () => new Response('123'),
          error: 'size 3 does not match expected size 4',
        },
        {
          label: 'declares wrong size',
          fetchImpl: async () => new Response('1234', { headers: { 'content-length': '5' } }),
          error: 'Content-Length 5 does not match expected size 4',
        },
        {
          label: 'has wrong digest',
          fetchImpl: async () => new Response('1234'),
          expectedSha256: '0'.repeat(64),
          error: 'does not match expected sha256',
        },
        {
          label: 'fails while streaming',
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from('12'));
                },
                pull(controller) {
                  controller.error(new Error('interrupted stream'));
                },
              }),
            ),
          error: 'interrupted stream',
        },
        {
          label: 'cancels fetch',
          fetchImpl: async () => {
            throw new DOMException('cancelled fetch', 'AbortError');
          },
          error: 'cancelled fetch',
        },
        {
          label: 'receives HTTP error',
          fetchImpl: async () => new Response('failure', { status: 500 }),
          error: 'HTTP 500',
        },
      ];
      for (const scenario of scenarios) {
        await expect(
          requestReleaseAssetProof(
            'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
            scenario.label,
            4,
            { ...scenario, retainedPath: path.join(directory, 'asset.tar.zst') },
          ),
        ).rejects.toThrow(scenario.error);
        expect(await readdir(directory)).toEqual([]);
      }
      expect(cancelled).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('refuses occupied and symlink destinations without modifying unrelated files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'github-retained-occupied-'));
    try {
      const existing = path.join(directory, 'existing');
      const symbolic = path.join(directory, 'symbolic');
      await writeFile(existing, 'unrelated bytes');
      await symlink(existing, symbolic);
      let fetches = 0;
      for (const retainedPath of [existing, symbolic]) {
        await expect(
          requestReleaseAssetProof(
            'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
            'asset.tar.zst',
            4,
            {
              retainedPath,
              fetchImpl: async () => {
                fetches += 1;
                return new Response('1234');
              },
            },
          ),
        ).rejects.toThrow();
      }
      expect(fetches).toBe(0);
      expect(await readFile(existing, 'utf8')).toBe('unrelated bytes');
      expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
      expect((await readdir(directory)).sort()).toEqual(['existing', 'symbolic']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects malformed expected digests before creating a retained file or fetching', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'github-retained-invalid-'));
    try {
      let fetches = 0;
      for (const expectedSha256 of ['invalid', 'A'.repeat(64), 123]) {
        await expect(
          requestReleaseAssetProof(
            'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
            'asset.tar.zst',
            4,
            {
              expectedSha256,
              retainedPath: path.join(directory, 'asset.tar.zst'),
              fetchImpl: async () => {
                fetches += 1;
                return new Response('1234');
              },
            },
          ),
        ).rejects.toThrow('invalid expected sha256');
      }
      expect(fetches).toBe(0);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('preserves files and symlinks that appear while a retained download is in flight', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'github-retained-race-'));
    try {
      const unrelated = path.join(directory, 'unrelated');
      await writeFile(unrelated, 'unrelated bytes');
      for (const kind of ['file', 'symlink']) {
        const retainedPath = path.join(directory, kind);
        await expect(
          requestReleaseAssetProof(
            'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
            'asset.tar.zst',
            4,
            {
              retainedPath,
              fetchImpl: async () => {
                if (kind === 'file') await writeFile(retainedPath, 'racing file');
                else await symlink(unrelated, retainedPath);
                return new Response('1234');
              },
            },
          ),
        ).rejects.toThrow();
      }
      expect(await readFile(path.join(directory, 'file'), 'utf8')).toBe('racing file');
      expect((await lstat(path.join(directory, 'symlink'))).isSymbolicLink()).toBe(true);
      expect(await readFile(unrelated, 'utf8')).toBe('unrelated bytes');
      expect((await readdir(directory)).sort()).toEqual(['file', 'symlink', 'unrelated']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects size mismatches before buffering or hashing an unbounded asset', async () => {
    await expect(
      requestReleaseAssetProof(
        'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
        'asset.tar.zst',
        4,
        {
          fetchImpl: async () =>
            new Response('x', {
              headers: { 'content-length': '5' },
            }),
        },
      ),
    ).rejects.toThrow('Content-Length 5 does not match expected size 4');
  });

  test('caps control manifests and rejects asset URLs outside the GitHub API origin', async () => {
    await expect(
      requestReleaseControlBytes(
        'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1',
        'manifest.json',
        8 * 1024 * 1024 + 1,
        { fetchImpl: async () => new Response('{}') },
      ),
    ).rejects.toThrow('invalid size');
    await expect(
      requestReleaseAssetProof('https://attacker.invalid/releases/assets/1', 'asset.tar.zst', 1, {
        fetchImpl: async () => new Response('x'),
      }),
    ).rejects.toThrow('must use https://api.github.com');
  });
});
