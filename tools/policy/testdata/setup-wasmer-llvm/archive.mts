import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { tarArchive } from '../../../test/tar-fixture.mts';

const fixtures = {
  unsafe: [{ name: '../escaped', data: 'unsafe' }],
  'unsafe-link': [{ name: 'bin/escape', type: '2', linkTarget: '../../escaped' }],
  duplicate: [
    { name: 'bin/duplicate', data: 'first' },
    { name: 'bin/duplicate', data: 'second' },
  ],
  special: [{ name: 'bin/fifo', type: '6' }],
  oversized: [{ name: 'lib/oversized', size: 4 * 1024 ** 3 + 1 }],
  collision: [{ name: 'Bin/one' }, { name: 'bin/two' }],
  cycle: [
    { name: 'a', type: '2', linkTarget: 'b' },
    { name: 'b', type: '2', linkTarget: 'a' },
  ],
  ancestor: [
    { name: 'dir', type: '2', linkTarget: 'file' },
    { name: 'file' },
    { name: 'dir/child' },
  ],
  privileged: [{ name: 'bin/tool', mode: 0o4755 }],
};
const rows = fixtures[process.argv[2]];
assert(rows, 'unknown archive fixture');
process.stdout.write(gunzipSync(tarArchive(rows)));
