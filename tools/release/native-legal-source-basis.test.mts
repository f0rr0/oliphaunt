import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildIosCarrierManifest } from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import {
  createCapturedPublishedNativeLegalSourceBasis,
  createPublishedNativeLegalSourceBasis,
  currentNativeLegalSourceBasis,
  nativeBaseLegalForSource,
} from '../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import { pinnedNativeCarrierDirectory } from '../../src/native/sdks/swift/tools/pinned-native-carrier.mts';
import { IOS_CARRIER_SCHEMA } from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import { validateSwiftSourceReleaseContract } from '../../src/native/sdks/swift/tools/swift-source-carrier-contract.mts';
import { archiveDirectory } from '../packaging/archive-directory.mts';
import { currentProductVersionSync } from './release-artifact-targets.mts';

function fixture({ nativeVersion = '2.3.4' } = {}) {
  const swiftVersion = '4.5.6';
  const nativeSha = 'a'.repeat(40);
  const swiftSha = 'b'.repeat(40);
  const sourceSha = 'c'.repeat(40);
  const groups = [
    { role: 'base-xcframework', profile: 'native-runtime', prefix: 'liboliphaunt.xcframework/' },
    { role: 'runtime-resources', profile: 'native-runtime-resources', prefix: '' },
  ];
  const carrier = {
    schema: IOS_CARRIER_SCHEMA,
    base: {
      product: 'liboliphaunt-native',
      version: nativeVersion,
      tag: `liboliphaunt-native-v${nativeVersion}`,
      assets: groups.map(({ role }, index) => {
        const name = `liboliphaunt-${nativeVersion}-${index ? 'runtime-resources-ios-datum64.tar.gz' : 'apple-spm-xcframework.zip'}`;
        return {
          role,
          name,
          url: `https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v${nativeVersion}/${name}`,
          sha256: createHash('sha256').update(name).digest('hex'),
          bytes: Buffer.byteLength(name),
          format: index ? 'tar.gz' : 'zip',
          member: index ? 'oliphaunt' : 'liboliphaunt.xcframework',
        };
      }),
    },
    carriers: [],
    extensions: [],
    legal: {
      base: groups.map(({ role, profile, prefix }) => ({
        assetRole: role,
        profile,
        spdx: 'MIT AND Historical-License',
        files: [
          { kind: 'license', member: `${prefix}LICENSE`, sha256: '3'.repeat(64), bytes: 29 },
          {
            kind: 'notice',
            member: `${prefix}THIRD_PARTY_NOTICES.historical.md`,
            sha256: '4'.repeat(64),
            bytes: 37,
          },
        ],
      })),
      extensions: [],
    },
  };
  const bytes = Buffer.from(JSON.stringify(carrier));
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const sourceMember = 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json';
  const responses = new Map<string, any>([
    [
      `repos/f0rr0/oliphaunt/releases/tags/liboliphaunt-native-v${nativeVersion}`,
      {
        id: 1,
        tag_name: `liboliphaunt-native-v${nativeVersion}`,
        draft: false,
        prerelease: false,
        target_commitish: nativeSha,
      },
    ],
    [
      `repos/f0rr0/oliphaunt/releases/tags/oliphaunt-swift-v${swiftVersion}`,
      {
        id: 2,
        tag_name: `oliphaunt-swift-v${swiftVersion}`,
        draft: false,
        prerelease: false,
        target_commitish: swiftSha,
      },
    ],
    [
      `repos/f0rr0/oliphaunt/git/ref/tags/${swiftVersion}`,
      { ref: `refs/tags/${swiftVersion}`, object: { type: 'commit', sha: sourceSha } },
    ],
    [
      `repos/f0rr0/oliphaunt/git/commits/${sourceSha}`,
      { sha: sourceSha, tree: { sha: 'd'.repeat(40) }, parents: [{ sha: swiftSha }] },
    ],
    [
      `repos/f0rr0/oliphaunt/contents/${sourceMember}?ref=${sourceSha}`,
      {
        path: sourceMember,
        type: 'file',
        encoding: 'base64',
        sha: blob,
        content: bytes.toString('base64'),
      },
    ],
  ]);
  const assets = carrier.base.assets.map((asset, index) => ({
    id: index + 10,
    name: asset.name,
    browser_download_url: asset.url,
    digest: `sha256:${asset.sha256}`,
    size: asset.bytes,
  }));
  const completed = [];
  const options = {
    nativeVersion,
    swiftVersion,
    readJson: async (endpoint) => {
      assert.ok(responses.has(endpoint), endpoint);
      return responses.get(endpoint);
    },
    readPages: async (endpoint) => {
      assert.equal(endpoint, 'repos/f0rr0/oliphaunt/releases/1/assets');
      return assets;
    },
    assertCompletedPublication: async (identity) => {
      completed.push(identity);
      return { ...identity, publicationTree: 'e'.repeat(40), releaseSha: 'f'.repeat(40) };
    },
  };
  const captures = {
    publication: {
      product: 'liboliphaunt-native',
      version: nativeVersion,
      tagName: `liboliphaunt-native-v${nativeVersion}`,
      publicationSha: nativeSha,
      publicationTree: 'e'.repeat(40),
      releaseSha: 'f'.repeat(40),
    },
    nativeRelease: responses.get(
      `repos/f0rr0/oliphaunt/releases/tags/liboliphaunt-native-v${nativeVersion}`,
    ),
    sourcePublication: {
      product: 'oliphaunt-swift',
      version: swiftVersion,
      tagName: `oliphaunt-swift-v${swiftVersion}`,
      publicationSha: swiftSha,
      publicationTree: 'e'.repeat(40),
      releaseSha: 'f'.repeat(40),
    },
    sourceReference: responses.get(`repos/f0rr0/oliphaunt/git/ref/tags/${swiftVersion}`),
    sourceCommit: responses.get(`repos/f0rr0/oliphaunt/git/commits/${sourceSha}`),
    carrierContents: responses.get(
      `repos/f0rr0/oliphaunt/contents/${sourceMember}?ref=${sourceSha}`,
    ),
    nativeAssets: assets,
  };
  return { carrier, responses, assets, completed, options, sourceSha, captures };
}

