export type JsiRawProtocolTransport = {
  readonly version: 1;
  readonly execProtocolRaw: (
    handle: number,
    request: Uint8Array,
  ) => Promise<ArrayBuffer | ArrayBufferView>;
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
