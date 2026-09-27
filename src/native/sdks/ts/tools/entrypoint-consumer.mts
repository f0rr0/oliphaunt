import assert from 'node:assert/strict';
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

const directConfig: DirectConfig = {
  storage: directory('/unused/database'),
  extensions: [extensions.hstore],
};
const brokerConfig: BrokerConfig = { brokerExecutable: '/unused/broker' };
void [directConfig, brokerConfig];
assert.equal(direct, namedDirect);
assert.equal(broker, namedBroker);
assert.equal(directory, bunDirectory);
assert.equal(directory, denoDirectory);
assert.deepEqual(directory(new URL('file:///unused/database')), directConfig.storage);
// @ts-expect-error restore accepts the same directory descriptor as open
await assert.rejects(direct.restore('/unused/database', new Uint8Array()), /directory/);

const conflictingTopology = { topology: 'broker' as const };
// @ts-expect-error direct mode is selected by the import, including widened variables
await assert.rejects(direct.open(conflictingTopology), /does not accept topology/);
// @ts-expect-error broker mode is selected by the import
await assert.rejects(broker.open(conflictingTopology), /does not accept topology/);
const conflictingHelper = { brokerExecutable: '/unused/broker' };
await assert.rejects(
  // @ts-expect-error a direct database does not accept a broker helper
  direct.open(conflictingHelper),
  /does not accept topology or brokerExecutable/,
);
