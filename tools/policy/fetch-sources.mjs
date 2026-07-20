#!/usr/bin/env bun
import {X509Certificate, createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {assertHttpsUrl, createSourceFetcher} from './source-fetch-core.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(workspaceRoot);

const sourceCheckoutRoot = join(workspaceRoot, 'target', 'oliphaunt-sources', 'checkouts');
const sourceArchiveRoot = join(workspaceRoot, 'target', 'oliphaunt-sources', 'archives');
const sourceFetcher = createSourceFetcher({
  workspaceRoot,
  checkoutRoot: sourceCheckoutRoot,
  archiveRoot: sourceArchiveRoot,
});
const sourceOrigins = {
  sharedThirdParty: 'shared-third-party',
  nativeThirdParty: 'native-third-party',
  wasixThirdParty: 'wasix-third-party',
  extension: 'extension',
};
const allowedScopes = new Set(['all', 'native-runtime', 'wasix-runtime', 'extensions']);

const {scope, force, validateOnly, verifyOnly} = parseArgs(process.argv.slice(2));
if (!allowedScopes.has(scope)) {
  fail(`unsupported source fetch scope '${scope}'; expected one of: ${[...allowedScopes].join(', ')}`, 2);
}

if (
  !validateOnly &&
  !verifyOnly &&
  !force &&
  process.env.CI !== 'true' &&
  process.env.OLIPHAUNT_FETCH_SOURCES !== '1'
) {
  console.log(
    `source checkout fetch skipped outside CI for scope '${scope}'; set OLIPHAUNT_FETCH_SOURCES=1 or pass --force to refresh pinned checkouts with Bun`,
  );
  process.exit(0);
}

try {
  const manifest = loadSourcesManifest(scope);
  validateSourcesManifest(manifest, scope);
  if (!validateOnly) {
    await fetchManifestSources(manifest, scope, verifyOnly);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseArgs(args) {
  let selectedScope = 'all';
  let sawScope = false;
  let forceFetch = false;
  let validateOnly = false;
  let verifyOnly = false;
  for (const arg of args) {
    if (arg === '--force') {
      forceFetch = true;
      continue;
    }
    if (arg === '--verify-only') {
      verifyOnly = true;
      continue;
    }
    if (arg === '--validate-only') {
      validateOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: bun tools/policy/fetch-sources.mjs [all|native-runtime|wasix-runtime|extensions] [--force|--validate-only|--verify-only]',
      );
      process.exit(0);
    }
    if (sawScope) {
      fail(`unexpected argument '${arg}'`, 2);
    }
    selectedScope = arg;
    sawScope = true;
  }
  if (Number(forceFetch) + Number(validateOnly) + Number(verifyOnly) > 1) {
    fail('--force, --validate-only, and --verify-only are mutually exclusive', 2);
  }
  return {scope: selectedScope, force: forceFetch, validateOnly, verifyOnly};
}

function loadSourcesManifest(selectedScope) {
  const sources = [];
  const names = new Set();
  const thirdPartyRoot = join(workspaceRoot, 'src', 'sources', 'third-party');
  for (const [domain, origin] of sourceDomainsForScope(selectedScope)) {
    const domainDir = join(thirdPartyRoot, domain);
    if (!existsSync(domainDir)) {
      continue;
    }
    for (const file of readdirSync(domainDir).sort()) {
      if (!file.endsWith('.toml')) {
        continue;
      }
      pushSourcePin(sources, names, join(domainDir, file), origin);
    }
  }
  for (const sourcePath of extensionSourcePinPaths()) {
    pushSourcePin(sources, names, sourcePath, sourceOrigins.extension);
  }
  return {sources, ...(scopeIncludesWasix(selectedScope) ? readToml('src/sources/toolchains/wasix.toml') : {})};
}

function sourceDomainsForScope(selectedScope) {
  const domains = [];
  if (selectedScope === 'all' || selectedScope === 'native-runtime' || selectedScope === 'wasix-runtime') {
    domains.push(['shared', sourceOrigins.sharedThirdParty]);
  }
  if (selectedScope === 'all' || selectedScope === 'native-runtime') {
    domains.push(['native', sourceOrigins.nativeThirdParty]);
  }
  if (selectedScope === 'all' || selectedScope === 'wasix-runtime') {
    domains.push(['wasix', sourceOrigins.wasixThirdParty]);
  }
  return domains;
}

function scopeIncludesWasix(selectedScope) {
  return selectedScope === 'all' || selectedScope === 'wasix-runtime';
}

function extensionSourcePinPaths() {
  const root = join(workspaceRoot, 'src', 'extensions', 'external');
  const paths = [];
  collectSourcePins(root, paths);
  return paths.sort();
}

function collectSourcePins(dir, paths) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, {withFileTypes: true}).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourcePins(path, paths);
    } else if (entry.name === 'source.toml') {
      paths.push(path);
    }
  }
}

