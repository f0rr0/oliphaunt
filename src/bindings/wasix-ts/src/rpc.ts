import type { WasixPersistenceMode, WasixProtocolConnectionMode } from './database.js';
import { WasixStorageError } from './errors.js';
import { PostgresError, type PostgresErrorField } from './query.js';
import type { SerializedWasixStorage } from './storage.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import type { WasixToolDescriptor, WasixToolProcessResult } from './tool-runtime.js';

export type SerializedAssetSource = string | Uint8Array;

export type SerializedExtensionCarrier = {
  product: string;
  version: string;
  sqlName: string;
  archive: string;
  sha256: string;
  size: number;
  source: SerializedAssetSource;
  compatibility: {
    extensionRuntimeContract: string;
    postgresMajor: string;
    wasixRuntimeProduct: 'liboliphaunt-wasix';
    wasixRuntimeVersion: string;
  };
  install: {
    schema: 'oliphaunt-wasix-extension-install-v1';
    name: string;
    nativeModule: string | null;
    nativeModules: {
      name: string;
      path: string;
      sha256: string;
      moduleSha256: string;
      size: number;
    }[];
    dependencies: string[];
    coreExportsRequired: string[];
    loadOrder: string[];
    lifecycle: {
      createExtension: boolean;
      createSchema?: string | null;
      loadSql: string[];
      postCreateSql: string[];
      startupConfig: string[];
      preloadRequired: boolean;
      restartRequired: boolean;
      sharedMemoryRequired: boolean;
    };
    installedFiles: string[];
    unresolvedImports: { module: string; name: string; kind: string }[];
  };
};

export type SerializedRuntimeArchive = {
  archive: string;
  sha256: string;
  size: number;
  source: SerializedAssetSource;
};

export type SerializedRuntimeDescriptor = {
  schema: 'oliphaunt-wasix-runtime-v2';
  runtime: 'wasix';
  product: 'liboliphaunt-wasix';
  version: string;
  runtimeArchive: SerializedRuntimeArchive;
  standardSeedArchive: SerializedRuntimeArchive;
  standardSeedManifest: {
    sha256: string;
    size: number;
    source: SerializedAssetSource;
  };
  manifest: {
    sha256: string;
    size: number;
    source: SerializedAssetSource;
  };
};

/** Runtime subset required by PostgreSQL frontend tools. */
export type SerializedToolRuntimeDescriptor = Pick<
  SerializedRuntimeDescriptor,
  'product' | 'version' | 'runtimeArchive' | 'manifest'
>;

export type SerializedIcuDescriptor = {
  schema: 'oliphaunt-wasix-icu-v1';
  runtime: 'wasix';
  product: 'oliphaunt-icu';
  version: string;
  compatibility: {
    runtimeProduct: 'liboliphaunt-wasix';
    runtimeVersion: string;
    postgresMajor: '18';
    physicalFormat: 'wasix-pg18-v1';
    compatibilityKey: 'wasix-pg18-datum32-v1';
    dataVersion: '76.1';
    dataForm: 'files-le';
    dataTreeSha256: string;
  };
  dataArchive: SerializedRuntimeArchive;
  clusterSeedArchive: SerializedRuntimeArchive;
  clusterSeedManifest: {
    sha256: string;
    size: number;
    source: SerializedAssetSource;
  };
};

/** Host-ready open options shared by direct and worker execution. */
export type SerializedOpenOptions = {
  runtime: SerializedRuntimeDescriptor;
  icu?: SerializedIcuDescriptor;
  /** Exact imported carrier closure, keyed by PostgreSQL SQL name. */
  extensionCarriers: Record<string, SerializedExtensionCarrier>;
  extensions: string[];
  username: string;
  database: string;
  startupGUCs: Record<string, string>;
  storage: SerializedWasixStorage;
};

/** @internal Compatibility name for the serialized options sent to a worker. */
export type WorkerOpenOptions = SerializedOpenOptions;

export type WorkerRequest =
  | { id: number; method: 'open'; options: SerializedOpenOptions }
  | {
      id: number;
      method: 'exec';
      input: Uint8Array;
      persistence: WasixPersistenceMode;
    }
  | {
      id: number;
      method: 'execStream';
      input: Uint8Array;
      persistence: WasixPersistenceMode;
      control: SharedArrayBuffer;
    }
  | { id: number; method: 'sync'; boundary: WasixStorageSyncBoundary }
  | { id: number; method: 'backup' }
  | {
      id: number;
      method: 'runPgDump';
      tool: WasixToolDescriptor;
      args: string[];
    }
  | {
      id: number;
      method: 'serve';
      connection: WasixProtocolConnection;
      mode: WasixProtocolConnectionMode;
    }
  | { id: number; method: 'close' };

export type SerializedWorkerError =
  | {
      name: 'WasixStorageError';
      message: string;
      code: WasixStorageError['code'];
      commitState: WasixStorageError['commitState'];
    }
  | { name: 'PostgresError'; message: string; fields: PostgresErrorField[] }
  | { name: 'Error'; message: string };

export type WorkerResponse =
  | { id: number; kind: 'chunk'; sequence: number; value: Uint8Array }
  | { id: number; ok: true; value?: Uint8Array | WasixToolProcessResult }
  | { id: number; ok: false; error: SerializedWorkerError };

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof WasixStorageError) {
    return {
      name: 'WasixStorageError',
      message: error.message,
      code: error.code,
      commitState: error.commitState,
    };
  }
  if (error instanceof PostgresError) {
    return {
      name: 'PostgresError',
      message: error.message,
      fields: error.fields.map((field) => ({ ...field })),
    };
  }
  return {
    name: 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function deserializeWorkerError(error: SerializedWorkerError): Error {
  if (error.name === 'WasixStorageError') {
    return new WasixStorageError(error.message, {
      code: error.code,
      commitState: error.commitState,
    });
  }
  if (error.name === 'PostgresError') {
    const restored = new PostgresError(error.fields);
    restored.message = error.message;
    return restored;
  }
  return new Error(error.message);
}
