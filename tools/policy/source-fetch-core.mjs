import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

const ARCHIVE_SAFETY_VERSION = 'source-archive-v2';
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 620_000;
const ARCHIVE_VALIDATE_TIMEOUT_MS = 120_000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 300_000;
const GIT_FETCH_TIMEOUT_MS = 300_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const CHECKOUT_MAX_ENTRIES = 500_000;
const CHECKOUT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

const temporaryPaths = new Set();
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
    throw new Error(`${label} must be an absolute HTTPS URL: ${error instanceof Error ? error.message : error}`);
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

export function curlPlatformTlsArgs(platform = process.platform) {
  return platform === 'win32' ? ['--ssl-revoke-best-effort'] : [];
}

export function curlDownloadArgs(url, output, {platform = process.platform} = {}) {
  assertHttpsUrl(url);
  return [
    '--disable',
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--retry',
    '8',
    '--retry-all-errors',
    '--retry-connrefused',
    '--retry-delay',
    '5',
    '--retry-max-time',
    '600',
    '--connect-timeout',
    '20',
    '--max-time',
    '600',
    '--speed-limit',
    '1024',
    '--speed-time',
    '120',
    '--max-filesize',
    String(DOWNLOAD_MAX_BYTES),
    '--max-redirs',
    '5',
    '--proto-default',
    'https',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--tlsv1.2',
    ...curlPlatformTlsArgs(platform),
    '--remove-on-error',
    '--url',
    url,
    '--output',
    output,
  ];
}