function pushSourcePin(sources, names, path, origin) {
  const raw = readToml(path);
  const source = {
    name: stringField(raw, 'name', path),
    kind: raw.kind ?? 'git',
    url: stringField(raw, 'url', path),
    mirrorUrl: optionalStringField(raw, 'mirror_url', path),
    branch: stringField(raw, 'branch', path),
    commit: stringField(raw, 'commit', path),
    sha256: optionalStringField(raw, 'sha256', path),
    stripPrefix: optionalStringField(raw, 'strip_prefix', path) ?? optionalStringField(raw, 'strip-prefix', path),
    origin,
  };
  if (names.has(source.name)) {
    throw new Error(`duplicate source pin '${source.name}' in source metadata`);
  }
  names.add(source.name);
  sources.push(source);
}

function readToml(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringField(object, field, path) {
  const value = object[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must set non-empty string field '${field}'`);
  }
  return value;
}

function optionalStringField(object, field, path) {
  const value = object[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} field '${field}' must be a string`);
  }
  return value;
}

function validateSourcesManifest(manifest, selectedScope) {
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new Error('source metadata must contain at least one source pin');
  }
  if (scopeIncludesWasix(selectedScope)) {
    validateWasixToolchain(manifest);
  }
  for (const source of manifest.sources) {
    validateSourcePin(source);
  }
}

