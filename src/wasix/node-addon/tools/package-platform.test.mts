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
  AOT_PACKAGES,
  EXTENSION_AOT_PACKAGE_SUFFIXES,
} from '../../runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  assertWasixNapiConstructionData,
  WASIX_NAPI_SOURCE_PATCH_MEMBER,
} from './carrier-contract.mts';
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

function constructionFixture(input: WasixNapiStage, version = 3): WasixNapiStage {
  const targetTriple = input.provenance.build.targetTriple;
  const runtimeVersion = input.manifest.oliphaunt.runtimeVersion;
  const sdkVersion = '9.8.7';
  const sqlNames = ['cube', 'pg_trgm'];
  const product = 'oliphaunt-extension-contrib-pg18';
  const identity = (file: string) => ({
    path: file,
    sha256: createHash('sha256').update(file).digest('hex'),
    size: Buffer.byteLength(file),
  });
  const cargoLock = identity('Cargo.lock');
  const sourcePatch = { ...identity(WASIX_NAPI_SOURCE_PATCH_MEMBER) };
  const files = [
    identity('portable/bin/initdb.wasix.wasm'),
    identity(`extensions/${product}/extension-artifacts.json`),
    identity('layout.json'),
  ];
  const file = (member: string) => {
    const row = identity(member);
    files.push(row);
    return row;
  };
  const dependencies: any[] = [];
  const registry = (name: string, packageVersion: string, members: string[], patched = false) => {
    const rows = members.map((member) => identity(`registry/${name}-${packageVersion}/${member}`));
    dependencies.push({
      name,
      version: packageVersion,
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      checksum: identity(name).sha256,
      files: rows,
      ...(patched ? { patches: [sourcePatch] } : {}),
    });
    return (member: string) => rows.find((row) => row.path.endsWith(`/${member}`))!;
  };
  const sdk = version === 2 ? registry('oliphaunt-wasix', sdkVersion, ['Cargo.toml']) : undefined;
  const portable =
    version === 2
      ? registry(
          'liboliphaunt-wasix-portable',
          runtimeVersion,
          [
            'Cargo.toml',
            'build-support.rs',
            'payload/manifest.json',
            'payload/oliphaunt.wasix.tar.zst',
          ],
          true,
        )
      : undefined;
  const core =
    version === 2
      ? registry(
          AOT_PACKAGES[input.target],
          runtimeVersion,
          ['Cargo.toml', 'build-support.rs', 'artifacts/manifest.json'],
          true,
        )
      : undefined;
  const contrib =
    version === 2
      ? registry(`${product}-wasix`, runtimeVersion, [
          'Cargo.toml',
          ...sqlNames.map((sqlName) => `payload/files/extensions/${sqlName}/extension.tar.zst`),
        ])
      : undefined;
  const contribAot =
    version === 2
      ? registry(`${product}-aot-${EXTENSION_AOT_PACKAGE_SUFFIXES[targetTriple]}`, runtimeVersion, [
          'Cargo.toml',
          ...sqlNames.map((sqlName) => `manifests/${sqlName}.json`),
        ])
      : undefined;
  const inputs = {
    portableManifest: portable ? portable('payload/manifest.json') : file('portable/manifest.json'),
    runtimeArchive: portable
      ? portable('payload/oliphaunt.wasix.tar.zst')
      : file('portable/oliphaunt.wasix.tar.zst'),
    runtimeAotManifest: {
      targetTriple,
      ...(core ? core('artifacts/manifest.json') : file(`aot/${targetTriple}/manifest.json`)),
    },
    extensionArtifacts: [
      {
        product,
        portableArchives: sqlNames.map((sqlName) => ({
          sqlName,
          ...(contrib
            ? contrib(`payload/files/extensions/${sqlName}/extension.tar.zst`)
            : file(
                `extensions/${product}/member-assets/${sqlName}/${product}-${runtimeVersion}-wasix-portable.tar.zst`,
              )),
        })),
        aotManifests: sqlNames.map((sqlName) => ({
          sqlName,
          targetTriple,
          ...(contribAot
            ? contribAot(`manifests/${sqlName}.json`)
            : file(`extensions/${product}/wasix-aot/${input.target}/${sqlName}/manifest.json`)),
        })),
      },
    ],
  };
  const {
    sourceSha: _sourceSha,
    artifactSourceSha: _artifactSourceSha,
    ...provenance
  } = input.provenance;
  return {
    ...input,
    constructionContract: {
      targetTriple,
      runtimeVersion,
      sdkVersion,
      sqlNames,
      ...(sdk ? { sourcePatch } : {}),
    },
    provenance: {
      ...provenance,
      schema: `oliphaunt-wasix-napi-construction-data-v${version}`,
      buildInputs: {
        schema: `oliphaunt-wasix-napi-build-inputs-v${version}`,
        target: input.target,
        targetTriple,
        ...(sdk
          ? { cargoLock, dependencies }
          : {
              runtimeVersion,
              files: [...files].sort((left, right) =>
                left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
              ),
              sdk: { name: 'oliphaunt-wasix', version: sdkVersion },
            }),
        inputs,
      },
    },
  };
}

