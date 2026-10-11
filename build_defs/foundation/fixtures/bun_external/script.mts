import assert from 'node:assert/strict';
import { marker } from './helper.mts';

assert.equal(marker, 'external Bun entrypoint');
assert.equal(process.argv.at(-1), 'external literal');
console.log(marker);
