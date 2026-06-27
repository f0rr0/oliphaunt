#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleExtensions = ['hstore', 'pg-trgm', 'unaccent'];
const localRegistrySourcePrefix = 'registry+file://';
const packageStartRe = /^\s*\[\[package\]\]\s*$/u;
const stringKeyRe = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/u;
const versionLineRe = /^(\s*version\s*=\s*)"[^"]*"(\s*(?:#.*)?)$/u;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function pathExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readVersionFile(relative) {
  return (await fs.readFile(path.join(root, relative), 'utf8')).trim();
}

async function readPackageVersion(relative) {
  const manifest = path.join(root, relative);
  const data = Bun.TOML.parse(await fs.readFile(manifest, 'utf8'));
  const pkg = data.package;
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
    fail(`${relative} is missing [package]`);
  }
  const { version } = pkg;
  if (typeof version !== 'string') {
    fail(`${relative} is missing package.version`);
  }
  return version;
}

async function readCargoManifest(relative) {
  return Bun.TOML.parse(await fs.readFile(path.join(root, relative), 'utf8'));
}

function objectTable(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function isWasixRuntimeArtifactDependency(name) {
  return (
    name === 'liboliphaunt-wasix-portable' ||
    name === 'oliphaunt-wasix-tools' ||
    name.startsWith('liboliphaunt-wasix-aot-') ||
    name.startsWith('oliphaunt-wasix-tools-aot-')
  );
}

function wasixRuntimeDependencyNames(manifest) {
  const names = new Set(['oliphaunt-wasix']);
  for (const name of Object.keys(objectTable(manifest.dependencies))) {
    if (isWasixRuntimeArtifactDependency(name)) {
      names.add(name);
    }
  }
  for (const target of Object.values(objectTable(manifest.target))) {
    for (const name of Object.keys(objectTable(objectTable(target).dependencies))) {
      if (isWasixRuntimeArtifactDependency(name)) {
        names.add(name);
      }
    }
  }
  const sorted = [...names].sort();
  for (const required of ['oliphaunt-wasix', 'liboliphaunt-wasix-portable', 'oliphaunt-wasix-tools']) {
    if (!names.has(required)) {
      fail(`oliphaunt-wasix manifest is missing required local-registry dependency ${required}`);
    }
  }
  if (!sorted.some((name) => name.startsWith('oliphaunt-wasix-tools-aot-'))) {
    fail('oliphaunt-wasix manifest is missing split tools-AOT dependencies');
  }
  return sorted;
}

function wasixAotTriplesFromDependencyNames(names) {
  const prefix = 'liboliphaunt-wasix-aot-';
  const triples = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .sort();
  if (triples.length === 0) {
    fail('oliphaunt-wasix manifest is missing runtime AOT dependencies');
  }
  return triples;
}

async function loadVersions() {
  const wasixManifest = await readCargoManifest('src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml');
  const wasixRuntimePackageNames = wasixRuntimeDependencyNames(wasixManifest);
  return {
    nativeRuntime: await readVersionFile('src/runtimes/liboliphaunt/native/VERSION'),
    wasixRuntime: await readVersionFile('src/runtimes/liboliphaunt/wasix/VERSION'),
    oliphaunt: await readPackageVersion('src/sdks/rust/Cargo.toml'),
    oliphauntBuild: await readPackageVersion('src/sdks/rust/crates/oliphaunt-build/Cargo.toml'),
    oliphauntWasix: await readPackageVersion('src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml'),
    brokerLinuxX64: await readPackageVersion('src/runtimes/broker/crates/linux-x64-gnu/Cargo.toml'),
    wasixRuntimePackageNames,
    wasixAotTriples: wasixAotTriplesFromDependencyNames(wasixRuntimePackageNames),
  };
}

function packageSpec(name, version) {
  return { name, version };
}

function wasixRuntimePackages(versions) {
  return versions.wasixRuntimePackageNames.map((name) =>
    packageSpec(name, name === 'oliphaunt-wasix' ? versions.oliphauntWasix : versions.wasixRuntime),
  );
}

function wasixExtensionPackages(versions) {
  const packages = [];
  for (const extension of exampleExtensions) {
    packages.push(packageSpec(`oliphaunt-extension-${extension}-wasix`, versions.wasixRuntime));
    for (const triple of versions.wasixAotTriples) {
      packages.push(packageSpec(`oliphaunt-extension-${extension}-wasix-aot-${triple}`, versions.wasixRuntime));
    }
  }
  return packages;
}

function nativeTauriPackages(versions) {
  return [
    packageSpec('oliphaunt', versions.oliphaunt),
    packageSpec('oliphaunt-build', versions.oliphauntBuild),
    packageSpec('liboliphaunt-native-linux-x64-gnu', versions.nativeRuntime),
    packageSpec('oliphaunt-tools', versions.nativeRuntime),
    packageSpec('oliphaunt-tools-linux-x64-gnu', versions.nativeRuntime),
    packageSpec('oliphaunt-broker-linux-x64-gnu', versions.brokerLinuxX64),
    ...exampleExtensions.map((extension) =>
      packageSpec(`oliphaunt-extension-${extension}-linux-x64-gnu`, versions.nativeRuntime),
    ),
  ];
}

const lockfiles = [
  {
    path: 'examples/tauri/src-tauri/Cargo.lock',
    expectedPackages: nativeTauriPackages,
  },
  {
    path: 'examples/tauri-wasix/src-tauri/Cargo.lock',
    expectedPackages: (versions) => [...wasixRuntimePackages(versions), ...wasixExtensionPackages(versions)],
  },
  {
    path: 'examples/electron-wasix/src-wasix/Cargo.lock',
    expectedPackages: (versions) => [...wasixRuntimePackages(versions), ...wasixExtensionPackages(versions)],
  },
  {
    path: 'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock',
    expectedPackages: wasixRuntimePackages,
  },
];

function stripNewline(line) {
  if (line.endsWith('\r\n')) {
    return [line.slice(0, -2), '\r\n'];
  }
  if (line.endsWith('\n')) {
    return [line.slice(0, -1), '\n'];
  }
  return [line, ''];
}

function stringKey(line, key) {
  const [body] = stripNewline(line);
  const match = body.match(stringKeyRe);
  return match?.[1] === key ? match[2] : null;
}

function replaceVersionLine(line, version) {
  const [body, newline] = stripNewline(line);
  const match = body.match(versionLineRe);
  if (!match) {
    fail(`cannot update Cargo.lock version line: ${line.trimEnd()}`);
  }
  return `${match[1]}"${version}"${match[2]}${newline}`;
}

function packageBlockRanges(lines) {
  const starts = [];
  for (const [index, line] of lines.entries()) {
    if (packageStartRe.test(line)) {
      starts.push(index);
    }
  }
  return starts.map((start, index) => [start, index + 1 < starts.length ? starts[index + 1] : lines.length]);
}

function splitLinesKeepEnds(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

async function cargoLockPackages(lockfile) {
  const data = Bun.TOML.parse(await fs.readFile(lockfile, 'utf8'));
  if (!Array.isArray(data.package)) {
    fail(`${rel(lockfile)} is missing [[package]] entries`);
  }
  return data.package.filter((pkg) => typeof pkg === 'object' && pkg !== null && typeof pkg.name === 'string');
}

function packageByName(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    const entries = byName.get(pkg.name) ?? [];
    entries.push(pkg);
    byName.set(pkg.name, entries);
  }
  return byName;
}

function fileUrlPath(url) {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

async function localRegistryIndexForPackage(pkg) {
  const candidates = [];
  const envIndex = process.env.CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX;
  if (typeof envIndex === 'string' && envIndex.length > 0) {
    candidates.push(envIndex.startsWith('file://') ? fileUrlPath(envIndex) : envIndex);
  }
  if (typeof pkg.source === 'string' && pkg.source.startsWith(localRegistrySourcePrefix)) {
    candidates.push(fileUrlPath(pkg.source.slice('registry+'.length)));
  }
  candidates.push(path.join(root, 'target/local-registries/cargo/index'));

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && (await pathExists(candidate))) {
      return candidate;
    }
  }
  return null;
}

