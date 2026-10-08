import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { packagedCargoManifestText } from '../../../../tools/packaging/cargo-source-package.mts';
import { preparePackagedCargoTestClosure } from '../../../../tools/packaging/cargo-package-test-closure.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import { assertReleaseNoticesInArchive } from '../../../../tools/packaging/release-notices.mts';
import { archiveTreeDigest, sha256File } from '../../../third-party/tools/source-fetch-core.mts';
import {
  ENGINE_CARGO_PACKAGES,
  ENGINE_PAYLOAD_PACKAGE,
  ENGINE_SOURCE_CRATES,
  isEnginePayloadPart,
} from './contract.mts';
import { packageEngine } from './package.mts';

test('freezes a closed engine family, rejects mixed inputs, and reconstructs every DLL byte', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-engine-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cratesDir = path.join(root, 'crates');
  cpSync(path.join(import.meta.dir, 'crates'), cratesDir, { recursive: true });
  const engineDir = path.join(root, 'engine');
  mkdirSync(engineDir);
  mkdirSync(path.join(cratesDir, 'wasmer/prebuilt'), { recursive: true });
  // Incompressible bytes exercise the registry size boundary and ordered parts.
  const dll = randomBytes(10 * 1024 * 1024);
  writeFileSync(path.join(engineDir, 'oliphaunt_wee8.dll'), dll);
  writeFileSync(
    path.join(cratesDir, 'wasmer/prebuilt/embedded_bindings.rs'),
    '// fixture bindings\n',
  );
  const sourceSha = 'b'.repeat(40);
  const receipt = {
    sourceSha,
    source: Bun.TOML.parse(readFileSync(path.join(import.meta.dir, 'source.toml'), 'utf8')),
    dllSha256: sha256File(path.join(engineDir, 'oliphaunt_wee8.dll')),
    bindingsSha256: sha256File(path.join(cratesDir, 'wasmer/prebuilt/embedded_bindings.rs')),
    engineSources: Object.fromEntries(
      ENGINE_SOURCE_CRATES.map((name) => [
        name,
        archiveTreeDigest(path.join(cratesDir, name, 'upstream')),
      ]),
    ),
  };
  const receiptPath = path.join(engineDir, 'source.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt));
  save();
  const options = {
    engineDir,
    cratesDir,
    sourceRoot: path.join(root, 'source'),
    outputDir: path.join(root, 'output'),
    version: '9.8.7',
    expectedSourceSha: sourceSha,
  };
  assert.throws(
    () => packageEngine({ ...options, expectedSourceSha: 'a'.repeat(40) }),
    /qualified source commit/u,
  );
  const digest = receipt.dllSha256;
  receipt.dllSha256 = '0'.repeat(64);
  save();
  assert.throws(() => packageEngine(options), /frozen engine DLL digest/u);
  receipt.dllSha256 = digest;
  save();
  const packages = packageEngine(options);
  const partNames = [`${ENGINE_PAYLOAD_PACKAGE}-part-001`, `${ENGINE_PAYLOAD_PACKAGE}-part-002`];
  assert(!isEnginePayloadPart(`${ENGINE_PAYLOAD_PACKAGE}-part-000`));
  assert.deepEqual(
    packages.map((row) => row.name).sort(),
    [...ENGINE_CARGO_PACKAGES, ...partNames].sort(),
  );
  const chunks = [];
  for (const row of packages) {
    assert.ok(row.size <= 9 * 1024 * 1024, row.name);
    const prefix = `${row.name}-9.8.7`;
    assertReleaseNoticesInArchive(row.cratePath, {
      prefix,
      profile: row.name.startsWith(ENGINE_PAYLOAD_PACKAGE)
        ? 'wasix-engine-windows'
        : 'wasix-engine-source',
    });
    const entries = readPortableArchiveEntries(row.cratePath);
    const text = entries.get(`${prefix}/Cargo.toml`).data().toString();
    const cargo = Bun.TOML.parse(text);
    assert.equal(cargo.package.version, '9.8.7');
    assert.equal(text, packagedCargoManifestText(text));
    for (const table of [cargo.dependencies, cargo['build-dependencies']]) {
      for (const [key, spec] of Object.entries(table ?? {})) {
        assert.equal(spec.path, undefined, `${row.name}:${key} must use registry dependencies`);
        if (ENGINE_CARGO_PACKAGES.includes(spec.package ?? key) || partNames.includes(key))
          assert.equal(spec.version ?? spec, '=9.8.7', `${row.name}:${key}`);
      }
    }
    if (partNames.includes(row.name)) chunks.push(entries.get(`${prefix}/payload.gz.part`).data());
    assert.ok(
      ![...entries.keys()].some((name) => /\.prepared|upstream\/tests\/|v8\.lib/u.test(name)),
    );
  }
  assert.deepEqual(gunzipSync(Buffer.concat(chunks)), dll);
  const before = packages.map((row) => row.sha256);
  assert.deepEqual(
    packageEngine(options).map((row) => row.sha256),
    before,
    'frozen carriers must be reproducible',
  );

  const consumer = path.join(root, 'consumer');
  const carrier = packages.find((row) => row.name === ENGINE_PAYLOAD_PACKAGE);
  const manifest = preparePackagedCargoTestClosure({
    cratePath: carrier.cratePath,
    scratch: consumer,
    dependencyCrates: packages
      .filter((row) => partNames.includes(row.name))
      .map((row) => row.cratePath),
  });
  const env = { ...process.env, CARGO_TARGET_DIR: path.join(consumer, 'target') };
  const fetched = Bun.spawnSync(
    ['cargo', '--config', 'net.offline=false', 'fetch', '--manifest-path', manifest],
    { cwd: consumer, env, timeout: 300_000 },
  );
  assert.equal(fetched.exitCode, 0, fetched.stderr.toString());
  const result = Bun.spawnSync(
    [
      'cargo',
      'build',
      '--manifest-path',
      manifest,
      '--locked',
      '--offline',
      '--message-format=json',
    ],
    { cwd: consumer, env, timeout: 300_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const build = result.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find(
      (message) =>
        message.reason === 'build-script-executed' &&
        message.package_id.includes(`${ENGINE_PAYLOAD_PACKAGE}@`),
    );
  assert.ok(build, 'the extracted carrier must reconstruct its own DLL');
  assert.deepEqual(readFileSync(path.join(build.out_dir, 'oliphaunt_wee8.dll')), dll);
});
