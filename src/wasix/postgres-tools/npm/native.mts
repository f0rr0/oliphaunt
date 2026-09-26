import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import portable from './index.js';

const require = createRequire(import.meta.url);
const targets = {
  'linux-arm64': 'linux-arm64-gnu',
  'linux-x64': 'linux-x64-gnu',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target)
  throw new Error(`WASIX PostgreSQL tools do not support ${process.platform}/${process.arch}`);
const root = dirname(require.resolve(`@oliphaunt/liboliphaunt-wasix-tools-${target}/package.json`));
const carrier = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (carrier.version !== portable.version)
  throw new Error('WASIX tools AOT carrier version differs from the portable tools package');
const manifestFile = join(root, 'assets/manifest.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const tool = (descriptor) => {
  const artifact = manifest.artifacts.find(({ name }) => name === `tool:${descriptor.name}`);
  if (
    !artifact ||
    typeof artifact.path !== 'string' ||
    artifact.path.includes('..') ||
    artifact.path.includes('/') ||
    artifact.path.includes('\\')
  ) {
    throw new Error(`WASIX tools AOT carrier is missing ${descriptor.name}`);
  }
  return Object.freeze({
    ...descriptor,
    aot: Object.freeze({
      source: pathToFileURL(join(root, 'assets', artifact.path)).href,
      manifest: pathToFileURL(manifestFile).href,
    }),
  });
};
export default Object.freeze({
  ...portable,
  pgDump: tool(portable.pgDump),
  psql: tool(portable.psql),
});
