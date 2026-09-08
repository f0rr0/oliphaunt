import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stagePackedWasixConsumer } from './packed-node-fixture.mts';

const { packageOnly, runtime } = readOptions(process.argv.slice(3));
const runtimeName =
  runtime === 'bun'
    ? 'Bun'
    : runtime === 'deno'
      ? 'Deno'
      : runtime === 'electron'
        ? 'Electron'
        : 'Node';
const packageCondition = runtime === 'electron' ? 'node' : runtime;
const storageCondition = runtime === 'electron' ? 'node' : runtime;
const expectedEntrypoint = `index.${packageCondition}.js`;
const expectedDirectEntrypoint = 'direct.node.js';
const expectedWorkerEntrypoint = `worker-entry.${packageCondition}.js`;
const expectedServerEntrypoint = 'server.node.js';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const pgwireClientUrl = pathToFileURL(
  resolve(repositoryRoot, 'src/bindings/wasix-ts/tools/pgwire-client.mts'),
).href;
if (!process.argv[2]) throw new Error('smoke-node.mts requires a scratch directory');
const scratch = resolve(process.argv[2]);
const fixture = await stagePackedWasixConsumer({
  scratch,
  consumerName: `oliphaunt-wasix-${runtime}-smoke-consumer`,
  includePgtap: !packageOnly,
  includeNative: !packageOnly,
  useStubRuntime: packageOnly,
});
const candidate = fixture.packages.binding.name;
const extension = fixture.packages.extension?.name;
await writeFile(
  resolve(fixture.consumer, 'fixture.json'),
  JSON.stringify({
    candidate,
    extension,
    runtime,
    storageCondition,
    runtimeName,
    packageOnly,
    expectedEntrypoint,
    expectedDirectEntrypoint,
    expectedWorkerEntrypoint,
    expectedServerEntrypoint,
    pgwireClientUrl,
  }),
);
await writeFile(
  resolve(fixture.consumer, 'verify.mjs'),
  stripTypeScriptTypes(await readFile(new URL('./verify-host.mts', import.meta.url), 'utf8')),
);
function readOptions(args) {
  let packageOnly = false;
  let runtime = 'node';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--package-only' && !packageOnly) {
      packageOnly = true;
      continue;
    }
    if (
      argument === '--runtime' &&
      index + 1 < args.length &&
      ['bun', 'deno', 'electron', 'node'].includes(args[index + 1])
    ) {
      runtime = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error('usage: smoke-node.mts [--runtime node|bun|deno|electron] [--package-only]');
  }
  return { packageOnly, runtime };
}
