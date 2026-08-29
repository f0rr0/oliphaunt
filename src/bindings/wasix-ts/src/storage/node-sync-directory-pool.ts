import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { syncNodeDirectory } from '../node-fs-commit-state.js';

const OP = {
  metadata: 1,
  readDirectory: 2,
  createDirectory: 3,
  removeDirectory: 4,
  rename: 5,
  removeFile: 6,
  open: 7,
  close: 8,
  read: 9,
  write: 10,
  flush: 11,
  truncate: 12,
  unlink: 13,
  fileSize: 14,
} as const;

const RESULT = {
  ok: 0,
  notFound: 1,
  exists: 2,
  notDirectory: 3,
  notFile: 4,
  directoryNotEmpty: 5,
  permission: 6,
  invalid: 7,
  storageFull: 8,
  unsupported: 9,
  timeout: 10,
  io: 11,
} as const;

const FLAG_READ = 1 << 0;
const FLAG_WRITE = 1 << 1;
const FLAG_CREATE_NEW = 1 << 2;
const FLAG_CREATE = 1 << 3;
const FLAG_APPEND = 1 << 4;
const FLAG_TRUNCATE = 1 << 5;
const TYPE_FILE = 1;
const TYPE_DIRECTORY = 2;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type BridgeResult = [result: number, responseLength: number, value0: number, value1: number];

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

type FileRecord = {
  path?: string;
  readonly identity: FileIdentity;
  readonly descriptors: Set<number>;
};

type Descriptor = {
  readonly fd: number;
  readonly record: FileRecord;
  readonly append: boolean;
};

type PathContract = Pick<typeof import('node:path'), 'isAbsolute' | 'relative' | 'sep'>;
const NATIVE_PATH_CONTRACT: PathContract = { isAbsolute, relative, sep };

/**
 * A synchronous WASIX filesystem bridge backed by one real Node directory.
 *
 * PostgreSQL reaches the host files directly. The pool retains descriptor
 * identity across rename/unlink, rejects symbolic-link traversal on every
 * namespace operation, and records the additional directory fsyncs which the
 * generic virtual filesystem cannot express itself.
 */
export class NodeSyncDirectoryPool {
  readonly request: (
    opcode: number,
    path: string,
    buffer: Uint8Array,
    arg0: number,
    arg1: number,
    flags: number,
  ) => BridgeResult;

  readonly #root: string;
  // Identity records exist only while a file is open or awaiting durability.
  readonly #recordsByIdentity = new Map<string, FileRecord>();
  readonly #dirtyRecords = new Set<FileRecord>();
  readonly #descriptors = new Map<number, Descriptor>();
  readonly #dirtyDirectories = new Map<string, Set<number>>();
  #nextDescriptor = 1;
  #closed = false;
  #poison: unknown;

