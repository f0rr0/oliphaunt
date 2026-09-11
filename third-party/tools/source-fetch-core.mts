import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { extractSourceArchive, sourceArchiveEntries } from './source-archive.mts';

const ARCHIVE_SAFETY_VERSION = 'source-archive-v2';
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const CHECKOUT_MAX_ENTRIES = 500_000;
const CHECKOUT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const GNU_MIRROR_ORIGIN = 'https://ftpmirror.gnu.org';
const GNU_CANONICAL_ARCHIVE_ORIGIN = 'https://ftp.gnu.org/gnu';
const GNU_ARCHIVE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

const activePromotions = [];
let signalHandlersInstalled = false;

export function assertHttpsUrl(value, label = 'source URL') {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.trim() !== value ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be one canonical absolute HTTPS URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(
      `${label} must be an absolute HTTPS URL: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS, got ${parsed.protocol || '<missing protocol>'}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  if (parsed.hash !== '') {
    throw new Error(`${label} must not contain a URL fragment`);
  }
  if (parsed.hostname === '') {
    throw new Error(`${label} must contain a hostname`);
  }
  return parsed;
}

export function canonicalGnuArchiveFallbackUrl(pinnedUrl) {
  let parsed;
  try {
    parsed = assertHttpsUrl(pinnedUrl);
  } catch {
    return undefined;
  }
  if (parsed.origin !== GNU_MIRROR_ORIGIN || parsed.search !== '' || parsed.href !== pinnedUrl) {
    return undefined;
  }
  const [, project, file, ...extra] = parsed.pathname.split('/');
  if (
    extra.length !== 0 ||
    !GNU_ARCHIVE_PATH_COMPONENT.test(project ?? '') ||
    !GNU_ARCHIVE_PATH_COMPONENT.test(file ?? '') ||
    (!file.endsWith('.tar.gz') && !file.endsWith('.tgz'))
  ) {
    return undefined;
  }
  return `${GNU_CANONICAL_ARCHIVE_ORIGIN}/${project}/${file}`;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function removePath(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function installSignalHandlers() {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.once(signal, () => {
      restoreActivePromotions();
      process.exit(exitCode);
    });
  }
}

function restorePromotion(promotion) {
  if (pathExists(promotion.destination)) {
    removePath(promotion.destination);
  }
  if (promotion.hadPrevious && pathExists(promotion.backup)) {
    renameSync(promotion.backup, promotion.destination);
  }
}

function restoreActivePromotions() {
  for (const promotion of [...activePromotions].reverse()) {
    try {
      restorePromotion(promotion);
    } catch (error) {
      // There is no safe logging dependency in a signal cleanup path.  Preserve
      // all remaining backups and continue attempting the other rollbacks.
      process.stderr.write(`warning: could not roll back ${promotion.destination}: ${error}\n`);
    }
  }
}

export function promotePathTransactional(candidate, destination, { afterBackup } = {}) {
  if (!pathExists(candidate)) {
    throw new Error(`transaction candidate does not exist: ${candidate}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  installSignalHandlers();
  const hadPrevious = pathExists(destination);
  const backup = join(
    dirname(destination),
    `.${destination.split(sep).at(-1)}-backup-${process.pid}-${randomUUID()}`,
  );
  const promotion = { destination, backup, hadPrevious };
  activePromotions.push(promotion);
  let candidateMoved = false;
  try {
    if (hadPrevious) {
      renameSync(destination, backup);
    }
    afterBackup?.();
    renameSync(candidate, destination);
    candidateMoved = true;
    if (hadPrevious) {
      removePath(backup);
    }
  } catch (error) {
    try {
      if (candidateMoved && pathExists(destination)) {
        removePath(destination);
      }
      if (hadPrevious && pathExists(backup)) {
        renameSync(backup, destination);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `promotion of ${candidate} to ${destination} failed and rollback was incomplete`,
      );
    }
    throw error;
  } finally {
    const index = activePromotions.indexOf(promotion);
    if (index >= 0) {
      activePromotions.splice(index, 1);
    }
  }
}

export function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function isRealDirectory(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(path, maximumBytes = Number.POSITIVE_INFINITY) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximumBytes;
  } catch {
    return false;
  }
}

