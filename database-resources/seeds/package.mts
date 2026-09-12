#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { releaseZstdCompressSync } from '../../tools/packaging/portable-archive.mts';
import { currentProductVersionSync } from '../../tools/release/release-artifact-targets.mts';
import {
  filesystemTreeRows,
  logicalTreeSha256,
  nativeClusterSeedCompatibilityKey,
} from '../contracts/native-manifest.mts';

const { values } = parseArgs({
  options: Object.fromEntries(
    ['family', 'profile', 'target', 'pgdata', 'runtime', 'icu-data', 'output-dir'].map((name) => [
      name,
      { type: 'string' },
    ]),
  ),
});
const { family, profile, target, pgdata, runtime } = values;
if (
  !['native', 'wasix'].includes(family) ||
  !['standard', 'icu'].includes(profile) ||
  !pgdata ||
  !runtime ||
  !target
)
  throw new Error('family, profile, target, pgdata and runtime are required');
if ((profile === 'icu') !== Boolean(values['icu-data']))
  throw new Error('only ICU seeds require --icu-data');
const contract = JSON.parse(
  readFileSync(new URL('../contracts/contract.json', import.meta.url), 'utf8'),
);
const postgresMajor = Number(readFileSync(path.join(pgdata, 'PG_VERSION'), 'utf8').trim());
if (postgresMajor !== 18 || statSync(path.join(pgdata, 'global/pg_control')).size === 0)
  throw new Error('seed is not a complete PostgreSQL 18 cluster');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const executable = (name) =>
  path.join(runtime, 'bin', `${name}${target.startsWith('windows-') ? '.exe' : ''}`);
const runtimeDigest = digest(readFileSync(executable('postgres')));
const initdbDigest = digest(readFileSync(executable('initdb')));
const version = currentProductVersionSync('database-resources');
const name = `database-resources-${version}-seed-${family}${family === 'native' ? `-${target}` : ''}-${profile}`;
const output = path.resolve(values['output-dir'] ?? 'target/database-resources/release-assets');
const rows = filesystemTreeRows(pgdata);
let directories = 0;
function countDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) {
      directories++;
      countDirectories(path.join(root, entry.name));
    }
}
countDirectories(pgdata);
const archive = releaseZstdCompressSync(await createDeterministicTar(pgdata));
const icu =
  profile === 'icu'
    ? {
        artifactRole: contract.icu.artifactRole,
        dataVersion: contract.icu.dataVersion,
        dataForm: contract.icu.dataForm,
        dataTreeSha256: logicalTreeSha256(filesystemTreeRows(values['icu-data'])),
      }
    : null;
const manifest = {
  schema: contract.manifests.wasix.schema,
  artifactRole: contract.profiles[profile].artifactRole,
  catalogProfile: profile,
  runtime: {
    product: `liboliphaunt-${family}`,
    version: currentProductVersionSync(`liboliphaunt-${family}`),
    engineFamily: family,
    target,
    physicalFormat: contract.physicalFormats[family],
    postgresMajor,
    compatibilityKey:
      family === 'native'
        ? nativeClusterSeedCompatibilityKey(target)
        : contract.compatibilityKeys.wasixDatum32,
    ...(family === 'wasix'
      ? { consumerSha256: runtimeDigest, producerSha256: runtimeDigest, initdbSha256: initdbDigest }
      : {}),
  },
  source: {
    producer: `${family}-initdb`,
    ...(family === 'native' ? { postgresSha256: runtimeDigest, initdbSha256: initdbDigest } : {}),
  },
  archive: {
    path: `${name}.tar.zst`,
    sha256: digest(archive),
    compressedBytes: archive.length,
    expandedBytes: rows.reduce((sum, row) => sum + row.bytes.length, 0),
    regularFiles: rows.length,
    directories,
  },
  requiredRuntimeFeatures: contract.profiles[profile].requiredRuntimeFeatures,
  extensions: { selected: [], startupConfiguration: [] },
  icu,
};
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, `${name}.tar.zst`), archive);
writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(path.join(output, `${name}.tar.zst`));
