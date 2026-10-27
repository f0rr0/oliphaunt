/** Offline conventional Cargo reconstruction of the actual emitted payload crates. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  type CargoLinkConfiguration,
  cargoLinkEnvironment,
} from '../../languages/cargo-environment.mts';

const [packagesDirectory, githubArchive, cargo, rustc, rustdoc, configurationFile, runfiles] =
  process.argv.slice(2);
assert(
  packagesDirectory &&
    githubArchive &&
    cargo &&
    rustc &&
    rustdoc &&
    configurationFile &&
    runfiles &&
    process.env.TEST_TMPDIR,
);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR, 'installed-native-cargo-'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  const privateGithub = path.join(root, path.basename(githubArchive));
  copyFileSync(githubArchive, privateGithub);
  const packages = JSON.parse(readFileSync(path.join(packagesDirectory, 'packages.json'), 'utf8'));
  assert.equal(packages.schema, 'oliphaunt-liboliphaunt-cargo-artifacts-v1');
  assert(
    packages.packages.length > 1,
    'actual native Cargo tree must contain aggregator and payload parts',
  );
  const records: {
    name: string;
    version: string;
    manifest: Record<string, any>;
    directory: string;
    role: string;
  }[] = [];
  for (const row of packages.packages) {
    // The tree owns the physical crates. The operational index may retain
    // execroot-relative locators; they must name precisely those actual files.
    const archive = path.join(packagesDirectory, path.basename(row.cratePath));
    const privateArchive = path.join(root, path.basename(archive));
    copyFileSync(realpathSync(archive), privateArchive);
    const entries = readPortableArchiveEntries(privateArchive);
    const manifests = [...entries.values()].filter(
      (entry) => entry.isFile && /^[^/]+\/Cargo\.toml$/u.test(entry.name),
    );
    assert.equal(
      manifests.length,
      1,
      'each emitted crate must contain exactly one package manifest',
    );
    const manifest = Bun.TOML.parse(manifests[0].data().toString()) as Record<string, any>;
    assert.equal(manifest.package.name, row.name);
    assert.equal(path.basename(archive), `${row.name}-${manifest.package.version}.crate`);
    const directory = path.join(root, 'crates', row.name);
    extractPortableArchiveTree(
      privateArchive,
      directory,
      `${row.name}-${manifest.package.version}`,
    );
    records.push({
      name: row.name,
      version: manifest.package.version,
      manifest,
      directory,
      role: row.role,
    });
  }
  const aggregators = records.filter(({ role }) => role === 'aggregator');
  assert.equal(aggregators.length, 1);
  const aggregator = aggregators[0];
  const parts = records.filter(({ role }) => role === 'part');
  assert(parts.length > 0);
  assert.deepEqual(
    Object.keys(aggregator.manifest['build-dependencies']).sort(),
    parts.map(({ name }) => name).sort(),
  );
  for (const part of parts) {
    assert.deepEqual(aggregator.manifest['build-dependencies'][part.name], {
      version: `=${part.version}`,
    });
    assert.equal(part.version, aggregator.version);
  }
  const consumer = path.join(root, 'consumer');
  mkdirSync(path.join(consumer, 'src'), { recursive: true });
  const quote = (value: string) => JSON.stringify(value.replaceAll('\\', '/'));
  writeFileSync(
    path.join(consumer, 'Cargo.toml'),
    `[package]\nname = "installed-native-payload-consumer"\nversion = "0.0.0"\nedition = "2024"\nbuild = "build.rs"\n\n[dependencies]\nartifact = { package = ${quote(aggregator.name)}, version = ${quote(`=${aggregator.version}`)}, path = ${quote(aggregator.directory)} }\n\n[patch.crates-io]\n${parts.map(({ name, directory }) => `${quote(name)} = { path = ${quote(directory)} }`).join('\n')}\n\n[workspace]\n`,
  );
  const metadataKey = `DEP_${aggregator.manifest.package.links.toUpperCase().replaceAll('-', '_')}_MANIFEST`;
  writeFileSync(
    path.join(consumer, 'build.rs'),
    `fn main() {\n    let manifest = std::env::var(${JSON.stringify(metadataKey)}).expect("actual aggregator must supply reconstructed manifest");\n    println!("cargo::rustc-env=RECONSTRUCTED_MANIFEST={manifest}");\n}\n`,
  );
  writeFileSync(
    path.join(consumer, 'src/main.rs'),
    'fn main() { println!("{}", env!("RECONSTRUCTED_MANIFEST")); }\n',
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(?:CARGO_|RUST|DEP_|OLIPHAUNT_|LIBOLIPHAUNT_)/u.test(key)) delete env[key];
  Object.assign(
    env,
    cargoLinkEnvironment(
      JSON.parse(readFileSync(configurationFile, 'utf8')) as CargoLinkConfiguration,
      runfiles,
    ),
    {
      CARGO_HOME: path.join(root, 'cargo-home'),
      CARGO_TARGET_DIR: path.join(root, 'target'),
      CARGO_NET_OFFLINE: 'true',
      RUSTC: rustc,
      RUSTDOC: rustdoc,
      OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: '1',
    },
  );
  const result = Bun.spawnSync(
    [cargo, 'run', '--offline', '--manifest-path', path.join(consumer, 'Cargo.toml')],
    { cwd: consumer, env, stdout: 'pipe', stderr: 'pipe' },
  );
  assert.equal(
    result.exitCode,
    0,
    `installed Cargo reconstruction failed:\n${result.stderr.toString()}`,
  );
  const manifest = Bun.TOML.parse(readFileSync(result.stdout.toString().trim(), 'utf8')) as Record<
    string,
    any
  >;
  assert.equal(manifest.schema, 'oliphaunt-artifact-manifest-v1');
  assert.equal(manifest.version, aggregator.version);
  assert.equal(
    manifest.product,
    packages.packages.find(({ role }) => role === 'aggregator').product,
  );
  const actual = manifest.files
    .map((file) => {
      const bytes = readFileSync(file.source);
      assert.equal(digest(bytes), file.sha256, `reconstructed bytes differ for ${file.relative}`);
      return { relative: file.relative, sha256: file.sha256, executable: file.executable };
    })
    .sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
  const expected = [...readPortableArchiveEntries(privateGithub).values()]
    .filter((entry) => entry.isFile)
    .map((entry) => ({
      relative: entry.name,
      sha256: digest(entry.data()),
      executable: Boolean(entry.mode & 0o100),
    }))
    .sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
  assert.deepEqual(
    actual,
    expected,
    'offline reconstructed Cargo payload must equal the final GitHub payload',
  );
  console.log(
    `Installed native Cargo: ${parts.length} actual payload parts reconstructed ${actual.length} final public files exactly, offline.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
