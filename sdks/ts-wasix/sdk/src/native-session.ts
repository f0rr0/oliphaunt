import { loadAsset } from './archive.js';
import { assertSha256, loadIcuData, loadSeedBytes } from './extensions.js';
import {
  WasixStorageError,
  type WasixStorageCommitState,
  type WasixStorageErrorCode,
  type WasixStoragePhase,
} from './errors.js';
import {
  loadNativeWasixAddon,
  type NativeWasixAddon,
  type NativeWasixActorDatabaseHandle,
  type NativeWasixDatabaseHandle,
  type NativeWasixOpenOptions,
  type NativeWasixToolResult,
  type NativeWasixToolAssets,
} from './native-addon.js';
import {
  normalizeWasixDatabaseIdentity,
  type WasixDatabaseIdentity,
  type WasixDatabaseSession,
  type WasixDatabaseSessionTerminalState,
  type WasixPersistenceMode,
  type WasixProtocolStreamOutcome,
} from './database.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type {
  WasixPgDumpProcessOptions,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './tool-runtime.js';
import { validateWasixToolDescriptor } from './tool-runtime.js';

/** @internal A synchronous Rust Oliphaunt owned by the importing JavaScript realm. */
export class NativeWasixSession implements WasixDatabaseSession {
  readonly identity: WasixDatabaseIdentity;
  readonly terminalState: NativeHandleTerminalState;
  readonly #handle: NativeWasixDatabaseHandle;
  readonly #runtimeVersion: string;
  #closed = false;
  #closeAttempt: Promise<void> | undefined;

  private constructor(
    handle: NativeWasixDatabaseHandle,
    identity: WasixDatabaseIdentity,
    runtimeVersion: string,
  ) {
    this.#handle = handle;
    this.identity = identity;
    this.#runtimeVersion = runtimeVersion;
    this.terminalState = new NativeHandleTerminalState(
      () => this.#handle.closed,
      'Oliphaunt WASIX direct owner stopped unexpectedly',
    );
  }

