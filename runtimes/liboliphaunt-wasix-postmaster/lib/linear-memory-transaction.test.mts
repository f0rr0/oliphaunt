import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  AGGREGATE_RELATIVE,
  initTransaction,
  prepareTransaction,
  publishTransaction,
  recoverTransaction,
} from './linear-memory-transaction.mts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const originals = { 'bin/a.wasm': 'original-a', 'lib/b.wasm': 'original-b' };
function fixture(root: string) {
  const install = join(root, 'install'),
    stage = join(install, '.oliphaunt-linear-memory.pending');
  for (const [file, text] of Object.entries(originals)) {
    mkdirSync(dirname(join(install, file)), { recursive: true });
    writeFileSync(join(install, file), text);
  }
  mkdirSync(dirname(join(install, AGGREGATE_RELATIVE)), { recursive: true });
  initTransaction(install, stage);
  const modules = Object.entries(originals).map(([path, text]) => {
    mkdirSync(dirname(join(stage, 'modules', path)), { recursive: true });
    writeFileSync(join(stage, 'modules', path), `sealed-${text}`);
    return { path, 'source-module-sha256': hash(text), 'module-sha256': hash(`sealed-${text}`) };
  });
  const aggregate = join(stage, 'wasix-postmaster.linear-memory-profile.receipt.json');
  writeFileSync(
    aggregate,
    JSON.stringify(
      {
        schema: 'oliphaunt.wasix-postmaster.linear-memory-install.v1',
        'module-count': modules.length,
        modules,
      },
      null,
      2,
    ),
  );
  prepareTransaction(install, stage, aggregate);
  return { install, stage, aggregate };
}

test('interrupted publication restores predecessors; a fully admitted closure survives recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'linear-memory-transaction-'));
  try {
    for (const phase of ['partial', 'premature-receipt', 'admitted', 'publish']) {
      const { install, stage, aggregate } = fixture(join(root, phase));
      if (phase === 'publish') {
        publishTransaction(install, stage);
        assert.equal(recoverTransaction(install, stage), 'none');
      } else {
        renameSync(join(stage, 'modules/bin/a.wasm'), join(install, 'bin/a.wasm'));
        if (phase === 'admitted')
          renameSync(join(stage, 'modules/lib/b.wasm'), join(install, 'lib/b.wasm'));
        if (phase !== 'partial') linkSync(aggregate, join(install, AGGREGATE_RELATIVE));
        assert.equal(
          recoverTransaction(install, stage),
          phase === 'admitted' ? 'committed' : 'rolled-back',
        );
      }
      const committed = phase === 'admitted' || phase === 'publish';
      for (const [file, text] of Object.entries(originals))
        assert.equal(
          readFileSync(join(install, file), 'utf8'),
          committed ? `sealed-${text}` : text,
        );
      assert.equal(existsSync(join(install, AGGREGATE_RELATIVE)), committed);
      assert(!existsSync(stage));
    }
    const install = join(root, 'staging');
    mkdirSync(install);
    const stage = join(install, '.pending');
    initTransaction(install, stage);
    writeFileSync(join(stage, 'modules/partial'), 'partial');
    assert.equal(recoverTransaction(install, stage), 'discarded-staging');
    assert(!existsSync(stage));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery rejects duplicate JSON keys and unsafe or corrupted backups', () => {
  const root = mkdtempSync(join(tmpdir(), 'linear-memory-reject-'));
  try {
    for (const failure of ['corrupt', 'symlink', 'duplicate-state']) {
      const { install, stage } = fixture(join(root, failure));
      const backup = join(stage, 'originals/bin/a.wasm');
      if (failure === 'corrupt') writeFileSync(backup, 'corrupt');
      else if (failure === 'symlink') {
        rmSync(backup);
        symlinkSync(join(install, 'bin/a.wasm'), backup);
      } else {
        const file = join(stage, 'transaction.json');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            '"phase": "prepared"',
            '"phase": "prepared", "phase": "staging"',
          ),
        );
      }
      assert.throws(() => recoverTransaction(install, stage));
      assert(existsSync(stage));
      for (const [file, text] of Object.entries(originals))
        assert.equal(readFileSync(join(install, file), 'utf8'), text);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
