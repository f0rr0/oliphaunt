import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { type CargoLinkConfiguration, cargoLinkEnvironment } from '../cargo-environment.mts';

/** A genuine std-only Cargo consumer; Cargo never constructs a product here. */
export function verifyInstalledBrokerCargo(inputs: {
  archive: string;
  cargo: string;
  rustc: string;
  rustdoc: string;
  compiler: string;
  runfiles: string;
  root: string;
  broker: Record<string, any>;
}): void {
  const archive = path.join(inputs.root, 'broker-input.crate');
  copyFileSync(inputs.archive, archive);
  const entries = readPortableArchiveEntries(archive);
  const manifests = [...entries.keys()].filter((name) => name.endsWith('/Cargo.toml'));
  assert.equal(manifests.length, 1, 'broker Cargo carrier must have one conventional manifest');
  const manifestMember = manifests[0];
  assert(manifestMember);
  const prefix = path.posix.dirname(manifestMember);
  const crate = path.join(inputs.root, 'broker-cargo');
  extractPortableArchiveTree(archive, crate, prefix);
  const manifest = Bun.TOML.parse(readFileSync(path.join(crate, 'Cargo.toml'), 'utf8'));
  assert.equal(manifest.package.version, inputs.broker.version);
  const constants = Object.fromEntries(
    [
      ...readFileSync(path.join(crate, 'src/lib.rs'), 'utf8').matchAll(
        /pub const ([A-Z_]+): &str = "([^"]+)";/gu,
      ),
    ].map((match) => [match[1], match[2]]),
  );
  assert.equal(constants.PRODUCT, inputs.broker.oliphaunt.brokerHelper);
  assert.equal(constants.RELEASE_TARGET, inputs.broker.oliphaunt.target);
  assert.equal(constants.EXECUTABLE_RELATIVE_PATH, inputs.broker.oliphaunt.executableRelativePath);
  assert(constants.CARGO_TARGET);
  const cargoHome = path.join(inputs.root, 'cargo-home');
  const target = path.join(inputs.root, 'cargo-target');
  mkdirSync(cargoHome);
  const env = {
    ...cargoLinkEnvironment(
      JSON.parse(readFileSync(inputs.compiler, 'utf8')) as CargoLinkConfiguration,
      inputs.runfiles,
    ),
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: target,
    CARGO_NET_OFFLINE: 'true',
    RUSTC: inputs.rustc,
    RUSTDOC: inputs.rustdoc,
    PATH: path.dirname(inputs.rustc),
    HOME: inputs.root,
    TMPDIR: inputs.root,
    OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: '1',
  };
  const compilerVersion = Bun.spawnSync([inputs.rustc, '-vV'], {
    cwd: crate,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(compilerVersion.exitCode, 0);
  assert.equal(
    compilerVersion.stdout.toString().match(/^host: (.+)$/mu)?.[1],
    constants.CARGO_TARGET,
    'this installed Cargo proof requires the actual declared host to match its native leaf',
  );
  const locked = Bun.spawnSync(
    [
      inputs.cargo,
      'generate-lockfile',
      '--offline',
      '--manifest-path',
      path.join(crate, 'Cargo.toml'),
    ],
    { cwd: crate, env, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 },
  );
  assert.equal(locked.exitCode, 0, `closed broker Cargo context: ${locked.stderr.toString()}`);
  const check = () =>
    Bun.spawnSync(
      [
        inputs.cargo,
        'check',
        '--locked',
        '--offline',
        '--jobs',
        '2',
        '--manifest-path',
        path.join(crate, 'Cargo.toml'),
      ],
      {
        cwd: crate,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 90_000,
      },
    );
  const checked = check();
  assert.equal(checked.exitCode, 0, `installed broker Cargo leaf: ${checked.stderr.toString()}`);
  const generated = [
    ...new Bun.Glob('**/out/oliphaunt-artifact.toml').scanSync({ cwd: target, onlyFiles: true }),
  ];
  assert.equal(generated.length, 1, 'real Cargo build script must emit its artifact manifest');
  const generatedManifest = generated[0];
  assert(generatedManifest);
  const artifact = Bun.TOML.parse(readFileSync(path.join(target, generatedManifest), 'utf8'));
  assert.equal(artifact.schema, 'oliphaunt-artifact-manifest-v1');
  assert.equal(artifact.product, constants.PRODUCT);
  assert.equal(artifact.kind, constants.KIND);
  assert.equal(artifact.target, constants.CARGO_TARGET);
  assert.equal(artifact.version, manifest.package.version);
  assert.equal(artifact.files.length, 1, 'Unix broker carrier must bind its actual executable');
  const binary = path.join(crate, 'payload', constants.EXECUTABLE_RELATIVE_PATH);
  assert.equal(artifact.files[0].source, binary);
  assert.equal(artifact.files[0].relative, constants.EXECUTABLE_RELATIVE_PATH);
  assert.equal(artifact.files[0].executable, true);
  assert.equal(
    artifact.files[0].sha256,
    createHash('sha256').update(readFileSync(binary)).digest('hex'),
  );
  renameSync(binary, `${binary}.removed`);
  try {
    const missing = check();
    assert.notEqual(missing.exitCode, 0, 'Cargo accepted a missing required broker payload');
    assert.match(missing.stderr.toString(), /missing packaged oliphaunt-broker payload/u);
  } finally {
    renameSync(`${binary}.removed`, binary);
  }
}
