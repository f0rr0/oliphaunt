import assert from 'node:assert/strict';
import { test } from 'vitest';

import Oliphaunt, { Oliphaunt as namedOliphaunt, simpleQuery } from '../jsr.js';

test('jsr entry point exposes protocol helpers and rejects native runtime use', async () => {
  assert.equal(Oliphaunt, namedOliphaunt);
  assert.equal(simpleQuery('SELECT 1')[0], 0x51);
  assert.deepEqual(await Oliphaunt.supportedModes(), []);
  await assert.rejects(
    () => Oliphaunt.open(),
    /Native Oliphaunt runtimes are not available from jsr:@oliphaunt\/ts/,
  );
  await assert.rejects(
    () => Oliphaunt.restore(),
    /Native Oliphaunt runtimes are not available from jsr:@oliphaunt\/ts/,
  );
});
