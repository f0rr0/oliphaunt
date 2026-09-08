import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tarArchive } from '../../../tools/test/tar-fixture.mts';
const [archive, manifest, metadata, launcherPath] = process.argv.slice(2);
const launcher = readFileSync(launcherPath, 'utf8');
const files = {
  'bin/pnpm.mjs': launcher,
  'bin/pnpx.mjs': launcher,
  'dist/node-gyp-bin/node-gyp': '#!/usr/bin/env sh\nexit 0\n',
  'dist/node-gyp-bin/node-gyp.cmd': '@ECHO OFF\r\nEXIT /B 0\r\n',
  'dist/node_modules/node-gyp/bin/node-gyp.js': launcher,
  'dist/pnpm.mjs': 'fixture payload\n',
  'package.json': '{"name":"pnpm","version":"11.5.0"}\n',
};
const executables = Object.keys(files).slice(0, 5);
const rows = Object.entries(files).sort(([a], [b]) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)),
);
const bytes = tarArchive(
  rows.map(([name, data]) => ({
    name: 'package/' + name,
    data,
    mode: executables.includes(name) ? 0o755 : 0o644,
  })),
);
const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
writeFileSync(archive, bytes);
const tree = createHash('sha256').update('oliphaunt-bootstrap-tree-v2\0');
for (const [name, data] of rows)
  tree.update(
    name +
      '\0' +
      Buffer.byteLength(data) +
      '\0' +
      (executables.includes(name) ? 'x' : '-') +
      '\0' +
      data +
      '\0',
  );
const values = {
  url: 'https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz',
  sha256: sha(bytes),
  sha512: sha(bytes, 'sha512'),
  bytes: bytes.length,
  expanded_bytes: rows.reduce((sum, [, data]) => sum + Buffer.byteLength(data), 0),
  format: 'tar.gz',
  prefix: 'package',
  entry_count: rows.length,
  file_count: rows.length,
  tree_sha256: tree.digest('hex'),
  executable_paths: executables.join(','),
  binary_path: 'bin/pnpm.mjs',
  binary_sha256: sha(files['bin/pnpm.mjs']),
  companion_path: 'bin/pnpx.mjs',
  companion_sha256: sha(files['bin/pnpx.mjs']),
  payload_path: 'dist/pnpm.mjs',
  payload_sha256: sha(files['dist/pnpm.mjs']),
};
writeFileSync(
  manifest,
  '[toolchain]\nversion = "11.5.0"\n\n[package]\n' +
    Object.entries(values)
      .map(([key, value]) => key + ' = "' + value + '"\n')
      .join(''),
);
writeFileSync(metadata, 'ARCHIVE_SHA256=' + sha(bytes) + '\nARCHIVE_BYTES=' + bytes.length + '\n');