  constructor(root: string) {
    const requestedRootInfo = lstatSync(root, { bigint: true });
    if (requestedRootInfo.isSymbolicLink()) {
      throw new BridgeIoError(`${root} is a symbolic link`);
    }
    if (!requestedRootInfo.isDirectory()) throw new BridgeNotDirectoryError();
    this.#root = realpathSync.native(root);
    const rootInfo = lstatSync(this.#root, { bigint: true });
    const currentRequestedRootInfo = lstatSync(root, { bigint: true });
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      currentRequestedRootInfo.isSymbolicLink() ||
      !sameIdentity(identity(requestedRootInfo), identity(currentRequestedRootInfo)) ||
      !sameIdentity(identity(requestedRootInfo), identity(rootInfo))
    ) {
      throw new Error(`${this.#root} is not a real directory`);
    }
    validateNodeSyncDirectoryTree(this.#root);
    this.request = (opcode, path, buffer, arg0, arg1, flags) => {
      if (this.#closed || this.#poison !== undefined) return [RESULT.io, 0, 0, 0];
      try {
        return this.#dispatch(opcode, path, buffer, arg0, arg1, flags);
      } catch (error) {
        const result = classifyError(error);
        if (shouldPoison(opcode, result)) {
          this.#poison = error;
        }
        return [result, 0, 0, 0];
      }
    };
  }

  async sync(): Promise<void> {
    this.#assertUsable();
    if (this.#dirtyRecords.size === 0 && this.#dirtyDirectories.size === 0) return;
    try {
      for (const phase of [0, 1, 2]) {
        const records = [...this.#dirtyRecords]
          .filter((record) => publicationOrder(record.path ?? '') === phase)
          .sort((left, right) => (left.path ?? '').localeCompare(right.path ?? ''));
        for (const record of records) this.#flushRecord(record);

        const directories = [...this.#dirtyDirectories]
          .filter(([, phases]) => phases.has(phase))
          .map(([path]) => path)
          .sort(comparePathDepthDescending);
        for (const path of directories) {
          this.#requireSafeExistingHostPath(path, 'directory');
          await syncNodeDirectory(path);
          const phases = this.#dirtyDirectories.get(path);
          phases?.delete(phase);
          if (phases?.size === 0) this.#dirtyDirectories.delete(path);
        }
      }
    } catch (error) {
      this.#poison = error;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let failure: unknown;
    for (const descriptor of this.#descriptors.values()) {
      try {
        closeSync(descriptor.fd);
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error]);
      }
    }
    this.#descriptors.clear();
    this.#recordsByIdentity.clear();
    this.#dirtyRecords.clear();
    this.#dirtyDirectories.clear();
    if (failure !== undefined) throw failure;
  }

  #dispatch(
    opcode: number,
    path: string,
    buffer: Uint8Array,
    arg0: number,
    arg1: number,
    flags: number,
  ): BridgeResult {
    switch (opcode) {
      case OP.metadata:
        return this.#metadata(path);
      case OP.readDirectory:
        return this.#readDirectory(path, arg0, buffer);
      case OP.createDirectory:
        this.#createDirectory(path);
        break;
      case OP.removeDirectory:
        this.#removeDirectory(path);
        break;
      case OP.rename:
        this.#rename(path, UTF8_DECODER.decode(buffer));
        break;
      case OP.removeFile:
        this.#removeFile(path);
        break;
      case OP.open:
        return this.#open(path, flags);
      case OP.close:
        this.#closeDescriptor(arg0);
        break;
      case OP.read:
        return this.#read(arg0, arg1, buffer);
      case OP.write:
        return this.#write(arg0, arg1, buffer);
      case OP.flush:
        this.#flushRecord(this.#descriptor(arg0).record);
        break;
      case OP.truncate:
        this.#truncate(arg0, arg1);
        break;
      case OP.unlink:
        this.#unlinkDescriptor(arg0);
        break;
      case OP.fileSize:
        return [RESULT.ok, 0, fileSize(this.#descriptor(arg0).fd), 0];
      default:
        throw new BridgeInputError('unsupported Node filesystem bridge operation');
    }
    return [RESULT.ok, 0, 0, 0];
  }

  #metadata(path: string): BridgeResult {
    const host = this.#safeExistingPath(path, true);
    const info = lstatSync(host, { bigint: true });
    if (info.isDirectory()) return [RESULT.ok, 0, TYPE_DIRECTORY, 0];
    if (!info.isFile()) throw new BridgeIoError(`${path} is not a regular file or directory`);
    requireSingleLink(info.nlink, path);
    return [RESULT.ok, 0, TYPE_FILE, safeNumber(info.size, `${path} size`)];
  }

  #readDirectory(path: string, start: number, output: Uint8Array): BridgeResult {
    validateOffset(start);
    const host = this.#safeExistingPath(path, true);
    const info = lstatSync(host);
    if (!info.isDirectory()) throw new BridgeNotDirectoryError();
    const entries = readdirSync(host, { withFileTypes: true })
      .map((entry) => {
        const child = path.length === 0 ? entry.name : `${path}/${entry.name}`;
        const childHost = this.#safeExistingPath(child);
        const childInfo = lstatSync(childHost, { bigint: true });
        if (childInfo.isDirectory()) return { name: entry.name, type: TYPE_DIRECTORY };
        if (!childInfo.isFile()) {
          throw new BridgeIoError(`${child} is not a regular file or directory`);
        }
        requireSingleLink(childInfo.nlink, child);
        return { name: entry.name, type: TYPE_FILE };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (start > entries.length) throw new BridgeInputError('invalid directory cursor');
    const page = encodeDirectoryPage(entries, start, output.byteLength);
    output.set(page.bytes);
    return [RESULT.ok, page.bytes.byteLength, page.next, Number(page.next === entries.length)];
  }

  #createDirectory(path: string): void {
    const target = this.#safeCreationPath(path);
    mkdirSync(target, { mode: 0o700 });
    this.#markNamespace(path);
  }

  #removeDirectory(path: string): void {
    const target = this.#safeExistingPath(path);
    const info = lstatSync(target);
    if (!info.isDirectory()) throw new BridgeNotDirectoryError();
    rmdirSync(target);
    this.#forgetDirtyDirectoryTree(target);
    this.#markNamespace(path);
  }

  #rename(from: string, to: string): void {
    const source = this.#safeExistingPath(from);
    validateNodeSyncDirectoryTree(source);
    if (from === to) return;
    const destination = this.#safeCreationPath(to);
    const sourceInfo = lstatSync(source, { bigint: true });
    const sourceIdentity = sourceInfo.isFile() ? identity(sourceInfo) : undefined;

    let destinationIdentity: FileIdentity | undefined;
    try {
      const destinationInfo = lstatSync(destination, { bigint: true });
      if (destinationInfo.isSymbolicLink()) throw new BridgeIoError('symbolic link destination');
      if (destinationInfo.isFile()) {
        requireSingleLink(destinationInfo.nlink, to);
        destinationIdentity = identity(destinationInfo);
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }

    renameSync(source, destination);
    if (
      destinationIdentity !== undefined &&
      (sourceIdentity === undefined || !sameIdentity(sourceIdentity, destinationIdentity))
    ) {
      const replaced = this.#recordsByIdentity.get(identityKey(destinationIdentity));
      if (replaced !== undefined) this.#detach(replaced);
    }
    for (const record of this.#recordsByIdentity.values()) {
      const current = record.path;
      if (current !== from && current?.startsWith(`${from}/`) !== true) continue;
      const next = current === from ? to : `${to}${current?.slice(from.length) ?? ''}`;
      record.path = next;
    }
    this.#relocateDirtyDirectoryTree(source, destination, to);
    const renamePhase = Math.max(publicationOrder(from), publicationOrder(to));
    this.#markNamespace(from, renamePhase);
    this.#markNamespace(to, renamePhase);
  }

  #removeFile(path: string): void {
    const target = this.#safeExistingPath(path);
    const info = lstatSync(target, { bigint: true });
    if (!info.isFile()) throw new BridgeNotFileError();
    requireSingleLink(info.nlink, path);
    unlinkSync(target);
    const record = this.#recordsByIdentity.get(identityKey(identity(info)));
    if (record !== undefined) this.#detach(record);
    this.#markNamespace(path);
  }

  #open(path: string, flags: number): BridgeResult {
    validatePath(path);
    const read = (flags & FLAG_READ) !== 0;
    const write = (flags & FLAG_WRITE) !== 0;
    const append = (flags & FLAG_APPEND) !== 0;
    const create = (flags & (FLAG_CREATE | FLAG_CREATE_NEW)) !== 0;
    const truncate = (flags & FLAG_TRUNCATE) !== 0;
    if ((!read && !write && !append) || ((create || truncate) && !write && !append)) {
      throw new BridgeInputError('invalid open flags');
    }

    let existed = true;
    let target: string;
    try {
      target = this.#safeExistingPath(path);
      const info = lstatSync(target, { bigint: true });
      if (!info.isFile()) throw new BridgeNotFileError();
      requireSingleLink(info.nlink, path);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      existed = false;
      target = this.#safeCreationPath(path);
    }

    let nativeFlags =
      write || append ? (read ? constants.O_RDWR : constants.O_WRONLY) : constants.O_RDONLY;
    if ((flags & FLAG_CREATE_NEW) !== 0) nativeFlags |= constants.O_CREAT | constants.O_EXCL;
    else if ((flags & FLAG_CREATE) !== 0) nativeFlags |= constants.O_CREAT;
    if (append) nativeFlags |= constants.O_APPEND;
    nativeFlags |= NOFOLLOW;

    const fd = openSync(target, nativeFlags, 0o600);
    let descriptor: number | undefined;
    try {
      const info = fstatSync(fd, { bigint: true });
      if (!info.isFile()) throw new BridgeNotFileError();
      requireSingleLink(info.nlink, path);
      const fileIdentity = identity(info);
      const currentTarget = this.#safeExistingPath(path);
      const currentInfo = lstatSync(currentTarget, { bigint: true });
      if (!currentInfo.isFile() || !sameIdentity(fileIdentity, identity(currentInfo))) {
        throw new BridgeIoError(`${path} changed while it was opened`);
      }
      requireSingleLink(currentInfo.nlink, path);
      const key = identityKey(fileIdentity);
      let record = this.#recordsByIdentity.get(key);
      if (record === undefined) {
        record = { path, identity: fileIdentity, descriptors: new Set() };
      } else if (record.path !== path) {
        throw new BridgeIoError(`file identity for ${path} aliases ${record.path ?? 'an unlink'}`);
      }

      if (truncate) ftruncateSync(fd, 0);
      if (!this.#recordsByIdentity.has(key)) {
        this.#recordsByIdentity.set(key, record);
      }

      descriptor = this.#nextDescriptor++;
      record.descriptors.add(descriptor);
      this.#descriptors.set(descriptor, { fd, record, append });
      if (!existed) this.#markNamespace(path);
      if (!existed || truncate) this.#dirtyRecords.add(record);
      return [RESULT.ok, 0, descriptor, truncate ? 0 : safeNumber(info.size, `${path} size`)];
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  #closeDescriptor(value: number): void {
    const descriptor = this.#descriptor(value);
    closeSync(descriptor.fd);
    this.#descriptors.delete(value);
    descriptor.record.descriptors.delete(value);
    this.#evictClosedRecord(descriptor.record);
  }

  #read(value: number, offset: number, output: Uint8Array): BridgeResult {
    validateOffset(offset);
    const descriptor = this.#descriptor(value);
    const read = readSync(descriptor.fd, output, 0, output.byteLength, offset);
    return [RESULT.ok, read, 0, 0];
  }

  #write(value: number, offset: number, bytes: Uint8Array): BridgeResult {
    validateOffset(offset);
    const descriptor = this.#descriptor(value);
    const writeOffset = descriptor.append ? null : offset;
    const written = writeSync(descriptor.fd, bytes, 0, bytes.byteLength, writeOffset);
    this.#dirtyRecords.add(descriptor.record);
    const next = descriptor.append ? fileSize(descriptor.fd) : offset + written;
    return [RESULT.ok, 0, written, next];
  }

