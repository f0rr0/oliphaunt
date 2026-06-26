#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lockfiles = [
  'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock',
];
const internalPackageManifests = [
  'src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/aot/aarch64-apple-darwin/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/aot/aarch64-unknown-linux-gnu/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/aot/x86_64-pc-windows-msvc/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/aot/x86_64-unknown-linux-gnu/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/tools-aot/aarch64-apple-darwin/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/tools-aot/aarch64-unknown-linux-gnu/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/tools-aot/x86_64-pc-windows-msvc/Cargo.toml',
  'src/runtimes/liboliphaunt/wasix/crates/tools-aot/x86_64-unknown-linux-gnu/Cargo.toml',
];
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

async function loadInternalVersions() {
  const versions = new Map();
  for (const relative of internalPackageManifests) {
    const manifest = path.join(root, relative);
    const data = Bun.TOML.parse(await fs.readFile(manifest, 'utf8'));
    const pkg = data.package;
    if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
      fail(`${relative} is missing [package]`);
    }
    const { name, version } = pkg;
    if (typeof name !== 'string' || typeof version !== 'string') {
      fail(`${relative} is missing package.name/version`);
    }
    versions.set(name, version);
  }
  return versions;
}

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

async function checkLockfileContainsInternalPackages(lockfile, versions) {
  const data = Bun.TOML.parse(await fs.readFile(lockfile, 'utf8'));
  if (!Array.isArray(data.package)) {
    fail(`${rel(lockfile)} is missing [[package]] entries`);
  }
  const present = new Set(
    data.package
      .filter((pkg) => typeof pkg === 'object' && pkg !== null && typeof pkg.name === 'string')
      .map((pkg) => pkg.name),
  );
  const missing = [...versions.keys()].filter((name) => !present.has(name)).sort();
  if (missing.length > 0) {
    fail(`${rel(lockfile)} is missing internal Oliphaunt packages: ${missing.join(', ')}`);
  }
}

async function syncLockfile(lockfile, versions, { check }) {
  await checkLockfileContainsInternalPackages(lockfile, versions);
  const text = await fs.readFile(lockfile, 'utf8');
  const lines = splitLinesKeepEnds(text);
  const changes = [];
  const registryChanges = [];

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

    if (!versions.has(name) || hasSource) {
      continue;
    }
    if (versionIndex === null || currentVersion === null) {
      fail(`${rel(lockfile)} package ${name} is missing version`);
    }

    const expectedVersion = versions.get(name);
    if (currentVersion !== expectedVersion) {
      if (hasSource) {
        registryChanges.push(`${rel(lockfile)}: ${name} ${currentVersion} -> ${expectedVersion}`);
        continue;
      }
      if (!check) {
        lines[versionIndex] = replaceVersionLine(lines[versionIndex], expectedVersion);
      }
      changes.push(`${rel(lockfile)}: ${name} ${currentVersion} -> ${expectedVersion}`);
    }
  }

  if (registryChanges.length > 0) {
    for (const change of registryChanges) {
      console.error(change);
    }
    fail(
      'registry-sourced example lockfiles are stale; run Cargo update through `examples/tools/with-local-registries.sh` after staging the local registry',
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
const versions = await loadInternalVersions();
const allChanges = [];
for (const relative of lockfiles) {
  const lockfile = path.join(root, relative);
  allChanges.push(...(await syncLockfile(lockfile, versions, { check: args.check })));
}

if (allChanges.length === 0) {
  console.log('example lockfiles match internal package versions');
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
