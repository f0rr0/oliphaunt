import assert from 'node:assert/strict';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';
import { sibling } from './sibling.mts';

test('declared sibling and nested imports execute from regular copied modules', () => {
  assert.equal(sibling, 'declared:nested:leaf');
  for (const relative of ['./sibling.mts', './nested/helper.mts', './nested/deep/value.mts']) {
    const file = new URL(relative, import.meta.url);
    assert(lstatSync(file).isFile());
    assert.equal(realpathSync(file), fileURLToPath(file));
  }
});

test('existing but undeclared siblings cannot escape the copied module boundary', async () => {
  for (const relative of ['./undeclared.mts', './nested/undeclared.mts']) {
    assert.equal(existsSync(new URL(relative, import.meta.url)), false);
    await assert.rejects(import(relative), (error: any) => error?.code === 'ERR_MODULE_NOT_FOUND');
  }
});
