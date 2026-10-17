import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import {
  elfFixture,
  machoFixture,
  windowsPeFixture,
} from '../../../../tools/packaging/testdata/release-fixture-utils.mts';
import {
  packageWasixNapiCarrier,
  stageWasixNapiCarrier,
  WASIX_NAPI_BINARY,
  type WasixNapiStage,
} from './package-platform.mts';

const ROOT = path.resolve(import.meta.dir, '../../../..');
const notices = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md',
  'src/third-party/postgres/COPYRIGHT',
  'src/third-party/postgres/source.toml',
  'src/third-party/icu/LICENSE',
  'src/third-party/icu/source.toml',
  'src/third-party/openssl/LICENSE.txt',
  'src/third-party/openssl/source.toml',
];
const targets = [
  ['linux-x64-gnu', 'linux-x64-gnu', 'x86_64-unknown-linux-gnu', () => elfFixture()],
  [
    'linux-arm64-gnu',
    'linux-arm64-gnu',
    'aarch64-unknown-linux-gnu',
    () => elfFixture({ machine: 183 }),
  ],
  ['macos-arm64', 'darwin-arm64', 'aarch64-apple-darwin', () => machoFixture()],
  [
    'windows-x64-msvc',
    'win32-x64-msvc',
    'x86_64-pc-windows-msvc',
    () => windowsPeFixture({ imports: ['VCRUNTIME140.dll'] }),
  ],
] as const;

function fixture(root: string, row: (typeof targets)[number]): WasixNapiStage {
  const [target, directory, targetTriple, bytes] = row;
  const sourceRoot = path.join(root, 'source');
  for (const file of notices) {
    const output = path.join(sourceRoot, file);
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(ROOT, file), output);
  }
  const binary = path.join(root, WASIX_NAPI_BINARY);
  writeFileSync(binary, bytes());
  const manifest = JSON.parse(
    readFileSync(
      path.join(ROOT, 'src/wasix/node-addon/packages', directory, 'package.json'),
      'utf8',
    ),
  );
  manifest.oliphaunt.qualificationOnly = true;
  let windowsRuntimeSourceDirectory: string | undefined;
  if (target === 'windows-x64-msvc') {
    windowsRuntimeSourceDirectory = path.join(root, 'redist');
    mkdirSync(windowsRuntimeSourceDirectory);
    const runtime = windowsPeFixture();
    writeFileSync(path.join(windowsRuntimeSourceDirectory, 'vcruntime140.dll'), runtime);
    writeFileSync(
      path.join(windowsRuntimeSourceDirectory, 'windows-vc-runtime.sha256'),
      `${createHash('sha256').update(runtime).digest('hex')}  vcruntime140.dll\n`,
    );
  }
  return {
    target,
    manifest,
    binary,
    sourceRoot,
    readme: path.join(ROOT, 'src/wasix/node-addon/packages', directory, 'README.md'),
    packageStage: path.join(root, 'npm'),
    releaseStage: path.join(root, 'github'),
    windowsRuntimeSourceDirectory,
    provenance: {
      schema: 'oliphaunt-wasix-napi-provenance-v1',
      product: 'oliphaunt-wasix-napi',
      target,
      sourceSha: 'a'.repeat(40),
      artifactSourceSha: 'a'.repeat(40),
      build: {
        cargoProfile: 'release',
        incremental: false,
        codegenUnits: 1,
        lto: 'thin',
        strip: 'symbols',
        features: ['release'],
        targetTriple,
      },
      buildInputs: {
        schema: 'oliphaunt-wasix-napi-build-inputs-v1',
        target,
        targetTriple,
        inputs: { extensionArtifacts: [{ fixture: true }] },
      },
      binary: {
        filename: WASIX_NAPI_BINARY,
        sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      },
    },
  };
}

test('canonical four-platform envelopes share exact subjects, preserve qualification, and repeat deterministically', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-envelopes-'));
  try {
    for (const row of targets) {
      const directory = path.join(root, row[0]);
      mkdirSync(directory);
      const input = fixture(directory, row);
      const options = {
        ...input,
        tarballRoot: path.join(directory, 'packages'),
        releaseArchive: path.join(
          directory,
          `addon.${row[0] === 'windows-x64-msvc' ? 'zip' : 'tar.gz'}`,
        ),
      };
      const outputs = await packageWasixNapiCarrier(options);
      const npm = readPortableArchiveEntries(outputs.npm);
      const github = readPortableArchiveEntries(outputs.github);
      const bytes = (entries: typeof npm, member: string) =>
        Buffer.from(entries.get(member)!.data());
      assert.deepEqual(
        bytes(npm, `package/prebuilds/${WASIX_NAPI_BINARY}`),
        bytes(github, WASIX_NAPI_BINARY),
      );
      assert.deepEqual(
        bytes(npm, 'package/artifact-provenance.json'),
        bytes(github, 'artifact-provenance.json'),
      );
      assert.equal(
        JSON.parse(bytes(npm, 'package/package.json').toString()).oliphaunt.qualificationOnly,
        true,
      );
      assert(![...npm.keys()].some((member) => member.includes('Cargo.lock')));
      const before = [readFileSync(outputs.npm), readFileSync(outputs.github)];
      await packageWasixNapiCarrier(options);
      assert.deepEqual([readFileSync(outputs.npm), readFileSync(outputs.github)], before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging rejects changed binary subjects and unsafe output overlap before deleting inputs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-inputs-'));
  try {
    const input = fixture(root, targets[0]);
    await assert.rejects(
      stageWasixNapiCarrier({
        ...input,
        provenance: {
          ...input.provenance,
          binary: { filename: WASIX_NAPI_BINARY, sha256: '0'.repeat(64) },
        },
      }),
      /provenance differs/,
    );
    await assert.rejects(
      stageWasixNapiCarrier({ ...input, packageStage: root }),
      /distinct from source/,
    );
    assert(readFileSync(input.binary).length > 0);
    const linked = path.join(root, 'linked.node');
    symlinkSync(input.binary, linked);
    await assert.rejects(stageWasixNapiCarrier({ ...input, binary: linked }), /regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
