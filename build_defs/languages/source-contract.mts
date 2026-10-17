import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertPackagedCargoDependencies } from '../../tools/packaging/cargo-dependencies.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from '../../tools/packaging/rust-native-targets.mts';
import { type SourceMetadata, sourceManifest } from './source-package.mts';

export type CargoSourceContract = {
  archive: string;
  manifest: string;
  workspace: string;
  metadata: SourceMetadata;
  entries: Record<string, string>;
};

/** Check actual public source bytes against declared checkout files and requirements. */
export function verifyCargoSourceContract(spec: CargoSourceContract) {
  const original = readFileSync(spec.manifest, 'utf8');
  const expected = sourceManifest(original, readFileSync(spec.workspace, 'utf8'), spec.metadata);
  const root = `${expected.package.name}-${expected.package.version}`;
  const entries = readPortableArchiveEntries(realpathSync(spec.archive));
  const bytes = (member: string) => {
    const entry = entries.get(`${root}/${member}`);
    assert(entry?.isFile, `Cargo source archive omitted ${member}`);
    return Buffer.from(entry.data());
  };
  const packed = Bun.TOML.parse(bytes('Cargo.toml').toString('utf8'));
  assert.deepEqual(packed.package, expected.package, 'public Cargo package metadata changed');
  assert.deepEqual(packed.features ?? {}, expected.features ?? {}, 'public Cargo features changed');
  assertPackagedCargoDependencies(packed, expected, 'public Cargo source archive');
  assert.deepEqual(packed.workspace, {}, 'source package must isolate its consumer workspace');
  assert.equal(
    bytes('Cargo.toml.orig').toString('utf8'),
    original,
    'original manifest bytes changed',
  );
  for (const [name, entry] of entries) {
    assert(
      (name === root && entry.isDirectory) || name.startsWith(`${root}/`),
      `Cargo source member is outside declared package: ${name}`,
    );
    assert(
      (entry.isFile && entry.mode === 0o644) || (entry.isDirectory && entry.mode === 0o755),
      `Cargo source member has invalid type or mode: ${name}`,
    );
    if (entry.isDirectory) continue;
    const member = name.slice(root.length + 1);
    if (member === 'Cargo.toml' || member === 'Cargo.toml.orig') continue;
    const source = spec.entries[member];
    assert(source, `Cargo source archive contains undeclared member ${member}`);
    const authored = readFileSync(source);
    const actual = Buffer.from(entry.data());
    if (member === 'src/lib.rs' && spec.metadata.nativeArtifacts) {
      const targets = spec.metadata.nativeArtifacts.map((row) => row.target);
      const guard = renderUnsupportedNativeTargetGuard({
        product: packed.package.name,
        nativeTargets: targets,
        nativeCfgs: targets.map(rustNativeTargetCfg),
        guidance: 'use the separately versioned oliphaunt-wasix crate for WASIX environments.',
      });
      assert.equal(
        actual.toString('utf8'),
        `${authored.toString('utf8')}\n${guard}\n`,
        'native SDK source archive changed its library or target guard',
      );
    } else assert(actual.equals(authored), `Cargo source bytes changed: ${member}`);
  }
  // Both SDKs promise their complete library tree and fixture payloads. Cargo
  // owns checkout-only tests/tools selection; those are not rebuilt here.
  for (const member of Object.keys(spec.entries))
    if (
      ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'build.rs'].includes(member) ||
      member.startsWith('src/') ||
      member.startsWith('testdata/')
    )
      bytes(member);
  return { root, manifest: packed, members: entries.size };
}

async function main(specification: string, runfiles: string) {
  assert(process.env.TEST_TMPDIR, 'source qualification requires Bazel TEST_TMPDIR');
  const spec = JSON.parse(readFileSync(specification, 'utf8'));
  const file = (name: string) => path.join(runfiles, name);
  const receipts = [];
  for (const [index, source] of spec.packages.entries()) {
    const input: CargoSourceContract = {
      archive: file(source.archive),
      manifest: file(source.manifest),
      workspace: file(source.workspace),
      metadata: JSON.parse(readFileSync(file(source.metadata), 'utf8')),
      entries: Object.fromEntries(
        Object.entries(source.entries).map(([name, value]) => [name, file(value as string)]),
      ),
    };
    const contract = verifyCargoSourceContract(input);
    const directory = path.join(process.env.TEST_TMPDIR, String(index));
    const sourceRoot = path.join(directory, 'source');
    const home = path.join(directory, 'cargo-home');
    mkdirSync(home, { recursive: true });
    extractPortableArchiveTree(realpathSync(input.archive), sourceRoot, contract.root);
    const result = Bun.spawnSync(
      [
        file(spec.cargo),
        'metadata',
        '--offline',
        '--no-deps',
        '--format-version',
        '1',
        '--manifest-path',
        path.join(sourceRoot, 'Cargo.toml'),
      ],
      {
        env: {
          HOME: home,
          CARGO_HOME: home,
          CARGO_NET_OFFLINE: 'true',
          RUSTC: file(spec.rustc),
          PATH: path.dirname(file(spec.rustc)),
        },
      },
    );
    assert.equal(
      result.exitCode,
      0,
      `installed Cargo source metadata failed: ${result.stderr.toString()}`,
    );
    const packages = JSON.parse(result.stdout.toString()).packages;
    assert.equal(packages.length, 1, 'source package must expose one conventional Cargo identity');
    const [compiled] = packages;
    assert.equal(compiled.name, contract.manifest.package.name);
    assert.equal(compiled.version, contract.manifest.package.version);
    assert.deepEqual(compiled.features, contract.manifest.features ?? {});
    assert(compiled.targets.length > 0, 'public source manifest omitted its compiler targets');
    for (const target of compiled.targets) {
      const member = path.relative(sourceRoot, target.src_path).split(path.sep).join('/');
      assert(
        member && !member.startsWith('../') && !path.isAbsolute(member),
        'Cargo target escapes its source package',
      );
      assert(input.entries[member], `Cargo target has undeclared source ${member}`);
      readFileSync(target.src_path);
    }
    receipts.push({
      name: compiled.name,
      version: compiled.version,
      members: contract.members,
      sha256: createHash('sha256').update(readFileSync(input.archive)).digest('hex'),
      targets: compiled.targets.map((target: { name: string; kind: string[] }) => ({
        name: target.name,
        kind: target.kind,
      })),
    });
  }
  const output = process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? process.env.TEST_TMPDIR;
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, 'cargo-source-contract.json'),
    `${JSON.stringify({ schema: 'oliphaunt-cargo-source-contract-v1', packages: receipts }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  const [specification, runfiles] = process.argv.slice(2);
  assert(
    specification && runfiles && process.argv.length === 4,
    'expected source specification and runfiles root',
  );
  await main(specification, runfiles);
}
