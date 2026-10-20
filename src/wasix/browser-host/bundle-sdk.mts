import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2]);
const ts = createRequire(resolve(directory, 'package.json'))('typescript');
const output = resolve(directory, 'dist');
await mkdir(output, { recursive: true });
for (const [input, filename] of [
  ['index.mts', 'index.mjs'],
  ['src/browser-worker.ts', 'worker.mjs'],
]) {
  const build = await Bun.build({
    entrypoints: [resolve(directory, input)],
    target: 'browser',
    format: 'esm',
    minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, `browser host bundle failed: ${input}`);
  await writeFile(resolve(output, filename), await build.outputs[0].text());
}
await copyFile(
  resolve(directory, 'pkg/wasmer_sdk_js_bg.wasm'),
  resolve(output, 'wasmer_js_bg.wasm'),
);
const declaration = ts
  .transpileDeclaration(await readFile(resolve(directory, 'index.mts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
  })
  .outputText.replace(/^import .*;\n|^export .*from .*;\n/gmu, '');
await writeFile(
  resolve(output, 'index.d.mts'),
  (await readFile(resolve(directory, 'pkg/wasmer_sdk_js.d.ts'), 'utf8')) + declaration,
);