test('declared independently verified captures bind the same historical package contract offline', () => {
  const { carrier, captures } = fixture();
  const sourceBasis = createCapturedPublishedNativeLegalSourceBasis(captures);
  const asset = carrier.base.assets[0];
  const inputs = {
    carrier,
    expectedNativeVersion: carrier.base.version,
    manifestText: `.binaryTarget(name: "liboliphaunt", url: "${asset.url}", checksum: "${asset.sha256}")`,
  };
  assert.throws(
    () => validateSwiftSourceReleaseContract(inputs),
    /canonical native Apple legal locators/,
  );
  assert.deepEqual(validateSwiftSourceReleaseContract({ ...inputs, sourceBasis }).carrier, carrier);
  const changed = structuredClone(carrier);
  changed.legal.base[0].files[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => validateSwiftSourceReleaseContract({ ...inputs, carrier: changed, sourceBasis }),
    /canonical native Apple legal locators/,
  );
  captures.nativeRelease.target_commitish = '0'.repeat(40);
  assert.throws(
    () => createCapturedPublishedNativeLegalSourceBasis(captures),
    /completion differs/,
  );
});

test('historical source policy survives later legal changes and same-version fresh construction', async () => {
  const { carrier, options, completed } = fixture();
  const basis = await createPublishedNativeLegalSourceBasis(options);
  assert.equal(completed.length, 2);
  assert.deepEqual(
    nativeBaseLegalForSource({
      base: carrier.base,
      sourceBasis: basis,
      currentLegal: () => {
        throw new Error('current source must not reinterpret historical policy');
      },
    }),
    carrier.legal.base,
  );
  const fresh = [{ assetRole: 'base-xcframework', files: ['future legal source'] }];
  assert.deepEqual(
    nativeBaseLegalForSource({
      base: carrier.base,
      sourceBasis: currentNativeLegalSourceBasis,
      currentLegal: () => fresh,
    }),
    fresh,
  );
  const changed = structuredClone(carrier.base);
  changed.assets[0].sha256 = '9'.repeat(64);
  assert.throws(
    () =>
      nativeBaseLegalForSource({ base: changed, sourceBasis: basis, currentLegal: () => fresh }),
    /differs from the authenticated publication/,
  );
  assert.throws(
    () =>
      nativeBaseLegalForSource({
        base: carrier.base,
        sourceBasis: JSON.parse(JSON.stringify(basis)),
        currentLegal: () => fresh,
      }),
    /authenticated published source basis/,
  );
  const legal = nativeBaseLegalForSource({
    base: carrier.base,
    sourceBasis: basis,
    currentLegal: () => fresh,
  });
  legal[0].files[0].sha256 = '0'.repeat(64);
  assert.deepEqual(
    nativeBaseLegalForSource({ base: carrier.base, sourceBasis: basis, currentLegal: () => fresh }),
    carrier.legal.base,
  );
});

test('held source requires exact completion, source parent, Git blob and native asset identities', async () => {
  const completion = fixture();
  completion.options.assertCompletedPublication = async (identity) => ({
    ...identity,
    publicationSha: '0'.repeat(40),
    publicationTree: 'e'.repeat(40),
    releaseSha: 'f'.repeat(40),
  });
  await assert.rejects(
    createPublishedNativeLegalSourceBasis(completion.options),
    /completion differs/,
  );
  const parent = fixture();
  parent.responses.get(`repos/f0rr0/oliphaunt/git/commits/${parent.sourceSha}`).parents[0].sha =
    '0'.repeat(40);
  await assert.rejects(createPublishedNativeLegalSourceBasis(parent.options), /publication parent/);
  const blob = fixture();
  const contents = [...blob.responses.values()].find((row) => row.encoding === 'base64');
  contents.content = Buffer.from('{}').toString('base64');
  await assert.rejects(createPublishedNativeLegalSourceBasis(blob.options), /immutable Git blob/);
  const asset = fixture();
  asset.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    createPublishedNativeLegalSourceBasis(asset.options),
    /asset differs from immutable source/,
  );
  const repeated = fixture();
  repeated.assets[1].id = repeated.assets[0].id;
  await assert.rejects(
    createPublishedNativeLegalSourceBasis(repeated.options),
    /repeats an asset identity/,
  );
});

