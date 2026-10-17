import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertWasixExtensionArchiveInstall,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from '../../src/extensions/contracts/wasix-extension-install.mts';
import { packageSqlOnlyWasixExtensionCargo } from '../../src/wasix/runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { extensionCompatibilityMetadata } from '../../tools/release/extension-release-metadata.mts';
import {
  declaredSqlFiles,
  packageSqlOnlyWasixCarriers,
  type WasixSqlCarrierSpec,
  wasixSqlCarrierLeaves,
} from './wasix_carriers.mts';

const [input, github, npm, cargo, manifest, frozen, sqlRoot] = process.argv.slice(2);
assert(input, 'expected canonical pgTAP WASIX carrier metadata');
const metadata = JSON.parse(readFileSync(input, 'utf8'));
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function checkCarriers(spec: WasixSqlCarrierSpec, sql: string[]) {
  const leaves = wasixSqlCarrierLeaves(spec);
  const bytes = readFileSync(spec.outputs.github);
  const frozen = readJson(spec.outputs.frozen);
  const manifest = readJson(spec.outputs.manifest);
  assert.deepEqual(frozen.compatibility, extensionCompatibilityMetadata(spec.compatibility));
  assert.deepEqual(manifest.compatibility, frozen.compatibility);
  assert.deepEqual(manifest.sourceIdentity, spec.releaseMetadata.sourceIdentity);
  assert.equal(frozen.product, spec.product);
  assert.equal(frozen.version, spec.version);
  assert.equal(frozen.nativeModuleStem, null);
  assert.equal(frozen.assets.length, 1);
  const asset = frozen.assets[0];
  assert.equal(asset.sha256, digest(spec.outputs.github));
  assert.deepEqual(manifest.assets, frozen.assets);
  assertWasixExtensionArchiveInstall(bytes, {
    schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
    sqlName: spec.sqlName,
    archive: `extensions/${spec.sqlName}.tar.zst`,
    sha256: asset.sha256,
    size: asset.bytes,
    install: frozen.wasixInstall,
  });
  const portable = readPortableArchiveEntries(spec.outputs.github);
  const files = [...portable].filter(([, row]) => row.isFile).map(([name]) => name);
  assert.deepEqual(
    files,
    sql.map((file) => `share/postgresql/extension/${path.basename(file)}`).sort(),
  );
  for (const file of sql)
    assert.deepEqual(
      portable.get(`share/postgresql/extension/${path.basename(file)}`)!.data(),
      readFileSync(file),
    );
  const npmFiles = readPortableArchiveEntries(spec.outputs.npm);
  const packageJson = JSON.parse(npmFiles.get('package/package.json')!.data().toString());
  assert.equal(packageJson.name, leaves.npm.name);
  assert.equal(packageJson.version, spec.version);
  assert.equal(packageJson.oliphaunt.runtime, 'wasix');
  assert.deepEqual(
    npmFiles.get(`package/extensions/${spec.sqlName}/extension.tar.zst`)!.data(),
    bytes,
  );
  const installation = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'installed-wasix-sql-'),
  );
  try {
    for (const [file, entry] of npmFiles) {
      if (!entry.isFile) continue;
      const destination = path.join(installation, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, entry.data());
    }
    const entry = path.join(installation, 'package', packageJson.exports['.'].import);
    const { default: descriptor } = await import(pathToFileURL(entry).href);
    assert.equal(descriptor.product, spec.product);
    assert.equal(descriptor.version, spec.version);
    assert.equal(
      descriptor.compatibility.wasixRuntimeVersion,
      spec.compatibility.wasix_runtime_version,
    );
    assert(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.carriers[0].install));
    assert.equal(descriptor.carriers.length, 1);
    assert.deepEqual(descriptor.carriers[0].install, frozen.wasixInstall);
    assert.deepEqual(readFileSync(descriptor.carriers[0].source), bytes);
  } finally {
    rmSync(installation, { recursive: true, force: true });
  }
  const cargoFiles = readPortableArchiveEntries(spec.outputs.cargo);
  const prefix = `${leaves.cargo.name}-${spec.version}`;
  const cargoToml = Bun.TOML.parse(cargoFiles.get(`${prefix}/Cargo.toml`)!.data().toString());
  assert.equal(cargoToml.package.name, leaves.cargo.name);
  assert.equal(cargoToml.package.version, spec.version);
  assert.deepEqual(
    cargoFiles.get(`${prefix}/payload/files/extensions/${spec.sqlName}/extension.tar.zst`)!.data(),
    bytes,
  );
  const build = cargoFiles.get(`${prefix}/build.rs`)!.data().toString();
  assert(
    build.includes(
      `const RUNTIME_VERSION: &str = ${JSON.stringify(spec.compatibility.wasix_runtime_version)};`,
    ),
  );
  assert([...npmFiles.keys()].some((file) => file.startsWith('package/share/licenses/pgtap/')));
  assert([...cargoFiles.keys()].some((file) => file.startsWith(`${prefix}/share/licenses/pgtap/`)));
  assert(
    ![...npmFiles.keys(), ...cargoFiles.keys()].some(
      (file) => file.endsWith('.wasmu') || file.endsWith('.wasm'),
    ),
  );
}

