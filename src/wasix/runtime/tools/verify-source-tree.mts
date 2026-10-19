import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  archiveTreeDigest,
  parseArchiveStamp,
} from '../../../third-party/tools/source-fetch-core.mts';

try {
  const { values } = parseArgs({
    options: { checkout: { type: 'string' }, manifest: { type: 'string' } },
  });
  if (!values.checkout || !values.manifest)
    throw new Error('--checkout and --manifest are required');
  const source = Bun.TOML.parse(readFileSync(values.manifest, 'utf8'));
  if (source.kind !== 'archive') throw new Error('source manifest must describe an archive');
  const marker = parseArchiveStamp(path.join(values.checkout, '.oliphaunt-source-pin'));
  for (const key of ['name', 'kind', 'url', 'branch', 'commit', 'sha256', 'strip_prefix']) {
    if (
      typeof source[key] !== 'string' ||
      !source[key] ||
      marker.get(key.replace('_', '-')) !== source[key]
    ) {
      throw new Error(`source checkout marker does not match manifest ${key}`);
    }
  }
  const actual = archiveTreeDigest(values.checkout);
  if (actual !== marker.get('tree-sha256'))
    throw new Error(
      `source checkout was modified: expected tree ${marker.get('tree-sha256')}, got ${actual}`,
    );
  console.log(actual);
} catch (error) {
  console.error(`source checkout verification failed: ${error.message}`);
  process.exitCode = 1;
}
