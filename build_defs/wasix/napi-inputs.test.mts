import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWasixNapiConstructionData,
  WASIX_NAPI_SOURCE_PATCH_MEMBER,
} from '../../src/wasix/node-addon/tools/carrier-contract.mts';
import { canonicalWasixAotMetadata } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  CORE_AOT_ARTIFACTS,
  EXTENSION_AOT_PACKAGE_SUFFIXES,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
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

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(root: string, target = 'linux-x64-gnu'): WasixNapiInputsSpec {
  const targetTriple = AOT_TARGET_TRIPLES[target];
  const catalog = JSON.parse(
    readFileSync('src/extensions/generated/extensions.catalog.json', 'utf8'),
  ).extensions;
  const release = Bun.TOML.parse(readFileSync('src/wasix/node-addon/Cargo.toml', 'utf8')).features
    .release;
  const sqlNames = release
    .filter((feature: string) => feature.startsWith('extension-'))
    .map((feature: string) => {
      const matches = catalog.filter(
        (row: any) => `extension-${row['sql-name'].replaceAll('_', '-')}` === feature,
      );
      assert.equal(matches.length, 1);
      return matches[0]['sql-name'];
    });
  assert.equal(sqlNames.length, 32);
  const packages = [
    'oliphaunt-wasix',
    'liboliphaunt-wasix-portable',
    AOT_PACKAGES[target],
    'oliphaunt-extension-contrib-pg18-wasix',
    `oliphaunt-extension-contrib-pg18-aot-${EXTENSION_AOT_PACKAGE_SUFFIXES[targetTriple]}`,
  ];
  const files = new Map<string, Record<string, string>>();
  const write = (name: string, member: string, bytes: string | Uint8Array) => {
    const file = path.join(root, 'inputs', name, member);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const entries = files.get(name) ?? {};
    entries[member] = file;
    files.set(name, entries);
  };
  const fingerprint = 'independent immutable registry fixture';
  const canonical = canonicalWasixAotMetadata();
  const manifest = (artifacts: any[]) => ({
    'format-version': 1,
    'source-lane': canonical.sourceLane,
    engine: canonical.engine,
    'wasmer-version': canonical.wasmerVersion,
    'wasmer-wasix-version': canonical.wasmerWasixVersion,
    'target-triple': targetTriple,
    'source-fingerprint': fingerprint,
    artifacts,
  });
  for (const name of packages)
    write(
      name,
      'Cargo.toml',
      `[package]\nname=${JSON.stringify(name)}\nversion="0.3.2"\n${name === 'oliphaunt-wasix' ? '[package.metadata.oliphaunt]\nruntime-version="0.3.2"\n' : ''}`,
    );
  write(packages[1], 'build-support.rs', '// actual patched portable source\n');
  write(packages[2], 'build-support.rs', '// actual patched AOT source\n');
  const runtime = Buffer.from('independent frozen runtime archive bytes');
  write(packages[1], 'payload/oliphaunt.wasix.tar.zst', runtime);
  write(packages[1], 'payload/bin/initdb.wasix.wasm', Buffer.from('\0asm\x01\0\0\0'));
  write(
    packages[1],
    'payload/manifest.json',
    JSON.stringify({
      'format-version': 2,
      'source-fingerprint': fingerprint,
      runtime: { archive: 'oliphaunt.wasix.tar.zst', sha256: digest(runtime) },
    }),
  );
  const core = CORE_AOT_ARTIFACTS.map((name, index) => {
    const bytes = Buffer.from(`independent frozen core ${name}`),
      member = `${index}.bin.zst`;
    write(packages[2], `artifacts/${member}`, bytes);
    return { name, path: member, sha256: digest(bytes) };
  });
  write(packages[2], 'artifacts/manifest.json', JSON.stringify(manifest(core)));
  for (const sqlName of sqlNames) {
    write(
      packages[3],
      `payload/files/extensions/${sqlName}/extension.tar.zst`,
      `independent frozen archive ${sqlName}`,
    );
    const bytes = Buffer.from(`independent frozen AOT ${sqlName}`),
      member = `${sqlName}.bin.zst`;
    write(packages[4], `payload/files/extensions/${sqlName}/${member}`, bytes);
    write(
      packages[4],
      `manifests/${sqlName}.json`,
      JSON.stringify(
        manifest([{ name: `extension:${sqlName}`, path: member, sha256: digest(bytes) }]),
      ),
    );
  }
  const cargoLock = path.join(root, 'Cargo.lock');
  writeFileSync(
    cargoLock,
    `version=4\n${packages.map((name) => `[[package]]\nname=${JSON.stringify(name)}\nversion="0.3.2"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum=${JSON.stringify(digest(name))}\n`).join('\n')}`,
  );
  return {
    target,
    targetTriple,
    cargoLock,
    sourcePatch: 'build_defs/wasix/held-wasix-relocatable-includes.patch',
    sqlNames,
    output: path.join(root, 'output'),
    dependencies: [...files].map(([name, files]) => ({ name, files })),
  };
}