  #truncate(value: number, size: number): void {
    validateOffset(size);
    const descriptor = this.#descriptor(value);
    ftruncateSync(descriptor.fd, size);
    this.#dirtyRecords.add(descriptor.record);
  }

  #unlinkDescriptor(value: number): void {
    const descriptor = this.#descriptor(value);
    const record = descriptor.record;
    const path = record.path;
    if (path === undefined) return;
    const target = this.#safeExistingPath(path);
    const current = lstatSync(target, { bigint: true });
    if (!current.isFile() || !sameIdentity(record.identity, identity(current))) {
      throw new BridgeIoError(`${path} changed before descriptor unlink`);
    }
    requireSingleLink(current.nlink, path);
    unlinkSync(target);
    this.#detach(record);
    this.#markNamespace(path);
  }

  #flushRecord(record: FileRecord): void {
    if (!this.#dirtyRecords.has(record)) return;
    const path = record.path;
    let target: string | undefined;
    if (path !== undefined) {
      target = this.#safeExistingPath(path);
      const current = lstatSync(target, { bigint: true });
      if (!current.isFile() || !sameIdentity(record.identity, identity(current))) {
        throw new BridgeIoError(`${path} changed before flush`);
      }
      requireSingleLink(current.nlink, path);
    }
    const openDescriptor = [...record.descriptors]
      .map((value) => this.#descriptors.get(value))
      .find((value): value is Descriptor => value !== undefined);
    if (openDescriptor !== undefined) {
      fsyncSync(openDescriptor.fd);
    } else {
      if (path === undefined) {
        this.#dirtyRecords.delete(record);
        this.#evictClosedRecord(record);
        return;
      }
      const fd = openSync(target as string, constants.O_RDONLY | NOFOLLOW);
      try {
        const current = fstatSync(fd, { bigint: true });
        if (!current.isFile() || !sameIdentity(record.identity, identity(current))) {
          throw new BridgeIoError(`${path} changed before flush`);
        }
        requireSingleLink(current.nlink, path);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.#dirtyRecords.delete(record);
    this.#evictClosedRecord(record);
  }

  #detach(record: FileRecord): void {
    record.path = undefined;
    if (record.descriptors.size === 0) {
      this.#dirtyRecords.delete(record);
      this.#recordsByIdentity.delete(identityKey(record.identity));
    }
  }

  #evictClosedRecord(record: FileRecord): void {
    if (record.descriptors.size !== 0) return;
    // Once the last descriptor for an unlinked/replaced inode is closed there
    // is no file left to publish; only the parent-directory durability work
    // recorded by the namespace operation remains.
    if (record.path === undefined) this.#dirtyRecords.delete(record);
    if (!this.#dirtyRecords.has(record)) {
      this.#recordsByIdentity.delete(identityKey(record.identity));
    }
  }

  #descriptor(value: number): Descriptor {
    validateDescriptor(value);
    const descriptor = this.#descriptors.get(value);
    if (descriptor === undefined) throw new BridgeInputError('invalid descriptor');
    return descriptor;
  }

  #safeExistingPath(path: string, allowRoot = false): string {
    const parts = validatePath(path, allowRoot);
    let current = this.#root;
    for (const part of parts) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new BridgeIoError(`symbolic link path ${path}`);
      assertContained(this.#root, realpathSync.native(current));
    }
    return current;
  }

  #safeCreationPath(path: string): string {
    const parts = validatePath(path);
    const parent = parts.slice(0, -1).join('/');
    const safeParent = this.#safeExistingPath(parent, true);
    const parentInfo = lstatSync(safeParent);
    if (!parentInfo.isDirectory()) throw new BridgeNotDirectoryError();
    const target = join(safeParent, parts.at(-1) as string);
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink()) throw new BridgeIoError(`symbolic link path ${path}`);
      assertContained(this.#root, realpathSync.native(target));
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    return target;
  }

  #requireSafeExistingHostPath(path: string, kind: 'directory' | 'file'): void {
    assertContained(this.#root, realpathSync.native(path));
    const relativePath =
      process.platform === 'win32'
        ? nodeSyncContainedRelativePath(this.#root, path)
        : path === this.#root
          ? ''
          : path
              .slice(this.#root.length + 1)
              .split(sep)
              .join('/');
    const safe = this.#safeExistingPath(relativePath, true);
    const info = lstatSync(safe);
    if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) {
      throw new BridgeIoError(`${path} changed before persistence`);
    }
  }

  #markNamespace(path: string, phase = publicationOrder(path)): void {
    const parent = dirname(join(this.#root, ...validatePath(path)));
    let phases = this.#dirtyDirectories.get(parent);
    if (phases === undefined) {
      phases = new Set();
      this.#dirtyDirectories.set(parent, phases);
    }
    retainLatestPublicationPhase(phases, phase);
  }

  #forgetDirtyDirectoryTree(target: string): void {
    for (const path of this.#dirtyDirectories.keys()) {
      if (path === target || path.startsWith(`${target}${sep}`)) {
        this.#dirtyDirectories.delete(path);
      }
    }
  }

  #relocateDirtyDirectoryTree(source: string, destination: string, to: string): void {
    const moved = [...this.#dirtyDirectories]
      .filter(([path]) => path === source || path.startsWith(`${source}${sep}`))
      .map(([path, phases]) => ({ path, phases: new Set(phases) }));
    this.#forgetDirtyDirectoryTree(destination);
    for (const { path } of moved) this.#dirtyDirectories.delete(path);
    for (const { path, phases } of moved) {
      const suffix = path === source ? '' : path.slice(source.length).split(sep).join('/');
      const guestPath = path === source ? to : `${to}${suffix}`;
      retainLatestPublicationPhase(phases, publicationOrder(guestPath));
      const next = path === source ? destination : `${destination}${path.slice(source.length)}`;
      let existing = this.#dirtyDirectories.get(next);
      if (existing === undefined) {
        existing = new Set();
        this.#dirtyDirectories.set(next, existing);
      }
      for (const phase of phases) retainLatestPublicationPhase(existing, phase);
    }
  }

  #assertUsable(): void {
    if (this.#closed) throw new Error(`Node filesystem ${JSON.stringify(this.#root)} is closed`);
    if (this.#poison !== undefined) {
      throw new Error(`Node filesystem ${JSON.stringify(this.#root)} is poisoned`, {
        cause: this.#poison,
      });
    }
  }
}

