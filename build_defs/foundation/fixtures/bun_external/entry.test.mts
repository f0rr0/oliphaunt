import assert from 'node:assert/strict';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';
import { marker } from './helper.mts';

test('external repository entrypoint loads declared regular modules', () => {
  assert.equal(marker, 'external Bun entrypoint');
  const helper = new URL('./helper.mts', import.meta.url);
  assert(lstatSync(helper).isFile());
  assert.equal(realpathSync(helper), fileURLToPath(helper));
});
