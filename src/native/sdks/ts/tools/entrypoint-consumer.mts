import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensions } from '@oliphaunt/ts';
import { directory } from '@oliphaunt/ts/storage/node';
import { directory as bunDirectory } from '@oliphaunt/ts/storage/bun';
import { directory as denoDirectory } from '@oliphaunt/ts/storage/deno';
import broker, {
  type OpenConfig as BrokerConfig,
  Oliphaunt as namedBroker,
} from '@oliphaunt/ts/broker';
import direct, {
  type OpenConfig as DirectConfig,
  Oliphaunt as namedDirect,
} from '@oliphaunt/ts/direct';

const databasePath = resolve('unused', 'database');
const brokerPath = resolve('unused', 'broker');
const directConfig: DirectConfig = {
  storage: directory(databasePath),
  extensions: [extensions.hstore],
};
const brokerConfig: BrokerConfig = { brokerExecutable: brokerPath };
void [directConfig, brokerConfig];
assert.equal(direct, namedDirect);
assert.equal(broker, namedBroker);
assert.equal(directory, bunDirectory);
assert.equal(directory, denoDirectory);
assert.deepEqual(directory(pathToFileURL(databasePath)), directConfig.storage);
// @ts-expect-error restore accepts the same directory descriptor as open
await assert.rejects(direct.restore(databasePath, new Uint8Array()), /directory/);

const conflictingTopology = { topology: 'broker' as const };
// @ts-expect-error direct mode is selected by the import, including widened variables
await assert.rejects(direct.open(conflictingTopology), /does not accept topology/);
// @ts-expect-error broker mode is selected by the import
await assert.rejects(broker.open(conflictingTopology), /does not accept topology/);
const conflictingHelper = { brokerExecutable: brokerPath };
await assert.rejects(
  // @ts-expect-error a direct database does not accept a broker helper
  direct.open(conflictingHelper),
  /does not accept topology or brokerExecutable/,
);