export function defaultRunProcess({command, args, cwd, env = process.env, label, timeoutMs}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  const description = label ?? `${command} ${args.join(' ')}`;
  if (result.error !== undefined) {
    const timeout = result.error.code === 'ETIMEDOUT' ? ` after ${timeoutMs}ms` : '';
    throw new Error(`${description} failed${timeout}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout;
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
  rmSync(path, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
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
      cleanupTemporaryPaths();
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

function cleanupTemporaryPaths() {
  for (const path of [...temporaryPaths].reverse()) {
    try {
      removePath(path);
    } catch (error) {
      process.stderr.write(`warning: could not remove source-fetch staging path ${path}: ${error}\n`);
    }
  }
}

function makeStageDirectory(parent, name) {
  mkdirSync(parent, {recursive: true});
  installSignalHandlers();
  const stage = mkdtempSync(join(parent, `.${name}-stage-`));
  temporaryPaths.add(stage);
  return stage;
}

function forgetStageDirectory(stage) {
  temporaryPaths.delete(stage);
  removePath(stage);
}

export function promotePathTransactional(candidate, destination, {afterBackup} = {}) {
  if (!pathExists(candidate)) {
    throw new Error(`transaction candidate does not exist: ${candidate}`);
  }
  mkdirSync(dirname(destination), {recursive: true});
  installSignalHandlers();
  const hadPrevious = pathExists(destination);
  const backup = join(dirname(destination), `.${destination.split(sep).at(-1)}-backup-${process.pid}-${randomUUID()}`);
  const promotion = {destination, backup, hadPrevious};
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

function validateSource(source) {
  validateSourceName(source.name);
  const parsedUrl = assertHttpsUrl(source.url, `source '${source.name}' URL`);
  const parsedMirrorUrl = source.mirrorUrl === undefined
    ? undefined
    : assertHttpsUrl(source.mirrorUrl, `source '${source.name}' mirror URL`);
  validateBranchName(source.branch);
  if (source.kind === 'git') {
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
      throw new Error(`archive source '${source.name}' must pin one lowercase SHA-256 as sha256 and commit`);
    }
    if (
      typeof source.stripPrefix !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(source.stripPrefix) ||
      source.stripPrefix.includes('..')
    ) {
      throw new Error(`archive source '${source.name}' has an unsafe strip prefix`);
    }
    if (!parsedUrl.pathname.endsWith('.tar.gz') && !parsedUrl.pathname.endsWith('.tgz')) {
      throw new Error(`archive source '${source.name}' URL must identify a .tar.gz or .tgz file`);
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

function isolatedGitEnvironment(globalConfig) {
  const env = {...process.env};
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_ASKPASS',
    'GIT_TEMPLATE_DIR',
    'GIT_CONFIG_COUNT',
  ]) {
    delete env[name];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

function stagedGitEnvironment(stage) {
  const globalConfig = join(stage, 'empty.gitconfig');
  writeFileSync(globalConfig, '', {mode: 0o600});
  return isolatedGitEnvironment(globalConfig);
}

function durableGitEnvironment() {
  return isolatedGitEnvironment(process.platform === 'win32' ? 'NUL' : '/dev/null');
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

export function sameDirectoryIdentity(left, right, {stat = statSync} = {}) {
  const leftMetadata = stat(left, {bigint: true});
  const rightMetadata = stat(right, {bigint: true});
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
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
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
      if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
        throw new Error(`Git source checkout contains escaping symlink ${path} -> ${target}`);
      }
      if (!pathExists(resolvedTarget)) {
        throw new Error(`Git source checkout contains dangling symlink ${path} -> ${target}`);
      }
      let realTarget;
      try {
        realTarget = realpathSync(resolvedTarget);
      } catch (error) {
        throw new Error(`Git source checkout contains unresolved symlink ${path} -> ${target}: ${error}`);
      }
      const relativeRealTarget = relative(realRoot, realTarget);
      if (
        relativeRealTarget === '..' ||
        relativeRealTarget.startsWith(`..${sep}`) ||
        isAbsolute(relativeRealTarget)
      ) {
        throw new Error(`Git source checkout contains transitively escaping symlink ${path} -> ${target}`);
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
    const children = readdirSync(directory, {withFileTypes: true}).sort((left, right) =>
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
      entries.push({relativePath, type, detail});
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

function parseArchiveStamp(path) {
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

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function createSourceFetcher({
  workspaceRoot,
  checkoutRoot,
  archiveRoot,
  archiveTool = join(workspaceRoot, 'tools', 'policy', 'source-archive.py'),
  runProcess = defaultRunProcess,
  sleep = defaultSleep,
  gitAttempts = 5,
  downloadFile,
  validateArchive,
  extractArchive,
} = {}) {
  if (!workspaceRoot || !checkoutRoot || !archiveRoot) {
    throw new Error('source fetcher requires workspaceRoot, checkoutRoot, and archiveRoot');
  }

  const run = (command, args, options = {}) =>
    runProcess({
      command,
      args,
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? process.env,
      label: options.label,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  const validate =
    validateArchive ??
    ((archive, source) =>
      run('python3', [archiveTool, 'validate', archive, source.stripPrefix], {
        label: `validate archive structure for ${source.name}`,
        timeoutMs: ARCHIVE_VALIDATE_TIMEOUT_MS,
      }));
  const extract =
    extractArchive ??
    ((archive, destination, source) =>
      run('python3', [archiveTool, 'extract', archive, source.stripPrefix, destination], {
        label: `safely extract ${source.name}`,
        timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
      }));
  const download =
    downloadFile ??
    ((source, output) =>
      run('curl', curlDownloadArgs(source.url, output), {
        label: `download ${source.name} from pinned HTTPS URL`,
        timeoutMs: ARCHIVE_DOWNLOAD_TIMEOUT_MS,
      }));

  function git(source, args, cwd, env, options = {}) {
    return run('git', ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args], {
      cwd,
      env,
      label: options.label ?? `git ${args.join(' ')} for ${source.name}`,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  }

  function cleanGitStatus(source, path, env = durableGitEnvironment()) {
    const status = git(source, ['status', '--porcelain=v1', '--untracked-files=all'], path, env, {
      label: `read dirty state for ${source.name} at ${path}`,
    });
    if (status.trim() !== '') {
      throw new Error(`source checkout ${path} (${source.name}) has uncommitted changes; preserve them before fetching pins`);
    }
  }

  function gitCheckoutIsReady(source, path) {
    const env = durableGitEnvironment();
    cleanGitStatus(source, path, env);
    try {
      const head = git(source, ['rev-parse', '--verify', 'HEAD'], path, env).trim();
      const branch = git(source, ['branch', '--show-current'], path, env).trim();
      const remote = git(source, ['remote', 'get-url', 'origin'], path, env).trim();
      return head === source.commit && branch === source.branch && remote === source.url;
    } catch {
      return false;
    }
  }

  function inspectDurablePath(source, path) {
    if (!pathExists(path)) {
      return {kind: 'missing', matchesArchivePin: false};
    }
    if (!isRealDirectory(path)) {
      throw new Error(`durable source path ${path} (${source.name}) is not a real directory; preserve it before fetching pins`);
    }
    assertSupportedGitMetadata(source, path);
    if (hasGitMetadata(path)) {
      const env = durableGitEnvironment();
      const worktree = git(source, ['rev-parse', '--show-toplevel'], path, env).trim();
      const gitDirectory = git(source, ['rev-parse', '--absolute-git-dir'], path, env).trim();
      if (!sameDirectoryIdentity(worktree, path) || !sameDirectoryIdentity(gitDirectory, join(path, '.git'))) {
        throw new Error(`source checkout ${path} (${source.name}) has Git metadata outside its durable directory`);
      }
      if (isRegularFile(join(path, '.git', 'objects', 'info', 'alternates'))) {
        throw new Error(`source checkout ${path} (${source.name}) uses external Git object storage`);
      }
      cleanGitStatus(source, path, env);
      return {kind: 'git', matchesArchivePin: false};
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
    return {kind: 'archive', matchesArchivePin};
  }

  async function fetchGit(source, path) {
    const durable = inspectDurablePath(source, path);
    if (durable.kind === 'git' && gitCheckoutIsReady(source, path)) {
      return;
    }

    const stage = makeStageDirectory(dirname(path), `${source.name}-git`);
    const candidate = join(stage, 'checkout');
    try {
      const env = stagedGitEnvironment(stage);
      git(source, ['init', '--quiet', '--template=', candidate], workspaceRoot, env, {
        label: `initialize staged checkout for ${source.name}`,
      });
      git(source, ['remote', 'add', 'origin', source.url], candidate, env, {
        label: `configure staged HTTPS origin for ${source.name}`,
      });

      const transports = [
        {name: 'primary', url: source.url},
        ...(source.mirrorUrl === undefined ? [] : [{name: 'mirror', url: source.mirrorUrl}]),
      ];
      let lastError;
      for (let attempt = 1; attempt <= gitAttempts; attempt += 1) {
        const transport = transports[(attempt - 1) % transports.length];
        try {
          git(
            source,
            [
              '-c',
              'protocol.allow=never',
              '-c',
              'protocol.https.allow=always',
              '-c',
              'credential.helper=',
              '-c',
              'http.followRedirects=false',
              '-c',
              'http.lowSpeedLimit=1024',
              '-c',
              'http.lowSpeedTime=120',
              'fetch',
              '--no-tags',
              '--depth=1',
              transport.url,
              source.commit,
            ],
            candidate,
            env,
            {
              label: `fetch exact commit for ${source.name} from ${transport.name} transport`,
              timeoutMs: GIT_FETCH_TIMEOUT_MS,
            },
          );
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < gitAttempts) {
            const completedTransportCycle = attempt % transports.length === 0;
            if (completedTransportCycle) {
              const completedCycles = attempt / transports.length;
              const delaySeconds = completedCycles * 5;
              process.stderr.write(
                `fetch ${source.name} from ${transport.name} transport failed on attempt ${attempt}/${gitAttempts}: ${error}; retrying in ${delaySeconds}s\n`,
              );
              await sleep(delaySeconds * 1000);
            } else {
              const nextTransport = transports[attempt % transports.length];
              process.stderr.write(
                `fetch ${source.name} from ${transport.name} transport failed on attempt ${attempt}/${gitAttempts}: ${error}; trying ${nextTransport.name} transport without delay\n`,
              );
            }
          }
        }
      }
      if (lastError !== undefined) {
        throw lastError;
      }

      const fetched = git(source, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], candidate, env).trim();
      if (fetched !== source.commit) {
        throw new Error(`fetch for ${source.name} returned ${fetched}, expected exact commit ${source.commit}`);
      }
      git(source, ['checkout', '--quiet', '-B', source.branch, source.commit], candidate, env, {
        label: `checkout exact staged commit for ${source.name}`,
      });
      cleanGitStatus(source, candidate, env);
      const head = git(source, ['rev-parse', '--verify', 'HEAD'], candidate, env).trim();
      const branch = git(source, ['branch', '--show-current'], candidate, env).trim();
      const remote = git(source, ['remote', 'get-url', 'origin'], candidate, env).trim();
      if (head !== source.commit || branch !== source.branch || remote !== source.url) {
        throw new Error(`staged Git checkout for ${source.name} did not preserve its exact pin, branch, and HTTPS origin`);
      }
      // Gitlinks remain opaque pinned entries. This fetcher globally disables
      // recursion, so no secondary URL or unpinned submodule transport can run.
      assertSafeCheckoutTree(candidate);

      inspectDurablePath(source, path);
      promotePathTransactional(candidate, path);
    } finally {
      forgetStageDirectory(stage);
    }
  }

  function cachedArchiveIsValid(archive, source) {
    if (!pathExists(archive)) {
      return false;
    }
    if (!isRegularFile(archive, DOWNLOAD_MAX_BYTES)) {
      process.stderr.write(`warning: repairing non-regular or oversized archive cache ${archive}\n`);
      return false;
    }
    const actual = sha256File(archive);
    if (actual !== source.sha256) {
      process.stderr.write(
        `warning: repairing corrupt archive cache ${archive}: expected ${source.sha256}, got ${actual}\n`,
      );
      return false;
    }
    try {
      validate(archive, source);
      return true;
    } catch (error) {
      process.stderr.write(`warning: repairing structurally unsafe archive cache ${archive}: ${error}\n`);
      return false;
    }
  }

  async function ensureArchive(source) {
    mkdirSync(archiveRoot, {recursive: true});
    const archive = join(archiveRoot, `${source.name}-${source.sha256}.tar.gz`);
    if (cachedArchiveIsValid(archive, source)) {
      return archive;
    }

    const stage = makeStageDirectory(archiveRoot, `${source.name}-download`);
    const candidate = join(stage, 'download.tar.gz');
    try {
      await download(source, candidate);
      if (!isRegularFile(candidate, DOWNLOAD_MAX_BYTES)) {
        throw new Error(`download for ${source.name} did not create one bounded regular file at ${candidate}`);
      }
      const actual = sha256File(candidate);
      if (actual !== source.sha256) {
        throw new Error(`${source.name} archive sha256: expected ${source.sha256}, got ${actual}`);
      }
      validate(candidate, source);
      promotePathTransactional(candidate, archive);
      return archive;
    } finally {
      forgetStageDirectory(stage);
    }
  }

  async function fetchArchive(source, path) {
    const durable = inspectDurablePath(source, path);
    if (durable.kind === 'archive' && durable.matchesArchivePin) {
      return;
    }

    const archive = await ensureArchive(source);
    const stage = makeStageDirectory(dirname(path), `${source.name}-extract`);
    const candidate = join(stage, 'checkout');
    try {
      extract(archive, candidate, source);
      if (!isRealDirectory(candidate)) {
        throw new Error(`safe extractor did not create the staged source directory ${candidate}`);
      }
      const treeSha256 = archiveTreeDigest(candidate);
      writeFileSync(join(candidate, '.oliphaunt-source-pin'), archiveStamp(source, treeSha256), {
        encoding: 'utf8',
        mode: 0o644,
        flag: 'wx',
      });
      inspectDurablePath(source, path);
      promotePathTransactional(candidate, path);
    } finally {
      forgetStageDirectory(stage);
    }
  }

  async function materialize(source, explicitPath) {
    validateSource(source);
    const path = explicitPath ?? join(checkoutRoot, source.name);
    const expectedPath = resolve(checkoutRoot, source.name);
    if (resolve(path) !== expectedPath) {
      throw new Error(`source checkout path must be the named child ${expectedPath}, got ${path}`);
    }
    if (source.kind === 'archive') {
      await fetchArchive(source, path);
    } else {
      await fetchGit(source, path);
    }
  }

  function verify(source, explicitPath) {
    validateSource(source);
    const path = explicitPath ?? join(checkoutRoot, source.name);
    const expectedPath = resolve(checkoutRoot, source.name);
    if (resolve(path) !== expectedPath) {
      throw new Error(`source checkout path must be the named child ${expectedPath}, got ${path}`);
    }
    const durable = inspectDurablePath(source, path);
    if (source.kind === 'archive') {
      if (durable.kind !== 'archive' || !durable.matchesArchivePin) {
        throw new Error(`archive source checkout ${path} (${source.name}) is missing or stale`);
      }
      return;
    }
    if (durable.kind !== 'git' || !gitCheckoutIsReady(source, path)) {
      throw new Error(`Git source checkout ${path} (${source.name}) is missing or stale`);
    }
  }

  return {materialize, verify, ensureArchive};
}
