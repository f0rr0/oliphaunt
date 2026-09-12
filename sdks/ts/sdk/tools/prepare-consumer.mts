import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractPortableTarGzipTree } from '../../../../tools/packaging/portable-archive.mts';
import {
  preparePublishedConsumerEnvironment,
  validPublishedConsumerInventory,
} from './published-consumer.mts';

const destination = path.resolve(process.argv[2]);
const artifact = (directory: string, pattern: RegExp) => {
  const files = readdirSync(directory).filter((name) => pattern.test(name));
  if (files.length !== 1)
    throw new Error(`expected one ${pattern} in ${directory}, found ${files.length}`);
  return path.resolve(directory, files[0]);
};
mkdirSync(destination, { recursive: true });
const sdk = artifact('target/sdk-artifacts/oliphaunt-js', /\.tgz$/u);
const published = process.argv[3] === '--published-dependencies';
if (published) {
  const inventory = JSON.parse(process.env.OLIPHAUNT_PUBLISHED_DEPENDENCIES ?? 'null');
  if (!validPublishedConsumerInventory(inventory))
    throw new Error('missing or invalid verified published dependency inventory');
  preparePublishedConsumerEnvironment(destination);
  writeFileSync(
    path.join(destination, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@oliphaunt/ts': `file:${sdk}`,
        ...Object.fromEntries(inventory.map((row) => [row.name, row.version])),
      },
    }),
  );
  process.exit(0);
}
const query = artifact('target/sdk-artifacts/oliphaunt-query-ts', /\.tgz$/u);
writeFileSync(
  path.join(destination, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { '@oliphaunt/ts': `file:${sdk}`, '@oliphaunt/ts-query': `file:${query}` },
    overrides: { '@oliphaunt/ts-query': `file:${query}` },
  }),
);
for (const [name, directory, pattern] of [
  [
    'runtime',
    'target/liboliphaunt/desktop-release-assets/linux-x64-gnu',
    /^liboliphaunt-.*-linux-x64-gnu\.tar\.gz$/u,
  ],
  [
    'broker',
    'target/oliphaunt-broker/release-assets',
    /^oliphaunt-broker-.*-linux-x64-gnu\.tar\.gz$/u,
  ],
  [
    'addon',
    'target/oliphaunt-node-direct/release-assets',
    /^oliphaunt-node-direct-.*-linux-x64-gnu\.tar\.gz$/u,
  ],
] as const)
  await extractPortableTarGzipTree(artifact(directory, pattern), path.join(destination, name));
