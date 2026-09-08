import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../../..');
const source = resolve(repositoryRoot, 'target/oliphaunt-wasix-ts/host/wasmer-sdk');
const destination = resolve(packageRoot, 'lib/host');

assertHostDeclarationCompatibility();

await rm(destination, { force: true, recursive: true });
await mkdir(destination, { recursive: true });

for (const [sourcePath, name] of [
  [resolve(source, 'dist/index.mjs'), 'index.mjs'],
  [resolve(source, 'dist/worker.mjs'), 'worker.mjs'],
  [resolve(source, 'dist/wasmer_js_bg.wasm'), 'wasmer_js_bg.wasm'],
  [resolve(packageRoot, 'src/host/index.d.mts'), 'index.d.mts'],
  [resolve(source, 'LICENSE'), 'LICENSE'],
  [resolve(source, 'provenance.json'), 'provenance.json'],
]) {
  await copyFile(sourcePath, resolve(destination, name));
}

console.log(`wasix-ts host stage: wrote package-relative host to ${destination}`);

function assertHostDeclarationCompatibility() {
  const virtualFile = resolve(packageRoot, '.host-abi-check.mts');
  const sourceText = [
    "import * as generated from '../../../target/oliphaunt-wasix-ts/host/wasmer-sdk/dist/index.mjs';",
    "import * as curated from './src/host/index.mjs';",
    'const compatible: typeof curated = generated;',
    'void compatible;',
    '// @ts-expect-error Instance handles are created by runWasix.',
    'new curated.Instance();',
    '// @ts-expect-error Direct handles are created by instantiateOliphauntDirect.',
    'new curated.OliphauntDirectInstance();',
  ].join('\n');
  const compilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.webworker.d.ts'],
    types: [],
  };
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const isVirtual = (path) => resolve(path) === virtualFile;
  const compilerHost = {
    ...defaultHost,
    fileExists: (path) => isVirtual(path) || defaultHost.fileExists(path),
    readFile: (path) => (isVirtual(path) ? sourceText : defaultHost.readFile(path)),
    getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      isVirtual(path)
        ? ts.createSourceFile(path, sourceText, languageVersion, true, ts.ScriptKind.TS)
        : defaultHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile),
  };
  const program = ts.createProgram([virtualFile], compilerOptions, compilerHost);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      `curated WASIX host declaration is incompatible with generated host ABI:\n${ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => packageRoot,
          getNewLine: () => '\n',
        },
      )}`,
    );
  }
}