function validateWasixToolchain(manifest) {
  assertEquals(manifest.toolchain?.wasmer, '7.2.0', 'toolchain.wasmer');
  assertEquals(manifest.toolchain?.['wasmer-wasix'], '0.702.0', 'toolchain.wasmer-wasix');
  assertEquals(manifest.toolchain?.wasmer_llvm, '22.1', 'toolchain.wasmer_llvm');
  assertEquals(manifest.toolchain?.wasixcc?.version, '0.4.3', 'toolchain.wasixcc.version');
  assertEquals(
    manifest.toolchain?.wasixcc?.target,
    'x86_64-unknown-linux-gnu',
    'toolchain.wasixcc.target',
  );
  assertEquals(manifest.toolchain?.sysroots?.version, '2026-03-02.1', 'toolchain.sysroots.version');
  assertEquals(manifest.toolchain?.llvm?.release, '21.1.204', 'toolchain.llvm.release');
  assertEquals(manifest.toolchain?.llvm?.reported_version, '21.1.2', 'toolchain.llvm.reported_version');
  assertEquals(manifest.toolchain?.binaryen?.release, 'version_130', 'toolchain.binaryen.release');
  assertEquals(manifest.toolchain?.binaryen?.reported_version, '130', 'toolchain.binaryen.reported_version');

  const assetsManifest = manifest.toolchain?.assets_manifest;
  assertEquals(
    assetsManifest,
    'src/runtimes/liboliphaunt/wasix/assets/build/docker/pinned-wasixcc-assets.tsv',
    'toolchain.assets_manifest',
  );
  const assetsManifestSha256 = manifest.toolchain?.assets_manifest_sha256;
  if (typeof assetsManifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(assetsManifestSha256)) {
    throw new Error(
      `toolchain.assets_manifest_sha256 must pin a lowercase sha256 digest, got ${assetsManifestSha256}`,
    );
  }
  const assetsManifestPath = join(workspaceRoot, ...assetsManifest.split('/'));
  assertEquals(sha256File(assetsManifestPath), assetsManifestSha256, 'toolchain assets manifest SHA-256');
  const assetRows = new Map(
    readFileSync(assetsManifestPath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const fields = line.split('\t');
        if (fields.length !== 5) {
          throw new Error(`invalid WASIX toolchain asset row: ${line}`);
        }
        return [fields[1], fields[3]];
      }),
  );
  const expectedAssets = [
    [manifest.toolchain?.wasixcc?.asset, manifest.toolchain?.wasixcc?.sha256],
    ['sysroot.tar.gz', manifest.toolchain?.sysroots?.sysroot_sha256],
    ['sysroot-eh.tar.gz', manifest.toolchain?.sysroots?.sysroot_eh_sha256],
    ['sysroot-ehpic.tar.gz', manifest.toolchain?.sysroots?.sysroot_ehpic_sha256],
    ['sysroot-exnref-eh.tar.gz', manifest.toolchain?.sysroots?.sysroot_exnref_eh_sha256],
    ['sysroot-exnref-ehpic.tar.gz', manifest.toolchain?.sysroots?.sysroot_exnref_ehpic_sha256],
    [manifest.toolchain?.llvm?.asset, manifest.toolchain?.llvm?.sha256],
    [manifest.toolchain?.binaryen?.asset, manifest.toolchain?.binaryen?.sha256],
  ];
  for (const [asset, expectedSha256] of expectedAssets) {
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error(`${asset ?? '<missing asset>'} metadata must pin a lowercase sha256 digest`);
    }
    assertEquals(assetRows.get(asset), expectedSha256, `toolchain asset ${asset}`);
  }

  assertEquals(manifest.builder?.base_image, 'ubuntu:24.04', 'builder.base_image');
  const baseDigest = manifest.builder?.base_image_digest;
  if (typeof baseDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(baseDigest)) {
    throw new Error(`builder.base_image_digest must pin a concrete sha256 digest, got ${baseDigest}`);
  }
  const aptSnapshot = manifest.builder?.apt_snapshot;
  if (typeof aptSnapshot !== 'string' || !/^\d{8}T\d{6}Z$/u.test(aptSnapshot)) {
    throw new Error(`builder.apt_snapshot must be a fixed YYYYMMDDTHHMMSSZ timestamp, got ${aptSnapshot}`);
  }
  if (typeof manifest.builder?.apt_snapshot_retention !== 'string' || manifest.builder.apt_snapshot_retention === '') {
    throw new Error('builder.apt_snapshot_retention must document the snapshot retention boundary');
  }
  const dockerfileFrontend = manifest.builder?.dockerfile_frontend;
  if (
    typeof dockerfileFrontend !== 'string' ||
    !/^docker\/dockerfile:[0-9]+(?:\.[0-9]+){1,2}@sha256:[0-9a-f]{64}$/u.test(dockerfileFrontend)
  ) {
    throw new Error(
      `builder.dockerfile_frontend must pin a versioned Dockerfile frontend by lowercase sha256 digest, got ${dockerfileFrontend}`,
    );
  }
  const snapshotTlsRoot = manifest.builder?.snapshot_tls_root;
  if (
    typeof snapshotTlsRoot !== 'string' ||
    !/^src\/runtimes\/liboliphaunt\/wasix\/assets\/build\/docker\/[A-Za-z0-9._-]+\.pem$/u.test(
      snapshotTlsRoot,
    )
  ) {
    throw new Error(
      `builder.snapshot_tls_root must name a PEM file in the WASIX Docker build inputs, got ${snapshotTlsRoot}`,
    );
  }
  const snapshotTlsRootSha256 = manifest.builder?.snapshot_tls_root_sha256;
  if (typeof snapshotTlsRootSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshotTlsRootSha256)) {
    throw new Error(
      `builder.snapshot_tls_root_sha256 must pin a lowercase sha256 digest, got ${snapshotTlsRootSha256}`,
    );
  }
  const snapshotTlsRootNotAfter = manifest.builder?.snapshot_tls_root_not_after;
  if (
    typeof snapshotTlsRootNotAfter !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(snapshotTlsRootNotAfter)
  ) {
    throw new Error(
      `builder.snapshot_tls_root_not_after must be an exact UTC timestamp, got ${snapshotTlsRootNotAfter}`,
    );
  }
  const snapshotTlsRootPath = join(workspaceRoot, ...snapshotTlsRoot.split('/'));
  assertEquals(
    sha256File(snapshotTlsRootPath),
    snapshotTlsRootSha256,
    'builder snapshot TLS root SHA-256',
  );
  let snapshotTlsCertificate;
  try {
    snapshotTlsCertificate = new X509Certificate(readFileSync(snapshotTlsRootPath));
  } catch (error) {
    throw new Error(
      `builder.snapshot_tls_root must contain a valid X.509 certificate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!snapshotTlsCertificate.ca) {
    throw new Error('builder.snapshot_tls_root must contain a CA certificate');
  }
  if (
    snapshotTlsCertificate.issuer !== snapshotTlsCertificate.subject ||
    !snapshotTlsCertificate.verify(snapshotTlsCertificate.publicKey)
  ) {
    throw new Error('builder.snapshot_tls_root must contain a self-signed trust root');
  }
  const certificateNotAfter = snapshotTlsCertificate.validToDate;
  if (!(certificateNotAfter instanceof Date) || Number.isNaN(certificateNotAfter.getTime())) {
    throw new Error('builder.snapshot_tls_root certificate must expose a valid notAfter timestamp');
  }
  assertEquals(
    certificateNotAfter.toISOString().replace(/\.000Z$/u, 'Z'),
    snapshotTlsRootNotAfter,
    'builder.snapshot_tls_root_not_after',
  );
  const dockerfile = readFileSync(
    join(workspaceRoot, 'src', 'runtimes', 'liboliphaunt', 'wasix', 'assets', 'build', 'docker', 'Dockerfile'),
    'utf8',
  );
  const aptInstaller = readFileSync(
    join(workspaceRoot, 'src', 'runtimes', 'liboliphaunt', 'wasix', 'assets', 'build', 'docker', 'install-pinned-apt-packages.sh'),
    'utf8',
  );
  if (!dockerfile.includes(`FROM ${manifest.builder.base_image}@${baseDigest}`)) {
    throw new Error(
      'WASIX build Dockerfile must pin the same builder base image digest as src/sources/toolchains/wasix.toml',
    );
  }
  if (dockerfile.split(/\r?\n/u, 1)[0] !== `# syntax=${dockerfileFrontend}`) {
    throw new Error('WASIX build Dockerfile must pin the declared Dockerfile frontend digest');
  }
  if (!dockerfile.includes(`OLIPHAUNT_WASIXCC_ASSET_MANIFEST_SHA256=${assetsManifestSha256}`)) {
    throw new Error('WASIX build Dockerfile must pin the toolchain asset manifest SHA-256');
  }
  if (
    !dockerfile.includes(`OLIPHAUNT_UBUNTU_APT_SNAPSHOT=${aptSnapshot}`) ||
    !dockerfile.includes('COPY --chmod=0555 install-pinned-apt-packages.sh') ||
    !dockerfile.includes('--snapshot "$OLIPHAUNT_UBUNTU_APT_SNAPSHOT"') ||
    !aptInstaller.includes('https://snapshot.ubuntu.com/ubuntu/$snapshot') ||
    !aptInstaller.includes('APT::Update::Error-Mode=any') ||
    !aptInstaller.includes('Acquire::https::CaInfo="$ca_bundle"') ||
    !aptInstaller.includes('install_transaction "builder package" ca-certificates')
  ) {
    throw new Error(
      'WASIX builder must use the declared minimal Ubuntu snapshot through its fail-closed pinned APT installer',
    );
  }
  if (
    !dockerfile.includes(`OLIPHAUNT_UBUNTU_SNAPSHOT_TLS_ROOT_SHA256=${snapshotTlsRootSha256}`) ||
    !dockerfile.includes(
      'COPY --chmod=0444 isrg-root-x1.pem /usr/local/share/oliphaunt/isrg-root-x1.pem',
    ) ||
    !dockerfile.includes('/etc/ssl/certs/ca-certificates.crt') ||
    !dockerfile.includes('sha256sum --check --strict')
  ) {
    throw new Error('WASIX build Dockerfile must verify and install the declared snapshot TLS root');
  }
  if (dockerfile.includes('Verify-Peer=false') || aptInstaller.includes('Verify-Peer=false')) {
    throw new Error('WASIX snapshot acquisition must not disable TLS peer verification');
  }
  for (const forbidden of ['raw.githubusercontent.com/wasix-org/wasixcc', 'latest']) {
    if (dockerfile.includes(forbidden)) {
      throw new Error(`WASIX build Dockerfile contains forbidden mutable installer input ${forbidden}`);
    }
  }
  assertEquals(manifest.build?.postgres_prefix, '/', 'build.postgres_prefix');
  assertEquals(manifest.build?.postgres_pkglibdir, '/lib/postgresql', 'build.postgres_pkglibdir');
  assertEquals(manifest.build?.postgres_sharedir, '/share/postgresql', 'build.postgres_sharedir');
  assertIncludes(manifest.build?.main_flags, '-fwasm-exceptions', 'build.main_flags');
  assertNoFlagContains(manifest.build?.main_flags, 'asyncify', 'build.main_flags');
  assertIncludes(manifest.build?.extension_flags, '-fwasm-exceptions', 'build.extension_flags');
  assertNoFlagContains(manifest.build?.extension_flags, 'asyncify', 'build.extension_flags');
  assertIncludes(manifest.build?.extension_flags, '-fPIC', 'build.extension_flags');
  assertIncludes(manifest.build?.extension_flags, '-Wl,-shared', 'build.extension_flags');
  assertEquals(manifest.build?.archive_format, 'tar.zst', 'build.archive_format');
  if (manifest.build?.deterministic_archives !== true) {
    throw new Error('build.deterministic_archives must be true');
  }
}

