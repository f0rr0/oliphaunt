import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test } from 'vitest';

import {
  publishNativeDescriptor,
  validateDescriptor,
  validateManagedRoot,
} from '../root-descriptor.js';
import { normalizeOpenConfig } from '../config.js';
import { createServerRuntimeBinding } from '../runtime/server.js';

const fixture = JSON.parse(readFileSync(sharedStorageFixturePath(), 'utf8')) as {
  validDescriptors: Array<Record<string, unknown>>;
  invalidDescriptors: Array<{ case: string; value: Record<string, unknown> }>;
  malformedJson: Array<{ case: string; value: string }>;
};

test('database-root descriptors follow the shared five-field contract', () => {
  for (const descriptor of fixture.validDescriptors) {
    assert.doesNotThrow(() => validateDescriptor(JSON.stringify(descriptor)));
  }
  for (const invalid of fixture.invalidDescriptors) {
    assert.throws(() => validateDescriptor(JSON.stringify(invalid.value)), invalid.case);
  }
  for (const malformed of fixture.malformedJson) {
    assert.throws(() => validateDescriptor(malformed.value), malformed.case);
  }
  assert.throws(
    () => validateDescriptor(`\u00a0${JSON.stringify(fixture.validDescriptors[0])}`),
    /not valid JSON/,
  );
  assert.doesNotThrow(() =>
    validateDescriptor(
      JSON.stringify({
        ...fixture.validDescriptors[0],
        physicalFormat: 'native-pg18-v1',
      }).replace('native-pg18-v1', 'native-pg18-v1'),
    ),
  );
});

test('descriptor publication removes staging debris after failure', async () => {
  const root = await completeRoot();
  try {
    await mkdir(join(root, '.oliphaunt.json'));
    await assert.rejects(() => publishNativeDescriptor(root));
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.oliphaunt.json.tmp-')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native server preflight failure removes temporary storage', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'oliphaunt-server-preflight-'));
  const temporary = join(parent, 'temporary');
  await mkdir(temporary);
  const previousTimeout = process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS;
  process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS = 'invalid';
  try {
    const runtime = createServerRuntimeBinding();
    await assert.rejects(
      async () =>
        await runtime.open(
          normalizeOpenConfig(
            { execution: 'server' },
            { instanceDirectory: temporary, temporaryDirectory: true },
          ),
        ),
      /must be a positive integer/,
    );
    await assert.rejects(() => access(temporary), { code: 'ENOENT' });
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS;
    } else {
      process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS = previousTimeout;
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test('managed roots never follow a caller-supplied root symlink', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'oliphaunt-root-link-'));
  const realRoot = join(parent, 'real');
  const linkedRoot = join(parent, 'linked');
  await mkdir(realRoot);
  await symlink(realRoot, linkedRoot, 'dir');
  try {
    await assert.rejects(() => validateManagedRoot(linkedRoot), /must be a real directory/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function completeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-root-'));
  await mkdir(join(root, 'pgdata', 'global'), { recursive: true });
  await mkdir(join(root, 'pgdata', 'pg_wal'));
  await writeFile(join(root, 'pgdata', 'PG_VERSION'), '18\n');
  await writeFile(join(root, 'pgdata', 'global', 'pg_control'), new Uint8Array([1]));
  return root;
}

function sharedStorageFixturePath(): string {
  return path.resolve(
    process.cwd(),
    '..',
    '..',
    '..',
    'src',
    'shared',
    'fixtures',
    'storage',
    'database-root.json',
  );
}
