/** Verify the native candidate already committed by its isolated Prepare coordinator. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateReleaseMetadata } from './check-release-metadata.mts';
import { validateReleaseConsumerCompatibility } from './consumer-compatibility.mts';
import {
  parseNativeReleaseInputRecord,
  relocateNativeReleaseInputs,
} from './native-release-inputs.mts';
import { assertNativeVersionSourceTransition } from './native-version-source.mts';
import { ROOT } from './release-graph.mts';
import { syncReleasePr } from './sync-release-pr.mts';
import { verifyReleaseCommit } from './verify-release-commit.mts';

if (import.meta.main) {
  assert.ok(
    process.argv.length === 3 &&
      /^[1-9][0-9]*$/u.test(process.env.NATIVE_QUALIFICATION_RUN_ID ?? ''),
    'native close requires its isolated qualification coordinator',
  );
  const directory = path.resolve(process.argv[2]);
  const bytes = readFileSync(path.join(directory, 'native-version-source.json'));
  assert.deepEqual(
    bytes,
    readFileSync(path.join(directory, 'native-release-inputs/native-version-source.json')),
    'native close and transported candidate differ',
  );
  const { record, buildBound } = parseNativeReleaseInputRecord(JSON.parse(bytes.toString('utf8')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const currentSource = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  assert.deepEqual(
    currentSource,
    record.preparedSource,
    'native candidate advanced after preparation',
  );
  assert.equal(
    process.env.RELEASE_SOURCE_SHA,
    currentSource.commit,
    'native close source context is stale',
  );
  assertNativeVersionSourceTransition(record.bridge, currentSource, ROOT);
  relocateNativeReleaseInputs(path.join(directory, 'native-release-inputs'), record);
  verifyReleaseCommit({
    products: record.selectedProducts,
    buildBound,
    repo: ROOT,
    headRef: 'HEAD',
  });
  validateReleaseConsumerCompatibility(record.selectedProducts, { buildBound });
  validateReleaseMetadata({ publication: true, buildBound });
  await syncReleasePr(['--check'], { buildBound });
  console.log(`native release candidate verified (${record.selectedProducts.length} products)`);
}