function validateSourcePin(source) {
  if (!validSourceNameComponent(source.name) || source.branch.trim() === '') {
    throw new Error(`invalid source pin in source metadata: ${JSON.stringify(source)}`);
  }
  const parsedUrl = assertHttpsUrl(source.url, `source '${source.name}' URL`);
  const parsedMirrorUrl = source.mirrorUrl === undefined
    ? undefined
    : assertHttpsUrl(source.mirrorUrl, `source '${source.name}' mirror URL`);
  if (!['git', 'archive'].includes(source.kind)) {
    throw new Error(`source '${source.name}' has unsupported kind '${source.kind}'`);
  }
  if (source.kind === 'git') {
    if (!/^[0-9a-f]{40}$/u.test(source.commit)) {
      throw new Error(`git source '${source.name}' commit must be an exact lowercase 40-hex revision`);
    }
    if (source.sha256 !== undefined || source.stripPrefix !== undefined) {
      throw new Error(`git source '${source.name}' must not set sha256 or strip-prefix`);
    }
    if (parsedMirrorUrl?.href === parsedUrl.href) {
      throw new Error(`git source '${source.name}' mirror URL must differ from its primary URL`);
    }
    return;
  }
  if (parsedMirrorUrl !== undefined) {
    throw new Error(`archive source '${source.name}' must not set mirror_url`);
  }
  const sha256 = archiveSha256(source);
  archiveStripPrefix(source);
  assertEquals(source.commit, sha256, `${source.name} archive commit must equal archive sha256`);
  if (!parsedUrl.pathname.endsWith('.tar.gz') && !parsedUrl.pathname.endsWith('.tgz')) {
    throw new Error(`archive source '${source.name}' must point at a .tar.gz or .tgz URL`);
  }
}

