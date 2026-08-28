export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

type QueryReadOptions = Omit<import('./query.js').QueryOptions, 'encoders'>;
/** A synchronous, serial raw-protocol consumer used as the backpressure acknowledgement. */
export type ProtocolChunkCallback = (chunk: Uint8Array) => undefined;

export type OpenConfig = {
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
  extensions?: ReadonlyArray<string>;
  libraryPath?: string;
  runtimeDirectory?: string;
  brokerExecutable?: string;
};

export type ServerOpenConfig = Omit<OpenConfig, 'topology' | 'brokerExecutable' | 'libraryPath'> & {
  serverExecutable?: string;
  listen?: ServerListen;
};

export type ServerListen =
  | { readonly transport: 'tcp'; readonly port?: number }
  | {
      readonly transport: 'unix';
      readonly directory: string;
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
  libraryPath?: string;
};

export type OliphauntClient = {
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  openServer(config?: ServerOpenConfig): Promise<OliphauntServer>;
  restore(destination: string, backup: BinaryInput, options?: RestoreOptions): Promise<void>;
};
