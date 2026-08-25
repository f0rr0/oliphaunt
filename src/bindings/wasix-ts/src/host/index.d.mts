export type WasixOutput = Readonly<{
  ok: boolean;
  code: number;
  stdoutBytes: Uint8Array;
  stdout: string;
  stderrBytes: Uint8Array;
  stderr: string;
}>;

export type OliphauntToolOutput = Readonly<{
  code: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}>;

export type DirectoryEntry = Readonly<{
  type: "dir" | "file" | "unknown";
  name: string;
}>;

export type DirectoryInit = Record<string, string | Uint8Array>;

export class Directory {
  constructor(files?: DirectoryInit | null);
  /** Create a filesystem served synchronously by a caller-realm backend. */
  static createSync(backend: object, capacity: number): Directory;
  free(): void;
  __getClassname(): string;
  createDir(path: string): Promise<void>;
  readDir(path: string): Promise<DirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  removeDir(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** List paths mutated since the last successful acknowledgement. */
  changedPaths(): string[];
  /** Discard the current mutation journal. */
  clearChanges(): void;
  /** Inspect a path without exception-based missing-entry detection. */
  entryType(path: string): string;
}

export class Instance {
  private constructor();
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  free(): void;
  wait(): Promise<WasixOutput>;
}

/** Caller-realm Oliphaunt driver. Methods run synchronously and never create a Worker. */
export class OliphauntDirectInstance {
  private constructor();
  startup(packet: Uint8Array): Uint8Array;
  execProtocolRaw(input: Uint8Array): Uint8Array;
  execProtocolStream(input: Uint8Array, onChunk: (chunk: Uint8Array) => void): void;
  execProtocolDuplex(
    input: Uint8Array,
    onRead: (maximumBytes: number) => Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): void;
  close(): void;
  free(): void;
}

/** Immutable caller-realm state reused across fresh frontend-tool processes. */
export class OliphauntPreparedTool {
  private constructor();
  free(): void;
}

export type RunWasixOptions = Readonly<{
  program?: string;
  moduleBytes?: Uint8Array;
  stdin?: string | Uint8Array;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  mount?: Record<string, DirectoryInit | Directory>;
}>;

export type WasmerInitOptions = Readonly<{
  module?:
    | RequestInfo
    | URL
    | Response
    | BufferSource
    | WebAssembly.Module
    | Promise<RequestInfo | URL | Response | BufferSource | WebAssembly.Module>;
  memory?: WebAssembly.Memory;
  workerUrl?: string | URL;
  sdkUrl?: string | URL;
  log?: string;
  registryUrl?: string;
  token?: string;
}>;

export function init(options?: WasmerInitOptions): Promise<unknown>;
export function runWasix(
  module: Uint8Array | WebAssembly.Module,
  options: RunWasixOptions,
): Promise<Instance>;
/** Internal preparation for repeated caller-realm frontend-tool invocations. */
export function prepareOliphauntTool(
  module: WebAssembly.Module,
  moduleBytes: Uint8Array,
): OliphauntPreparedTool;
/** Internal caller-realm runner for a single PostgreSQL frontend tool invocation. */
export function runOliphauntToolDirect(
  prepared: OliphauntPreparedTool,
  options: RunWasixOptions,
  protocolRead: (maximumBytes: number) => Uint8Array,
  /** Borrowed bytes: synchronously copy; never mutate or retain this view. */
  protocolWrite: (chunk: Uint8Array) => void,
): Promise<OliphauntToolOutput>;
export function instantiateOliphauntDirect(
  module: WebAssembly.Module,
  moduleBytes: Uint8Array,
  options: RunWasixOptions,
): Promise<OliphauntDirectInstance>;
