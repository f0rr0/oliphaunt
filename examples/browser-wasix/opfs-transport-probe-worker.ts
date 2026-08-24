type ProbeRequest = Readonly<{ name: string }>;
type ProbeResponse =
  | Readonly<{ ok: true; transport: 'direct' | 'portable' }>
  | Readonly<{ ok: false; error: string }>;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<ProbeRequest>) => {
  void probe(event.data.name)
    .then((transport) => respond({ ok: true, transport }))
    .catch((error) => respond({ ok: false, error: describeError(error) }));
});

async function probe(name: string): Promise<'direct' | 'portable'> {
  const origin = await navigator.storage.getDirectory();
  const root = await origin.getDirectoryHandle('.oliphaunt-wasix-pool-v1');
  const database = await root.getDirectoryHandle(name);
  const state = JSON.parse(
    await (await database.getFileHandle('state.json')).getFile().then((file) => file.text()),
  ) as {
    entries?: Array<{ path?: unknown; type?: unknown; backing?: unknown }>;
  };
  const version = state.entries?.find(
    (entry) => entry.path === 'PG_VERSION' && entry.type === 'file',
  );
  if (typeof version?.backing !== 'string') {
    throw new Error('OPFS transport probe could not resolve the PG_VERSION backing');
  }
  const data = await database.getDirectoryHandle('data');
  const file = (await data.getFileHandle(version.backing)) as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle>;
  };
  if (file.createSyncAccessHandle === undefined) return 'portable';
  try {
    const access = await file.createSyncAccessHandle();
    access.close();
    return 'portable';
  } catch (error) {
    if (errorName(error) === 'NoModificationAllowedError') return 'direct';
    throw error;
  }
}

function respond(response: ProbeResponse): void {
  scope.postMessage(response);
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
