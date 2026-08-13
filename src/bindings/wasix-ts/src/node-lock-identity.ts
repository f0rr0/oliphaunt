import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';

export const NODE_DIRECTORY_LOCK_PREFIX = '.oliphaunt-lock-';
export const NODE_DIRECTORY_LOCK_SUFFIX = '.lease';
export const NODE_DIRECTORY_LOCK_SLOT = '.oliphaunt-lock.lease';
export const NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX = '.oliphaunt-lock-candidate-';

const TOKEN = /^[A-Za-z0-9-]{16,128}$/u;
const HASH = '[0-9a-f]{16}';
const LINUX_LOCK = new RegExp(
  `^\\.oliphaunt-lock-l-(${HASH})-(${HASH})-(${HASH})-([1-9][0-9]*)-([A-Za-z0-9-]{16,128})\\.lease$`,
  'u',
);
const PROCESS_LOCK = new RegExp(
  `^\\.oliphaunt-lock-p-(${HASH})-([1-9][0-9]*)-([A-Za-z0-9-]{16,128})\\.lease$`,
  'u',
);

type LinuxLockScope = Readonly<{
  kind: 'linux';
  host: string;
  boot: string;
  pidNamespace: string;
}>;

type ProcessLockScope = Readonly<{
  kind: 'process';
  process: string;
}>;

type NodeLockScope = LinuxLockScope | ProcessLockScope;

export type NodeDirectoryLockOwner = NodeLockScope &
  Readonly<{
    pid: number;
    token: string;
  }>;

const localScope = detectLocalScope();

export function nodeDirectoryLockName(pid: number, token: string): string {
  if (!Number.isSafeInteger(pid) || pid < 1 || !TOKEN.test(token)) {
    throw new TypeError('Node directory lock owner identity is invalid');
  }
  return localScope.kind === 'linux'
    ? `${NODE_DIRECTORY_LOCK_PREFIX}l-${localScope.host}-${localScope.boot}-${localScope.pidNamespace}-${pid}-${token}${NODE_DIRECTORY_LOCK_SUFFIX}`
    : `${NODE_DIRECTORY_LOCK_PREFIX}p-${localScope.process}-${pid}-${token}${NODE_DIRECTORY_LOCK_SUFFIX}`;
}

export function parseNodeDirectoryLockName(name: string): NodeDirectoryLockOwner | undefined {
  const linux = LINUX_LOCK.exec(name);
  if (linux !== null) {
    return {
      kind: 'linux',
      host: capture(linux, 1),
      boot: capture(linux, 2),
      pidNamespace: capture(linux, 3),
      pid: Number(linux[4]),
      token: capture(linux, 5),
    };
  }
  const process = PROCESS_LOCK.exec(name);
  if (process !== null) {
    return {
      kind: 'process',
      process: capture(process, 1),
      pid: Number(process[2]),
      token: capture(process, 3),
    };
  }
  return undefined;
}

export function nodeDirectoryLockCandidateToken(name: string): string | undefined {
  if (!name.startsWith(NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX)) return undefined;
  const token = name.slice(NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX.length);
  return TOKEN.test(token) ? token : undefined;
}

/** A lease is stale only when its process identity is meaningful locally. */
export function nodeDirectoryLockIsStale(owner: NodeDirectoryLockOwner): boolean {
  if (owner.kind !== localScope.kind) return false;
  if (owner.kind === 'linux' && localScope.kind === 'linux') {
    if (owner.host !== localScope.host) return false;
    // Directory storage supports local filesystems only. A lease from this
    // machine's previous boot cannot still own a process, regardless of PID
    // reuse or namespaces in the current boot.
    if (owner.boot !== localScope.boot) return true;
    if (owner.pidNamespace !== localScope.pidNamespace) return false;
  }
  // On hosts without Linux boot/namespace identities, local PID liveness is
  // the conservative arbiter. PID reuse can delay recovery but cannot evict a
  // live owner. Cross-host shared filesystems are outside this adapter's
  // contract, so a producer discriminator must not make crash remnants
  // permanent.
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, 'ESRCH');
  }
}

function detectLocalScope(): NodeLockScope {
  try {
    const host = readMachineId();
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const pidNamespace = readlinkSync('/proc/self/ns/pid').trim();
    if (host.length > 0 && boot.length > 0 && pidNamespace.length > 0) {
      return {
        kind: 'linux',
        host: digest(host),
        boot: digest(boot),
        pidNamespace: digest(pidNamespace),
      };
    }
  } catch {
    // Non-Linux hosts retain a producer discriminator in the owner identity;
    // local PID liveness still governs recovery for the local-filesystem-only
    // adapter contract.
  }
  return {
    kind: 'process',
    // Worker isolates share the process PID and executable, while PPID can
    // change after OS reparenting. Keep this fallback stable for the process.
    process: digest(`${process.pid}\0${process.execPath}`),
  };
}

function readMachineId(): string {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value.length > 0) return value;
    } catch {
      // Try the next conventional machine-id location.
    }
  }
  throw new Error('machine identity is unavailable');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error('Node directory lock pattern invariant failed');
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
