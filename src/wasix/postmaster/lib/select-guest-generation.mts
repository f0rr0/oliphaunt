#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { lstatSync, writeFileSync } from 'node:fs';
import { atomicFile } from './receipt-files.mts';

const [destination, identity, ...extra] = process.argv.slice(2);
assert(
  destination && /^[0-9a-f]{64}$/.test(identity ?? '') && !extra.length,
  'expected selection file and completed guest generation SHA-256',
);
const existing = lstatSync(destination, { throwIfNoEntry: false });
assert(!existing || existing.isFile(), 'guest selection is not a regular file');
atomicFile(destination, (fd) => writeFileSync(fd, `${identity}\n`));
