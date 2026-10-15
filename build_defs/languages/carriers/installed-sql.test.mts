import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { hostRuntimeEnvironment } from '../../native/host-runtime-test-helpers.mts';
import { verifyInstalledBrokerCargo } from './cargo-consumer.mts';

const [
  sdk,
  query,
  addon,
  broker,
  runtime,
  node,
  source,
  artifactCrate,
  cargo,
  rustc,
  rustdoc,
  compiler,
  contractEntry,
  contractAssertions,
  deno,
  contractHostsJson,
  runfiles,
] = process.argv.slice(2);
assert(
  sdk &&
    query &&
    addon &&
    broker &&
    runtime &&
    node &&
    source &&
    artifactCrate &&
    cargo &&
    rustc &&
    rustdoc &&
    compiler &&
    contractEntry &&
    contractAssertions &&
    contractHostsJson &&
    runfiles,
  'expected actual npm carriers and pinned Node consumer tools',
);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'installed-native-sdk-'));
try {
  const packages = new Map<string, { directory: string; manifest: Record<string, any> }>();
  for (const [index, declaredArchive] of [sdk, query, addon, broker, runtime].entries()) {
    const archive = path.join(root, `${index}-input.tgz`);
    copyFileSync(declaredArchive, archive);
    const entries = readPortableArchiveEntries(archive);
    assert(
      [...entries.keys()].every((name) => name === 'package' || name.startsWith('package/')),
      'npm archive must contain only its package root',
    );
    const metadata = entries.get('package/package.json');
    assert(metadata?.isFile, 'npm carrier missing conventional package.json');
    const manifest = JSON.parse(metadata.data().toString());
    assert(typeof manifest.name === 'string' && /^@oliphaunt\/[a-z0-9-]+$/u.test(manifest.name));
    assert(!packages.has(manifest.name), 'installed carrier identity duplicated');
    const directory = path.join(root, 'node_modules', manifest.name);
    extractPortableArchiveTree(archive, directory, 'package');
    packages.set(manifest.name, { directory, manifest });
  }
  const sdkPackage = packages.get('@oliphaunt/ts');
  const queryPackage = packages.get('@oliphaunt/ts-query');
  assert(sdkPackage && queryPackage);
  assert.equal(
    queryPackage.manifest.version,
    sdkPackage.manifest.dependencies[queryPackage.manifest.name],
  );
  const optional = [...packages.values()].filter(({ manifest }) => manifest.optional === true);
  assert.equal(optional.length, 3, 'the runtime, Node addon and broker packages must be installed');
  for (const { manifest } of optional)
    assert.equal(
      manifest.version,
      sdkPackage.manifest.optionalDependencies[manifest.name],
      `SDK optional requirement differs from installed ${manifest.name}`,
    );
  const brokerPackage = optional.find(({ manifest }) => manifest.oliphaunt?.brokerHelper);
  assert(brokerPackage, 'actual installed broker package missing');
  verifyInstalledBrokerCargo({
    archive: artifactCrate,
    cargo,
    rustc,
    rustdoc,
    compiler,
    runfiles,
    root,
    broker: brokerPackage.manifest,
  });
  const held = optional.find(({ manifest }) => manifest.oliphaunt?.libraryRelativePath);
  assert(held, 'held native runtime package missing');
  assert.equal(
    held.manifest.version,
    sdkPackage.manifest.oliphaunt.liboliphauntVersion,
    'runtime must retain the SDK conventional held pin',
  );
  const runtimeDirectory = path.join(held.directory, held.manifest.oliphaunt.runtimeRelativePath);
  const env = hostRuntimeEnvironment(runtimeDirectory, root);
  const libraryDirectory = path.dirname(
    path.join(held.directory, held.manifest.oliphaunt.libraryRelativePath),
  );
  if (process.platform === 'win32') env.PATH = [libraryDirectory, env.PATH].join(path.delimiter);
  else {
    const loader = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[loader] = [libraryDirectory, env[loader]].join(path.delimiter);
  }
  for (const key of Object.keys(env))
    if (/^(?:NODE_|BUN_|RUNFILES|TEST_SRCDIR)/iu.test(key)) delete env[key];
  env.NODE_PATH = '';
  env.NODE_OPTIONS = '';
  env.TMPDIR = path.join(root, 'tmp');
  env.TMP = env.TMPDIR;
  env.TEMP = env.TMPDIR;
  mkdirSync(env.TMPDIR);
  const consumer = path.join(root, 'consumer.mjs');
  writeFileSync(
    consumer,
    new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(
      readFileSync(source, 'utf8'),
    ),
  );
  const run = (mode: string, phase: string) =>
    Bun.spawnSync([node, consumer, mode, phase, path.join(root, `${mode}-database`)], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 90_000,
    });
  for (const mode of ['direct', 'broker'])
    for (const phase of ['write', 'read']) {
      const result = run(mode, phase);
      assert.equal(
        result.exitCode,
        0,
        `${mode}/${phase}: ${result.stderr.toString()}\n${result.stdout.toString()}`,
      );
    }
  for (const package_ of optional) {
    const metadata = path.join(package_.directory, 'package.json');
    writeFileSync(metadata, JSON.stringify({ ...package_.manifest, version: '99.0.0' }));
    try {
      const result = run(package_.manifest.oliphaunt?.brokerHelper ? 'broker' : 'direct', 'read');
      assert.notEqual(
        result.exitCode,
        0,
        'SDK accepted an incompatible installed optional version',
      );
      assert.match(result.stderr.toString(), /version 99\.0\.0 does not match @oliphaunt\/ts/iu);
    } finally {
      writeFileSync(metadata, JSON.stringify(package_.manifest));
    }
  }
  const contractHosts = JSON.parse(contractHostsJson) as string[];
  assert(
    Array.isArray(contractHosts) &&
      contractHosts.length > 0 &&
      new Set(contractHosts).size === contractHosts.length &&
      contractHosts.every((host) => ['node', 'bun', 'deno'].includes(host)),
    'native SDK contracts require explicit unique supported hosts',
  );
  if (contractHosts.includes('deno')) assert(deno, 'pinned Deno is required');
  const contracts = path.join(root, 'contracts');
  mkdirSync(contracts);
  const contractDatabases = path.join(root, 'contract-databases');
  mkdirSync(contractDatabases);
  const entry = path.join(contracts, 'native-smoke.mts');
  copyFileSync(contractEntry, entry);
  copyFileSync(contractAssertions, path.join(contracts, 'native-direct-contract.mts'));
  for (const host of contractHosts) {
    const command =
      host === 'node'
        ? [node, '--experimental-strip-types', entry]
        : host === 'bun'
          ? [process.execPath, '--no-install', '--no-env-file', entry]
          : [deno, 'run', '--no-config', '--node-modules-dir=manual', '--allow-all', entry];
    for (const phase of ['source', 'restored']) {
      const result = Bun.spawnSync(command, {
        cwd: root,
        env: {
          ...env,
          OLIPHAUNT_SMOKE_SDK: path.join(sdkPackage.directory, 'lib/index.js'),
          OLIPHAUNT_SMOKE_ROOT: contractDatabases,
          OLIPHAUNT_SMOKE_HOST: host,
          OLIPHAUNT_SMOKE_PHASE: phase,
          LIBOLIPHAUNT_PATH: path.join(held.directory, held.manifest.oliphaunt.libraryRelativePath),
          OLIPHAUNT_INSTALL_DIR: runtimeDirectory,
          OLIPHAUNT_RUNTIME_DIR: runtimeDirectory,
          OLIPHAUNT_BROKER: path.join(
            brokerPackage.directory,
            brokerPackage.manifest.oliphaunt.executableRelativePath,
          ),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 90_000,
        killSignal: 'SIGKILL',
      });
      assert.equal(
        result.exitCode,
        0,
        `original native SDK contract ${host}/${phase}: ${result.stderr.toString()}\n${result.stdout.toString()}`,
      );
    }
  }
  console.log(
    `Original installed native SDK contracts: ${contractHosts.join(', ')} source/restored: PASS`,
  );
  console.log(
    'Installed public native SDK: default optional resolution, held runtime, direct/broker init + process reopen, broker reap, three incompatible-version rejections: PASS',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
