export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

export type OpenConfig = {
  execution?: 'direct' | 'broker';
  storage?: DatabaseStorage;
  startupGUCs?: Readonly<Record<string, string>>;
  username?: string;
  database?: string;
  extensions?: ReadonlyArray<string>;
  libraryPath?: string;
  runtimeDirectory?: string;
  brokerExecutable?: string;
};

export type ServerOpenConfig = Omit<
  OpenConfig,
  'execution' | 'brokerExecutable' | 'libraryPath'
> & {
  serverExecutable?: string;
  serverPort?: number;
};

export type OliphauntTransaction = {
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').CommandResult>;
  query(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
};

export type OliphauntDatabase = {
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').CommandResult>;
  query(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  backup(): Promise<Uint8Array>;
  checkpoint(): Promise<void>;
  cancel(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type OliphauntServer = {
  execute(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').CommandResult>;
  query(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  checkpoint(): Promise<void>;
  cancel(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  readonly connectionString: string;
};

export type OliphauntClient = {
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  openServer(config?: ServerOpenConfig): Promise<OliphauntServer>;
  restore(destination: string, backup: BinaryInput): Promise<void>;
};
