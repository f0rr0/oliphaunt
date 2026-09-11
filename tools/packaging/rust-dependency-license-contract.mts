import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPortableArchiveEntries } from './portable-archive.mts';
import { requireSafeDirectoryChain as requireReleaseDirectoryChain } from './release-directory-safety.mts';
import { assertReleaseNoticesInEntries } from './release-notices.mts';

export function createRustDependencyLicenseContract({
  owner,
  product,
  payloadLicense,
  noticeProfile = 'source-sdk',
  targets,
}) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const TOOL = `${product} dependency licenses`;
  const CONTRACT_PATH = path.join(ROOT, owner, 'dependency-licenses.json');
  const BLOB_ROOT = path.join(ROOT, owner, 'dependency-license-blobs');
  const CARGO_LOCK_PATH = path.join(ROOT, 'Cargo.lock');
  const CARGO_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';
  const CONTRACT_SCHEMA = `${product}-dependency-license-contract-v1`;
  const INDEX_SCHEMA = `${product}-target-dependency-license-index-v1`;

  const RUST_DEPENDENCY_LICENSE_ROOT = 'THIRD_PARTY_LICENSES/rust';
  const RUST_PAYLOAD_LICENSE = payloadLicense;

  const TARGET_ROWS = Object.freeze(
    targets ?? [
      Object.freeze({ id: 'linux-x64-gnu', cargoTarget: 'x86_64-unknown-linux-gnu' }),
      Object.freeze({ id: 'linux-arm64-gnu', cargoTarget: 'aarch64-unknown-linux-gnu' }),
      Object.freeze({ id: 'macos-arm64', cargoTarget: 'aarch64-apple-darwin' }),
      Object.freeze({ id: 'windows-x64-msvc', cargoTarget: 'x86_64-pc-windows-msvc' }),
    ],
  );
  const TARGET_IDS = Object.freeze(TARGET_ROWS.map(({ id }) => id));
  const TARGET_BY_ID = new Map(TARGET_ROWS.map((row) => [row.id, row]));
  const PAYLOAD_LICENSE_ATOMS = Object.freeze(payloadLicense.split(' AND '));
  const LEGAL_BASENAME_PREFIXES = Object.freeze([
    'acknowledg',
    'authors',
    'copying',
    'copyright',
    'credits',
    'legal',
    'license',
    'notice',
    'patents',
    'unlicense',
  ]);
  const LEGAL_BASENAME_FRAGMENTS = Object.freeze(['third-party', 'third_party', 'thirdparty']);
  const HEX_64 = /^[0-9a-f]{64}$/u;
  const PACKAGE_KEY = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[^\s/\\]+$/u;
  const SAFE_MEMBER =
    /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f])[^/]+(?:\/[^/]+)*$/u;

  let validatedDefaultContract;

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function fail(message) {
    throw new Error(`${TOOL}: ${message}`);
  }

  function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  function renderBase64(bytes) {
    return `${
      bytes
        .toString('base64')
        .match(/.{1,76}/gu)
        ?.join('\n') ?? ''
    }\n`;
  }

  function canonicalBlobBytes(digest, expectedBytes) {
    const file = path.join(BLOB_ROOT, `${digest}.base64`);
    requireRealFile(file, 'canonical Rust dependency license blob');
    const encoded = readFileSync(file, 'utf8');
    if (!/^(?:[A-Za-z0-9+/=]{1,76}\n)+$/u.test(encoded)) {
      fail(`canonical Rust dependency license blob is not wrapped base64 text: ${file}`);
    }
    const content = Buffer.from(encoded.replaceAll('\n', ''), 'base64');
    if (
      content.length !== expectedBytes ||
      sha256(content) !== digest ||
      encoded !== renderBase64(content)
    ) {
      fail(
        `canonical Rust dependency license blob does not match ${digest}/${expectedBytes}: ${file}`,
      );
    }
    return content;
  }

  function packageKey(row) {
    return `${row.name}@${row.version}`;
  }

  function isAllowedRustPathPackageMetadataRow(row, workspaceMembers) {
    if (
      !row ||
      typeof row !== 'object' ||
      row.source !== null ||
      row.license !== 'MIT' ||
      !workspaceMembers.has(row.id) ||
      typeof row.name !== 'string' ||
      typeof row.version !== 'string' ||
      row.version.length === 0 ||
      typeof row.manifest_path !== 'string'
    ) {
      return false;
    }
    try {
      const manifest = realpathSync(row.manifest_path);
      const relative = path.relative(realpathSync(ROOT), manifest);
      return (
        relative !== '' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        path.basename(manifest) === 'Cargo.toml'
      );
    } catch {
      return false;
    }
  }

  function sameStrings(actual, expected) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  function exactObjectKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }
    const actual = Object.keys(value);
    if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
      fail(`${label} keys must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  function hasCanonicalRustFilesystemMode(mode, expectedMode, platform = process.platform) {
    // Windows exposes synthetic Unix permission bits through stat(2). chmod can
    // toggle the read-only attribute, but it cannot establish meaningful 0644
    // or 0755 filesystem metadata. Published archives still carry and validate
    // their explicit portable modes in assertRustDependencyLicensesInEntries.
    return platform === 'win32' || (mode & 0o777) === expectedMode;
  }

  function hasSafeRustSourceFilesystemMode(mode, platform = process.platform) {
    if (platform === 'win32') return true;
    const permissions = mode & 0o777;
    // Git records only the executable bit for regular files; checkout read/write
    // bits reflect the host umask. Staged and archived members are normalized and
    // verified as exact 0644, so source inputs need only be readable and non-executable.
    return (permissions & 0o444) !== 0 && (permissions & 0o111) === 0;
  }

  function requireRealFile(file, label) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch (cause) {
      fail(`${label} cannot be inspected: ${file}: ${cause.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`${label} must be a regular non-symlink file: ${file}`);
    }
    if (!hasSafeRustSourceFilesystemMode(stat.mode)) {
      fail(`${label} must have a safe non-executable mode derived from 0644: ${file}`);
    }
    return stat;
  }

  function requireRealDirectory(directory, label) {
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (cause) {
      fail(`${label} cannot be inspected: ${directory}: ${cause.message}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`${label} must be a real non-symlink directory: ${directory}`);
    }
    return stat;
  }

  function ensureSafeDirectoryChain(directory, label) {
    try {
      return requireReleaseDirectoryChain(directory, { create: true, label });
    } catch (cause) {
      fail(cause.message);
    }
  }

  function requireSafeDirectoryChain(directory, label) {
    try {
      return requireReleaseDirectoryChain(directory, { label });
    } catch (cause) {
      fail(cause.message);
    }
  }

  function safeMember(value, label) {
    if (typeof value !== 'string' || !SAFE_MEMBER.test(value)) {
      fail(`${label} is not a safe portable member path: ${JSON.stringify(value)}`);
    }
    return value;
  }

  function targetRow(target) {
    const row = TARGET_BY_ID.get(target);
    if (!row) {
      fail(`unsupported Rust target ${JSON.stringify(target)}; expected ${TARGET_IDS.join(', ')}`);
    }
    return row;
  }

  function canonicalJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  function legalSourceFile(relative) {
    const basename = path.posix.basename(relative).toLowerCase();
    return (
      LEGAL_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix)) ||
      LEGAL_BASENAME_FRAGMENTS.some((fragment) => basename.includes(fragment))
    );
  }

  function walkRegularFiles(root, relative = '') {
    const files = [];
    for (const name of readdirSync(path.join(root, ...relative.split('/').filter(Boolean))).sort(
      compareText,
    )) {
      const member = relative ? `${relative}/${name}` : name;
      const file = path.join(root, ...member.split('/'));
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        fail(`source dependency legal inventory contains a symlink: ${file}`);
      }
      if (stat.isDirectory()) {
        files.push(...walkRegularFiles(root, member));
      } else if (stat.isFile()) {
        files.push(member);
      }
    }
    return files;
  }

  function readCargoSnapshot(graphDirectory, file) {
    const snapshot = path.join(graphDirectory, file);
    const metadata = requireRealFile(snapshot, 'Rust Cargo snapshot');
    if (metadata.size > 128 * 1024 * 1024) fail('Rust Cargo snapshot exceeds 128 MiB');
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(snapshot));
  }

  function cargoTreePackageKeys(cargoTarget, metadataPackages, graphDirectory, workspaceMembers) {
    const output = readCargoSnapshot(graphDirectory, `${cargoTarget}.tree`);
    const keys = new Set();
    for (const rawLine of output.split(/\r?\n/u)) {
      const line = rawLine.replace(/ \(\*\)$/u, '').trim();
      if (!line) continue;
      const match = /^([^\s]+) v([^\s]+)/u.exec(line);
      if (!match) {
        fail(`cannot parse cargo tree package line for ${cargoTarget}: ${JSON.stringify(rawLine)}`);
      }
      const key = `${match[1]}@${match[2]}`;
      const candidates = metadataPackages.get(key) ?? [];
      if (candidates.length === 0) {
        fail(`cargo tree package ${key} is absent from cargo metadata`);
      }
      const registry = candidates.filter((row) => row.source === CARGO_SOURCE);
      if (registry.length === 1) {
        keys.add(key);
        continue;
      }
      if (registry.length > 1) {
        fail(`cargo metadata has duplicate crates.io identities for ${key}`);
      }
      const pathPackages = candidates.filter((row) =>
        isAllowedRustPathPackageMetadataRow(row, workspaceMembers),
      );
      if (pathPackages.length !== 1) {
        fail(`Rust graph contains unsupported non-crates.io dependency ${key}`);
      }
    }
    return [...keys].sort(compareText);
  }

  function payloadLicenseAtoms(selectedLicense) {
    const atoms = selectedLicense.split(' AND ');
    if (atoms.length === 0 || atoms.some((atom) => !PAYLOAD_LICENSE_ATOMS.includes(atom))) {
      fail(`unsupported selected license expression ${JSON.stringify(selectedLicense)}`);
    }
    return atoms;
  }

  function selectedLicenseIsCompatible(row) {
    for (const atom of payloadLicenseAtoms(row.selectedLicense)) {
      if (atom === 'CC-BY-3.0') {
        if (
          !row.licenseFiles.some(({ name }) =>
            LEGAL_BASENAME_FRAGMENTS.some((fragment) => name.toLowerCase().includes(fragment)),
          )
        ) {
          fail(
            `${packageKey(row)} selects CC-BY-3.0 without an exact third-party attribution file`,
          );
        }
      } else if (atom === 'BSD-3-Clause') {
        if (
          !row.licenseFiles.some(
            ({ name }) => name.toLowerCase().includes('bsd') || name === 'zstd/LICENSE',
          )
        ) {
          fail(`${packageKey(row)} selects BSD-3-Clause without an exact BSD license file`);
        }
      } else if (atom === 'Unicode-3.0') {
        if (!row.declaredLicense.includes('Unicode-3.0')) {
          fail(`${packageKey(row)} selects Unicode-3.0 but its declared license does not`);
        }
      } else if (!row.declaredLicense.includes(atom)) {
        fail(`${packageKey(row)} selects ${atom} but declares ${row.declaredLicense}`);
      }
    }
  }

  function validateContractShape(contract) {
    exactObjectKeys(
      contract,
      ['schema', 'product', 'cargoSource', 'payloadLicense', 'targets', 'packages'],
      'Rust dependency license contract',
    );
    if (contract.schema !== CONTRACT_SCHEMA) fail(`contract schema must be ${CONTRACT_SCHEMA}`);
    if (contract.product !== product) fail(`contract product must be ${product}`);
    if (contract.cargoSource !== CARGO_SOURCE) fail(`contract cargoSource must be ${CARGO_SOURCE}`);
    if (contract.payloadLicense !== RUST_PAYLOAD_LICENSE) {
      fail(`contract payloadLicense must be ${RUST_PAYLOAD_LICENSE}`);
    }
    if (!Array.isArray(contract.packages) || contract.packages.length === 0) {
      fail('contract packages must be a non-empty array');
    }
    exactObjectKeys(contract.targets, TARGET_IDS, 'contract targets');

    const packages = new Map();
    const actualPackageOrder = [];
    const selectedAtoms = new Set();
    for (const row of contract.packages) {
      exactObjectKeys(
        row,
        [
          'name',
          'version',
          'checksum',
          'declaredLicense',
          'selectedLicense',
          'targets',
          'licenseFiles',
        ],
        'contract package',
      );
      const key = packageKey(row);
      if (!PACKAGE_KEY.test(key)) fail(`invalid contract package identity ${JSON.stringify(key)}`);
      if (packages.has(key)) fail(`duplicate contract package ${key}`);
      if (!HEX_64.test(row.checksum)) fail(`${key} has invalid Cargo checksum`);
      if (typeof row.declaredLicense !== 'string' || !row.declaredLicense)
        fail(`${key} has no declaredLicense`);
      if (typeof row.selectedLicense !== 'string' || !row.selectedLicense)
        fail(`${key} has no selectedLicense`);
      selectedLicenseIsCompatible(row);
      for (const atom of payloadLicenseAtoms(row.selectedLicense)) selectedAtoms.add(atom);
      if (
        !Array.isArray(row.targets) ||
        row.targets.length === 0 ||
        !sameStrings(row.targets, [...new Set(row.targets)].sort(compareText)) ||
        row.targets.some((target) => !TARGET_BY_ID.has(target))
      ) {
        fail(`${key} targets must be a sorted, unique, non-empty supported-target list`);
      }
      if (!Array.isArray(row.licenseFiles) || row.licenseFiles.length === 0) {
        fail(`${key} must pin at least one legal source file`);
      }
      const legalNames = [];
      for (const file of row.licenseFiles) {
        exactObjectKeys(
          file,
          ['name', 'sha256', 'bytes', ...(file.upstream ? ['upstream'] : [])],
          `${key} legal file`,
        );
        safeMember(file.name, `${key} legal file name`);
        if (!legalSourceFile(file.name)) {
          fail(
            `${key} legal file does not match the fail-closed legal-file classifier: ${file.name}`,
          );
        }
        if (!HEX_64.test(file.sha256)) fail(`${key} ${file.name} has invalid sha256`);
        if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0)
          fail(`${key} ${file.name} has invalid byte count`);
        if (file.upstream) {
          exactObjectKeys(
            file.upstream,
            ['repository', 'commit', 'path'],
            `${key} upstream license`,
          );
          const repository = new URL(file.upstream.repository);
          if (
            repository.protocol !== 'https:' ||
            repository.username ||
            repository.password ||
            repository.search ||
            repository.hash ||
            !/^[a-f0-9]{40}$/.test(file.upstream.commit)
          )
            fail(`${key} upstream license must identify an HTTPS repository and exact Git commit`);
          safeMember(file.upstream.path, `${key} upstream license path`);
          if (!legalSourceFile(file.upstream.path))
            fail(`${key} upstream path is not a legal file`);
        }
        legalNames.push(file.name);
      }
      if (!sameStrings(legalNames, [...new Set(legalNames)].sort(compareText))) {
        fail(`${key} legal files must be sorted and unique by source member`);
      }
      packages.set(key, row);
      actualPackageOrder.push(key);
    }
    if (!sameStrings(actualPackageOrder, [...actualPackageOrder].sort(compareText))) {
      fail('contract packages must be sorted by name@version');
    }
    if (
      !sameStrings(
        [...selectedAtoms].sort(compareText),
        [...PAYLOAD_LICENSE_ATOMS].sort(compareText),
      )
    ) {
      fail(
        `contract selected-license closure must be ${PAYLOAD_LICENSE_ATOMS.join(', ')}, got ${[...selectedAtoms].sort(compareText).join(', ')}`,
      );
    }

    for (const target of TARGET_IDS) {
      const row = contract.targets[target];
      exactObjectKeys(row, ['cargoTarget', 'packages'], `contract target ${target}`);
      if (row.cargoTarget !== targetRow(target).cargoTarget) {
        fail(`${target} cargoTarget must be ${targetRow(target).cargoTarget}`);
      }
      if (
        !Array.isArray(row.packages) ||
        row.packages.length === 0 ||
        !sameStrings(row.packages, [...new Set(row.packages)].sort(compareText))
      ) {
        fail(`${target} packages must be a sorted, unique, non-empty list`);
      }
      for (const key of row.packages) {
        if (!packages.has(key)) fail(`${target} references unknown package ${key}`);
        if (!packages.get(key).targets.includes(target))
          fail(`${key} does not claim target ${target}`);
      }
      const reverse = contract.packages
        .filter((pkg) => pkg.targets.includes(target))
        .map(packageKey);
      if (!sameStrings(row.packages, reverse)) {
        fail(`${target} package graph and package target claims disagree`);
      }
    }

    return packages;
  }

  function validateCanonicalBlobs(contract) {
    requireRealDirectory(BLOB_ROOT, 'Rust dependency license blob root');
    const expected = new Map();
    for (const row of contract.packages) {
      for (const legal of row.licenseFiles) {
        const prior = expected.get(legal.sha256);
        if (prior !== undefined && prior !== legal.bytes) {
          fail(`license digest ${legal.sha256} has inconsistent byte counts`);
        }
        expected.set(legal.sha256, legal.bytes);
      }
    }
    const actualNames = readdirSync(BLOB_ROOT).sort(compareText);
    const expectedNames = [...expected.keys()]
      .sort(compareText)
      .map((digest) => `${digest}.base64`);
    if (!sameStrings(actualNames, expectedNames)) {
      fail(
        `canonical Rust dependency license blobs differ: expected=${JSON.stringify(expectedNames)}, actual=${JSON.stringify(actualNames)}`,
      );
    }
    for (const [digest, bytes] of expected) {
      canonicalBlobBytes(digest, bytes);
    }
  }

  function validateLockIdentity(packages) {
    let lock;
    try {
      lock = Bun.TOML.parse(readFileSync(CARGO_LOCK_PATH, 'utf8'));
    } catch (cause) {
      fail(`cannot parse Cargo.lock: ${cause.message}`);
    }
    const lockRows = new Map();
    for (const row of lock?.package ?? []) {
      const key = packageKey(row);
      if (!row.source) continue;
      if (lockRows.has(key)) fail(`Cargo.lock contains ambiguous package identity ${key}`);
      lockRows.set(key, row);
    }
    for (const [key, row] of packages) {
      const locked = lockRows.get(key);
      if (!locked) fail(`Cargo.lock is missing contracted Rust dependency ${key}`);
      if (locked.source !== CARGO_SOURCE || locked.checksum !== row.checksum) {
        fail(
          `Cargo.lock identity changed for ${key}: expected ${CARGO_SOURCE}/${row.checksum}, got ${locked.source}/${locked.checksum}`,
        );
      }
    }
  }

  function validateGraph(contract, packages, graphDirectory) {
    requireSafeDirectoryChain(graphDirectory, 'Rust Cargo snapshot directory');
    const metadata = JSON.parse(readCargoSnapshot(graphDirectory, 'metadata.json'));
    if (
      path.resolve(metadata.workspace_root) !== ROOT ||
      !Array.isArray(metadata.workspace_members)
    )
      fail('Rust Cargo metadata must describe this workspace');
    const workspaceMembers = new Set(metadata.workspace_members);
    const metadataPackages = new Map();
    for (const row of metadata.packages ?? []) {
      const key = packageKey(row);
      const values = metadataPackages.get(key) ?? [];
      values.push(row);
      metadataPackages.set(key, values);
    }
    for (const [key, row] of packages) {
      const matches = (metadataPackages.get(key) ?? []).filter(
        (candidate) => candidate.source === CARGO_SOURCE,
      );
      if (matches.length !== 1) {
        fail(
          `cargo metadata must contain exactly one crates.io package for ${key}, got ${matches.length}`,
        );
      }
      const metadataRow = matches[0];
      if (metadataRow.license !== row.declaredLicense) {
        fail(
          `${key} declared license changed: expected ${row.declaredLicense}, got ${metadataRow.license}`,
        );
      }
      const sourceRoot = path.dirname(metadataRow.manifest_path);
      requireRealDirectory(sourceRoot, `${key} Cargo source directory`);
      const legalFiles = walkRegularFiles(sourceRoot).filter(legalSourceFile).sort(compareText);
      const contracted = row.licenseFiles.filter((file) => !file.upstream).map(({ name }) => name);
      if (!sameStrings(legalFiles, contracted)) {
        fail(
          `${key} legal source inventory changed: expected=${JSON.stringify(contracted)}, actual=${JSON.stringify(legalFiles)}`,
        );
      }
      for (const legal of row.licenseFiles) {
        if (legal.upstream) {
          const vcsPath = path.join(sourceRoot, '.cargo_vcs_info.json');
          requireRealFile(vcsPath, `${key} published Cargo VCS provenance`);
          const vcs = JSON.parse(readFileSync(vcsPath, 'utf8'));
          if (
            legal.upstream.repository !== metadataRow.repository ||
            legal.upstream.commit !== vcs.git?.sha1 ||
            legalFiles.includes(legal.name)
          )
            fail(
              `${key} supplemental license must match its published repository/commit and must not replace a crate legal file`,
            );
          continue;
        }
        const file = path.join(sourceRoot, ...legal.name.split('/'));
        const content = readFileSync(file);
        if (content.length !== legal.bytes || sha256(content) !== legal.sha256) {
          fail(`${key} legal source file changed: ${legal.name}`);
        }
      }
    }

    for (const target of TARGET_IDS) {
      const actual = cargoTreePackageKeys(
        contract.targets[target].cargoTarget,
        metadataPackages,
        graphDirectory,
        workspaceMembers,
      );
      const expected = contract.targets[target].packages;
      if (!sameStrings(actual, expected)) {
        fail(
          `${target} exact normal dependency graph changed: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
        );
      }
    }
  }

  function loadRustDependencyLicenseContract({
    contractPath = CONTRACT_PATH,
    auditLock = false,
    graphDirectory,
  } = {}) {
    const resolvedContractPath = path.resolve(contractPath);
    const cacheable =
      resolvedContractPath === CONTRACT_PATH && !auditLock && graphDirectory === undefined;
    if (cacheable && validatedDefaultContract !== undefined) return validatedDefaultContract;
    requireRealFile(resolvedContractPath, 'Rust dependency license contract');
    const bytes = readFileSync(resolvedContractPath);
    let contract;
    try {
      contract = JSON.parse(bytes.toString('utf8'));
    } catch (cause) {
      fail(`cannot parse ${resolvedContractPath}: ${cause.message}`);
    }
    const packages = validateContractShape(contract);
    validateCanonicalBlobs(contract);
    if (auditLock || graphDirectory !== undefined) validateLockIdentity(packages);
    if (graphDirectory !== undefined) validateGraph(contract, packages, graphDirectory);
    const result = Object.freeze({ contract, packages, contractPath: resolvedContractPath });
    if (cacheable) {
      validatedDefaultContract = result;
    }
    return result;
  }

  function targetPackages(contractState, target) {
    const targetContract = contractState.contract.targets[target];
    return targetContract.packages.map((key) => contractState.packages.get(key));
  }

  function targetBlobMembers(contractState, target) {
    const digests = [
      ...new Set(
        targetPackages(contractState, target).flatMap((row) =>
          row.licenseFiles.map(({ sha256: digest }) => digest),
        ),
      ),
    ].sort(compareText);
    return new Map(
      digests.map((digest, index) => [digest, `licenses/${String(index).padStart(3, '0')}.txt`]),
    );
  }

  function renderedTargetIndex(contractState, target) {
    const targetContract = contractState.contract.targets[target];
    const blobMembers = targetBlobMembers(contractState, target);
    return {
      schema: INDEX_SCHEMA,
      product: product,
      target,
      cargoTarget: targetContract.cargoTarget,
      payloadLicense: RUST_PAYLOAD_LICENSE,
      packages: targetPackages(contractState, target).map((row) => ({
        name: row.name,
        version: row.version,
        checksum: row.checksum,
        sourceUrl: `https://crates.io/api/v1/crates/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}/download`,
        declaredLicense: row.declaredLicense,
        selectedLicense: row.selectedLicense,
        licenseFiles: row.licenseFiles.map((legal) => ({
          name: legal.name,
          sha256: legal.sha256,
          bytes: legal.bytes,
          member: blobMembers.get(legal.sha256),
          ...(legal.upstream ? { upstream: legal.upstream } : {}),
        })),
      })),
    };
  }

  function targetExpectedFiles(contractState, target) {
    const files = new Map();
    const blobMembers = targetBlobMembers(contractState, target);
    files.set(
      `${RUST_DEPENDENCY_LICENSE_ROOT}/DEPENDENCIES.json`,
      Buffer.from(canonicalJson(renderedTargetIndex(contractState, target))),
    );
    for (const row of targetPackages(contractState, target)) {
      for (const legal of row.licenseFiles) {
        files.set(
          `${RUST_DEPENDENCY_LICENSE_ROOT}/${blobMembers.get(legal.sha256)}`,
          canonicalBlobBytes(legal.sha256, legal.bytes),
        );
      }
    }
    return new Map([...files].sort(([left], [right]) => compareText(left, right)));
  }

  function rustDependencyLicenseMembers(target, { prefix = '' } = {}) {
    targetRow(target);
    const state = loadRustDependencyLicenseContract();
    const checkedPrefix = prefix
      ? safeMember(prefix.replace(/\/$/u, ''), 'Rust dependency archive prefix')
      : '';
    return [...targetExpectedFiles(state, target).keys()].map((member) =>
      checkedPrefix ? `${checkedPrefix}/${member}` : member,
    );
  }

  function expectedDirectories(expectedFiles) {
    const directories = new Set();
    for (const member of expectedFiles.keys()) {
      const parts = member.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        directories.add(parts.slice(0, index).join('/'));
      }
    }
    return directories;
  }

  function normalizeRustDependencyLicenseModes(destination, target) {
    targetRow(target);
    const state = loadRustDependencyLicenseContract();
    const root = requireSafeDirectoryChain(destination, 'Rust dependency license carrier root');
    const expected = targetExpectedFiles(state, target);
    for (const member of expectedDirectories(expected)) {
      const directory = path.join(root, ...member.split('/'));
      requireRealDirectory(directory, `Rust dependency license directory ${member}`);
      chmodSync(directory, 0o755);
    }
    for (const member of expected.keys()) {
      const file = path.join(root, ...member.split('/'));
      let stat;
      try {
        stat = lstatSync(file);
      } catch (cause) {
        fail(`Rust dependency license member cannot be inspected: ${member}: ${cause.message}`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(`Rust dependency license member must be a regular non-symlink file: ${member}`);
      }
      chmodSync(file, 0o644);
    }
  }

  function stageRustDependencyLicenses(destination, target) {
    targetRow(target);
    const state = loadRustDependencyLicenseContract();
    const root = ensureSafeDirectoryChain(destination, 'Rust dependency license staging root');
    const dependencyRoot = path.join(root, ...RUST_DEPENDENCY_LICENSE_ROOT.split('/'));
    // Validate the namespace ancestor before even inspecting the owned leaf.
    // rmSync on a leaf beneath a symlinked THIRD_PARTY_LICENSES directory could
    // otherwise remove data outside the carrier stage.
    ensureSafeDirectoryChain(
      path.dirname(dependencyRoot),
      'Rust dependency license namespace parent',
    );
    let prior;
    try {
      prior = lstatSync(dependencyRoot);
    } catch (cause) {
      if (cause?.code !== 'ENOENT')
        fail(`cannot inspect prior Rust dependency license root: ${cause.message}`);
    }
    if (prior) {
      if (!prior.isDirectory() || prior.isSymbolicLink()) {
        fail(`prior Rust dependency license root must be a real directory: ${dependencyRoot}`);
      }
      rmSync(dependencyRoot, { recursive: true });
    }
    ensureSafeDirectoryChain(
      path.join(dependencyRoot, 'licenses'),
      'Rust dependency license staging root',
    );
    for (const [member, bytes] of targetExpectedFiles(state, target)) {
      const file = path.join(root, ...member.split('/'));
      ensureSafeDirectoryChain(path.dirname(file), 'Rust dependency license staging parent');
      writeFileSync(file, bytes);
      chmodSync(file, 0o644);
    }
    normalizeRustDependencyLicenseModes(root, target);
    assertRustDependencyLicensesInDirectory(root, { target });
    return rustDependencyLicenseMembers(target);
  }

  function directoryNamespaceEntries(root) {
    const namespace = path.join(root, ...RUST_DEPENDENCY_LICENSE_ROOT.split('/'));
    requireSafeDirectoryChain(namespace, 'Rust dependency license namespace');
    const entries = new Map();
    function walk(directory, relative) {
      for (const name of readdirSync(directory).sort(compareText)) {
        const file = path.join(directory, name);
        const member = relative ? `${relative}/${name}` : name;
        const stat = lstatSync(file);
        entries.set(`${RUST_DEPENDENCY_LICENSE_ROOT}/${member}`, { file, stat });
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file, member);
      }
    }
    walk(namespace, '');
    return entries;
  }

  function assertRustDependencyLicensesInDirectory(directory, { target } = {}) {
    targetRow(target);
    const state = loadRustDependencyLicenseContract();
    const root = requireSafeDirectoryChain(directory, 'Rust dependency license carrier root');
    const expected = targetExpectedFiles(state, target);
    const expectedDirs = expectedDirectories(expected);
    const actual = directoryNamespaceEntries(root);
    const expectedMembers = new Set([...expected.keys(), ...expectedDirs]);
    for (const member of expectedMembers) {
      if (member === 'THIRD_PARTY_LICENSES' || member === RUST_DEPENDENCY_LICENSE_ROOT) continue;
      const entry = actual.get(member);
      if (!entry) fail(`Rust dependency license carrier is missing ${member}`);
      if (expected.has(member)) {
        if (!entry.stat.isFile() || entry.stat.isSymbolicLink())
          fail(`${member} must be a regular non-symlink file`);
        if (!hasCanonicalRustFilesystemMode(entry.stat.mode, 0o644))
          fail(`${member} must have mode 0644`);
        if (!readFileSync(entry.file).equals(expected.get(member)))
          fail(`${member} differs from the canonical dependency license bytes`);
      } else {
        if (!entry.stat.isDirectory() || entry.stat.isSymbolicLink())
          fail(`${member} must be a real non-symlink directory`);
        if (!hasCanonicalRustFilesystemMode(entry.stat.mode, 0o755))
          fail(`${member} must have mode 0755`);
      }
    }
    for (const member of actual.keys()) {
      if (!expectedMembers.has(member))
        fail(`Rust dependency license carrier has unexpected member ${member}`);
    }
    return [...expected.keys()];
  }

  function checkedArchivePrefix(prefix) {
    if (prefix === '') return '';
    return safeMember(
      String(prefix).replace(/^\.\//u, '').replace(/\/$/u, ''),
      'Rust dependency archive prefix',
    );
  }

  function assertRustDependencyLicensesInEntries(
    entries,
    { target, prefix = '', label = 'archive' } = {},
  ) {
    targetRow(target);
    if (!(entries instanceof Map)) fail('Rust dependency archive entries must be a Map');
    const state = loadRustDependencyLicenseContract();
    const archivePrefix = checkedArchivePrefix(prefix);
    const localExpected = targetExpectedFiles(state, target);
    const localDirs = expectedDirectories(localExpected);
    const prefixed = (member) => (archivePrefix ? `${archivePrefix}/${member}` : member);
    const expectedFiles = new Map(
      [...localExpected].map(([member, bytes]) => [prefixed(member), bytes]),
    );
    const expectedDirs = new Set([...localDirs].map(prefixed));
    const namespace = `${prefixed(RUST_DEPENDENCY_LICENSE_ROOT)}/`;
    for (const [member, bytes] of expectedFiles) {
      const entry = entries.get(member);
      if (!entry?.isFile || entry.isSymbolicLink)
        fail(`${label} is missing regular dependency license member ${member}`);
      if ((entry.mode & 0o777) !== 0o644)
        fail(`${label} dependency license member ${member} must have mode 0644`);
      if (!Buffer.from(entry.data()).equals(bytes))
        fail(`${label} dependency license member ${member} differs from canonical bytes`);
    }
    for (const [member, entry] of entries) {
      if (expectedFiles.has(member)) continue;
      if (expectedDirs.has(member)) {
        if (!entry.isDirectory || entry.isSymbolicLink)
          fail(`${label} dependency license directory ${member} must be a real directory`);
        if ((entry.mode & 0o777) !== 0o755)
          fail(`${label} dependency license directory ${member} must have mode 0755`);
        continue;
      }
      if (member !== prefixed(RUST_DEPENDENCY_LICENSE_ROOT) && !member.startsWith(namespace))
        continue;
      fail(`${label} contains unexpected dependency license member ${member}`);
    }
    assertReleaseNoticesInEntries(entries, {
      profile: noticeProfile,
      prefix: archivePrefix,
      exact: false,
      label,
    });
    return [...expectedFiles.keys()];
  }

  function assertRustDependencyLicensesInArchive(file, options = {}) {
    const archive = path.resolve(file);
    return assertRustDependencyLicensesInEntries(readPortableArchiveEntries(archive), {
      ...options,
      label: options.label ?? path.basename(archive),
    });
  }

  function usage() {
    return [
      'usage:',
      `  ${TOOL} check-contract`,
      `  bash ${owner}/tools/audit-dependency-licenses.sh`,
      `  ${TOOL} stage <directory> --target <${TARGET_IDS.join('|')}>`,
      `  ${TOOL} check-directory <directory> --target <${TARGET_IDS.join('|')}>`,
      `  ${TOOL} check-archive <archive> --target <${TARGET_IDS.join('|')}> [--prefix <member-prefix>]`,
    ].join('\n');
  }

  function parseCli(argv) {
    const values = [...argv];
    const command = values.shift();
    if (command === 'audit-contract' && values.length === 1)
      return { command, graphDirectory: path.resolve(values[0]) };
    if (['check-contract', 'audit-targets'].includes(command)) {
      if (values.length > 0) fail(usage());
      return { command };
    }
    if (!['stage', 'check-directory', 'check-archive'].includes(command)) fail(usage());
    const subject = values.shift();
    if (!subject) fail(usage());
    let target;
    let prefix = '';
    while (values.length > 0) {
      const flag = values.shift();
      if (flag === '--target') {
        if (target !== undefined) fail('--target may be supplied only once');
        target = values.shift();
        if (!target) fail('--target requires a value');
      } else if (flag === '--prefix' && command === 'check-archive') {
        if (prefix) fail('--prefix may be supplied only once');
        prefix = values.shift();
        if (prefix === undefined) fail('--prefix requires a value');
      } else {
        fail(`unsupported argument ${JSON.stringify(flag)}\n${usage()}`);
      }
    }
    targetRow(target);
    return { command, subject, target, prefix };
  }

  function main() {
    try {
      const args = parseCli(process.argv.slice(2));
      if (args.command === 'audit-targets') {
        console.log(TARGET_ROWS.map((row) => row.cargoTarget).join('\n'));
      } else if (args.command === 'check-contract') {
        const state = loadRustDependencyLicenseContract();
        console.log(
          `${TOOL}: self-contained license contract passed (${state.contract.packages.length} packages)`,
        );
      } else if (args.command === 'audit-contract') {
        const state = loadRustDependencyLicenseContract({ graphDirectory: args.graphDirectory });
        console.log(
          `${TOOL}: exact graph/source audit passed (${state.contract.packages.length} packages)`,
        );
      } else if (args.command === 'stage') {
        stageRustDependencyLicenses(args.subject, args.target);
        console.log(`${TOOL}: staged ${args.target} dependency licenses in ${args.subject}`);
      } else if (args.command === 'check-directory') {
        assertRustDependencyLicensesInDirectory(args.subject, { target: args.target });
        console.log(`${TOOL}: checked ${args.target} dependency licenses in ${args.subject}`);
      } else {
        assertRustDependencyLicensesInArchive(args.subject, {
          target: args.target,
          prefix: args.prefix,
        });
        console.log(`${TOOL}: checked ${args.target} dependency licenses in ${args.subject}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }

  return {
    RUST_DEPENDENCY_LICENSE_ROOT,
    RUST_PAYLOAD_LICENSE,
    isAllowedRustPathPackageMetadataRow,
    hasCanonicalRustFilesystemMode,
    hasSafeRustSourceFilesystemMode,
    loadRustDependencyLicenseContract,
    rustDependencyLicenseMembers,
    normalizeRustDependencyLicenseModes,
    stageRustDependencyLicenses,
    assertRustDependencyLicensesInDirectory,
    assertRustDependencyLicensesInEntries,
    assertRustDependencyLicensesInArchive,
    runCli: main,
  };
}
