export type JsiProtocolChunkResult =
  | {
      readonly __oliphauntProtocolChunkFailure: true;
      readonly error: unknown;
    }
  | undefined;

export type JsiRawProtocolTransport = {
  readonly version: 1;
  readonly execProtocolRaw: (
    handle: number,
    request: Uint8Array,
  ) => Promise<ArrayBuffer | ArrayBufferView>;
  readonly execProtocolStream: (
    handle: number,
    request: Uint8Array,
    onChunk: (chunk: ArrayBuffer | ArrayBufferView) => JsiProtocolChunkResult,
  ) => Promise<void>;
  readonly backup: (handle: number) => Promise<ArrayBuffer | ArrayBufferView>;
  readonly restore: (
    destination: {
      storageKind: 'directory' | 'applicationData';
      storagePath?: string;
      storageName?: string;
    },
    artifact: Uint8Array,
  ) => Promise<void>;
};

type GlobalWithOliphauntJsi = typeof globalThis & {
  __oliphauntReactNativeJsi?: Partial<JsiRawProtocolTransport>;
};

export function resolveJsiRawProtocolTransport(): JsiRawProtocolTransport | null {
  const candidate = (globalThis as GlobalWithOliphauntJsi).__oliphauntReactNativeJsi;
  if (
    candidate?.version === 1 &&
    typeof candidate.execProtocolRaw === 'function' &&
    typeof candidate.execProtocolStream === 'function' &&
    typeof candidate.backup === 'function' &&
    typeof candidate.restore === 'function'
  ) {
    return candidate as JsiRawProtocolTransport;
  }
  return null;
}

export function requireJsiRawProtocolTransport(): JsiRawProtocolTransport {
  const transport = resolveJsiRawProtocolTransport();
  if (transport) {
    return transport;
  }
  throw new Error(
    'Oliphaunt requires React Native New Architecture JSI ArrayBuffer bindings; rebuild the app with the Oliphaunt TurboModule installed',
  );
}

export async function execProtocolRawJsi(
  transport: JsiRawProtocolTransport,
  handle: number,
  request: Uint8Array,
): Promise<Uint8Array> {
  return binaryResponseToUint8Array(await transport.execProtocolRaw(handle, request));
}

export async function execProtocolStreamJsi(
  transport: JsiRawProtocolTransport,
  handle: number,
  request: Uint8Array,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  let callbackFailed = false;
  let callbackFailure: unknown;
  try {
    await transport.execProtocolStream(handle, request, (chunk) => {
      if (callbackFailed) {
        return protocolChunkFailure(callbackFailure);
      }
      try {
        onChunk(binaryResponseToUint8Array(chunk));
        return undefined;
      } catch (error) {
        callbackFailed = true;
        callbackFailure = error;
        return protocolChunkFailure(error);
      }
    });
  } catch (error) {
    if (!callbackFailed) {
      throw error;
    }
  }
  if (callbackFailed) {
    throw callbackFailure;
  }
}

function protocolChunkFailure(error: unknown): Exclude<JsiProtocolChunkResult, undefined> {
  return {
    __oliphauntProtocolChunkFailure: true,
    error,
  };
}

export async function backupJsi(
  transport: JsiRawProtocolTransport,
  handle: number,
): Promise<Uint8Array> {
  return binaryResponseToUint8Array(await transport.backup(handle));
}

export async function restoreJsi(
  transport: JsiRawProtocolTransport,
  destination: {
    storageKind: 'directory' | 'applicationData';
    storagePath?: string;
    storageName?: string;
  },
  artifact: Uint8Array,
): Promise<void> {
  await transport.restore(destination, artifact);
}

function binaryResponseToUint8Array(response: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (response instanceof Uint8Array) {
    return response;
  }
  if (ArrayBuffer.isView(response)) {
    return new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
  }
  if (response instanceof ArrayBuffer) {
    return new Uint8Array(response);
  }
  throw new Error('liboliphaunt JSI transport returned a non-binary response');
}
