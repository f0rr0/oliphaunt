import Browser from '@oliphaunt/wasix-ts/browser';
import Native from '@oliphaunt/wasix-ts';
import Direct from '@oliphaunt/wasix-ts/direct';
import Worker from '@oliphaunt/wasix-ts/worker';
import { openServer } from '@oliphaunt/wasix-ts/server';
import { directory } from '@oliphaunt/wasix-ts/storage/node';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';
import { opfs } from '@oliphaunt/wasix-ts/storage/opfs';

const disk = directory('/db');
const origin = indexedDB('db');
const bytes = new Uint8Array();
void Browser.open({ storage: origin });
void Browser.restore(opfs('restore'), bytes);
// @ts-expect-error Browser open cannot use host directories.
void Browser.open({ storage: disk });
// @ts-expect-error Browser restore cannot use host directories.
void Browser.restore(disk, bytes);
for (const client of [Native, Direct, Worker]) {
  void client.open({ storage: disk });
  void client.restore(disk, bytes);
  // @ts-expect-error Node conditions must select native declarations.
  void client.open({ storage: origin });
  // @ts-expect-error Native restore cannot use browser persistence.
  void client.restore(origin, bytes);
}
void openServer({ storage: disk });
// @ts-expect-error Servers are native-only.
void openServer({ storage: origin });