function hasGitMetadata(path) {
  return pathExists(join(path, '.git'));
}

function assertSupportedGitMetadata(source, path) {
  if (hasGitMetadata(path) && !isRealDirectory(join(path, '.git'))) {
    throw new Error(
      `source checkout ${path} (${source.name}) has unsupported non-directory .git metadata; preserve it before fetching pins`,
    );
  }
}

function validateSourceName(name) {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\') ||
    !/^[A-Za-z0-9._-]+$/u.test(name)
  ) {
    throw new Error(`unsafe source name ${JSON.stringify(name)}`);
  }
}

function validateBranchName(branch) {
  if (
    typeof branch !== 'string' ||
    branch === '' ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\u0000-\u0020\u007f~^:?*[\\]/u.test(branch) ||
    branch.split('/').some((part) => part === '' || part.endsWith('.lock'))
  ) {
    throw new Error(`unsafe Git branch name ${JSON.stringify(branch)}`);
  }
}

export function validateSource(source) {
  validateSourceName(source.name);
  const parsedUrl = assertHttpsUrl(source.url, `source '${source.name}' URL`);
  const parsedMirrorUrl =
    source.mirrorUrl === undefined
      ? undefined
      : assertHttpsUrl(source.mirrorUrl, `source '${source.name}' mirror URL`);
  validateBranchName(source.branch);
  if (source.kind === 'git') {
    if (source.sha256 !== undefined || source.stripPrefix !== undefined)
      throw new Error(`git source '${source.name}' must not set sha256 or strip-prefix`);
    if (!/^[0-9a-f]{40}$/u.test(source.commit)) {
      throw new Error(`git source '${source.name}' must pin an exact lowercase 40-hex commit`);
    }
    if (parsedMirrorUrl?.href === parsedUrl.href) {
      throw new Error(`git source '${source.name}' mirror URL must differ from its primary URL`);
    }
  } else if (source.kind === 'archive') {
    if (parsedMirrorUrl !== undefined) {
      throw new Error(`archive source '${source.name}' must not set mirror_url`);
    }
    if (!/^[0-9a-f]{64}$/u.test(source.sha256 ?? '') || source.commit !== source.sha256) {
      throw new Error(
        `archive source '${source.name}' must pin one lowercase SHA-256 as sha256 and commit`,
      );
    }
    if (
      typeof source.stripPrefix !== 'string' ||
      (source.stripPrefix !== '.' &&
        (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(source.stripPrefix) ||
          source.stripPrefix.includes('..')))
    ) {
      throw new Error(`archive source '${source.name}' has an unsafe strip prefix`);
    }
    if (
      !parsedUrl.pathname.endsWith('.tar.gz') &&
      !parsedUrl.pathname.endsWith('.tgz') &&
      !parsedUrl.pathname.endsWith('.zip')
    ) {
      throw new Error(
        `archive source '${source.name}' URL must identify a .tar.gz, .tgz, or .zip file`,
      );
    }
    if (source.stripPrefix === '.' && !parsedUrl.pathname.endsWith('.zip')) {
      throw new Error(
        `archive source '${source.name}' may use a rootless strip prefix only for ZIP releases`,
      );
    }
  } else {
    throw new Error(`source '${source.name}' has unsupported kind '${source.kind}'`);
  }
}

function archiveStampMetadata(source) {
  return `safety=${ARCHIVE_SAFETY_VERSION}\nname=${source.name}\nkind=archive\nurl=${source.url}\nbranch=${source.branch}\ncommit=${source.commit}\nsha256=${source.sha256}\nstrip-prefix=${source.stripPrefix}\n`;
}

function archiveStamp(source, treeSha256) {
  return `${archiveStampMetadata(source)}tree-sha256=${treeSha256}\n`;
}

