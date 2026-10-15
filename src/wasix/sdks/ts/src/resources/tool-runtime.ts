import { assertSha256 } from './extensions.js';
import type { Directory, RunWasixOptions } from '../host/index.mjs';
import { loadAsset } from './archive.js';
import type { SerializedAssetSource } from '../workers/rpc.js';

export type WasixToolDescriptor = Readonly<{
  name: 'pg_dump' | 'psql';
  sha256: string;
  size: number;
  source: SerializedAssetSource;
  /** Selected native target carrier; browser execution only needs source. */
  aot?: Readonly<{ source: SerializedAssetSource; manifest: SerializedAssetSource }>;
}>;

export type WasixToolProcessOptions = Readonly<{
  runtimeVersion: string;
  tool: WasixToolDescriptor;
  args: readonly string[];
  /** @internal The admitted database-owned copy may be transferred to a worker. */
  stdin?: Uint8Array;
  /** Buffered text input; encode only after database admission. */
  script?: string;
  command?: string;
  /** Host path published create-only after tool and database cleanup succeed. */
  outputFile?: string;
  /** @internal Owned chunks; returning settles only after destination acceptance. */
  output?: WasixToolOutputDestination;
}>;

export type WasixToolOutputDestination = Readonly<{
  /** @internal Same-process native Worker output, registered in its parent realm. */
  nativeRegistration?: number;
  stdout(chunk: Uint8Array): Promise<void>;
  stderr?(chunk: Uint8Array): Promise<void>;
}>;

export type WasixToolProcessInput = WasixToolProcessOptions | (() => WasixToolProcessOptions);

/** @internal Snapshot queued work only after the shared database budget admits it. */
export function snapshotWasixToolProcessOptions(
  input: WasixToolProcessInput,
  retain: (bytes: number) => void,
): WasixToolProcessOptions {
  const options = typeof input === 'function' ? input() : input;
  if (options.stdin !== undefined && options.script !== undefined) {
    throw new TypeError('WASIX tools accept stdin or script, not both');
  }
  // Three UTF-8 bytes per UTF-16 unit also covers unpaired surrogates.
  retain(
    options.args.reduce((bytes, argument) => bytes + argument.length * 3, 0) +
      (options.command?.length ?? 0) * 3 +
      (options.script?.length ?? 0) * 3 +
      (options.outputFile?.length ?? 0) * 3 +
      (options.stdin?.byteLength ?? 0),
  );
  return {
    ...options,
    tool: { ...options.tool },
    args: [...options.args],
    ...(options.stdin === undefined ? {} : { stdin: Uint8Array.from(options.stdin) }),
  };
}

export type WasixToolProcessResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutBytes?: number;
  stderrTruncated?: boolean;
}>;

/** @internal The already-open database worker does not need carrier runtime metadata again. */
export type WasixPgDumpProcessOptions = Readonly<{
  tool: WasixToolDescriptor;
  args: readonly string[];
}>;

export type PreparedWasixToolAsset = Readonly<{
  name: 'pg_dump' | 'psql';
  bytes: Uint8Array;
  module: WebAssembly.Module;
}>;

/** @internal Verify and compile one immutable frontend program once per owning worker. */
export async function prepareWasixToolAsset(
  descriptor: WasixToolDescriptor,
): Promise<PreparedWasixToolAsset> {
  validateWasixToolDescriptor(descriptor);
  const loaded = await loadAsset(descriptor.source, `WASIX ${descriptor.name} module`);
  const bytes = standaloneBytes(loaded);
  if (bytes.length !== descriptor.size) {
    throw new Error(`WASIX ${descriptor.name} module size mismatch`);
  }
  await assertSha256(bytes, descriptor.sha256, `WASIX ${descriptor.name} module`);
  return {
    name: descriptor.name,
    bytes,
    module: await WebAssembly.compile(bytes),
  };
}

/** @internal Create only the fresh mutable paths a standalone frontend program uses. */
export async function materializeWasixToolMounts(
  DirectoryConstructor: typeof Directory,
  tool: PreparedWasixToolAsset,
): Promise<Record<string, Directory>> {
  const mounts: Record<string, Directory> = {};
  try {
    mounts['/bin'] = new DirectoryConstructor({ [tool.name]: tool.bytes });
    const home = new DirectoryConstructor();
    mounts['/home'] = home;
    await home.createDir('postgres');
    mounts['/tmp'] = new DirectoryConstructor();
    return mounts;
  } catch (error) {
    releaseWasixToolMounts(mounts, { primary: error });
  }
}

/** @internal Release every mount and retain both execution and cleanup failures. */
export function releaseWasixToolMounts(mounts: Record<string, Directory>): void;
export function releaseWasixToolMounts(
  mounts: Record<string, Directory>,
  failure: Readonly<{ primary: unknown }>,
): never;
export function releaseWasixToolMounts(
  mounts: Record<string, Directory>,
  failure?: Readonly<{ primary: unknown }>,
): void {
  const cleanupFailures: unknown[] = [];
  for (const directory of Object.values(mounts)) {
    try {
      directory.free();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (failure !== undefined) {
    if (cleanupFailures.length === 0) throw failure.primary;
    throw new AggregateError(
      [failure.primary, ...cleanupFailures],
      'WASIX tool execution and mount cleanup both failed',
      { cause: failure.primary },
    );
  }
  if (cleanupFailures.length !== 0) {
    throw new AggregateError(cleanupFailures, 'WASIX tool mount cleanup failed');
  }
}

/** @internal Build the identical fresh-process contract for both execution topologies. */
export function wasixToolRunOptions(
  tool: PreparedWasixToolAsset,
  args: readonly string[],
  mounts: Record<string, Directory>,
  stdin?: Uint8Array,
): RunWasixOptions {
  return {
    program: `/bin/${tool.name}`,
    args: [...args],
    cwd: '/',
    env: {
      PGUSER: 'postgres',
      PGPASSWORD: 'password',
      PGSSLMODE: 'disable',
      PGCLIENTENCODING: 'UTF8',
      ...(tool.name === 'psql' ? { OLIPHAUNT_PSQL_NONINTERACTIVE: '1' } : {}),
      HOME: '/home/postgres',
      PATH: '/bin',
      LC_CTYPE: 'C.UTF-8',
      TZ: 'UTC',
    },
    mount: mounts,
    stdin,
  };
}

export function validateWasixToolDescriptor(tool: WasixToolDescriptor): void {
  if (tool.name !== 'pg_dump' && tool.name !== 'psql') {
    throw new TypeError('unsupported Oliphaunt WASIX tool');
  }
  if (!/^[0-9a-f]{64}$/u.test(tool.sha256)) {
    throw new TypeError(`WASIX ${tool.name} SHA-256 is invalid`);
  }
  if (!Number.isSafeInteger(tool.size) || tool.size <= 0) {
    throw new TypeError(`WASIX ${tool.name} size is invalid`);
  }
}

export function wasixToolAssetIdentity(descriptor: WasixToolDescriptor): string {
  return `${descriptor.name}:${descriptor.sha256}:${descriptor.size}`;
}

function standaloneBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? (bytes as Uint8Array<ArrayBuffer>)
    : Uint8Array.from(bytes);
}