test('source construction inventories stage unchanged on all four hosts and retain v2 registry parsing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-source-envelopes-'));
  try {
    for (const row of targets) {
      const directory = path.join(root, row[0]);
      mkdirSync(directory);
      const input = constructionFixture(fixture(directory, row));
      await stageWasixNapiCarrier(input);
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(input.packageStage, 'artifact-provenance.json'), 'utf8')),
        input.provenance,
      );
      assert(!Object.hasOwn(input.provenance.buildInputs, 'dependencies'));
      assert(!Object.hasOwn(input.provenance.buildInputs, 'cargoLock'));
      assert(!input.provenance.buildInputs.files.some((file: any) => file.path === 'Cargo.lock'));
      assert.deepEqual(input.provenance.buildInputs.sdk, {
        name: 'oliphaunt-wasix',
        version: '9.8.7',
      });
      assert(
        !input.provenance.buildInputs.files.some(
          (file: any) => file.path === 'src/wasix/sdks/rust/Cargo.toml',
        ),
      );
      assert(!Object.hasOwn(input.constructionContract!, 'sourcePatch'));
      const legacy = constructionFixture(input, 2);
      await stageWasixNapiCarrier(legacy);
      assert.deepEqual(
        JSON.parse(
          readFileSync(path.join(legacy.releaseStage, 'artifact-provenance.json'), 'utf8'),
        ),
        legacy.provenance,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source construction rejects unbound files, wrong versions and incomplete release inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-source-contract-'));
  try {
    const input = constructionFixture(fixture(root, targets[0]));
    const verify = (provenance: any, contract = input.constructionContract!) =>
      assertWasixNapiConstructionData(
        provenance,
        input.target,
        input.provenance.binary.sha256,
        contract,
      );
    verify(input.provenance);
    for (const mutate of [
      (value: any) => {
        value.schema = 'oliphaunt-wasix-napi-construction-data-v2';
      },
      (value: any) => {
        value.buildInputs.schema = 'oliphaunt-wasix-napi-build-inputs-v2';
      },
      (value: any) => {
        value.buildInputs.dependencies = [];
      },
      (value: any) => {
        value.sourcePatch = {};
      },
      (value: any) => {
        value.buildInputs.sourcePatch = {};
      },
      (value: any) => {
        value.scope = 'release';
      },
      (value: any) => {
        value.sourceSha = 'a'.repeat(40);
      },
      (value: any) => {
        value.artifactSourceSha = 'a'.repeat(40);
      },
      (value: any) => {
        value.binary.sha256 = '0'.repeat(64);
      },
      (value: any) => {
        value.buildInputs.runtimeVersion = '0.0.1';
      },
      (value: any) => {
        value.buildInputs.sdk.name = 'foreign-sdk';
      },
      (value: any) => {
        value.buildInputs.sdk.version = '0.0.1';
      },
      (value: any) => {
        value.buildInputs.sdk.cargoManifest = {
          path: 'src/wasix/sdks/rust/Cargo.toml',
          sha256: '0'.repeat(64),
          size: 1,
        };
      },
      (value: any) => {
        value.buildInputs.cargoLock = {
          path: 'Cargo.lock',
          sha256: '0'.repeat(64),
          size: 1,
        };
      },
      (value: any) => {
        value.buildInputs.files = [];
      },
      (value: any) => {
        value.buildInputs.files.push(value.buildInputs.files[0]);
      },
      (value: any) => {
        value.buildInputs.files.reverse();
      },
      (value: any) => {
        value.buildInputs.files[2].path = '../escape';
      },
      (value: any) => {
        value.buildInputs.files[2].path = 'C:/escape';
      },
      (value: any) => {
        value.buildInputs.files[2].sha256 = 'invalid';
      },
      (value: any) => {
        value.buildInputs.files[2].size = -1;
      },
      (value: any) => {
        value.buildInputs.files.unshift({ path: 'Cargo.lock', sha256: '0'.repeat(64), size: 1 });
      },
      (value: any) => {
        value.buildInputs.files.push({
          path: 'src/wasix/sdks/rust/Cargo.toml',
          sha256: '0'.repeat(64),
          size: 1,
        });
      },
      (value: any) => {
        value.buildInputs.files = value.buildInputs.files.filter(
          (file: any) => file.path !== 'layout.json',
        );
      },
      (value: any) => {
        value.buildInputs.files = value.buildInputs.files.filter(
          (file: any) => file.path !== 'portable/bin/initdb.wasix.wasm',
        );
      },
      (value: any) => {
        value.buildInputs.files = value.buildInputs.files.filter(
          (file: any) =>
            file.path !== 'extensions/oliphaunt-extension-contrib-pg18/extension-artifacts.json',
        );
      },
      (value: any) => {
        value.buildInputs.inputs.runtimeArchive.sha256 = '0'.repeat(64);
      },
      (value: any) => {
        value.buildInputs.inputs.runtimeAotManifest.targetTriple = 'aarch64-apple-darwin';
      },
      (value: any) => {
        value.buildInputs.inputs.extensionArtifacts[0].portableArchives.pop();
      },
      (value: any) => {
        value.buildInputs.inputs.extensionArtifacts[0].portableArchives.push(
          value.buildInputs.inputs.extensionArtifacts[0].portableArchives[0],
        );
      },
      (value: any) => {
        value.buildInputs.inputs.extensionArtifacts[0].aotManifests.pop();
      },
      (value: any) => {
        value.buildInputs.inputs.extensionArtifacts[0].aotManifests[0].targetTriple =
          'aarch64-apple-darwin';
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(input.provenance));
      mutate(changed);
      assert.throws(() => verify(changed));
    }
    const legacy = constructionFixture(input, 2);
    verify(legacy.provenance, legacy.constructionContract!);
    const locklessLegacy = JSON.parse(JSON.stringify(legacy.provenance));
    delete locklessLegacy.buildInputs.cargoLock;
    assert.throws(() => verify(locklessLegacy, legacy.constructionContract!));
    legacy.provenance.buildInputs.schema = 'oliphaunt-wasix-napi-build-inputs-v3';
    assert.throws(() => verify(legacy.provenance, legacy.constructionContract!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
import './workspace-runtime-contract.test.mts';