test('explicit held origin downloads published bytes for the same version as changed current source', async () => {
  const version = currentProductVersionSync(
    'liboliphaunt-native',
    'native-legal-source-basis.test',
  );
  const { carrier, options } = fixture({ nativeVersion: version });
  const sourceBasis = await createPublishedNativeLegalSourceBasis(options);
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'published-native-carrier-'));
  let downloads = 0;
  let corrupt = false;
  const fetchImpl = async (input) => {
    const row = carrier.base.assets.find((asset) => asset.url === String(input));
    assert.ok(row, String(input));
    downloads += 1;
    const response = new Response(corrupt ? 'x'.repeat(row.bytes) : row.name);
    Object.defineProperty(response, 'url', { value: row.url });
    return response;
  };
  try {
    const inputs = {
      version: carrier.base.version,
      sourceBasis,
      assetDir: '/different-current-source',
      workRoot,
      fetchImpl,
    };
    assert.equal(
      await pinnedNativeCarrierDirectory({ ...inputs, sourceBasis: currentNativeLegalSourceBasis }),
      '/different-current-source',
    );
    const directory = await pinnedNativeCarrierDirectory(inputs);
    for (const asset of carrier.base.assets)
      assert.equal(readFileSync(path.join(directory, asset.name), 'utf8'), asset.name);
    assert.equal(downloads, 2);
    await pinnedNativeCarrierDirectory(inputs);
    assert.equal(downloads, 2);
    rmSync(path.join(workRoot, 'pinned-native-carrier-cache'), { recursive: true });
    corrupt = true;
    await assert.rejects(pinnedNativeCarrierDirectory(inputs), /checksum mismatch/);
    await assert.rejects(
      pinnedNativeCarrierDirectory({ ...inputs, version: '2.3.5' }),
      /does not bind runtime/,
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('held construction preserves historical member names while enforcing physical legal bytes and modes', async () => {
  const { carrier, captures } = fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'held-native-legal-members-'));
  const legalBytes = {
    LICENSE: Buffer.from('independent historical license\n'),
    'THIRD_PARTY_NOTICES.historical.md': Buffer.from('historical notice before source changes\n'),
  };
  const updateCapture = () => {
    for (const [index, asset] of carrier.base.assets.entries()) {
      const bytes = readFileSync(path.join(directory, asset.name));
      asset.sha256 = createHash('sha256').update(bytes).digest('hex');
      asset.bytes = bytes.length;
      captures.nativeAssets[index].digest = `sha256:${asset.sha256}`;
      captures.nativeAssets[index].size = asset.bytes;
    }
    const bytes = Buffer.from(JSON.stringify(carrier));
    captures.carrierContents.content = bytes.toString('base64');
    captures.carrierContents.sha = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    return createCapturedPublishedNativeLegalSourceBasis(captures);
  };
  try {
    for (const [index, group] of carrier.legal.base.entries()) {
      const staging = path.join(directory, `staging-${index}`);
      const root = index ? staging : path.join(staging, 'liboliphaunt.xcframework');
      mkdirSync(path.join(staging, index ? 'oliphaunt' : 'liboliphaunt.xcframework'), {
        recursive: true,
      });
      writeFileSync(
        path.join(staging, index ? 'oliphaunt/payload' : 'liboliphaunt.xcframework/payload'),
        'runtime fixture\n',
      );
      for (const file of group.files) {
        const bytes = legalBytes[path.posix.basename(file.member)];
        const output = path.join(staging, file.member);
        writeFileSync(output, bytes);
        chmodSync(output, 0o644);
        file.sha256 = createHash('sha256').update(bytes).digest('hex');
        file.bytes = bytes.length;
      }
      await archiveDirectory(root, path.join(directory, carrier.base.assets[index].name), {
        keepParent: index === 0,
      });
    }
    const options = {
      baseAssetDir: directory,
      baseRuntimeVersion: carrier.base.version,
      extensionManifests: [],
    };
    assert.throws(
      () => buildIosCarrierManifest(options),
      /canonical SHA-256|missing regular legal file/,
    );
    const baseSourceBasis = updateCapture();
    assert.deepEqual(buildIosCarrierManifest({ ...options, baseSourceBasis }), carrier);
    chmodSync(path.join(directory, 'staging-1/LICENSE'), 0o755);
    await archiveDirectory(
      path.join(directory, 'staging-1'),
      path.join(directory, carrier.base.assets[1].name),
      { keepParent: false },
    );
    assert.throws(
      () => buildIosCarrierManifest({ ...options, baseSourceBasis: updateCapture() }),
      /mode 0644/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
