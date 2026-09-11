import type { Oliphaunt as browser } from '../browser.js';
import type { Oliphaunt as native } from '../index.node.js';
import type { Oliphaunt as direct } from '../direct.node.js';
import type { Oliphaunt as browserWorker } from '../worker-entry.js';
import type { Oliphaunt as nativeWorker } from '../worker-entry.node.js';
import type { openServer } from '../server.node.js';
import { memory } from '../storage.js';
import { directory } from '../storage/node.js';
import { indexedDB } from '../storage/indexed-db.js';
import { opfs } from '../storage/opfs.js';

// Compiled by the SDK typecheck; never executed against an engine.
export function checkEntrypointTypes(
  web: typeof browser,
  node: typeof native,
  sync: typeof direct,
  webWorker: typeof browserWorker,
  nodeWorker: typeof nativeWorker,
  server: typeof openServer,
): void {
  const disk = directory('/database');
  const idb = indexedDB('database');
  const origin = opfs('database');
  const bytes = new Uint8Array();
  for (const client of [web, webWorker]) {
    void client.open({ storage: memory() });
    void client.open({ storage: idb });
    void client.open({ storage: origin });
    void client.restore(idb, bytes);
    void client.restore(origin, bytes);
    // @ts-expect-error A directory descriptor is native-only, including when passed through a variable.
    void client.open({ storage: disk });
    // @ts-expect-error Browser restore accepts the same persistent storage kinds as open.
    void client.restore(disk, bytes);
    // @ts-expect-error Memory cannot receive a persistent restore.
    void client.restore(memory(), bytes);
  }
  for (const client of [node, sync, nodeWorker]) {
    void client.open({ storage: memory() });
    void client.open({ storage: disk });
    void client.restore(disk, bytes);
    // @ts-expect-error IndexedDB is browser-only.
    void client.open({ storage: idb });
    // @ts-expect-error OPFS is browser-only.
    void client.open({ storage: origin });
    // @ts-expect-error Native restore cannot write browser storage.
    void client.restore(idb, bytes);
    // @ts-expect-error Native restore cannot write browser storage.
    void client.restore(origin, bytes);
  }
  void server({ storage: disk });
  // @ts-expect-error The native server cannot use browser storage either.
  void server({ storage: origin });
}
