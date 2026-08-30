import type {
  WasixPersistenceMode,
  WasixProtocolConnectionMode,
  WasixProtocolStreamOutcome,
} from './database.js';
import { WasixStorageError } from './errors.js';
import { PostgresError, type PostgresErrorField } from './query.js';
import type { SerializedWasixStorage } from './storage.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './tool-runtime.js';

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

/** Host-ready open options shared by both public execution surfaces. */
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

export type WorkerRequest =
  | { id: number; method: 'open'; options: SerializedOpenOptions }
  | {
      id: number;
      method: 'restore';
      storage: SerializedWasixStorage;
      bytes: Uint8Array;
    }
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
      method: 'runTool';
      options: WasixToolProcessOptions;
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
      phase?: NonNullable<WasixStorageError['phase']>;
    }
  | {
      name: 'OliphauntWasixToolError';
      message: string;
      code: 'tool-error';
      tool: string;
      exitCode: number | null;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }
  | { name: 'PostgresError'; fields: PostgresErrorField[] }
  | { name: 'Error'; message: string; errorName?: string; stack?: string };

export type WorkerResponse =
  | { id: number; kind: 'chunk'; sequence: number; value: Uint8Array }
  | { id: number; ok: true; streamOutcome: WasixProtocolStreamOutcome }
  | { id: number; ok: true; value?: Uint8Array | WasixToolProcessResult }
  | { id: number; ok: false; error: SerializedWorkerError };

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof WasixStorageError) {
    return {
      name: 'WasixStorageError',
      message: error.message,
      code: error.code,
      commitState: error.commitState,
      ...(error.phase === undefined ? {} : { phase: error.phase }),
    };
  }
  if (error instanceof PostgresError) {
    return {
      name: 'PostgresError',
      fields: error.fields.map((field) => ({ ...field })),
    };
  }
  const nativeTool = nativeToolError(error);
  if (nativeTool !== undefined) {
    return {
      name: 'OliphauntWasixToolError',
      message: nativeTool.message,
      code: 'tool-error',
      tool: nativeTool.tool,
      exitCode: nativeTool.exitCode,
      stdout: nativeTool.stdout.slice(),
      stderr: nativeTool.stderr.slice(),
    };
  }
  const generic = {
    name: 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.name !== 'Error' ? { errorName: error.name } : {}),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  } as const;
  return generic;
}

export function deserializeWorkerError(error: SerializedWorkerError): Error {
  if (error.name === 'WasixStorageError') {
    return new WasixStorageError(error.message, {
      code: error.code,
      commitState: error.commitState,
      ...(error.phase === undefined ? {} : { phase: error.phase }),
    });
  }
  if (error.name === 'PostgresError') {
    return new PostgresError(error.fields);
  }
  if (error.name === 'OliphauntWasixToolError') {
    const restored = new Error(error.message);
    restored.name = error.name;
    return Object.assign(restored, {
      oliphauntWasixError: 'tool' as const,
      oliphauntWasixAddonAbi: 1 as const,
      code: error.code,
      tool: error.tool,
      exitCode: error.exitCode,
      stdout: error.stdout.slice(),
      stderr: error.stderr.slice(),
    });
  }
  const restored = new Error(error.message);
  restored.name = error.errorName ?? 'Error';
  if (error.stack !== undefined) restored.stack = error.stack;
  return restored;
}

type NativeToolError = Readonly<{
  message: string;
  tool: string;
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

function nativeToolError(error: unknown): NativeToolError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as Record<string, unknown>;
  if (
    candidate.oliphauntWasixError !== 'tool' ||
    candidate.oliphauntWasixAddonAbi !== 1 ||
    candidate.code !== 'tool-error' ||
    typeof candidate.message !== 'string' ||
    typeof candidate.tool !== 'string' ||
    (candidate.exitCode !== null && !Number.isSafeInteger(candidate.exitCode)) ||
    !(candidate.stdout instanceof Uint8Array) ||
    !(candidate.stderr instanceof Uint8Array)
  ) {
    return undefined;
  }
  return candidate as NativeToolError;
}
