import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Oliphaunt as direct } from '../direct.js';
import { Oliphaunt as broker } from '../broker.js';

test('native mode entrypoints reject contradictory configuration before opening', async () => {
  const topology = { topology: 'broker' as const };
  // @ts-expect-error mode-specific imports forbid topology even through a variable
  await assert.rejects(direct.open(topology), /does not accept topology/);
  // @ts-expect-error the broker import owns its topology
  await assert.rejects(broker.open(topology), /does not accept topology/);
  const helper = { brokerExecutable: '/unused/broker' };
  // @ts-expect-error direct execution has no broker helper
  await assert.rejects(direct.open(helper), /does not accept topology or brokerExecutable/);
});
