export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;
/**
 * A synchronous, serial raw-protocol consumer. Returning a Promise or thenable
 * rejects the stream because the native callback boundary cannot await it.
 */
export type ProtocolChunkCallback = (chunk: Uint8Array) => void;

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
  query<Row = import('./query.js').QueryObjectRow>(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').QueryOptions,
  ): Promise<import('./query.js').QueryResult<Row>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').RawQueryResult>;
  exec<Row = import('./query.js').QueryObjectRow>(
    sql: string,
    options?: Omit<import('./query.js').QueryOptions, 'encoders'>,
  ): Promise<import('./query.js').ExecResult<Row>>;
  describe(
    sql: string,
    parameterTypeOids?: ReadonlyArray<number>,
  ): Promise<import('./query.js').DescribeResult>;
  rollback(): Promise<void>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
};

export type OliphauntDatabase = {
  readonly closed: boolean;
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').CommandResult>;
  query<Row = import('./query.js').QueryObjectRow>(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').QueryOptions,
  ): Promise<import('./query.js').QueryResult<Row>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').RawQueryResult>;
  exec<Row = import('./query.js').QueryObjectRow>(
    sql: string,
    options?: Omit<import('./query.js').QueryOptions, 'encoders'>,
  ): Promise<import('./query.js').ExecResult<Row>>;
  describe(
    sql: string,
    parameterTypeOids?: ReadonlyArray<number>,
  ): Promise<import('./query.js').DescribeResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  backup(): Promise<Uint8Array>;
  cancel(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type OliphauntServer = {
  readonly closed: boolean;
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').CommandResult>;
  query<Row = import('./query.js').QueryObjectRow>(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').QueryOptions,
  ): Promise<import('./query.js').QueryResult<Row>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
    options?: import('./query.js').ParameterOptions,
  ): Promise<import('./query.js').RawQueryResult>;
  exec<Row = import('./query.js').QueryObjectRow>(
    sql: string,
    options?: Omit<import('./query.js').QueryOptions, 'encoders'>,
  ): Promise<import('./query.js').ExecResult<Row>>;
  describe(
    sql: string,
    parameterTypeOids?: ReadonlyArray<number>,
  ): Promise<import('./query.js').DescribeResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  cancel(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  readonly connectionString: string;
};

export type RestoreOptions = {
  libraryPath?: string;
};

export type OliphauntClient = {
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  openServer(config?: ServerOpenConfig): Promise<OliphauntServer>;
  restore(destination: string, backup: BinaryInput, options?: RestoreOptions): Promise<void>;
};
