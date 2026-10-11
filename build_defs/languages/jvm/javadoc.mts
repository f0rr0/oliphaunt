import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';

const [output, specification] = process.argv.slice(2);
assert.equal(process.argv.length, 4, 'Expected output archive and declared Java tool/source JSON');
const values = JSON.parse(readFileSync(specification, 'utf8'));
assert.ok(Array.isArray(values.sources) && values.sources.length > 0);
assert.ok(Array.isArray(values.classpath) && /^\d+$/u.test(values.release));
assert.ok(
  !path.isAbsolute(values.javaHome),
  'Javadoc requires the acquired execution JDK, not an ambient local JDK',
);
const directory = mkdtempSync(path.join(path.dirname(output), '.javadoc-'));
try {
  const result = spawnSync(
    path.join(values.javaHome, 'bin/javadoc'),
    [
      '--release',
      values.release,
      '-quiet',
      '-Xdoclint:none',
      '-notimestamp',
      '-encoding',
      'UTF-8',
      '-charset',
      'UTF-8',
      '-docencoding',
      'UTF-8',
      '-classpath',
      values.classpath.join(path.delimiter),
      '-d',
      directory,
      ...values.sources,
    ],
    { env: {}, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined, `Javadoc could not start: ${result.error?.message}`);
  assert.equal(result.status, 0, `Javadoc failed:\n${result.stdout}${result.stderr}`);
  // Validate the actual producer tree before handing it across Bazel's sandbox
  // boundary, where declared tree inputs are represented by symlinks.
  writeFileSync(output, await createDeterministicZip(directory));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