/** Reject every link and non-file/non-directory object before mounting PGDATA. */
export function validateNodeSyncDirectoryTree(root: string): void {
  const initial = lstatSync(root, { bigint: true });
  if (initial.isSymbolicLink()) throw new BridgeIoError(`${root} is a symbolic link`);
  if (initial.isFile()) {
    requireSingleLink(initial.nlink, root);
    return;
  }
  if (!initial.isDirectory()) throw new BridgeIoError(`${root} has an unsupported file type`);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    validateNodeSyncDirectoryTree(join(root, entry.name));
  }
}

export function validateNodeSyncBridgePath(
  path: string,
  allowRoot = false,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (path === '') {
    if (allowRoot) return [];
    throw new BridgeInputError('empty path');
  }
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    throw new BridgeInputError('unsafe path');
  }
  const parts = path.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new BridgeInputError('unsafe path');
  }
  if (platform === 'win32' && parts.some(isUnsafeWindowsPathSegment)) {
    throw new BridgeInputError('unsafe Windows path');
  }
  return parts;
}

const validatePath = validateNodeSyncBridgePath;

function isUnsafeWindowsPathSegment(segment: string): boolean {
  if (
    segment.endsWith('.') ||
    segment.endsWith(' ') ||
    /[<>:"|?*]/u.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) <= 0x1f)
  ) {
    return true;
  }
  return /^(?:aux|clock\$|com[1-9¹²³]|con|conin\$|conout\$|lpt[1-9¹²³]|nul|prn)(?:\.|$)/iu.test(
    segment,
  );
}

function validateOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new BridgeInputError('invalid offset');
}