function hasUsableDirectoryIdentity(metadata) {
  // Path strings cannot prove identity: Windows may spell one directory with
  // either an 8.3 alias or its long name.  Require both the volume and file ID
  // so filesystems without a complete stable identity fail closed.
  return (
    metadata.isDirectory() &&
    typeof metadata.dev === 'bigint' &&
    metadata.dev > 0n &&
    typeof metadata.ino === 'bigint' &&
    metadata.ino > 0n
  );
}

export function sameDirectoryIdentity(left, right, { stat = statSync } = {}) {
  const leftMetadata = stat(left, { bigint: true });
  const rightMetadata = stat(right, { bigint: true });
  if (!hasUsableDirectoryIdentity(leftMetadata) || !hasUsableDirectoryIdentity(rightMetadata)) {
    return false;
  }

  return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino;
}

function assertSafeCheckoutTree(root) {
  const realRoot = realpathSync(root);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === '.git') {
        continue;
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (metadata.isFile()) {
        continue;
      }
      if (!metadata.isSymbolicLink()) {
        throw new Error(`Git source checkout contains unsupported filesystem object ${path}`);
      }
      const target = readlinkSync(path);
      if (isAbsolute(target)) {
        throw new Error(`Git source checkout contains absolute symlink ${path} -> ${target}`);
      }
      const resolvedTarget = resolve(dirname(path), target);
      const relativeTarget = relative(root, resolvedTarget);
      if (
        relativeTarget === '..' ||
        relativeTarget.startsWith(`..${sep}`) ||
        isAbsolute(relativeTarget)
      ) {
        throw new Error(`Git source checkout contains escaping symlink ${path} -> ${target}`);
      }
      if (!pathExists(resolvedTarget)) {
        // Source repositories may intentionally track dangling relative links
        // as filesystem fixtures. They are safe only when both the lexical
        // destination and its deepest existing ancestor remain in the staged
        // checkout. The ancestor check catches paths that cross an existing
        // symlink before reaching the missing leaf.
        let existingAncestor = dirname(resolvedTarget);
        while (existingAncestor !== root && !pathExists(existingAncestor)) {
          existingAncestor = dirname(existingAncestor);
        }
        let realAncestor;
        try {
          realAncestor = realpathSync(existingAncestor);
        } catch (error) {
          throw new Error(
            `Git source checkout contains unresolved dangling symlink ${path} -> ${target}: ${error}`,
          );
        }
        const relativeRealAncestor = relative(realRoot, realAncestor);
        if (
          relativeRealAncestor === '..' ||
          relativeRealAncestor.startsWith(`..${sep}`) ||
          isAbsolute(relativeRealAncestor)
        ) {
          throw new Error(
            `Git source checkout contains transitively escaping dangling symlink ${path} -> ${target}`,
          );
        }
        continue;
      }
      let realTarget;
      try {
        realTarget = realpathSync(resolvedTarget);
      } catch (error) {
        throw new Error(
          `Git source checkout contains unresolved symlink ${path} -> ${target}: ${error}`,
        );
      }
      const relativeRealTarget = relative(realRoot, realTarget);
      if (
        relativeRealTarget === '..' ||
        relativeRealTarget.startsWith(`..${sep}`) ||
        isAbsolute(relativeRealTarget)
      ) {
        throw new Error(
          `Git source checkout contains transitively escaping symlink ${path} -> ${target}`,
        );
      }
    }
  }
}

function updateDigestField(hash, value) {
  hash.update(String(value), 'utf8');
  hash.update(Buffer.from([0]));
}

