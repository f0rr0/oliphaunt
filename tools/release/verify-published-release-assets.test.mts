import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extensionMetadata, extensionSourceIdentity } from './release-artifact-targets.mts';
import { isolatedGitHubTestEnvironment } from './testdata/isolated-github-test-environment.mts';
import { expectedAssets, verifyReleaseAssets } from './verify_github_release_attestations.mts';

const VERSION = '0.0.1';
const CONTRIB = 'oliphaunt-extension-contrib-pg18';
const REPO = 'f0rr0/oliphaunt';
const API = `https://api.github.com/repos/${REPO}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (process.argv[2] === '--verify-fixture') {
  const fixture = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(`/releases/tags/${fixture.product}-v${VERSION}`)) {
      return Response.json({
        id: 1,
        tag_name: `${fixture.product}-v${VERSION}`,
        draft: fixture.draft ?? false,
        prerelease: false,
        // Embedded assets are incomplete; the dedicated endpoint is authoritative.
        assets: [],
      });
    }
    if (parsed.pathname.endsWith('/releases/1/assets')) {
      return Response.json(fixture.assets);
    }
    const asset = fixture.assets.find((row) => row.url === String(url));
    if (asset) return new Response(Buffer.from(fixture.bytes[asset.name], 'base64'));
    throw new Error(`unexpected fixture request: ${url}`);
  };
  const assets = fixture.staged ? await expectedAssets(fixture.product, VERSION) : undefined;
  await verifyReleaseAssets(fixture.product, VERSION, assets);
} else {
  function fixture(product) {
    const family = product === 'liboliphaunt-wasix' ? 'wasix' : 'native';
    const external = product === 'oliphaunt-extension-pgtap';
    const artifactProduct = external ? product : CONTRIB;
    const metadata = extensionMetadata(artifactProduct);
    const sourceIdentity = extensionSourceIdentity(artifactProduct);
    if (external) sourceIdentity.commit = 'a'.repeat(40);
    else sourceIdentity.sha256 = 'a'.repeat(64);
    const stem = `${artifactProduct}-${VERSION}`;
    const payloadName = `${stem}-${family}-bundle.tar.gz`;
    const payload = Buffer.from('immutable historical extension payload\n');
    const target = family === 'wasix' ? 'linux-x64-gnu' : 'macos-arm64';
    const members = ['historical_a', 'historical_b'].map((sqlName) => ({
      sqlName,
      createsExtension: true,
      dependencies: [],
      dataFiles: [],
      extensionSqlFileNames: [`${sqlName}--1.0.sql`],
      extensionSqlFilePrefixes: [],
      nativeModuleStem: null,
      iosNativeDependencies: [],
      iosRegistration: null,
      wasixInstall: null,
      sharedPreloadLibraries: [],
      assets: [
        {
          name: `${sqlName}.tar.gz`,
          family,
          target,
          kind: family === 'wasix' ? 'wasix-runtime' : 'native-dynamic',
          identity: null,
          sha256: hash(payload),
          bytes: payload.length,
          carrierAsset: payloadName,
          carrierRoot: payloadName.replace(/\.tar\.gz$/u, ''),
          memberPath: `extensions/${sqlName}/${sqlName}.tar.gz`,
        },
      ],
    }));
    const manifest = {
      schema: external
        ? 'oliphaunt-extension-release-manifest-v1'
        : 'oliphaunt-extension-release-manifest-v2',
      product: artifactProduct,
      releaseProduct: product,
      family: external ? 'combined' : family,
      version: VERSION,
      extensionClass: external ? 'external' : 'contrib',
      versioning: external ? 'upstream-bound' : 'runtime-bound',
      sourceIdentity,
      compatibility: {
        ...metadata.compatibility,
        nativeRuntimeVersion: VERSION,
        wasixRuntimeVersion: VERSION,
      },
      ...(external
        ? {
            ...members[0],
            assets: [
              {
                name: payloadName,
                family,
                target,
                kind: 'native-dynamic',
                identity: null,
                sha256: hash(payload),
                bytes: payload.length,
              },
            ],
          }
        : {
            extensions: members,
            assets: [
              {
                name: payloadName,
                family,
                target,
                kind: 'extension-bundle',
                sha256: hash(payload),
                bytes: payload.length,
                memberCount: members.length,
              },
            ],
          }),
    };
    const bytes = new Map([
      [payloadName, payload],
      [`${stem}-manifest.json`, Buffer.from(JSON.stringify(manifest))],
      [`${stem}-manifest.properties`, Buffer.from(`version=${VERSION}\n`)],
    ]);
    if (family === 'native')
      bytes.set(`${stem}-swift-extension-carrier.json`, Buffer.from('{"historical":true}'));
    const checksumName = `${stem}-release-assets.sha256`;
    bytes.set(
      checksumName,
      Buffer.from([...bytes].map(([name, value]) => `${hash(value)}  ./${name}\n`).join('')),
    );
    if (!external) {
      const runtimeNames =
        product === 'liboliphaunt-wasix'
          ? [
              `liboliphaunt-wasix-${VERSION}-runtime-portable.tar.zst`,
              ...['linux-arm64-gnu', 'linux-x64-gnu', 'macos-arm64', 'windows-x64-msvc'].map(
                (target) => `liboliphaunt-wasix-${VERSION}-runtime-aot-${target}.tar.zst`,
              ),
              `liboliphaunt-wasix-${VERSION}-release-assets.sha256`,
            ]
          : [
              ...[
                'linux-arm64-gnu',
                'linux-x64-gnu',
                'macos-arm64',
                'windows-x64-msvc',
                'android-arm64-v8a',
                'android-x86_64',
                'ios-xcframework',
              ].map(
                (target) =>
                  `liboliphaunt-${VERSION}-${target}.${target.startsWith('windows') ? 'zip' : 'tar.gz'}`,
              ),
              `liboliphaunt-${VERSION}-apple-spm-xcframework.zip`,
              `liboliphaunt-${VERSION}-runtime-resources-ios-datum64.tar.gz`,
              `liboliphaunt-${VERSION}-runtime-resources-android-datum64.tar.gz`,
              `liboliphaunt-${VERSION}-release-assets.sha256`,
            ];
      for (const name of runtimeNames) bytes.set(name, Buffer.from('historical runtime bytes\n'));
    }
    return {
      product,
      stem,
      payloadName,
      assets: [...bytes].map(([name, value], index) => ({
        id: index + 1,
        name,
        size: value.length,
        url: `${API}/releases/assets/${index + 1}`,
      })),
      bytes: Object.fromEntries(
        [...bytes].map(([name, value]) => [name, value.toString('base64')]),
      ),
    };
  }

  async function verify(value) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-public-assets-test.'));
    try {
      const file = path.join(scratch, 'fixture.json');
      const tags = path.join(scratch, 'tags');
      writeFileSync(file, JSON.stringify(value));
      writeFileSync(
        tags,
        `${value.product}-v${VERSION}\0${value.contrib === false ? 'false' : 'true'}\0`,
      );
      const child = Bun.spawn([process.execPath, import.meta.filename, '--verify-fixture', file], {
        env: isolatedGitHubTestEnvironment({ RELEASE_TAG_CONTRIB: tags }),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { status, output: stdout + stderr };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  for (const product of [
    'liboliphaunt-wasix',
    'liboliphaunt-native',
    'oliphaunt-extension-pgtap',
  ]) {
    test(`${product} verifies an older public release without staged artifacts or current member metadata`, async () => {
      const result = await verify(fixture(product));
      expect(result.output).toContain('GitHub release assets verified');
      expect(result.status).toBe(0);
    });
  }

  test('candidate checks still require the staged manifest', async () => {
    const result = await verify({ ...fixture('liboliphaunt-wasix'), staged: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('failed to read target/extension-artifacts');
  });

  test('runtime releases predating contrib ownership do not require extension artifacts', async () => {
    const row = fixture('liboliphaunt-wasix');
    row.contrib = false;
    row.assets = row.assets.filter((asset) => !asset.name.startsWith(CONTRIB));
    const result = await verify(row);
    expect(result.output).toContain('GitHub release assets verified');
    expect(result.status).toBe(0);
  });

  function changeManifest(row, change) {
    const name = `${row.stem}-manifest.json`;
    const manifest = JSON.parse(Buffer.from(row.bytes[name], 'base64').toString());
    change(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    row.bytes[name] = bytes.toString('base64');
    row.assets.find((asset) => asset.name === name).size = bytes.length;
  }

  for (const [scenario, mutate, error] of [
    [
      'draft dependency',
      (row) => {
        row.draft = true;
      },
      'must be published and stable',
    ],
    [
      'missing payload',
      (row) => {
        row.assets = row.assets.filter((asset) => asset.name !== row.payloadName);
      },
      'missing checksum-covered asset',
    ],
    [
      'unexpected asset',
      (row) => {
        row.assets.push({ name: 'foreign.bin', size: 1, url: `${API}/releases/assets/999` });
      },
      'asset set mismatch',
    ],
    [
      'changed payload bytes',
      (row) => {
        row.bytes[row.payloadName] = Buffer.from(
          'tampered historical extension payload!!\n',
        ).toString('base64');
      },
      'failed to verify GitHub asset',
    ],
    [
      'same-size payload corruption',
      (row) => {
        const bytes = Buffer.from(row.bytes[row.payloadName], 'base64');
        bytes[0] ^= 1;
        row.bytes[row.payloadName] = bytes.toString('base64');
      },
      'checksum mismatch',
    ],
    [
      'wrong version',
      (row) =>
        changeManifest(row, (manifest) => {
          manifest.version = '9.9.9';
        }),
      'version differs from requested release identity',
    ],
    [
      'wrong runtime owner',
      (row) =>
        changeManifest(row, (manifest) => {
          manifest.releaseProduct = 'liboliphaunt-native';
        }),
      'releaseProduct differs from requested release identity',
    ],
    [
      'mismatched runtime pin',
      (row) =>
        changeManifest(row, (manifest) => {
          manifest.compatibility.wasixRuntimeVersion = '9.9.9';
        }),
      'compatibility differs from its runtime owner version',
    ],
  ]) {
    test(`public dependency verification rejects ${scenario}`, async () => {
      const row = fixture('liboliphaunt-wasix');
      mutate(row);
      const result = await verify(row);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(error);
    });
  }
}
