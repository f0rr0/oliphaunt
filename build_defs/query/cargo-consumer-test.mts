import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  extractPortableArchiveTree,
  readFileOnlyTarGzipEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  type CargoLinkConfiguration,
  cargoLinkEnvironment,
} from '../languages/cargo-environment.mts';

export {
  type CargoLinkConfiguration,
  cargoLinkEnvironment,
} from '../languages/cargo-environment.mts';

async function installedConsumerTest(args: string[]) {
  const [archive, manifest, source, cargo, rustc, rustdoc, linkConfiguration, runfiles] = args;
  assert(
    archive &&
      manifest &&
      source &&
      cargo &&
      rustc &&
      rustdoc &&
      linkConfiguration &&
      runfiles &&
      process.env.TEST_TMPDIR,
  );
  const directory = join(process.env.TEST_TMPDIR, 'query-cargo-consumer');
  await mkdir(directory, { recursive: true });
  const installedArchive = join(directory, 'query.crate');
  await copyFile(archive, installedArchive);
  const entries = readFileOnlyTarGzipEntries(installedArchive);
  const manifests = [...entries.keys()].filter((path) => path.endsWith('/Cargo.toml'));
  assert.equal(manifests.length, 1, 'source crate must contain one Cargo manifest');
  const packageManifest = manifests[0];
  assert(packageManifest);
  const prefix = packageManifest.slice(0, -'/Cargo.toml'.length);
  extractPortableArchiveTree(installedArchive, join(directory, 'installed'), prefix);
  const consumer = join(directory, 'consumer');
  await mkdir(join(consumer, 'src'), { recursive: true });
  await copyFile(manifest, join(consumer, 'Cargo.toml'));
  await copyFile(source, join(consumer, 'src/main.rs'));

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CARGO_') || key.startsWith('RUST')) delete env[key];
  }
  Object.assign(env, {
    ...cargoLinkEnvironment(
      JSON.parse(await readFile(linkConfiguration, 'utf8')) as CargoLinkConfiguration,
      runfiles,
    ),
    CARGO_HOME: join(directory, 'cargo-home'),
    CARGO_TARGET_DIR: join(directory, 'target'),
    CARGO_NET_OFFLINE: 'true',
    RUSTC: rustc,
    RUSTDOC: rustdoc,
  });
  const result = Bun.spawnSync(
    [cargo, 'run', '--offline', '--manifest-path', join(consumer, 'Cargo.toml')],
    {
      cwd: consumer,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  assert.equal(result.exitCode, 0, 'installed source crate consumer failed');
}

if (import.meta.main) await installedConsumerTest(process.argv.slice(2));
