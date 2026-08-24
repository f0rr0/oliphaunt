export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;
export type ProtocolChunkCallback = (chunk: Uint8Array) => void;

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
  listen?: ServerListen;
};

export type ServerListen =
  | { readonly transport: 'tcp'; readonly port?: number }
  | { readonly transport: 'unix'; readonly directory: string; readonly port?: number };

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
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
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
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
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
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  checkpoint(): Promise<void>;
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