async function fetchManifestSources(manifest, selectedScope, verifyOnly) {
  for (const source of manifest.sources) {
    if (!scopeIncludes(selectedScope, source.origin)) {
      console.error(`skipping source '${source.name}' for selected source lane`);
      continue;
    }
    const checkoutPath = sourceCheckoutPath(source.name);
    if (checkoutPath === undefined) {
      console.error(`warning: source '${source.name}' has no configured checkout path; skipping fetch`);
      continue;
    }
    if (verifyOnly) {
      sourceFetcher.verify(source, checkoutPath);
    } else {
      await sourceFetcher.materialize(source, checkoutPath);
    }
  }
}

function scopeIncludes(selectedScope, origin) {
  if (selectedScope === 'all') {
    return true;
  }
  if (selectedScope === 'native-runtime') {
    return [
      sourceOrigins.sharedThirdParty,
      sourceOrigins.nativeThirdParty,
      sourceOrigins.extension,
    ].includes(origin);
  }
  if (selectedScope === 'wasix-runtime') {
    return [
      sourceOrigins.sharedThirdParty,
      sourceOrigins.wasixThirdParty,
      sourceOrigins.extension,
    ].includes(origin);
  }
  return origin === sourceOrigins.extension;
}

function archiveSha256(source) {
  if (source.sha256 === undefined || !/^[0-9a-f]{64}$/u.test(source.sha256)) {
    throw new Error(`archive source '${source.name}' has invalid sha256 ${source.sha256}`);
  }
  return source.sha256;
}

function archiveStripPrefix(source) {
  if (
    source.stripPrefix === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(source.stripPrefix) ||
    source.stripPrefix.includes('..') ||
    source.stripPrefix.startsWith('/')
  ) {
    throw new Error(`archive source '${source.name}' has invalid strip-prefix`);
  }
  return source.stripPrefix;
}

function sourceCheckoutPath(name) {
  return validSourceNameComponent(name) ? join(sourceCheckoutRoot, name) : undefined;
}

function validSourceNameComponent(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    !name.includes('..') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function assertEquals(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(values, expected, name) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    throw new Error(`${name} must contain ${expected}`);
  }
}

function assertNoFlagContains(values, needle, name) {
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be an array`);
  }
  if (values.some((value) => typeof value === 'string' && value.includes(needle))) {
    throw new Error(`${name} must not contain ${needle}`);
  }
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
