import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tarArchive } from '../../../../tools/test/tar-fixture.mts';

const output = process.argv[2];
const root = 'node-v22.22.3';

function entry(name, contents = '', type = '0', options = {}) {
  return [
    {
      name,
      data: options.omitPayload ? '' : contents,
      type,
      mode: type === '5' ? 0o755 : 0o644,
      size: options.declaredSize,
      linkTarget: options.linkName,
    },
  ];
}
function archive(name, entries) {
  writeFileSync(path.join(output, name), tarArchive(entries.flat()));
}

const required = [
  ...entry(`${root}/`, '', '5'),
  ...entry(`${root}/include/`, '', '5'),
  ...entry(`${root}/include/node/`, '', '5'),
  ...entry(`${root}/include/node/node_api.h`, 'node api\n'),
  ...entry(`${root}/include/node/node.h`, 'node\n'),
  ...entry(`${root}/include/node/v8.h`, 'v8\n'),
];
const longName = `${root}/include/node/openssl/archs/solaris64-x86_64-gcc/asm_avx2/providers/common/include/prov/der_digests.h`;
const longNameRecord = entry('././@LongLink', Buffer.from(`${longName}\0`), 'L');
const longNameFile = entry(longName.slice(0, 100), 'long name\n');
archive('valid.tar.gz', [...required, ...longNameRecord, ...longNameFile]);
archive('duplicate.tar.gz', [...required, ...entry(`${root}/include/node/node.h`, 'duplicate\n')]);
archive('traversal.tar.gz', [...required, ...entry(`${root}/../../escaped`, 'escape\n')]);
archive('symlink.tar.gz', [
  ...required,
  ...entry(`${root}/include/node/link`, '', '2', { linkName: '../../escape' }),
]);
archive('oversized.tar.gz', [
  ...required,
  ...entry(`${root}/include/node/oversized.h`, '', '0', {
    declaredSize: 32 * 1024 * 1024 + 1,
    omitPayload: true,
  }),
]);
archive('missing-layout.tar.gz', [
  ...entry(`${root}/`, '', '5'),
  ...entry(`${root}/include/node/node_api.h`, 'node api\n'),
  ...entry(`${root}/include/node/node.h`, 'node\n'),
]);

const valid = readFileSync(path.join(output, 'valid.tar.gz'));
writeFileSync(
  path.join(output, 'truncated.tar.gz'),
  valid.subarray(0, Math.floor(valid.length / 2)),
);
writeFileSync(path.join(output, 'node.lib'), Buffer.from('mock pinned Windows import library\n'));