function cargoIndexRelativePath(crateName) {
  const name = crateName.toLowerCase();
  if (name.length === 1) {
    return path.join('1', name);
  }
  if (name.length === 2) {
    return path.join('2', name);
  }
  if (name.length === 3) {
    return path.join('3', name[0], name);
  }
  return path.join(name.slice(0, 2), name.slice(2, 4), name);
}

async function cargoIndexChecksum(indexDir, crateName, version) {
  const indexPath = path.join(indexDir, cargoIndexRelativePath(crateName));
  const text = await fs.readFile(indexPath, 'utf8');
  for (const line of text.split(/\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = JSON.parse(line);
    if (entry.name === crateName && entry.vers === version) {
      return entry.cksum;
    }
  }
  return null;
}

async function checkLocalRegistryChecksums(lockfile, packages) {
  const failures = [];
  for (const pkg of packages) {
    if (typeof pkg.source !== 'string' || !pkg.source.startsWith(localRegistrySourcePrefix)) {
      continue;
    }
    if (typeof pkg.version !== 'string' || typeof pkg.checksum !== 'string') {
      failures.push(`${rel(lockfile)}: ${pkg.name} is missing version/checksum`);
      continue;
    }
    const indexDir = await localRegistryIndexForPackage(pkg);
    if (indexDir === null) {
      continue;
    }
    const expected = await cargoIndexChecksum(indexDir, pkg.name, pkg.version);
    if (expected === null) {
      failures.push(`${rel(lockfile)}: ${pkg.name} ${pkg.version} is missing from ${rel(indexDir)}`);
    } else if (pkg.checksum !== expected) {
      failures.push(
        `${rel(lockfile)}: ${pkg.name} ${pkg.version} checksum ${pkg.checksum} does not match local registry ${expected}`,
      );
    }
  }
  return failures;
}

function validateExpectedPackages(lockfile, packages, expectedPackages) {
  const byName = packageByName(packages);
  const failures = [];
  for (const expected of expectedPackages) {
    const entries = byName.get(expected.name) ?? [];
    if (entries.length === 0) {
      failures.push(`${rel(lockfile)} is missing ${expected.name}`);
      continue;
    }
    if (!entries.some((entry) => entry.version === expected.version)) {
      const actual = entries.map((entry) => entry.version).join(', ');
      failures.push(`${rel(lockfile)} has ${expected.name} version ${actual}; expected ${expected.version}`);
    }
    if (!entries.some((entry) => typeof entry.source === 'string' && entry.source.startsWith(localRegistrySourcePrefix))) {
      failures.push(`${rel(lockfile)} must resolve ${expected.name} from the local Cargo registry`);
    }
  }
  return failures;
}

function syncPathPackageVersions(lockfile, lines, versionsByName, { check }) {
  const changes = [];

  for (const [start, end] of packageBlockRanges(lines)) {
    const block = lines.slice(start, end);
    let name = null;
    let versionIndex = null;
    let currentVersion = null;
    let hasSource = false;

    for (const [offset, line] of block.entries()) {
      if (stringKey(line, 'source') !== null) {
        hasSource = true;
      }
      const keyName = stringKey(line, 'name');
      if (keyName !== null) {
        name = keyName;
      }
      const keyVersion = stringKey(line, 'version');
      if (keyVersion !== null) {
        versionIndex = start + offset;
        currentVersion = keyVersion;
      }
    }

    if (name === null || hasSource || !versionsByName.has(name)) {
      continue;
    }
    if (versionIndex === null || currentVersion === null) {
      fail(`${rel(lockfile)} package ${name} is missing version`);
    }

    const expectedVersion = versionsByName.get(name);
    if (currentVersion !== expectedVersion) {
      if (!check) {
        lines[versionIndex] = replaceVersionLine(lines[versionIndex], expectedVersion);
      }
      changes.push(`${rel(lockfile)}: ${name} ${currentVersion} -> ${expectedVersion}`);
    }
  }

  return changes;
}

async function syncLockfile(lockfileConfig, versions, { check }) {
  const lockfile = path.join(root, lockfileConfig.path);
  const expectedPackages = lockfileConfig.expectedPackages(versions);
  const expectedVersions = new Map(expectedPackages.map((pkg) => [pkg.name, pkg.version]));
  const packages = await cargoLockPackages(lockfile);
  const text = await fs.readFile(lockfile, 'utf8');
  const lines = splitLinesKeepEnds(text);
  const changes = syncPathPackageVersions(lockfile, lines, expectedVersions, { check });
  const failures = [
    ...validateExpectedPackages(lockfile, packages, expectedPackages),
    ...(await checkLocalRegistryChecksums(lockfile, packages)),
  ];

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    fail(
      'registry-sourced example lockfiles are stale; run Cargo update through `examples/tools/with-local-registries.sh` after staging the local Cargo registry',
    );
  }
  if (changes.length > 0 && !check) {
    await fs.writeFile(lockfile, lines.join(''));
  }
  return changes;
}

function parseArgs(argv) {
  let check = false;
  for (const arg of argv) {
    if (arg === '--check') {
      check = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { check };
}

const args = parseArgs(Bun.argv.slice(2));
const versions = await loadVersions();
const allChanges = [];
for (const lockfile of lockfiles) {
  allChanges.push(...(await syncLockfile(lockfile, versions, { check: args.check })));
}

if (allChanges.length === 0) {
  console.log('example lockfiles match local-registry package versions and checksums');
  process.exit(0);
}

for (const change of allChanges) {
  console.error(change);
}
if (args.check) {
  console.error('example lockfiles are stale; run `tools/release/sync-example-lockfiles.mjs`');
  process.exit(1);
}

console.log('updated example lockfiles');
