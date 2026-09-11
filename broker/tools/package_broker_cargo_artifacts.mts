#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageGeneratedCargoSource } from '../../tools/packaging/cargo-source-package.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../tools/packaging/release-notices.mts';
import {
  parseWindowsVcRuntimeReceipt,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from '../../tools/packaging/windows-vc-runtime-closure.mts';
import {
  assertBrokerDependencyLicensesInDirectory,
  assertBrokerDependencyLicensesInEntries,
  BROKER_PAYLOAD_LICENSE,
  brokerDependencyLicenseMembers,
  normalizeBrokerDependencyLicenseModes,
} from './broker-dependency-license-contract.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const PRODUCT = 'oliphaunt-broker';
const BROKER_CARRIER_LICENSE = BROKER_PAYLOAD_LICENSE;
const BROKER_NOTICE_OPTIONS = Object.freeze({ profile: 'broker' });
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
const TARGETS = ['linux-arm64-gnu', 'linux-x64-gnu', 'macos-arm64', 'windows-x64-msvc'];

function fail(message) {
  throw new Error(`package_broker_cargo_artifacts.mts: ${message}`);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith('..') ? file : relative;
}

function usage() {
  fail(
    'usage: package_broker_cargo_artifacts.mts [--asset-dir DIR] [--output-dir DIR] [--source-output-dir DIR] [--target TARGET]... [--version VERSION]',
  );
}

function optionValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    usage();
  }
  return value;
}

async function parseArgs(argv) {
  const args = {
    assetDir: 'target/oliphaunt-broker/release-assets',
    outputDir: 'target/oliphaunt-broker/cargo-artifacts',
    sourceOutputDir: undefined,
    targets: [],
    version: undefined,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--asset-dir') {
      args.assetDir = optionValue(argv, index);
      index += 2;
    } else if (arg === '--output-dir') {
      args.outputDir = optionValue(argv, index);
      index += 2;
    } else if (arg === '--source-output-dir') {
      args.sourceOutputDir = optionValue(argv, index);
      index += 2;
    } else if (arg === '--target') {
      args.targets.push(optionValue(argv, index));
      index += 2;
    } else if (arg === '--version') {
      args.version = optionValue(argv, index);
      index += 2;
    } else {
      usage();
    }
  }
  return {
    assetDir: repoPath(args.assetDir),
    outputDir: repoPath(args.outputDir),
    sourceOutputDir:
      args.sourceOutputDir === undefined ? undefined : repoPath(args.sourceOutputDir),
    targets: args.targets,
    version: args.version ?? (await currentVersion()),
  };
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

async function currentVersion() {
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, '.release-please-manifest.json'), 'utf8'),
  );
  const version = manifest['broker'];
  if (typeof version !== 'string' || version.length === 0) {
    fail('.release-please-manifest.json is missing broker');
  }
  return version;
}

function cargoPackageName(targetId) {
  return `${PRODUCT}-${targetId}`;
}

function cargoLinksName(targetId) {
  return `oliphaunt_artifact_broker_${targetId.replaceAll('-', '_')}`;
}

function sourceCrateDir(targetId) {
  return path.join(ROOT, 'broker/crates', targetId);
}