if (github) {
  assert(
    npm && cargo && manifest && frozen && sqlRoot,
    'production proof requires all final envelopes and their sole SQL input',
  );
  const production = realpathSync(sqlRoot);
  await checkCarriers(
    {
      ...metadata,
      sqlRoot: production,
      outputs: {
        github: realpathSync(github),
        npm: realpathSync(npm),
        cargo: realpathSync(cargo),
        manifest: realpathSync(manifest),
        frozen: realpathSync(frozen),
      },
    },
    readdirSync(production).map((name) => path.join(production, name)),
  );
  console.log('installed pgTAP WASIX npm/Cargo/GitHub envelopes preserve the exact production SQL');
  process.exit(0);
}

const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-sql-carrier-test-'));
try {
  const sqlRoot = path.join(root, 'sql');
  mkdirSync(sqlRoot);
  const defaultVersion = metadata.source['extension-control']['default-version'];
  const sql = [
    ['pgtap.control', `default_version = '${defaultVersion}'\nrequires = 'plpgsql'\n`],
    [`pgtap--${defaultVersion}.sql`, '-- canonical fixture SQL\nSELECT 1;\n'],
    [`pgtap-core--${defaultVersion}.sql`, '-- canonical core SQL\n'],
    [`pgtap-schema--${defaultVersion}.sql`, '-- canonical schema SQL\n'],
    ['uninstall_pgtap.sql', '-- canonical uninstall SQL\n'],
    ['pgtap--1.3.4--1.3.5.sql', '-- canonical upgrade SQL\n'],
  ].map(([name, bytes]) => {
    const file = path.join(sqlRoot, name);
    writeFileSync(file, bytes);
    return file;
  });
  const specAt = (name: string): WasixSqlCarrierSpec => {
    const out = path.join(root, name);
    return {
      ...structuredClone(metadata),
      sqlRoot,
      outputs: {
        github: path.join(out, `${metadata.product}-${metadata.version}-wasix-portable.tar.zst`),
        npm: path.join(out, `oliphaunt-extension-pgtap-wasix-${metadata.version}.tgz`),
        cargo: path.join(out, `oliphaunt-extension-pgtap-wasix-${metadata.version}.crate`),
        manifest: path.join(out, `${metadata.product}-${metadata.version}-manifest.json`),
        frozen: path.join(out, 'extension-artifacts.json'),
      },
    };
  };
  const first = specAt('first');
  packageSqlOnlyWasixCarriers(first, sql);
  await checkCarriers(first, sql);
  const second = specAt('second');
  packageSqlOnlyWasixCarriers(second, [...sql].reverse());
  for (const key of Object.keys(first.outputs) as (keyof WasixSqlCarrierSpec['outputs'])[])
    assert.deepEqual(
      readFileSync(first.outputs[key]),
      readFileSync(second.outputs[key]),
      `nondeterministic ${key} envelope`,
    );
  writeFileSync(sql[1], '-- changed source SQL\nSELECT 2;\n');
  const changed = specAt('changed');
  packageSqlOnlyWasixCarriers(changed, sql);
  await checkCarriers(changed, sql);
  for (const key of ['github', 'npm', 'cargo'] as const)
    assert.notEqual(
      digest(first.outputs[key]),
      digest(changed.outputs[key]),
      `${key} failed to propagate changed SQL`,
    );
  assert.deepEqual(
    readJson(first.outputs.frozen).compatibility,
    readJson(changed.outputs.frozen).compatibility,
    'changing SQL must preserve the declared held runtime versions',
  );
  // Replay few/many changes through public envelopes with a reproducible seed.
  let seed = 294;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const count of [0, 3, 64]) {
    const additional = Array.from({ length: count }, (_, index) => {
      const file = path.join(sqlRoot, `pgtap--8.${index}.0--8.${index}.1.sql`);
      writeFileSync(file, `-- scenario seed 294\nSELECT ${random()};\n`);
      return file;
    });
    const scenario = specAt(`scenario-${count}`);
    scenario.version = count === 64 ? '1.0.0' : count === 3 ? '0.4.0' : '0.3.3';
    for (const carrier of scenario.carriers) carrier.version = scenario.version;
    const out = path.dirname(scenario.outputs.github);
    scenario.outputs.github = path.join(
      out,
      `${scenario.product}-${scenario.version}-wasix-portable.tar.zst`,
    );
    scenario.outputs.cargo = path.join(out, `${scenario.product}-wasix-${scenario.version}.crate`);
    scenario.outputs.manifest = path.join(
      out,
      `${scenario.product}-${scenario.version}-manifest.json`,
    );
    packageSqlOnlyWasixCarriers(scenario, [...additional, ...sql]);
    await checkCarriers(scenario, [...sql, ...additional]);
    assert.deepEqual(
      readJson(scenario.outputs.frozen).compatibility,
      readJson(first.outputs.frozen).compatibility,
    );
    for (const file of additional) rmSync(file);
  }
  for (const missing of sql.slice(0, 5))
    assert.throws(
      () =>
        declaredSqlFiles(
          first,
          sql.filter((file) => file !== missing),
        ),
      /missing canonical SQL/u,
    );
  assert.throws(() => declaredSqlFiles(first, [...sql, sql[1]]), /unique/u);
  const unexpected = path.join(sqlRoot, 'foreign.wasm');
  writeFileSync(unexpected, '\0asm');
  assert.throws(() => declaredSqlFiles(first, [...sql, unexpected]), /unexpected SQL/u);
  const foreign = path.join(root, path.basename(sql[1]));
  writeFileSync(foreign, '-- undeclared source');
  assert.throws(
    () => declaredSqlFiles(first, [foreign, ...sql.slice(1)]),
    /declared producer tree/u,
  );
  const directory = path.join(sqlRoot, 'pgtap--9.9.9.sql');
  mkdirSync(directory);
  assert.throws(() => declaredSqlFiles(first, [...sql, directory]), /regular declared file/u);
  const declaredLinks = path.join(root, 'declared-links');
  mkdirSync(declaredLinks);
  const linkFiles = sql.map((file) => {
    const link = path.join(declaredLinks, path.basename(file));
    symlinkSync(file, link);
    return link;
  });
  assert.deepEqual(
    declaredSqlFiles({ ...first, sqlRoot: declaredLinks }, linkFiles),
    declaredSqlFiles(first, sql),
    'Bazel input links must preserve the declared regular SQL file inventory',
  );
  writeFileSync(sql[0], "default_version = '99.0.0'\n");
  assert.throws(() => declaredSqlFiles(first, sql), /control default version/u);
  for (const mutate of [
    (spec: WasixSqlCarrierSpec) => {
      spec.product = 'oliphaunt-extension-vector';
    },
    (spec: WasixSqlCarrierSpec) => {
      spec.target = 'linux-x64-gnu';
    },
    (spec: WasixSqlCarrierSpec) => {
      spec.descriptor['native-module-file'] = 'pgtap.so';
    },
    (spec: WasixSqlCarrierSpec) => {
      spec.carriers.find(
        (row) => row.role === 'portable-leaf' && row.ecosystem === 'npm',
      )!.version = '99.0.0';
    },
    (spec: WasixSqlCarrierSpec) => {
      spec.recipe.artifacts.data_files = ['share/postgresql/foreign'];
    },
    (spec: WasixSqlCarrierSpec) => {
      spec.source.commit = '0'.repeat(40);
    },
    (spec: WasixSqlCarrierSpec) => {
      spec.compatibility.wasix_runtime_version = '99.0.0';
    },
  ]) {
    const corrupt = specAt('corrupt');
    mutate(corrupt);
    assert.throws(() => wasixSqlCarrierLeaves(corrupt));
  }
  const member = readJson(first.outputs.frozen);
  const asset = member.assets[0];
  const cargoSpec = {
    product: first.product,
    version: first.version,
    runtimeProduct: first.compatibility.wasix_runtime_product,
    runtimeVersion: first.compatibility.wasix_runtime_version,
    member: {
      sqlName: first.sqlName,
      dependencies: first.selectedDependencies,
      archive: first.outputs.github,
      sha256: '0'.repeat(64),
      size: asset.bytes,
      install: member.wasixInstall,
    },
  };
  assert.throws(
    () =>
      packageSqlOnlyWasixExtensionCargo(cargoSpec, {
        outputDir: path.join(root, 'bad-cargo'),
        workDir: path.join(root, 'bad-work'),
      }),
    /digest differs/u,
  );
  console.log(
    'pgTAP WASIX final envelopes preserve exact production SQL, compatibility, determinism, legal bytes, and canonical Cargo/npm identities',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
