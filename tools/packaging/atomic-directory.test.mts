import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSiblingStage,
  promoteDirectory,
  stageExistingDirectory,
} from './atomic-directory.mts';

if (process.argv[2] === 'exit-fixture') {
  createSiblingStage(process.argv[3]);
  process.exit(0);
}

test('promotes a staged directory and removes the old bytes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-atomic-directory-'));
  try {
    const destination = path.join(root, 'live');
    mkdirSync(destination);
    writeFileSync(path.join(destination, 'old'), 'old');
    const stage = createSiblingStage(destination);
    writeFileSync(path.join(stage, 'new'), 'new');

    promoteDirectory(stage, destination);

    assert.equal(readFileSync(path.join(destination, 'new'), 'utf8'), 'new');
    assert.equal(existsSync(path.join(destination, 'old')), false);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(`${stage}.previous`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging an existing directory copies bytes without symbolic links', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-atomic-directory-copy-'));
  try {
    const destination = path.join(root, 'live');
    mkdirSync(destination);
    writeFileSync(path.join(destination, 'kept'), 'bytes');
    const stage = stageExistingDirectory(destination);
    assert.equal(readFileSync(path.join(stage, 'kept'), 'utf8'), 'bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