async function isDirectory(file) {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function extractMember(entries, memberName, destination) {
  const entry = entries.get(memberName);
  if (!entry?.isFile || entry.isSymbolicLink) fail(`missing regular archive member ${memberName}`);
  if (entry.size > 32 * 1024 * 1024) fail(`archive member exceeds 32 MiB: ${memberName}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, entry.data());
}

function targetFromSource(targetId, version) {
  return {
    target: targetId,
    packageName: cargoPackageName(targetId),
    sourceDir: sourceCrateDir(targetId),
    archiveName: `${PRODUCT}-${version}-${targetId}.${targetId === 'windows-x64-msvc' ? 'zip' : 'tar.gz'}`,
  };
}

async function copySourceCrate(target, crateDir, version) {
  if (!(await isDirectory(target.sourceDir))) {
    fail(`${target.target} source Cargo artifact crate is missing: ${rel(target.sourceDir)}`);
  }
  await rm(crateDir, { recursive: true, force: true });
  await cp(target.sourceDir, crateDir, { recursive: true });
  const cargoTomlPath = path.join(crateDir, 'Cargo.toml');
  const cargoToml = await readFile(cargoTomlPath, 'utf8');
  const metadata = Bun.TOML.parse(cargoToml);
  const expectedLinks = cargoLinksName(target.target);
  if (metadata?.package?.name !== target.packageName) {
    fail(
      `${rel(path.join(target.sourceDir, 'Cargo.toml'))} has package.name=${JSON.stringify(metadata?.package?.name)}, expected ${target.packageName}`,
    );
  }
  if (metadata?.package?.version !== version) {
    fail(
      `${rel(path.join(target.sourceDir, 'Cargo.toml'))} has package.version=${JSON.stringify(metadata?.package?.version)}, expected ${version}`,
    );
  }
  if (metadata?.package?.license !== BROKER_CARRIER_LICENSE) {
    fail(
      `${rel(path.join(target.sourceDir, 'Cargo.toml'))} has package.license=${JSON.stringify(metadata?.package?.license)}, ` +
        `expected ${BROKER_CARRIER_LICENSE}`,
    );
  }
  if (metadata?.package?.links !== expectedLinks) {
    fail(
      `${rel(path.join(target.sourceDir, 'Cargo.toml'))} has package.links=${JSON.stringify(metadata?.package?.links)}, expected ${expectedLinks}`,
    );
  }
  if (metadata?.package?.build !== 'build.rs') {
    fail(`${rel(path.join(target.sourceDir, 'Cargo.toml'))} must declare build = "build.rs"`);
  }
  const libRsPath = path.join(crateDir, 'src/lib.rs');
  const libRs = await readFile(libRsPath, 'utf8');
  const constants = Object.fromEntries(
    [...libRs.matchAll(/pub const ([A-Z_]+): &str = "([^"]+)";/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  for (const [key, value] of Object.entries({
    PRODUCT,
    KIND: 'broker-helper',
    RELEASE_TARGET: target.target,
  })) {
    if (constants[key] !== value) {
      fail(
        `${rel(path.join(target.sourceDir, 'src/lib.rs'))} has ${key}=${JSON.stringify(constants[key])}, expected ${value}`,
      );
    }
  }
  if (typeof constants.CARGO_TARGET !== 'string' || constants.CARGO_TARGET.length === 0) {
    fail(`${rel(path.join(target.sourceDir, 'src/lib.rs'))} must declare CARGO_TARGET`);
  }
  if (
    typeof constants.EXECUTABLE_RELATIVE_PATH !== 'string' ||
    constants.EXECUTABLE_RELATIVE_PATH.length === 0
  ) {
    fail(`${rel(path.join(target.sourceDir, 'src/lib.rs'))} must declare EXECUTABLE_RELATIVE_PATH`);
  }
  target.executableRelativePath = constants.EXECUTABLE_RELATIVE_PATH;
  stageReleaseNotices(crateDir, BROKER_NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(crateDir, BROKER_NOTICE_OPTIONS);
}

async function sha256File(file) {
  const digest = createHash('sha256');
  for await (const chunk of Bun.file(file).stream()) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function validateCrate(cratePath, packageName, version, payloadMembers, targetId) {
  if (!(await isFile(cratePath))) {
    fail(`missing generated Cargo crate ${rel(cratePath)}`);
  }
  const size = (await stat(cratePath)).size;
  if (size > CRATES_IO_MAX_BYTES) {
    fail(`${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
  const expected = new Set([
    `${packageName}-${version}/Cargo.toml`,
    `${packageName}-${version}/README.md`,
    `${packageName}-${version}/build.rs`,
    `${packageName}-${version}/src/lib.rs`,
    `${packageName}-${version}/payload/sha256`,
    ...releaseNoticeRows(BROKER_NOTICE_OPTIONS).map(
      (row) => `${packageName}-${version}/${row.member}`,
    ),
    ...brokerDependencyLicenseMembers(targetId, { prefix: `${packageName}-${version}` }),
    ...payloadMembers.map((member) => `${packageName}-${version}/payload/${member}`),
  ]);
  const entries = readPortableArchiveEntries(cratePath);
  const names = new Set([...entries].filter(([, entry]) => entry.isFile).map(([name]) => name));
  const missing = [...expected].filter((name) => !names.has(name)).sort();
  if (missing.length > 0) {
    fail(`${rel(cratePath)} is missing package members: ${missing.join(', ')}`);
  }
  assertBrokerDependencyLicensesInEntries(entries, {
    target: targetId,
    prefix: `${packageName}-${version}`,
  });
}

async function prepareTarget(target, { version, assetDir, sourceRoot }) {
  const crateDir = path.join(sourceRoot, target.packageName);
  await copySourceCrate(target, crateDir, version);
  const archive = path.join(assetDir, target.archiveName);
  if (!(await isFile(archive))) {
    fail(`missing broker release asset: ${rel(archive)}`);
  }
  const entries = readPortableArchiveEntries(archive);
  assertBrokerDependencyLicensesInEntries(entries, { target: target.target, label: rel(archive) });
  for (const member of brokerDependencyLicenseMembers(target.target)) {
    const destination = path.join(crateDir, ...member.split('/'));
    await extractMember(entries, member, destination);
    await chmod(destination, 0o644);
  }
  normalizeBrokerDependencyLicenseModes(crateDir, target.target);
  assertBrokerDependencyLicensesInDirectory(crateDir, { target: target.target });
  const payload = path.join(crateDir, 'payload', target.executableRelativePath);
  await extractMember(entries, target.executableRelativePath, payload);
  if ((await stat(payload)).size <= 0) {
    fail(`${rel(payload)} must be a non-empty broker helper payload`);
  }
  await chmod(payload, 0o755);
  const payloadMembers = [target.executableRelativePath];
  if (target.target === 'windows-x64-msvc') {
    const receiptRelativePath = `bin/${WINDOWS_VC_RUNTIME_RECEIPT}`;
    const receiptPath = path.join(crateDir, 'payload', receiptRelativePath);
    await extractMember(entries, receiptRelativePath, receiptPath);
    const receipt = parseWindowsVcRuntimeReceipt(
      await readFile(receiptPath),
      `${rel(archive)}:${receiptRelativePath}`,
    );
    payloadMembers.push(receiptRelativePath);
    for (const [name, digest] of receipt) {
      const relativePath = `bin/${name}`;
      const destination = path.join(crateDir, 'payload', relativePath);
      await extractMember(entries, relativePath, destination);
      if ((await sha256File(destination)) !== digest) {
        fail(`${rel(archive)} ${relativePath} does not match ${receiptRelativePath}`);
      }
      payloadMembers.push(relativePath);
    }
  }
  payloadMembers.sort();
  const checksumText =
    target.target === 'windows-x64-msvc'
      ? `${(await Promise.all(payloadMembers.map(async (member) => `${await sha256File(path.join(crateDir, 'payload', member))}  ${member}`))).join('\n')}\n`
      : `${await sha256File(payload)}\n`;
  await writeFile(path.join(crateDir, 'payload/sha256'), checksumText, 'utf8');
  return { ...target, crateDir, payloadMembers };
}

export async function packageBrokerCargoArtifacts(argv = []) {
  const args = await parseArgs(argv);
  if (!(await isDirectory(args.assetDir)))
    fail(`broker release asset directory does not exist: ${rel(args.assetDir)}`);
  const unknown = args.targets.filter((target) => !TARGETS.includes(target));
  if (unknown.length) fail(`unsupported broker target(s): ${unknown.join(', ')}`);
  const workParent = path.join(ROOT, 'target/oliphaunt-broker/cargo-package-runs');
  await mkdir(workParent, { recursive: true });
  const workRoot = await mkdtemp(path.join(workParent, 'run-'));
  try {
    const sourceRoot = args.sourceOutputDir ?? path.join(workRoot, 'sources');
    for (const directory of [args.outputDir, sourceRoot]) {
      for (const input of [ROOT, args.assetDir]) {
        const relative = path.relative(directory, input);
        if (
          relative === '' ||
          (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
        )
          fail(`output directory must not contain repository or input assets: ${directory}`);
      }
    }
    await mkdir(sourceRoot, { recursive: true });
    await rm(args.outputDir, { recursive: true, force: true });
    await mkdir(args.outputDir, { recursive: true });
    for (const targetId of TARGETS.filter(
      (target) => !args.targets.length || args.targets.includes(target),
    )) {
      const target = await prepareTarget(targetFromSource(targetId, args.version), {
        ...args,
        sourceRoot,
      });
      const packaged = packageGeneratedCargoSource(
        path.join(target.crateDir, 'Cargo.toml'),
        args.outputDir,
        { fail, rel },
      );
      await validateCrate(
        packaged,
        target.packageName,
        args.version,
        target.payloadMembers,
        target.target,
      );
      console.log(rel(packaged));
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await packageBrokerCargoArtifacts(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
