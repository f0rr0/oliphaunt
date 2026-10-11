import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const workspace = resolve(process.argv[2]);
const ts = createRequire(join(workspace, 'package.json'))('typescript');
const file = join(workspace, 'consumer.mts');
const text = [
  'import * as generated from "./generated/index.mjs";',
  'import * as curated from "./curated/index.mjs";',
  'const compatible: typeof curated = generated;',
  'void compatible;',
  '// @ts-expect-error Instance handles are created by runWasix.',
  'new curated.Instance();',
  '// @ts-expect-error Direct handles are created by instantiateOliphauntDirect.',
  'new curated.OliphauntDirectInstance();',
].join('\n');
writeFileSync(file, text);
const options = {
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.webworker.d.ts'],
  types: [],
};
const program = ts.createProgram([file], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path: string) => path,
      getCurrentDirectory: () => workspace,
      getNewLine: () => '\n',
    }),
  );
assert.equal(diagnostics.length, 0);
writeFileSync(
  join(workspace, 'abi-check.json'),
  JSON.stringify({
    compatible: true,
    typescriptVersion: ts.version,
    nodeVersion: process.versions.node,
  }),
);