export function archiveTreeDigest(root) {
  if (!isRealDirectory(root)) {
    throw new Error(`archive source tree is not a real directory: ${root}`);
  }
  const entries = [];
  const pending = [root];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    for (const child of children) {
      if (directory === root && child.name === '.oliphaunt-source-pin') {
        continue;
      }
      const path = join(directory, child.name);
      const relativePath = relative(root, path).split(sep).join('/');
      const metadata = lstatSync(path);
      let type;
      let detail = '';
      if (metadata.isDirectory()) {
        type = 'directory';
        pending.push(path);
      } else if (metadata.isFile()) {
        type = 'file';
        totalBytes += metadata.size;
        if (totalBytes > CHECKOUT_MAX_BYTES) {
          throw new Error(`archive source tree ${root} exceeds ${CHECKOUT_MAX_BYTES} bytes`);
        }
        detail = `${metadata.size}:${sha256File(path)}`;
      } else if (metadata.isSymbolicLink()) {
        type = 'symlink';
        detail = readlinkSync(path);
      } else {
        throw new Error(`archive source tree contains unsupported filesystem object ${path}`);
      }
      entries.push({ relativePath, type, detail });
      if (entries.length > CHECKOUT_MAX_ENTRIES) {
        throw new Error(`archive source tree ${root} exceeds ${CHECKOUT_MAX_ENTRIES} entries`);
      }
    }
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)),
  );
  const hash = createHash('sha256');
  for (const entry of entries) {
    updateDigestField(hash, entry.type);
    updateDigestField(hash, entry.relativePath);
    updateDigestField(hash, entry.detail);
  }
  return hash.digest('hex');
}

export function parseArchiveStamp(path) {
  if (!isRegularFile(path, 64 * 1024)) {
    throw new Error(`archive source marker is missing, non-regular, or oversized: ${path}`);
  }
  const fields = new Map();
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`archive source marker ${path} contains a malformed line`);
    }
    const key = line.slice(0, separator);
    if (fields.has(key)) {
      throw new Error(`archive source marker ${path} repeats ${key}`);
    }
    fields.set(key, line.slice(separator + 1));
  }
  const required = [
    'safety',
    'name',
    'kind',
    'url',
    'branch',
    'commit',
    'sha256',
    'strip-prefix',
    'tree-sha256',
  ];
  if (fields.size !== required.length || required.some((key) => !fields.has(key))) {
    throw new Error(`archive source marker ${path} does not carry complete integrity state`);
  }
  if (fields.get('safety') !== ARCHIVE_SAFETY_VERSION) {
    throw new Error(
      `archive source marker ${path} predates ${ARCHIVE_SAFETY_VERSION}; move or remove the checkout before rematerializing it`,
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(fields.get('tree-sha256'))) {
    throw new Error(`archive source marker ${path} has an invalid tree digest`);
  }
  return fields;
}

function assertGitIdentity(source, path, snapshot) {
  const worktree = readGitSnapshot(snapshot, 'worktree');
  const gitDirectory = readGitSnapshot(snapshot, 'git-directory');
  if (
    !sameDirectoryIdentity(worktree, path) ||
    !sameDirectoryIdentity(gitDirectory, join(path, '.git'))
  ) {
    throw new Error(
      `source checkout ${path} (${source.name}) has Git metadata outside its durable directory`,
    );
  }
  if (isRegularFile(join(path, '.git', 'objects', 'info', 'alternates'))) {
    throw new Error(`source checkout ${path} (${source.name}) uses external Git object storage`);
  }
}

export function inspectDurablePath(source, path, snapshot) {
  if (!pathExists(path)) {
    return { kind: 'missing', matchesArchivePin: false };
  }
  if (!isRealDirectory(path)) {
    throw new Error(
      `durable source path ${path} (${source.name}) is not a real directory; preserve it before fetching pins`,
    );
  }
  assertSupportedGitMetadata(source, path);
  if (hasGitMetadata(path)) {
    assertGitIdentity(source, path, snapshot);
    if (readGitSnapshot(snapshot, 'status') !== '') {
      throw new Error(
        `source checkout ${path} (${source.name}) has uncommitted changes; preserve them before fetching pins`,
      );
    }
    return { kind: 'git', matchesArchivePin: false };
  }

  const markerPath = join(path, '.oliphaunt-source-pin');
  if (!pathExists(markerPath)) {
    throw new Error(
      `durable source path ${path} (${source.name}) is unmanaged; move or remove it before materializing a pinned source`,
    );
  }
  let fields;
  try {
    fields = parseArchiveStamp(markerPath);
  } catch (error) {
    throw new Error(
      `durable archive source ${path} (${source.name}) has unverifiable integrity state; preserve it before fetching pins: ${error}`,
    );
  }
  const actualTreeSha256 = archiveTreeDigest(path);
  const recordedTreeSha256 = fields.get('tree-sha256');
  if (actualTreeSha256 !== recordedTreeSha256) {
    throw new Error(
      `durable archive source ${path} (${source.name}) was modified: expected tree ${recordedTreeSha256}, got ${actualTreeSha256}; preserve it before fetching pins`,
    );
  }
  const matchesArchivePin =
    source.kind === 'archive' &&
    fields.get('name') === source.name &&
    fields.get('kind') === 'archive' &&
    fields.get('url') === source.url &&
    fields.get('branch') === source.branch &&
    fields.get('commit') === source.commit &&
    fields.get('sha256') === source.sha256 &&
    fields.get('strip-prefix') === source.stripPrefix;
  return { kind: 'archive', matchesArchivePin };
}