function validateDescriptor(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeInputError('invalid descriptor');
  }
}

function fileSize(fd: number): number {
  return safeNumber(fstatSync(fd, { bigint: true }).size, 'file size');
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BridgeIoError(`${label} is outside the bridge range`);
  }
  return Number(value);
}

function identity(info: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function identityKey(value: FileIdentity): string {
  return `${value.dev}:${value.ino}`;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireSingleLink(links: bigint, path: string): void {
  if (links !== 1n) throw new BridgeIoError(`${path} is not an exclusively named file`);
}

function publicationOrder(path: string): number {
  if (path === 'pg_wal' || path.startsWith('pg_wal/')) return 0;
  if (path === 'global/pg_control') return 2;
  return 1;
}

function retainLatestPublicationPhase(phases: Set<number>, phase: number): void {
  const latest = Math.max(phase, ...phases);
  phases.clear();
  phases.add(latest);
}

function comparePathDepthDescending(left: string, right: string): number {
  return right.split(sep).length - left.split(sep).length || right.localeCompare(left);
}

function encodeDirectoryPage(
  entries: readonly { name: string; type: number }[],
  start: number,
  capacity: number,
): { bytes: Uint8Array; next: number } {
  const selected: { entry: { name: string; type: number }; name: Uint8Array }[] = [];
  let length = 4;
  let next = start;
  while (next < entries.length) {
    const entry = entries[next] as { name: string; type: number };
    const name = UTF8_ENCODER.encode(entry.name);
    if (length + 5 + name.byteLength > capacity) break;
    selected.push({ entry, name });
    length += 5 + name.byteLength;
    next += 1;
  }
  if (capacity < 4 || (next < entries.length && selected.length === 0)) {
    throw new BridgeStorageFullError();
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, selected.length, true);
  let offset = 4;
  for (const selectedEntry of selected) {
    bytes[offset] = selectedEntry.entry.type;
    view.setUint32(offset + 1, selectedEntry.name.byteLength, true);
    bytes.set(selectedEntry.name, offset + 5);
    offset += 5 + selectedEntry.name.byteLength;
  }
  return { bytes, next };
}

function classifyError(error: unknown): number {
  if (error instanceof BridgeNotDirectoryError) return RESULT.notDirectory;
  if (error instanceof BridgeNotFileError) return RESULT.notFile;
  if (error instanceof BridgeInputError) return RESULT.invalid;
  if (error instanceof BridgeStorageFullError) return RESULT.storageFull;
  const code = nodeErrorCode(error);
  switch (code) {
    case 'ENOENT':
      return RESULT.notFound;
    case 'EEXIST':
      return RESULT.exists;
    case 'ENOTDIR':
      return RESULT.notDirectory;
    case 'EISDIR':
      return RESULT.notFile;
    case 'ENOTEMPTY':
      return RESULT.directoryNotEmpty;
    case 'EACCES':
    case 'EPERM':
      return RESULT.permission;
    case 'EINVAL':
      return RESULT.invalid;
    case 'EDQUOT':
    case 'EFBIG':
    case 'ENOSPC':
      return RESULT.storageFull;
    case 'ENOTSUP':
    case 'EOPNOTSUPP':
      return RESULT.unsupported;
    case 'ETIMEDOUT':
      return RESULT.timeout;
    default:
      return RESULT.io;
  }
}

function isMutatingOperation(opcode: number): boolean {
  const mutating: readonly number[] = [
    OP.createDirectory,
    OP.removeDirectory,
    OP.rename,
    OP.removeFile,
    OP.open,
    OP.write,
    OP.flush,
    OP.truncate,
    OP.unlink,
  ];
  return mutating.includes(opcode);
}

function shouldPoison(opcode: number, result: number): boolean {
  if (result === RESULT.io) return true;
  return (
    isMutatingOperation(opcode) && (result === RESULT.storageFull || result === RESULT.timeout)
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return nodeErrorCode(error) === code;
}

function assertContained(root: string, path: string): void {
  if (process.platform === 'win32') {
    nodeSyncContainedRelativePath(root, path);
    return;
  }
  const normalized = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(normalized)) {
    throw new BridgeIoError(`resolved path escapes ${root}`);
  }
}

/** @internal Host-path containment shared with platform-contract tests. */
export function nodeSyncContainedRelativePath(
  root: string,
  path: string,
  contract: PathContract = NATIVE_PATH_CONTRACT,
): string {
  const candidate = contract.relative(root, path);
  if (
    contract.isAbsolute(candidate) ||
    candidate === '..' ||
    candidate.startsWith(`..${contract.sep}`)
  ) {
    throw new BridgeIoError(`resolved path escapes ${root}`);
  }
  return candidate.split(contract.sep).join('/');
}

class BridgeInputError extends Error {}
class BridgeNotDirectoryError extends Error {}
class BridgeNotFileError extends Error {}
class BridgeStorageFullError extends Error {}
class BridgeIoError extends Error {}
