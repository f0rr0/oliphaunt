import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = resolve(process.argv[2]);
process.chdir(workspace);
const require = createRequire(join(workspace, 'package.json'));
const { rollup } = await import(pathToFileURL(require.resolve('rollup')).href);
const { default: configure } = await import(
  pathToFileURL(join(workspace, 'rollup.config.mjs')).href
);
const configurations = configure({ environment: 'BUILD:production' });
assert(Array.isArray(configurations) && configurations.length === 2);
for (const configuration of configurations) {
  const { output, ...input } = configuration;
  const bundle = await rollup(input);
  try {
    for (const options of Array.isArray(output) ? output : [output]) await bundle.write(options);
  } finally {
    await bundle.close();
  }
}
