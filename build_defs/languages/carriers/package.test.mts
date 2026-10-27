import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import {
  type HelperPackageSpec,
  packageNativeHelper,
  validateHelperNpmManifest,
} from './package.mts';

const [inputs, binary] = process.argv.slice(2);
assert(inputs && binary, 'expected canonical carrier fixtures and constructed host binary');
const cases: HelperPackageSpec[] = JSON.parse(readFileSync(inputs, 'utf8'));
const license = 'MIT AND ISC AND Unicode-3.0 AND BSD-3-Clause';
let valid = 0;
let rejected = 0;
for (const spec of cases) {
  const manifestPath = spec.sources['package.json'];
  assert(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateHelperNpmManifest(manifest, spec, license);
  valid++;
  for (const mutation of [
    (value: any) => (value.name = '@oliphaunt/wrong'),
    (value: any) => (value.version = '99.0.0'),
    (value: any) => (value.oliphaunt.target = 'wrong-target'),
    (value: any) => (value.os = ['wrong']),
    (value: any) => (value.cpu = ['wrong']),
    (value: any) =>
      (value.files = value.files.filter((name: string) => name !== 'THIRD_PARTY_LICENSES')),
    (value: any) => delete value.exports['./package.json'],
  ]) {
    const altered = structuredClone(manifest);
    mutation(altered);
    assert.throws(() => validateHelperNpmManifest(altered, spec, license));
    rejected++;
  }
}
assert.equal(valid, 8);
assert.equal(rejected, 56);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-carrier-unit-'));
try {
  let outputs = 0;
  for (const original of cases.filter(
    (spec) => spec.artifact.npm_os === process.platform && spec.artifact.npm_cpu === process.arch,
  )) {
    const directory = path.join(root, original.product);
    mkdirSync(directory);
    const spec = {
      ...original,
      binary: path.resolve(binary),
      outputs: {
        github: path.join(
          directory,
          original.artifact.asset.replace('{version}', original.version),
        ),
        npm: path.join(directory, 'npm.tgz'),
        ...(original.product === 'oliphaunt-broker'
          ? { cargo: path.join(directory, 'broker.crate') }
          : {}),
      },
    };
    await packageNativeHelper(spec);
    if (spec.product === 'oliphaunt-broker') {
      const entries = readPortableArchiveEntries(spec.outputs.github);
      const manifest = entries.get('manifest.properties');
      assert(manifest?.isFile, 'GitHub broker carrier omitted its conventional manifest');
      const values = Object.fromEntries(
        manifest
          .data()
          .toString('utf8')
          .trimEnd()
          .split('\n')
          .map((line) => line.split('=')),
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(values).filter(([key]) => key !== 'windowsVcRuntimeDlls'),
        ),
        {
          schema: 'oliphaunt-broker-release-assets-v1',
          product: spec.product,
          version: spec.version,
          target: spec.artifact.target,
          binary: spec.artifact.executable_relative_path,
        },
      );
      const runtime = [...entries.keys()]
        .filter((name) => name.startsWith('bin/') && name.endsWith('.dll'))
        .map((name) => path.posix.basename(name))
        .sort();
      assert.equal(values.windowsVcRuntimeDlls, runtime.length ? runtime.join(',') : undefined);
    }
    const first = Object.values(spec.outputs).map((file) => readFileSync(file));
    await packageNativeHelper(spec);
    Object.values(spec.outputs).forEach((file, index) => {
      const original = first[index];
      assert(original);
      assert(readFileSync(file).equals(original), 'envelopes must be byte deterministic');
    });
    outputs += first.length;
    const wrongTarget = cases.find(
      (candidate) =>
        candidate.product === spec.product &&
        candidate.artifact.npm_os === 'linux' &&
        candidate.artifact.npm_cpu !== process.arch,
    );
    assert(wrongTarget);
    await assert.rejects(
      packageNativeHelper({ ...wrongTarget, binary: spec.binary, outputs: spec.outputs }),
      /ELF|Mach-O|PE|architecture/u,
    );
    const missing = structuredClone(spec);
    delete missing.legal['Cargo.lock'];
    await assert.rejects(packageNativeHelper(missing), /missing declared legal source Cargo.lock/u);
    const changed = structuredClone(spec);
    changed.version = '99.0.0';
    await assert.rejects(packageNativeHelper(changed), /version|canonical/u);
    if (spec.outputs.cargo) {
      const missingBuild = structuredClone(spec);
      delete missingBuild.sources['cargo/build.rs'];
      await assert.rejects(
        packageNativeHelper(missingBuild),
        /missing declared Cargo target source build\.rs/u,
      );
      const manifest = spec.sources['cargo/Cargo.toml'];
      assert(manifest);
      const invalidManifest = path.join(directory, 'invalid-Cargo.toml');
      writeFileSync(
        invalidManifest,
        readFileSync(manifest, 'utf8').replace('path = "src/lib.rs"', 'path = "src/missing.rs"'),
      );
      await assert.rejects(
        packageNativeHelper({
          ...spec,
          sources: { ...spec.sources, 'cargo/Cargo.toml': invalidManifest },
        }),
        /Cargo lib\.path/u,
      );
    }
  }
  assert.equal(outputs, 5, 'both Node envelopes and all three broker envelopes must be exercised');
  console.log(
    `Native carrier manifests ${valid}, rejected mutations ${rejected}, deterministic host-binary envelopes ${outputs}: PASS`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