test('held registry origins, default contrib and canonical construction carriers bind exactly on all supported hosts', async () => {
  for (const target of Object.keys(AOT_TARGET_TRIPLES)) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-registry-'));
    try {
      const spec = fixture(root, target);
      const actual = stageWasixNapiInputs(spec);
      assert.equal(actual.runtimeVersion, '0.3.2');
      assert.equal(actual.inventory.dependencies.length, 5);
      assert.equal(actual.inventory.inputs.extensionArtifacts[0].portableArchives.length, 32);
      assert.equal(actual.inventory.inputs.extensionArtifacts[0].aotManifests.length, 32);
      assert(actual.inventory.dependencies.every((row) => row.checksum === digest(row.name)));
      const binarySha = digest('independently compiled addon');
      const provenance = {
        schema: 'oliphaunt-wasix-napi-construction-data-v2',
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
        sdkVersion: '0.3.2',
        runtimeVersion: actual.runtimeVersion,
        sqlNames: spec.sqlNames,
        sourcePatch: {
          path: WASIX_NAPI_SOURCE_PATCH_MEMBER,
          sha256: digest(readFileSync(spec.sourcePatch)),
          size: readFileSync(spec.sourcePatch).length,
        },
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
          value.buildInputs.dependencies.push(value.buildInputs.dependencies[0]);
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
        (value: any) => {
          value.buildInputs.dependencies.find(
            (row: any) => row.name === 'liboliphaunt-wasix-portable',
          ).patches[0].sha256 = '0'.repeat(64);
        },
      ]) {
        const changed = JSON.parse(JSON.stringify(provenance));
        mutate(changed);
        assert.throws(() => assertWasixNapiConstructionData(changed, target, binarySha, contract));
      }
      const reverse = stageWasixNapiInputs({
        ...spec,
        output: path.join(root, 'reverse'),
        dependencies: [...spec.dependencies].reverse().map((row) => ({
          ...row,
          files: Object.fromEntries(Object.entries(row.files).reverse()),
        })),
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
        // The actual SDK filegroup declares provider DLLs, without a packaging receipt.
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
        sourcePatch: spec.sourcePatch,
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

test('rejects wrong cached versions, incomplete inputs, foreign AOT and incompatible source identities', () => {
  const mutations = [
    (spec: WasixNapiInputsSpec) => {
      const row = spec.dependencies[3];
      writeFileSync(
        row.files['Cargo.toml'],
        readFileSync(row.files['Cargo.toml'], 'utf8').replace('0.3.2', '0.3.0'),
      );
    },
    (spec: WasixNapiInputsSpec) => {
      delete spec.dependencies[1].files['payload/oliphaunt.wasix.tar.zst'];
    },
    (spec: WasixNapiInputsSpec) => {
      delete spec.dependencies[4].files[`manifests/${spec.sqlNames[0]}.json`];
    },
    (spec: WasixNapiInputsSpec) => {
      spec.sqlNames.push(spec.sqlNames[0]);
    },
    (spec: WasixNapiInputsSpec) => {
      const file = spec.dependencies[2].files['artifacts/manifest.json'];
      const value = JSON.parse(readFileSync(file, 'utf8'));
      value['target-triple'] = 'aarch64-apple-darwin';
      writeFileSync(file, JSON.stringify(value));
    },
    (spec: WasixNapiInputsSpec) => {
      const file = spec.dependencies[2].files['artifacts/manifest.json'];
      const value = JSON.parse(readFileSync(file, 'utf8'));
      value['source-fingerprint'] = 'another producer';
      writeFileSync(file, JSON.stringify(value));
    },
    (spec: WasixNapiInputsSpec) => {
      const file = spec.dependencies[2].files['artifacts/manifest.json'];
      const value = JSON.parse(readFileSync(file, 'utf8'));
      value.artifacts[0].sha256 = '0'.repeat(64);
      writeFileSync(file, JSON.stringify(value));
    },
    (spec: WasixNapiInputsSpec) => {
      spec.dependencies[0].files['../escape'] = spec.dependencies[0].files['Cargo.toml'];
    },
  ];
  for (const mutate of mutations) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-napi-invalid-'));
    try {
      const spec = fixture(root);
      mutate(spec);
      assert.throws(() => stageWasixNapiInputs(spec));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
