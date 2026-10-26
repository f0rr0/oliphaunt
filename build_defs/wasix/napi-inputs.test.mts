import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWasixNapiConstructionData } from '../../src/wasix/node-addon/tools/carrier-contract.mts';
import { canonicalWasixAotMetadata } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_CFGS,
  AOT_TARGET_TRIPLES,
  CORE_AOT_ARTIFACTS,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { tarHeader } from '../../tools/packaging/archive-directory.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../tools/packaging/portable-archive.mts';
import {
  elfFixture,
  machoFixture,
  windowsPeFixture,
} from '../../tools/packaging/testdata/release-fixture-utils.mts';
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  windowsVcRuntimeProfileNames,
} from '../../tools/packaging/windows-vc-runtime-closure.mts';
import { packageNativeWasixNapi } from './napi.mts';
import { stageWasixNapiInputs, type WasixNapiInputsSpec } from './napi-inputs.mts';

const PRODUCT = 'oliphaunt-extension-contrib-pg18';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function tar(files: Record<string, Uint8Array>) {
  return Buffer.concat([
    ...Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([name, bytes]) => [
        tarHeader({ name, isDirectory: false }, bytes.length, 0o644),
        bytes,
        Buffer.alloc((512 - (bytes.length % 512)) % 512),
      ]),
    Buffer.alloc(1024),
  ]);
}
function releaseSqlNames() {
  const catalog = JSON.parse(
    readFileSync('src/extensions/generated/extensions.catalog.json', 'utf8'),
  ).extensions;
  const release = Bun.TOML.parse(readFileSync('src/wasix/node-addon/Cargo.toml', 'utf8')).features
    .release;
  const names = release
    .filter((feature: string) => feature.startsWith('extension-'))
    .map((feature: string) => {
      const matches = catalog.filter(
        (row: any) => `extension-${row['sql-name'].replaceAll('_', '-')}` === feature,
      );
      assert.equal(matches.length, 1);
      return matches[0]['sql-name'];
    });
  assert.equal(names.length, 32);
  return names.sort();
}
function fixture(
  root: string,
  target = 'linux-x64-gnu',
  sqlNames = releaseSqlNames(),
  sdkVersion = '0.3.2',
  runtimeVersion = '0.3.2',
): WasixNapiInputsSpec {
  const targetTriple = AOT_TARGET_TRIPLES[target];
  const input = path.join(root, 'inputs');
  mkdirSync(input, { recursive: true });
  const write = (name: string, bytes: Uint8Array | string) => {
    const file = path.join(input, name);
    writeFileSync(file, bytes);
    return file;
  };
  const crate = (name: string, files: Record<string, Uint8Array>) =>
    write(
      `${name}-${runtimeVersion}.crate`,
      canonicalGzipSync(
        tar(
          Object.fromEntries(
            Object.entries({
              'Cargo.toml': Buffer.from(
                `[package]\nname=${JSON.stringify(name)}\nversion=${JSON.stringify(runtimeVersion)}\n`,
              ),
              ...files,
            }).map(([member, bytes]) => [`${name}-${runtimeVersion}/${member}`, bytes]),
          ),
        ),
      ),
    );
  const fingerprint = 'current source-qualified fixture';
  const canonical = canonicalWasixAotMetadata(undefined, targetTriple);
  const manifest = (artifacts: any[]) =>
    Buffer.from(
      JSON.stringify({
        'format-version': 1,
        'source-lane': canonical.sourceLane,
        engine: canonical.engine,
        'wasmer-version': canonical.wasmerVersion,
        'wasmer-wasix-version': canonical.wasmerWasixVersion,
        'target-triple': targetTriple,
        'source-fingerprint': fingerprint,
        artifacts,
      }),
    );
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const runtime = releaseZstdCompressSync(
    tar({
      'oliphaunt/bin/postgres': wasm,
      'oliphaunt/bin/initdb': wasm,
    }),
  );
  const portableArchive = crate('liboliphaunt-wasix-portable', {
    'payload/manifest.json': Buffer.from(
      JSON.stringify({
        'format-version': 2,
        'source-fingerprint': fingerprint,
        extensions: [],
        runtime: {
          archive: 'oliphaunt.wasix.tar.zst',
          sha256: digest(runtime),
          size: runtime.length,
          'module-sha256': digest(wasm),
        },
      }),
    ),
    'payload/oliphaunt.wasix.tar.zst': runtime,
    'payload/bin/initdb.wasix.wasm': wasm,
  });
  const artifact = (name: string, member: string, raw: Buffer, moduleSha = digest(wasm)) => {
    const bytes = releaseZstdCompressSync(raw);
    return {
      bytes,
      row: {
        name,
        path: member,
        sha256: digest(bytes),
        'raw-sha256': digest(raw),
        'raw-size': raw.length,
        'module-sha256': moduleSha,
        compressed: true,
      },
    };
  };
  const core = CORE_AOT_ARTIFACTS.map((name, i) =>
    artifact(name, `core-${i}-llvm-opta.bin.zst`, Buffer.from(`current core ${name}`)),
  );
  const coreAotArchive = crate(AOT_PACKAGES[target], {
    'artifacts/manifest.json': manifest(core.map(({ row }) => row)),
    ...Object.fromEntries(core.map(({ row, bytes }) => [`artifacts/${row.path}`, bytes])),
  });
  const portableFiles: Record<string, Uint8Array> = {};
  const aotFiles: Record<string, Uint8Array> = {};
  const extensions = sqlNames.map((sqlName, i) => {
    const moduleNames = i === 0 ? [sqlName, `${sqlName}_helper`] : [sqlName];
    const nativeModules = moduleNames.map((name) => ({
      name,
      moduleSha256: digest(`portable module ${name}`),
    }));
    const portable = releaseZstdCompressSync(
      tar({
        [`share/postgresql/extension/${sqlName}.control`]: Buffer.from("default_version = '1.0'\n"),
        ...Object.fromEntries(moduleNames.map((name) => [`lib/postgresql/${name}.so`, wasm])),
      }),
    );
    portableFiles[`payload/files/extensions/${sqlName}/extension.tar.zst`] = portable;
    const artifacts = nativeModules.map(({ name, moduleSha256 }) =>
      artifact(
        `extension:${sqlName}${name === sqlName ? '' : `:${name}`}`,
        `${name}-llvm-opta.bin.zst`,
        Buffer.from(`current extension ${name}`),
        moduleSha256,
      ),
    );
    aotFiles[`manifests/${sqlName}.json`] = manifest(artifacts.map(({ row }) => row));
    for (const { row, bytes } of artifacts)
      aotFiles[`payload/files/extensions/${sqlName}/${row.path}`] = bytes;
    return {
      sqlName,
      nativeModuleStem: sqlName,
      wasixInstall: { nativeModules },
      assets: [
        {
          name: `${PRODUCT}-${runtimeVersion}-${sqlName}-wasix-portable.tar.zst`,
          target: 'wasix-portable',
          family: 'wasix',
          kind: 'wasix-runtime',
          sha256: digest(portable),
          bytes: portable.length,
        },
      ],
    };
  });
  return {
    target,
    targetTriple,
    runtimeVersion,
    sdkVersion,
    sqlNames,
    portableArchive,
    coreAotArchive,
    contribPortable: crate(wasixExtensionPackageName(PRODUCT), portableFiles),
    contribAot: crate(wasixExtensionAotPackageName(PRODUCT, targetTriple), aotFiles),
    contribFrozen: write(
      'extension-artifacts.json',
      JSON.stringify({
        schema: 'oliphaunt-extension-ci-artifacts-v2',
        product: PRODUCT,
        version: runtimeVersion,
        compatibility: {
          wasixRuntimeProduct: 'liboliphaunt-wasix',
          wasixRuntimeVersion: runtimeVersion,
        },
        extensions,
      }),
    ),
    sdkManifest: write(
      'sdk-Cargo.toml',
      `[package]\nname="oliphaunt-wasix"\nversion=${JSON.stringify(sdkVersion)}\n[package.metadata.oliphaunt]\nruntime-version="0.3.2"\n[dependencies]\nliboliphaunt-wasix-portable = { version = "*", path = "../../runtime/crates/assets" }\n[target.${JSON.stringify(AOT_TARGET_CFGS[targetTriple])}.dependencies]\n${AOT_PACKAGES[target]} = { version = "*", path = "../../runtime/crates/aot/${targetTriple}" }\n`,
    ),
    output: path.join(root, 'output'),
  };
}
function rewriteCrate(file: string, change: (files: Record<string, Buffer>) => void) {
  const files = Object.fromEntries(
    [...readPortableArchiveEntries(file)]
      .filter(([, entry]) => entry.isFile)
      .map(([name, entry]) => [name, Buffer.from(entry.data())]),
  );
  change(files);
  writeFileSync(file, canonicalGzipSync(tar(files)));
}
function rewriteJson(files: Record<string, Buffer>, suffix: string, change: (value: any) => void) {
  const member = Object.keys(files).find((name) => name.endsWith(suffix));
  assert(member, `fixture missing ${suffix}`);
  const value = JSON.parse(files[member].toString());
  change(value);
  files[member] = Buffer.from(JSON.stringify(value));
}
function physicalFiles(root: string, prefix = ''): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix + entry.name;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) return physicalFiles(file, `${relative}/`);
      assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
      return [relative];
    })
    .sort();
}

