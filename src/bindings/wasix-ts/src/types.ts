import type { CommandResult, QueryParam, QueryResult } from './query.js';
import type { PersistentWasixStorage, WasixStorage } from './storage.js';

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

/** A host-neutral asset reference accepted by the portable WASIX carrier contract. */
export type WasixAssetSource = string | URL | ArrayBuffer | Uint8Array;

/** One exact archive carried by the portable WASIX runtime package. */
export type WasixRuntimeArchive = Readonly<{
  /** Canonical path recorded by the generated runtime manifest. */
  archive: string;
  sha256: string;
  size: number;
  source: WasixAssetSource;
}>;

/** The canonical generated manifest carried alongside the runtime archives. */
export type WasixRuntimeManifest = Readonly<{
  sha256: string;
  size: number;
  source: WasixAssetSource;
}>;

/**
 * A package-authored runtime identity. The default value comes from
 * `@oliphaunt/liboliphaunt-wasix`; callers normally never handle it directly.
 */
export type WasixRuntimeDescriptor = Readonly<{
  schema: 'oliphaunt-wasix-runtime-v1';
  runtime: 'wasix';
  product: 'liboliphaunt-wasix';
  version: string;
  runtimeArchive: WasixRuntimeArchive;
  pgdataArchive: WasixRuntimeArchive;
  manifest: WasixRuntimeManifest;
}>;

export type WasixExtensionCarrier = Readonly<{
  /** Owning Oliphaunt release product, not the PostgreSQL SQL name. */
  product: string;
  /** Oliphaunt product version; upstream provenance stays release/evidence metadata. */
  version: string;
  sqlName: string;
  /** Exact canonical manifest archive key, for example `extensions/pgtap.tar.zst`. */
  archive: string;
  sha256: string;
  size: number;
  /** Portable archive URL or bytes. The same descriptor can be hosted by Node or a browser. */
  source: WasixAssetSource;
  /** Exact install contract owned by this independently versioned carrier. */
  install: WasixExtensionInstall;
}>;

export type WasixExtensionCompatibility = Readonly<{
  extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1';
  postgresMajor: string;
  wasixRuntimeProduct: 'liboliphaunt-wasix';
  wasixRuntimeVersion: string;
}>;

export type WasixExtensionInstall = Readonly<{
  schema: 'oliphaunt-wasix-extension-install-v1';
  name: string;
  nativeModule: string | null;
  nativeModules: readonly WasixExtensionNativeModule[];
  dependencies: readonly string[];
  coreExportsRequired: readonly string[];
  loadOrder: readonly string[];
  lifecycle: WasixExtensionLifecycle;
  installedFiles: readonly string[];
  unresolvedImports: readonly WasixExtensionImport[];
}>;

export type WasixExtensionImport = Readonly<{
  module: string;
  name: string;
  kind: string;
}>;

export type WasixExtensionNativeModule = Readonly<{
  name: string;
  path: string;
  sha256: string;
  moduleSha256: string;
  size: number;
}>;

export type WasixExtensionDescriptorInput = Readonly<{
  schema: 'oliphaunt-wasix-extension-v1';
  runtime: 'wasix';
  /** Product and version of the root carrier selected by `sqlName`. */
  product: string;
  version: string;
  /** Exact WASIX runtime identity against which this descriptor was qualified. */
  compatibility: WasixExtensionCompatibility;
  sqlName: string;
  /** Root carrier plus any extension carrier dependencies required by this import. */
  carriers: readonly WasixExtensionCarrier[];
}>;

/**
 * A package-authored, runtime-validated WASIX extension import. Applications
 * obtain these from extension packages instead of constructing SQL strings.
 * The schema and runtime literals discriminate it structurally, so generated
 * carrier packages do not need a dependency on this binding.
 */
export type WasixExtensionDescriptor = WasixExtensionDescriptorInput;

/** Lifecycle fields owned by an independently versioned extension carrier. */
export type WasixExtensionLifecycle = {
  createExtension: boolean;
  createSchema: string | null;
  loadSql: readonly string[];
  postCreateSql: readonly string[];
  startupConfig: readonly string[];
  preloadRequired: boolean;
  restartRequired: boolean;
  sharedMemoryRequired: boolean;
};

/** Host-relevant subset of the generated liboliphaunt WASIX asset manifest. */
export type WasixAssetManifest = {
  'format-version': 1;
  'source-fingerprint': string;
  runtime: {
    archive: string;
    sha256: string;
    /** Present when the canonical producer records the outer archive size. */
    size?: number;
    'module-sha256': string;
    'postgres-version': string;
    link: {
      exports: readonly {
        name: string;
        kind: string;
      }[];
    };
  };
  'runtime-support': readonly {
    name: string;
    path: string;
    sha256: string;
  }[];
  'pgdata-template': {
    archive: string;
    sha256: string;
    size: number;
    'runtime-module-sha256': string;
    'source-fingerprint': string;
    'postgres-version': string;
  };
  /** The core runtime carrier is intentionally extension-free. */
  extensions: readonly [];
};

/** Where package-owned WASIX lifecycle work runs. */
export type ExecutionMode = 'direct' | 'worker';

export type OpenConfig = {
  /** Worker-isolated by default; direct opens in and then blocks the caller's realm. */
  execution?: ExecutionMode;
  /** Existing PostgreSQL role selected after the fixed superuser bootstrap. */
  username?: string;
  database?: string;
  /** PostgreSQL `-c name=value` settings applied before the database opens. */
  startupGUCs?: Readonly<Record<string, string>>;
  /** Selectively imported WASIX carriers. SQL strings are intentionally not accepted. */
  extensions?: readonly WasixExtensionDescriptor[];
  /** Fresh memory by default, or an explicitly imported host storage adapter. */
  storage?: WasixStorage;
};

export type OliphauntDatabase = {
  execute(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<CommandResult>;
  query(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  /** Create a session-preserving PostgreSQL online physical backup. */
  backup(): Promise<Uint8Array>;
  /** CHECKPOINT PostgreSQL, then publish the resulting journaled PGDATA delta. */
  checkpoint(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** A database session pinned to one callback-scoped PostgreSQL transaction. */
export type OliphauntTransaction = {
  execute(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<CommandResult>;
  query(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
};

export type OliphauntClient = {
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  restore(storage: PersistentWasixStorage, bytes: BinaryInput): Promise<void>;
};