  static async open(options: SerializedOpenOptions): Promise<NativeWasixSession> {
    const addon = requireCompatibleNativeWasixAddon(options);
    let nativeOptions: NativeWasixOpenOptions;
    if (options.storage.kind === 'memory') {
      nativeOptions = nativeWasixOpenOptions(options, { kind: 'memory' });
    } else if (options.storage.kind === 'directory') {
      nativeOptions = nativeWasixOpenOptions(options, {
        kind: 'directory',
        path: options.storage.path,
      });
    } else {
      const provider = options.storage.kind === 'indexed-db' ? 'IndexedDB' : 'OPFS';
      throw new TypeError(`@oliphaunt/wasix-ts ${provider} storage is browser-only`);
    }

    try {
      const handle = addon.NativeWasixDatabase.open({
        ...nativeOptions,
        ...(await loadNativeResources(options)),
      });
      validateDatabaseHandle(handle);
      return new NativeWasixSession(
        handle,
        normalizeWasixDatabaseIdentity(options.username, options.database),
        options.runtime.version,
      );
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async exec(input: Uint8Array, _persistence: WasixPersistenceMode = 'sync'): Promise<Uint8Array> {
    this.#assertOpen();
    try {
      return binaryView(this.#handle.execProtocolRaw(input));
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async execStream(
    input: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
    _persistence: WasixPersistenceMode = 'sync',
  ): Promise<WasixProtocolStreamOutcome> {
    this.#assertOpen();
    let outcome: ReturnType<NativeWasixDatabaseHandle['execProtocolRawStream']>;
    try {
      outcome = this.#handle.execProtocolRawStream(input, (chunk) => onChunk(binaryView(chunk)));
    } catch (error) {
      throw this.#mapFailure(error);
    }
    if (outcome === 'complete') return outcome;
    if (outcome === 'callbackAborted') return outcome;
    throw new Error(`Oliphaunt WASIX native addon returned invalid stream outcome ${outcome}`);
  }

  async sync(_boundary: WasixStorageSyncBoundary): Promise<void> {
    this.#assertOpen();
    // Rust's host-directory filesystem publishes and flushes inside each
    // synchronous protocol operation. Memory storage has no host boundary.
  }

  async backup(): Promise<Uint8Array> {
    this.#assertOpen();
    try {
      return binaryView(this.#handle.backup());
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  runPgDump(options: WasixPgDumpProcessOptions): Promise<WasixToolProcessResult> {
    return this.runTool({
      runtimeVersion: '',
      tool: options.tool,
      args: options.args,
    });
  }

  async runTool(options: WasixToolProcessOptions): Promise<WasixToolProcessResult> {
    this.#assertOpen();
    const assets = await loadNativeToolAssets(this.#runtimeVersion, options);
    if (options.tool.name === 'pg_dump') {
      try {
        return toolProcessResult(
          this.#handle.pgDump(userPgDumpArguments(options.args, this.identity), assets),
        );
      } catch (error) {
        throw this.#mapFailure(error);
      }
    }
    const parsed = userPsqlArguments(options.args, options.stdin, this.identity);
    try {
      return toolProcessResult(
        this.#handle.psql(parsed.args, assets, parsed.command, parsed.script),
      );
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  close(): Promise<void> {
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    this.#closed = true;
    this.terminalState.beginOrderlyClose();
    this.#closeAttempt = this.#close();
    return this.#closeAttempt;
  }

  async #close(): Promise<void> {
    try {
      this.#handle.close();
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX native session is closed');
    }
    this.terminalState.assertActive();
  }

  #mapFailure(error: unknown): unknown {
    const mapped = mapNativeError(error);
    this.terminalState.recordFailure(mapped);
    return mapped;
  }
}

/** @internal A Rust-owner actor whose Promise completions return to the importing realm. */
export class NativeWasixActorSession implements WasixDatabaseSession {
  readonly identity: WasixDatabaseIdentity;
  readonly terminalState: NativeHandleTerminalState;
  readonly #handle: NativeWasixActorDatabaseHandle;
  readonly #runtimeVersion: string;
  #closed = false;
  #closeAttempt: Promise<void> | undefined;

  private constructor(
    handle: NativeWasixActorDatabaseHandle,
    identity: WasixDatabaseIdentity,
    runtimeVersion: string,
  ) {
    this.#handle = handle;
    this.identity = identity;
    this.#runtimeVersion = runtimeVersion;
    this.terminalState = new NativeHandleTerminalState(
      () => this.#handle.closed,
      'Oliphaunt WASIX actor owner stopped unexpectedly',
    );
  }

  static async open(options: SerializedOpenOptions): Promise<NativeWasixActorSession> {
    const addon = requireCompatibleNativeWasixAddon(options);
    try {
      const handle = await addon.NativeWasixActorDatabase.open({
        ...nativeWasixOpenOptions(options, nativeStorage(options)),
        ...(await loadNativeResources(options)),
      });
      validateActorDatabaseHandle(handle);
      return new NativeWasixActorSession(
        handle,
        normalizeWasixDatabaseIdentity(options.username, options.database),
        options.runtime.version,
      );
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  async exec(input: Uint8Array, _persistence: WasixPersistenceMode = 'sync'): Promise<Uint8Array> {
    this.#assertOpen();
    try {
      return binaryView(await this.#handle.execProtocolRaw(input));
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async execStream(
    input: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
    _persistence: WasixPersistenceMode = 'sync',
  ): Promise<WasixProtocolStreamOutcome> {
    this.#assertOpen();
    let outcome: Awaited<ReturnType<NativeWasixActorDatabaseHandle['execProtocolRawStream']>>;
    try {
      outcome = await this.#handle.execProtocolRawStream(input, (chunk) =>
        onChunk(binaryView(chunk)),
      );
    } catch (error) {
      throw this.#mapFailure(error);
    }
    if (outcome === 'complete' || outcome === 'callbackAborted') return outcome;
    throw new Error(`Oliphaunt WASIX native actor returned invalid stream outcome ${outcome}`);
  }

  async sync(_boundary: WasixStorageSyncBoundary): Promise<void> {
    this.#assertOpen();
    // Rust publishes host-directory storage at the operation boundary.
  }

  async backup(): Promise<Uint8Array> {
    this.#assertOpen();
    try {
      return binaryView(await this.#handle.backup());
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  runPgDump(options: WasixPgDumpProcessOptions): Promise<WasixToolProcessResult> {
    return this.runTool({ runtimeVersion: '', tool: options.tool, args: options.args });
  }

  async runTool(options: WasixToolProcessOptions): Promise<WasixToolProcessResult> {
    this.#assertOpen();
    const assets = await loadNativeToolAssets(this.#runtimeVersion, options);
    try {
      if (options.tool.name === 'pg_dump') {
        return toolProcessResult(
          await this.#handle.pgDump(userPgDumpArguments(options.args, this.identity), assets),
        );
      }
      const parsed = userPsqlArguments(options.args, options.stdin, this.identity);
      return toolProcessResult(
        await this.#handle.psql(parsed.args, assets, parsed.command, parsed.script),
      );
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  close(): Promise<void> {
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    this.#closed = true;
    this.terminalState.beginOrderlyClose();
    this.#closeAttempt = this.#close();
    return this.#closeAttempt;
  }

  async #close(): Promise<void> {
    try {
      await this.#handle.close();
    } catch (error) {
      throw mapNativeError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX native actor session is closed');
    }
    this.terminalState.assertActive();
  }

  #mapFailure(error: unknown): unknown {
    const mapped = mapNativeError(error);
    this.terminalState.recordFailure(mapped);
    return mapped;
  }
}

/** @internal Stable observation of a native owner which can retire below TypeScript. */
class NativeHandleTerminalState implements WasixDatabaseSessionTerminalState {
  readonly #isClosed: () => boolean;
  readonly #ownerLossMessage: string;
  #orderlyClose = false;
  #failure: Error | undefined;

  constructor(isClosed: () => boolean, ownerLossMessage: string) {
    this.#isClosed = isClosed;
    this.#ownerLossMessage = ownerLossMessage;
  }

  get terminal(): boolean {
    this.#observeOwnerLoss();
    return this.#failure !== undefined;
  }

  get failure(): Error | undefined {
    return this.#failure;
  }

  assertActive(): void {
    this.#observeOwnerLoss();
    if (this.#failure !== undefined) throw this.#failure;
  }

  beginOrderlyClose(): void {
    this.#orderlyClose = true;
  }

  recordFailure(error: unknown): void {
    if (this.#orderlyClose || !this.#closedAfterFailure()) return;
    this.#failure ??= terminalError(error, this.#ownerLossMessage);
  }

  #observeOwnerLoss(): void {
    if (this.#orderlyClose || this.#failure !== undefined) return;
    try {
      if (this.#isClosed()) this.#failure = new Error(this.#ownerLossMessage);
    } catch (error) {
      this.#failure = terminalError(error, this.#ownerLossMessage);
    }
  }

  #closedAfterFailure(): boolean {
    try {
      return this.#isClosed();
    } catch {
      // A synchronous failure while observing the native owner's terminal bit
      // is itself loss of that owner. Preserve the operation's original error.
      return true;
    }
  }
}

/** @internal Restore through the synchronous Rust archive validator. */
export async function restoreNativeWasix(
  options: SerializedOpenOptions,
  bytes: Uint8Array,
): Promise<void> {
  const addon = requireCompatibleNativeWasixAddon(options);
  return restoreNativeWasixStorage(options.storage, bytes, addon);
}

/** @internal Worker-side restore after the parent has validated package config. */
export async function restoreNativeWasixStorage(
  storage: SerializedOpenOptions['storage'],
  bytes: Uint8Array,
  addon: NativeWasixAddon = loadNativeWasixAddon(),
): Promise<void> {
  if (storage.kind !== 'directory') {
    throw new TypeError('WASIX restore requires Node-compatible directory storage');
  }
  try {
    await addon.restore(storage.path, bytes);
  } catch (error) {
    throw mapNativeError(error);
  }
}

/** @internal Restore synchronously inside `/direct` or its dedicated Worker realm. */
export async function restoreNativeWasixDirect(
  options: SerializedOpenOptions,
  bytes: Uint8Array,
): Promise<void> {
  const addon = requireCompatibleNativeWasixAddon(options);
  return restoreNativeWasixStorageDirect(options.storage, bytes, addon);
}

/** @internal Worker-side synchronous restore after the parent validates config. */
export async function restoreNativeWasixStorageDirect(
  storage: SerializedOpenOptions['storage'],
  bytes: Uint8Array,
  addon: NativeWasixAddon = loadNativeWasixAddon(),
): Promise<void> {
  if (storage.kind !== 'directory') {
    throw new TypeError('WASIX restore requires Node-compatible directory storage');
  }
  try {
    addon.restoreDirect(storage.path, bytes);
  } catch (error) {
    throw mapNativeError(error);
  }
}

/** @internal Validate serialized package descriptors against the selected addon. */
export function requireCompatibleNativeWasixAddon(
  options: SerializedOpenOptions,
): NativeWasixAddon {
  const addon = loadNativeWasixAddon();
  if (
    options.runtime.product !== 'liboliphaunt-wasix' ||
    options.runtime.version !== addon.runtimeVersion()
  ) {
    throw new Error(
      `WASIX runtime ${options.runtime.version} is incompatible with native runtime ${addon.runtimeVersion()}`,
    );
  }
  requireEmbeddedPayloadIdentity(
    addon,
    'runtimeArchive',
    options.runtime.runtimeArchive,
    'runtime archive',
  );
  for (const [sqlName, carrier] of Object.entries(options.extensionCarriers)) {
    if (carrier.sqlName !== sqlName) {
      throw new Error(`WASIX extension carrier key ${sqlName} does not match ${carrier.sqlName}`);
    }
    const expectedIdentity = `${carrier.sha256}:${carrier.size}`;
    if (addon.extensionIdentity(sqlName) !== expectedIdentity) {
      throw new Error(
        `WASIX extension ${sqlName} descriptor does not match the archive embedded in the native addon`,
      );
    }
  }
  return addon;
}

function requireEmbeddedPayloadIdentity(
  addon: NativeWasixAddon,
  component: Parameters<NativeWasixAddon['payloadIdentity']>[0],
  descriptor: Readonly<{ sha256: string; size: number }>,
  label: string,
): void {
  if (addon.payloadIdentity(component) !== `${descriptor.sha256}:${descriptor.size}`) {
    throw new Error(`WASIX ${label} descriptor does not match the native addon payload`);
  }
}

export async function loadNativeResources(options: SerializedOpenOptions) {
  const [seed, icuData] = await Promise.all([
    options.seed === undefined ? undefined : loadSeedBytes(options.seed),
    options.icu === undefined ? undefined : loadIcuData(options.icu),
  ]);
  return {
    ...(seed === undefined ? {} : { seed }),
    ...(icuData === undefined
      ? {}
      : { icuData: { data: icuData.data, manifest: icuData.manifest } }),
  };
}

/** @internal Project already-validated TS config onto the narrow native ABI. */
export function nativeWasixOpenOptions(
  options: SerializedOpenOptions,
  storage: NativeWasixOpenOptions['storage'],
): NativeWasixOpenOptions {
  const identity = normalizeWasixDatabaseIdentity(options.username, options.database);
  return {
    profile: options.icu === undefined ? 'standard' : 'icu',
    storage,
    username: identity.username,
    database: identity.database,
    startupGucs: { ...options.startupGUCs },
    extensions: [...options.extensions],
  };
}

function nativeStorage(options: SerializedOpenOptions): NativeWasixOpenOptions['storage'] {
  if (options.storage.kind === 'memory') return { kind: 'memory' };
  if (options.storage.kind === 'directory') {
    return { kind: 'directory', path: options.storage.path };
  }
  const provider = options.storage.kind === 'indexed-db' ? 'IndexedDB' : 'OPFS';
  throw new TypeError(`@oliphaunt/wasix-ts ${provider} storage is browser-only`);
}

async function loadNativeToolAssets(
  runtimeVersion: string,
  options: WasixToolProcessOptions,
): Promise<NativeWasixToolAssets> {
  if (options.runtimeVersion !== '' && options.runtimeVersion !== runtimeVersion) {
    throw new Error(
      `WASIX tools runtime ${options.runtimeVersion} is incompatible with database runtime ${runtimeVersion}`,
    );
  }
  validateWasixToolDescriptor(options.tool);
  if (!options.tool.aot)
    throw new Error('WASIX native tools require the installed target AOT carrier');
  const [wasm, aot, manifest] = await Promise.all([
    loadAsset(options.tool.source, 'WASIX tool module'),
    loadAsset(options.tool.aot.source, 'WASIX tool AOT'),
    loadAsset(options.tool.aot.manifest, 'WASIX tools AOT manifest'),
  ]);
  if (wasm.length !== options.tool.size) throw new Error('WASIX tool module size mismatch');
  await assertSha256(wasm, options.tool.sha256, 'WASIX tool module');
  return { wasm, aot, manifest: new TextDecoder('utf-8', { fatal: true }).decode(manifest) };
}

function validateDatabaseHandle(handle: NativeWasixDatabaseHandle): void {
  if (
    typeof handle !== 'object' ||
    handle === null ||
    typeof handle.closed !== 'boolean' ||
    typeof handle.execProtocolRaw !== 'function' ||
    typeof handle.execProtocolRawStream !== 'function' ||
    typeof handle.backup !== 'function' ||
    typeof handle.pgDump !== 'function' ||
    typeof handle.psql !== 'function' ||
    typeof handle.close !== 'function'
  ) {
    throw new Error('Oliphaunt WASIX native addon returned an invalid database handle');
  }
}

function validateActorDatabaseHandle(handle: NativeWasixActorDatabaseHandle): void {
  if (
    typeof handle !== 'object' ||
    handle === null ||
    typeof handle.closed !== 'boolean' ||
    typeof handle.execProtocolRaw !== 'function' ||
    typeof handle.execProtocolRawStream !== 'function' ||
    typeof handle.backup !== 'function' ||
    typeof handle.pgDump !== 'function' ||
    typeof handle.psql !== 'function' ||
    typeof handle.close !== 'function'
  ) {
    throw new Error('Oliphaunt WASIX native addon returned an invalid actor database handle');
  }
}

function binaryView(value: Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new TypeError('Oliphaunt WASIX native addon returned a non-binary value');
}

function toolProcessResult(result: NativeWasixToolResult): WasixToolProcessResult {
  if (
    typeof result !== 'object' ||
    result === null ||
    !Number.isSafeInteger(result.status) ||
    !isBinary(result.stdout) ||
    !isBinary(result.stderr)
  ) {
    throw new TypeError('Oliphaunt WASIX native tool returned an invalid process result');
  }
  return {
    exitCode: result.status,
    stdout: binaryView(result.stdout),
    stderr: binaryView(result.stderr),
  };
}

function userPgDumpArguments(args: readonly string[], identity: WasixDatabaseIdentity): string[] {
  const suffix = [
    '--encoding=UTF8',
    '--no-password',
    `--username=${identity.username}`,
    '--host=127.0.0.1',
    '--port=65432',
    `--dbname=${identity.database}`,
  ];
  return stripManagedSuffix('pg_dump', args, suffix);
}

function userPsqlArguments(
  args: readonly string[],
  stdin: Uint8Array | undefined,
  identity: WasixDatabaseIdentity,
): Readonly<{ args: string[]; command?: string; script?: string }> {
  const managed = [
    '--no-psqlrc',
    '--no-password',
    '--set=ON_ERROR_STOP=1',
    `--username=${identity.username}`,
    '--host=127.0.0.1',
    '--port=65432',
    `--dbname=${identity.database}`,
  ];
  const start = findExactSequence(args, managed);
  if (start < 0) throw new Error('Oliphaunt WASIX psql call has an invalid managed argument set');
  const user = args.slice(0, start);
  const input = args.slice(start + managed.length);
  if (input.length === 0) return { args: user };
  if (input.length === 2 && input[0] === '--command' && input[1] !== undefined) {
    return { args: user, command: input[1] };
  }
  if (input.length === 1 && input[0] === '--file=-' && stdin !== undefined) {
    return {
      args: user,
      script: new TextDecoder('utf-8', { fatal: true }).decode(stdin),
    };
  }
  throw new Error('Oliphaunt WASIX psql call has invalid managed input arguments');
}

function stripManagedSuffix(
  tool: string,
  args: readonly string[],
  suffix: readonly string[],
): string[] {
  if (
    args.length < suffix.length ||
    !suffix.every((argument, index) => args[args.length - suffix.length + index] === argument)
  ) {
    throw new Error(`Oliphaunt WASIX ${tool} call has an invalid managed argument set`);
  }
  return args.slice(0, -suffix.length);
}

function findExactSequence(values: readonly string[], expected: readonly string[]): number {
  for (let start = values.length - expected.length; start >= 0; start -= 1) {
    if (expected.every((value, offset) => values[start + offset] === value)) return start;
  }
  return -1;
}

/** @internal Translate only the exact tagged native storage contract. */
export function mapNativeError(error: unknown): unknown {
  if (error instanceof WasixStorageError) return error;
  const details = nativeStorageError(error);
  if (details === undefined) return error;
  return new WasixStorageError(describeError(error), { ...details, cause: error });
}

type NativeStorageError = Readonly<{
  code: WasixStorageErrorCode;
  commitState: WasixStorageCommitState;
  phase: WasixStoragePhase;
}>;

const STORAGE_CODES = [
  'busy',
  'corrupt',
  'incomplete',
  'incompatible',
  'publication-failed',
  'unavailable',
] as const satisfies readonly WasixStorageErrorCode[];
const STORAGE_COMMIT_STATES = [
  'not-persisted',
  'persisted',
  'unchanged',
  'unknown',
] as const satisfies readonly WasixStorageCommitState[];
const STORAGE_PHASES = [
  'ownership',
  'open',
  'open-publication',
  'operation',
  'backup',
  'close',
  'restore-validation',
  'restore-staging',
  'restore-publication',
  'restore-durability',
] as const satisfies readonly WasixStoragePhase[];

function nativeStorageError(error: unknown): NativeStorageError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as Record<string, unknown>;
  if (
    candidate.oliphauntWasixError !== 'storage' ||
    candidate.oliphauntWasixAddonAbi !== 2 ||
    !memberOf(candidate.code, STORAGE_CODES) ||
    !memberOf(candidate.commitState, STORAGE_COMMIT_STATES) ||
    !memberOf(candidate.phase, STORAGE_PHASES)
  ) {
    return undefined;
  }
  return {
    code: candidate.code,
    commitState: candidate.commitState,
    phase: candidate.phase,
  };
}

function memberOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}