test('current source Cargo, complete contrib and canonical carriers bind exactly on all supported hosts', async () => {
  for (const target of Object.keys(AOT_TARGET_TRIPLES)) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-source-'));
    try {
      const spec = fixture(root, target);
      const actual = stageWasixNapiInputs(spec);
      assert.equal(actual.runtimeVersion, spec.runtimeVersion);
      assert.equal(actual.inventory.schema, 'oliphaunt-wasix-napi-build-inputs-v3');
      assert.deepEqual(actual.inventory.sdk, { name: 'oliphaunt-wasix', version: spec.sdkVersion });
      assert.equal(actual.inventory.inputs.extensionArtifacts[0].portableArchives.length, 32);
      assert.equal(actual.inventory.inputs.extensionArtifacts[0].aotManifests.length, 32);
      assert(!Object.hasOwn(actual.inventory, 'dependencies'));
      assert(!Object.hasOwn(actual.inventory, 'sourcePatch'));
      assert(!Object.hasOwn(actual.inventory, 'cargoLock'));
      assert(!actual.inventory.files.some((row) => row.path === 'Cargo.lock'));
      assert(!actual.inventory.files.some((row) => row.path === 'src/wasix/sdks/rust/Cargo.toml'));
      assert.deepEqual(
        physicalFiles(spec.output).filter((name) => name !== 'build-inputs.json'),
        actual.inventory.files.map((row) => row.path),
      );
      for (const row of actual.inventory.files) {
        const bytes = readFileSync(path.join(spec.output, row.path));
        assert.equal(bytes.length, row.size);
        assert.equal(digest(bytes), row.sha256);
      }
      assert.deepEqual(
        readFileSync(path.join(spec.output, `extensions/${PRODUCT}/extension-artifacts.json`)),
        readFileSync(spec.contribFrozen),
      );
      const binarySha = digest('independently compiled addon');
      const provenance = {
        schema: 'oliphaunt-wasix-napi-construction-data-v3',
        product: 'oliphaunt-wasix-napi',
        target,
        build: {
          cargoProfile: 'release',
          incremental: false,
          codegenUnits: 1,
          lto: 'thin',
          strip: 'symbols',
          features: ['release'],
          targetTriple: spec.targetTriple,
        },
        buildInputs: actual.inventory,
        binary: { filename: 'oliphaunt_wasix_napi.node', sha256: binarySha },
      };
      const contract = {
        targetTriple: spec.targetTriple,
        sdkVersion: spec.sdkVersion,
        runtimeVersion: actual.runtimeVersion,
        sqlNames: spec.sqlNames,
      };
      assertWasixNapiConstructionData(provenance, target, binarySha, contract);
      for (const mutate of [
        (value: any) => {
          value.sourceSha = 'a'.repeat(40);
        },
        (value: any) => {
          value.build.features = [];
        },
        (value: any) => {
          value.buildInputs.inputs.runtimeArchive.sha256 = '0'.repeat(64);
        },
        (value: any) => {
          value.buildInputs.files.push(value.buildInputs.files[0]);
        },
        (value: any) => {
          value.buildInputs.files.reverse();
        },
        (value: any) => {
          value.buildInputs.sdk.version = '9.9.9';
        },
        (value: any) => {
          value.buildInputs.runtimeVersion = '9.9.9';
        },
        (value: any) => {
          value.buildInputs.inputs.extensionArtifacts[0].aotManifests.pop();
        },
        (value: any) => {
          value.scope = 'release';
        },
        (value: any) => {
          value.buildInputs.targetTriple = 'x86_64-unknown-other';
          value.build.targetTriple = value.buildInputs.targetTriple;
        },
        (value: any) => {
          value.buildInputs.inputs.extensionArtifacts[0].portableArchives.pop();
          value.buildInputs.inputs.extensionArtifacts[0].aotManifests.pop();
        },
      ]) {
        const changed = JSON.parse(JSON.stringify(provenance));
        mutate(changed);
        assert.throws(() => assertWasixNapiConstructionData(changed, target, binarySha, contract));
      }
      const reverse = stageWasixNapiInputs({
        ...spec,
        output: path.join(root, 'reverse'),
        sqlNames: [...spec.sqlNames].reverse(),
      });
      assert.deepEqual(reverse.inventory, actual.inventory);
      const rootPackage = 'src/wasix/node-addon/package.json';
      const product = JSON.parse(readFileSync(rootPackage, 'utf8'));
      const directory =
        target === 'macos-arm64'
          ? 'darwin-arm64'
          : target === 'windows-x64-msvc'
            ? 'win32-x64-msvc'
            : target;
      const manifestPath = `src/wasix/node-addon/packages/${directory}/package.json`;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const binary = path.join(root, 'compiled.node');
      writeFileSync(
        binary,
        target === 'macos-arm64'
          ? machoFixture()
          : target === 'windows-x64-msvc'
            ? windowsPeFixture({ imports: ['VCRUNTIME140.dll'] })
            : elfFixture({ machine: target === 'linux-arm64-gnu' ? 183 : 62 }),
      );
      const windowsRuntime: Record<string, string> = {};
      if (target === 'windows-x64-msvc') {
        const bytes = windowsPeFixture();
        for (const member of windowsVcRuntimeProfileNames('provider')) {
          const file = path.join(root, member);
          writeFileSync(file, bytes);
          windowsRuntime[member] = file;
        }
        assert(!Object.hasOwn(windowsRuntime, WINDOWS_VC_RUNTIME_RECEIPT));
      }
      const outputs = await packageNativeWasixNapi({
        target: target as any,
        version: product.version,
        sdkVersion: contract.sdkVersion,
        sqlNames: spec.sqlNames,
        binary,
        inputs: spec.output,
        manifest: manifestPath,
        productManifest: rootPackage,
        readme: `src/wasix/node-addon/packages/${directory}/README.md`,
        targetContract: {
          triple: spec.targetTriple,
          npm_package: manifest.name,
          npm_os: manifest.os[0],
          npm_cpu: manifest.cpu[0],
          npm_libc: manifest.libc?.[0],
        },
        windowsRuntime,
        notices: Object.fromEntries(
          [
            'LICENSE',
            'THIRD_PARTY_NOTICES.md',
            'src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md',
            'src/third-party/postgres/COPYRIGHT',
            'src/third-party/postgres/source.toml',
            'src/third-party/icu/LICENSE',
            'src/third-party/icu/source.toml',
            'src/third-party/openssl/LICENSE.txt',
            'src/third-party/openssl/source.toml',
          ].map((file) => [file, file]),
        ),
        outputs: {
          npm: path.join(root, 'addon.tgz'),
          github: path.join(root, target === 'windows-x64-msvc' ? 'addon.zip' : 'addon.tar.gz'),
          provenance: path.join(root, 'provenance.json'),
        },
      });
      const npm = readPortableArchiveEntries(outputs.npm);
      if (target === 'windows-x64-msvc') {
        const dll = readFileSync(windowsRuntime['vcruntime140.dll']);
        const receipt = `${digest(dll)}  vcruntime140.dll\n`;
        for (const [entries, prefix] of [
          [npm, 'package/prebuilds/'],
          [readPortableArchiveEntries(outputs.github), ''],
        ] as const) {
          const runtime = entries.get(`${prefix}vcruntime140.dll`);
          const manifest = entries.get(prefix + WINDOWS_VC_RUNTIME_RECEIPT);
          assert(runtime?.isFile && !runtime.isSymbolicLink);
          assert(manifest?.isFile && !manifest.isSymbolicLink);
          assert.deepEqual(Buffer.from(runtime.data()), dll);
          assert.equal(Buffer.from(manifest.data()).toString(), receipt);
          assert(!entries.has(`${prefix}msvcp140.dll`));
          assert(!entries.has(`${prefix}vcruntime140_1.dll`));
        }
      }
      const published = JSON.parse(
        Buffer.from(npm.get('package/artifact-provenance.json')!.data()).toString(),
      );
      assert.deepEqual(published.buildInputs, actual.inventory);
      assert(!Object.hasOwn(published, 'scope'));
      assert(
        !Object.hasOwn(
          JSON.parse(Buffer.from(npm.get('package/package.json')!.data()).toString()).oliphaunt,
          'qualificationOnly',
        ),
      );
      assertWasixNapiConstructionData(published, target, digest(readFileSync(binary)), contract);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('one, several and all selected contrib members stage an exact source closure with independent SDK versions', () => {
  for (const count of [1, 3, 32]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-source-members-'));
    try {
      const spec = fixture(root, 'linux-x64-gnu', releaseSqlNames().slice(0, count), '0.9.1');
      const { inventory } = stageWasixNapiInputs(spec);
      assert.equal(inventory.sdk.version, '0.9.1');
      assert.equal(inventory.runtimeVersion, '0.3.2');
      const extension = inventory.inputs.extensionArtifacts[0];
      assert.deepEqual(
        extension.portableArchives.map((row) => row.sqlName),
        spec.sqlNames,
      );
      assert.deepEqual(
        extension.aotManifests.map((row) => row.sqlName),
        spec.sqlNames,
      );
      for (const row of extension.portableArchives)
        assert.equal(
          row.path,
          `extensions/${PRODUCT}/member-assets/${row.sqlName}/${PRODUCT}-${spec.runtimeVersion}-wasix-portable.tar.zst`,
        );
      assert.equal(
        inventory.files.filter((row) => row.path.includes('/wasix-aot/')).length,
        count * 2 + 1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a runtime-only release embeds the constructed core while the SDK public minimum stays held', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-runtime-only-'));
  try {
    const spec = fixture(root, 'linux-x64-gnu', releaseSqlNames().slice(0, 3), '0.3.2', '0.3.3');
    const sdk = Bun.TOML.parse(readFileSync(spec.sdkManifest, 'utf8'));
    assert.equal(sdk.package.metadata.oliphaunt['runtime-version'], '0.3.2');
    const { inventory, runtimeVersion } = stageWasixNapiInputs(spec);
    assert.equal(runtimeVersion, '0.3.3');
    assert.equal(inventory.runtimeVersion, '0.3.3');
    assert.equal(inventory.sdk.version, '0.3.2');
    const frozen = JSON.parse(
      readFileSync(
        path.join(spec.output, `extensions/${PRODUCT}/extension-artifacts.json`),
        'utf8',
      ),
    );
    assert.equal(frozen.version, '0.3.3');
    for (const row of inventory.files) {
      const bytes = readFileSync(path.join(spec.output, row.path));
      assert.equal(bytes.length, row.size);
      assert.equal(digest(bytes), row.sha256);
    }
    const extensions = inventory.inputs.extensionArtifacts[0];
    assert.equal(extensions.portableArchives.length, 3);
    assert.equal(extensions.aotManifests.length, 3);
    assert(
      extensions.portableArchives.every((row) =>
        row.path.includes('-0.3.3-wasix-portable.tar.zst'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('equivalent SDK manifest formatting and local paths do not alter staged payload identities', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-sdk-manifest-'));
  try {
    const spec = fixture(root, 'linux-x64-gnu', releaseSqlNames().slice(0, 3));
    const before = stageWasixNapiInputs(spec).inventory;
    const original = readFileSync(spec.sdkManifest, 'utf8');
    writeFileSync(
      spec.sdkManifest,
      '# Source Cargo validation input\n\n' +
        original
          .replace('name="oliphaunt-wasix"', 'name = "oliphaunt-wasix"')
          .replaceAll('../../runtime/crates/', '../../runtime/./crates/'),
    );
    const output = path.join(root, 'after');
    const after = stageWasixNapiInputs({ ...spec, output }).inventory;
    assert.deepEqual(after, before);
    assert.deepEqual(after.sdk, { name: 'oliphaunt-wasix', version: spec.sdkVersion });
    const files = physicalFiles(spec.output);
    assert.deepEqual(physicalFiles(output), files);
    assert(!files.includes('src/wasix/sdks/rust/Cargo.toml'));
    for (const file of files)
      assert.deepEqual(
        readFileSync(path.join(output, file)),
        readFileSync(path.join(spec.output, file)),
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unrelated workspace lock changes do not alter embedded source construction data', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-unrelated-lock-'));
  try {
    const spec = fixture(root, 'linux-x64-gnu', releaseSqlNames().slice(0, 3));
    const lock = path.join(root, 'Cargo.lock');
    writeFileSync(lock, 'version=4\n[[package]]\nname="oliphaunt-native"\nversion="0.3.3"\n');
    const before = stageWasixNapiInputs(spec).inventory;
    writeFileSync(lock, 'version=4\n[[package]]\nname="oliphaunt-native"\nversion="0.3.4"\n');
    const output = path.join(root, 'after');
    const after = stageWasixNapiInputs({ ...spec, output }).inventory;
    assert.deepEqual(after, before);
    assert(!Object.hasOwn(after, 'cargoLock'));
    assert(!after.files.some((row) => row.path === 'Cargo.lock'));
    for (const row of after.files) {
      const bytes = readFileSync(path.join(output, row.path));
      assert.equal(bytes.length, row.size);
      assert.equal(digest(bytes), row.sha256);
      assert.deepEqual(bytes, readFileSync(path.join(spec.output, row.path)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects mismatched source versions, incomplete physical crates and incompatible target or payload identities', () => {
  const mutations: [string, (spec: WasixNapiInputsSpec) => void][] = [
    ...(
      [
        'portableArchive',
        'coreAotArchive',
        'contribPortable',
        'contribAot',
        'contribFrozen',
      ] as const
    ).map((field): [string, (spec: WasixNapiInputsSpec) => void] => [
      `missing original ${field}`,
      (spec) => rmSync(spec[field]),
    ]),
    [
      'source SDK version',
      (spec) => {
        writeFileSync(
          spec.sdkManifest,
          readFileSync(spec.sdkManifest, 'utf8').replace('0.3.2', '0.3.0'),
        );
      },
    ],
    [
      'source SDK runtime requirement',
      (spec) => {
        writeFileSync(
          spec.sdkManifest,
          readFileSync(spec.sdkManifest, 'utf8').replace('version = "*"', 'version = "=0.3.0"'),
        );
      },
    ],
    [
      'source SDK runtime local path',
      (spec) => {
        writeFileSync(
          spec.sdkManifest,
          readFileSync(spec.sdkManifest, 'utf8').replace(
            '../../runtime/crates/assets',
            '../../another-runtime/crates/assets',
          ),
        );
      },
    ],
    [
      'source SDK target AOT requirement',
      (spec) => {
        writeFileSync(
          spec.sdkManifest,
          readFileSync(spec.sdkManifest, 'utf8').replace(
            `${AOT_PACKAGES[spec.target]} = { version = "*"`,
            `${AOT_PACKAGES[spec.target]} = { version = "=0.3.0"`,
          ),
        );
      },
    ],
    [
      'source SDK package identity',
      (spec) => {
        writeFileSync(
          spec.sdkManifest,
          readFileSync(spec.sdkManifest, 'utf8').replace(
            'name="oliphaunt-wasix"',
            'name="foreign-sdk"',
          ),
        );
      },
    ],
    [
      'constructed version',
      (spec) =>
        rewriteCrate(spec.contribPortable, (files) => {
          const member = Object.keys(files).find((name) => name.endsWith('/Cargo.toml'))!;
          files[member] = Buffer.from(files[member].toString().replace('0.3.2', '0.3.0'));
        }),
    ],
    [
      'runtime missing',
      (spec) =>
        rewriteCrate(spec.portableArchive, (files) => {
          delete files[
            Object.keys(files).find((name) => name.endsWith('/payload/oliphaunt.wasix.tar.zst'))!
          ];
        }),
    ],
    [
      'runtime changed',
      (spec) =>
        rewriteCrate(spec.portableArchive, (files) => {
          files[
            Object.keys(files).find((name) => name.endsWith('/payload/oliphaunt.wasix.tar.zst'))!
          ] = Buffer.from('corrupt runtime');
        }),
    ],
    [
      'initdb missing',
      (spec) =>
        rewriteCrate(spec.portableArchive, (files) => {
          delete files[
            Object.keys(files).find((name) => name.endsWith('/payload/bin/initdb.wasix.wasm'))!
          ];
        }),
    ],
    [
      'member missing',
      (spec) =>
        rewriteCrate(spec.contribPortable, (files) => {
          delete files[
            Object.keys(files).find((name) =>
              name.endsWith(`/extensions/${spec.sqlNames[0]}/extension.tar.zst`),
            )!
          ];
        }),
    ],
    [
      'member changed',
      (spec) =>
        rewriteCrate(spec.contribPortable, (files) => {
          files[
            Object.keys(files).find((name) =>
              name.endsWith(`/extensions/${spec.sqlNames[0]}/extension.tar.zst`),
            )!
          ] = Buffer.from('corrupt extension');
        }),
    ],
    [
      'AOT member missing',
      (spec) =>
        rewriteCrate(spec.contribAot, (files) => {
          delete files[
            Object.keys(files).find((name) => name.endsWith(`/manifests/${spec.sqlNames[0]}.json`))!
          ];
        }),
    ],
    [
      'duplicate requested member',
      (spec) => {
        spec.sqlNames.push(spec.sqlNames[0]);
      },
    ],
    [
      'wrong target pair',
      (spec) => {
        spec.targetTriple = AOT_TARGET_TRIPLES['macos-arm64'];
      },
    ],
    [
      'foreign core target',
      (spec) =>
        rewriteCrate(spec.coreAotArchive, (files) =>
          rewriteJson(files, '/artifacts/manifest.json', (value) => {
            value['target-triple'] = 'aarch64-apple-darwin';
          }),
        ),
    ],
    [
      'incompatible fingerprint',
      (spec) =>
        rewriteCrate(spec.coreAotArchive, (files) =>
          rewriteJson(files, '/artifacts/manifest.json', (value) => {
            value['source-fingerprint'] = 'another producer';
          }),
        ),
    ],
    [
      'wrong core hash',
      (spec) =>
        rewriteCrate(spec.coreAotArchive, (files) =>
          rewriteJson(files, '/artifacts/manifest.json', (value) => {
            value.artifacts[0].sha256 = '0'.repeat(64);
          }),
        ),
    ],
    [
      'incomplete core inventory',
      (spec) =>
        rewriteCrate(spec.coreAotArchive, (files) =>
          rewriteJson(files, '/artifacts/manifest.json', (value) => {
            value.artifacts.pop();
          }),
        ),
    ],
    [
      'wrong portable module',
      (spec) =>
        rewriteCrate(spec.contribAot, (files) =>
          rewriteJson(files, `/manifests/${spec.sqlNames[0]}.json`, (value) => {
            value.artifacts[0]['module-sha256'] = '0'.repeat(64);
          }),
        ),
    ],
    [
      'foreign extension artifact',
      (spec) =>
        rewriteCrate(spec.contribAot, (files) =>
          rewriteJson(files, `/manifests/${spec.sqlNames[0]}.json`, (value) => {
            value.artifacts[0].name = 'extension:foreign';
          }),
        ),
    ],
    [
      'unsafe AOT path',
      (spec) =>
        rewriteCrate(spec.coreAotArchive, (files) =>
          rewriteJson(files, '/artifacts/manifest.json', (value) => {
            value.artifacts[0].path = '../escape';
          }),
        ),
    ],
    [
      'wrong frozen owner version',
      (spec) => {
        const frozen = JSON.parse(readFileSync(spec.contribFrozen, 'utf8'));
        frozen.version = '0.3.0';
        writeFileSync(spec.contribFrozen, JSON.stringify(frozen));
      },
    ],
  ];
  for (const [scenario, mutate] of mutations) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-source-invalid-'));
    try {
      const spec = fixture(root, 'linux-x64-gnu', releaseSqlNames().slice(0, 3));
      mutate(spec);
      assert.throws(() => stageWasixNapiInputs(spec), undefined, scenario);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
