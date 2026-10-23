import assert from 'node:assert/strict';
import { sibling } from './sibling.mts';

assert.equal(import.meta.main, true);
assert.equal(sibling, 'declared:nested:leaf');
assert.deepEqual(process.argv.slice(2), ['declared launcher', 'forwarded argument']);
console.log('Declared Bun launcher: sibling/nested imports and forwarded arguments passed.');
