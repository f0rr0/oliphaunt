export type JsiRawProtocolTransport = {
  readonly version: 1;
  readonly execProtocolRaw: (
    handle: number,
    request: Uint8Array,
  ) => Promise<ArrayBuffer | ArrayBufferView>;
  readonly execProtocolStream?: (
    handle: number,
    request: Uint8Array,
    onChunk: (chunk: ArrayBuffer | ArrayBufferView) => void,
  ) => Promise<void>;
  readonly backup: (handle: number, format: string) => Promise<ArrayBuffer | ArrayBufferView>;
  readonly restore: (
    root: string,
    format: string,
    artifact: Uint8Array,
    replaceExisting: boolean,
    libraryPath: string | null,
  ) => Promise<string>;
};

type GlobalWithOliphauntJsi = typeof globalThis & {
  __oliphauntReactNativeJsi?: Partial<JsiRawProtocolTransport>;
};

export function resolveJsiRawProtocolTransport(): JsiRawProtocolTransport | null {
  const candidate = (globalThis as GlobalWithOliphauntJsi).__oliphauntReactNativeJsi;
  if (
    candidate?.version === 1 &&
    typeof candidate.execProtocolRaw === 'function' &&
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
): Promise<boolean> {
  if (!jsiTransportSupportsProtocolStream(transport)) {
    return false;
  }
  let chunkError: unknown;
  await transport.execProtocolStream(handle, request, (chunk) => {
    if (chunkError !== undefined) {
      return;
    }
    try {
      onChunk(binaryResponseToUint8Array(chunk));
    } catch (error) {
      chunkError = error;
    }
  });
  if (chunkError !== undefined) {
    throw chunkError;
  }
  return true;
}

export function jsiTransportSupportsProtocolStream(
  transport: JsiRawProtocolTransport | null | undefined,
): transport is JsiRawProtocolTransport &
  Required<Pick<JsiRawProtocolTransport, 'execProtocolStream'>> {
  return typeof transport?.execProtocolStream === 'function';
}
export async function backupJsi(
  transport: JsiRawProtocolTransport,
  handle: number,
  format: string,
): Promise<Uint8Array> {
  return binaryResponseToUint8Array(await transport.backup(handle, format));
}

export async function restoreJsi(
  transport: JsiRawProtocolTransport,
  root: string,
  format: string,
  artifact: Uint8Array,
  replaceExisting: boolean,
  libraryPath: string | null,
): Promise<string> {
  const restored = await transport.restore(root, format, artifact, replaceExisting, libraryPath);
  if (typeof restored !== 'string') {
    throw new Error('liboliphaunt JSI restore returned a non-string response');
  }
  return restored;
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