function readGitSnapshot(snapshot, field) {
  const file = join(snapshot, field);
  if (!isRegularFile(file, 16 * 1024 * 1024))
    throw new Error('missing or oversized Git snapshot: ' + file);
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)).trim();
}

export function sourceCheckoutIsReady(source, path, snapshot) {
  const durable = inspectDurablePath(source, path, snapshot);
  if (source.kind === 'archive') return durable.matchesArchivePin;
  return (
    durable.kind === 'git' &&
    readGitSnapshot(snapshot, 'head') === source.commit &&
    readGitSnapshot(snapshot, 'branch') === source.branch &&
    readGitSnapshot(snapshot, 'origin') === source.url &&
    readGitSnapshot(snapshot, 'autocrlf') === 'false' &&
    readGitSnapshot(snapshot, 'eol') === 'lf'
  );
}

export function validateCachedArchive(archive, source) {
  if (!isRegularFile(archive, DOWNLOAD_MAX_BYTES))
    throw new Error('archive is missing, non-regular, or oversized: ' + archive);
  const actual = sha256File(archive);
  if (actual !== source.sha256)
    throw new Error(`${source.name} archive sha256: expected ${source.sha256}, got ${actual}`);
  sourceArchiveEntries(archive, source.stripPrefix);
}

export function prepareSourceArchive(source, archive, candidate) {
  validateCachedArchive(archive, source);
  extractSourceArchive(archive, source.stripPrefix, candidate);
  const treeSha256 = archiveTreeDigest(candidate);
  writeFileSync(join(candidate, '.oliphaunt-source-pin'), archiveStamp(source, treeSha256), {
    encoding: 'utf8',
    mode: 0o644,
    flag: 'wx',
  });
}

if (import.meta.main) {
  try {
    const [operation, sourceFile, path, snapshot] = process.argv.slice(2);
    if (operation === 'promote') {
      promotePathTransactional(sourceFile, path);
    } else {
      const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
      validateSource(source);
      switch (operation) {
        case 'fields': {
          const suffix = new URL(source.url).pathname.endsWith('.zip') ? '.zip' : '.tar.gz';
          process.stdout.write(
            [
              source.name,
              source.kind,
              source.url,
              source.mirrorUrl ?? '',
              source.branch,
              source.commit,
              source.name + '-' + source.sha256 + suffix,
              canonicalGnuArchiveFallbackUrl(source.url) ?? '',
            ].join('\0') + '\0',
          );
          break;
        }
        case 'git-identity':
          assertGitIdentity(source, path, snapshot);
          break;
        case 'inspect':
          console.log(sourceCheckoutIsReady(source, path, snapshot) ? 'ready' : 'stale');
          break;
        case 'git-candidate':
          if (!sourceCheckoutIsReady(source, path, snapshot))
            throw new Error(
              'staged Git checkout did not preserve its exact pin, branch, and HTTPS origin',
            );
          assertSafeCheckoutTree(path);
          break;
        case 'archive-valid':
          try {
            validateCachedArchive(path, source);
            console.log('valid');
          } catch (error) {
            console.error(error.message);
            console.log('invalid');
          }
          break;
        case 'unpack':
          prepareSourceArchive(source, path, snapshot);
          break;
        default:
          throw new Error('unknown source data operation: ' + operation);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
