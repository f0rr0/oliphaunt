/** A host filesystem path or a file URL, normalized before native execution. */
export type FilePathInput = string | URL;

export type DirectoryStorage = { readonly kind: 'directory'; readonly path: FilePathInput };

export type DatabaseStorage = { readonly kind: 'temporaryDirectory' } | DirectoryStorage;

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

/** An explicitly selected, immutable resource directory and its producer receipt. */
export type NativeResourceDirectory = {
  readonly directory: FilePathInput;
  readonly manifestPath: FilePathInput;
};

type QueryReadOptions = Omit<import('./query.js').QueryOptions, 'encoders'>;
/** A synchronous, serial raw-protocol consumer used as the backpressure acknowledgement. */
export type ProtocolChunkCallback = (chunk: Uint8Array) => undefined;

export type AdmissionLimits =
  import('@oliphaunt/ts-query/internal/operation-budget').AdmissionLimits;

export type OpenConfig = {
  /** Pending work shared by the database and its transaction handles. */
  admission?: AdmissionLimits;
  /**
   * Runtime placement topology. `direct` is in-process; it does not mean that
   * PostgreSQL work runs synchronously on the JavaScript caller thread.
   * Server ownership is selected explicitly with `Oliphaunt.openServer()`.
   */
  topology?: 'direct' | 'broker';
  storage?: DatabaseStorage;
  startupGUCs?: Readonly<Record<string, string>>;
  username?: string;
  database?: string;
  extensions?: ReadonlyArray<import('./extensions.js').NativeExtension>;
  libraryPath?: FilePathInput;
  runtimeDirectory?: FilePathInput;
  /** Optional preinitialized cluster. Without one, desktop initialization uses initdb. */
  seed?: NativeResourceDirectory;
  /** Canonical ICU data, selected independently of the runtime and seed. */
  icuData?: NativeResourceDirectory;
  brokerExecutable?: FilePathInput;
};

export type ServerOpenConfig = Omit<
  OpenConfig,
  'topology' | 'brokerExecutable' | 'libraryPath' | 'seed' | 'admission'
> & {
  serverExecutable?: FilePathInput;
  listen?: ServerListen;
};

export type ServerListen =
  | { readonly transport: 'tcp'; readonly port?: number }
  | {
      readonly transport: 'unix';
      readonly directory: FilePathInput;
      readonly port?: number;
    };

export type OliphauntTransaction = {
  readonly closed: boolean;
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').CommandResult>;
  query<Row = never, const Options extends import('./query.js').QueryOptions = {}>(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: Options & import('./query.js').QueryOptions,
  ): Promise<import('./query.js').QueryResult<import('./query.js').InferQueryRow<Options, Row>>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').RawQueryResult>;
  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options?: Options & QueryReadOptions,
  ): Promise<import('./query.js').ExecResult<import('./query.js').InferQueryRow<Options, Row>>>;
  describe(
    sql: string,
    parameterTypeOids?: ReadonlyArray<number>,
  ): Promise<import('./query.js').DescribeResult>;
  rollback(): Promise<void>;
};

export type OliphauntDatabase = {
  readonly closed: boolean;
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').CommandResult>;
  query<Row = never, const Options extends import('./query.js').QueryOptions = {}>(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: Options & import('./query.js').QueryOptions,
  ): Promise<import('./query.js').QueryResult<import('./query.js').InferQueryRow<Options, Row>>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').RawQueryResult>;
  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options?: Options & QueryReadOptions,
  ): Promise<import('./query.js').ExecResult<import('./query.js').InferQueryRow<Options, Row>>>;
  describe(
    sql: string,
    parameterTypeOids?: ReadonlyArray<number>,
  ): Promise<import('./query.js').DescribeResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  backup(): Promise<Uint8Array>;
  /** Publish a streamed physical archive to a new host file after backup cleanup succeeds. */
  backupToFile(destination: FilePathInput): Promise<void>;
  cancel(): Promise<void>;
  /**
   * Own the session for one callback. Use callback return/throw or rollback()
   * for lifecycle; manual BEGIN/START/COMMIT/END/ABORT/PREPARE TRANSACTION and
   * AND CHAIN are unsupported. SAVEPOINT and ROLLBACK TO are allowed.
   */
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type OliphauntServer = {
  readonly closed: boolean;
  /** Endpoint for caller-owned ORM, driver, or tool connections. */
  readonly connectionString: string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type RestoreOptions = {
  libraryPath?: FilePathInput;
};

export type OliphauntClient = {
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  openServer(config?: ServerOpenConfig): Promise<OliphauntServer>;
  restore(
    destination: DirectoryStorage,
    backup: BinaryInput,
    options?: RestoreOptions,
  ): Promise<void>;
};
