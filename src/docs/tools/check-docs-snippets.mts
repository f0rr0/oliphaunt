#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(docsRoot, '../..');
const generatedRoot = path.join(repoRoot, 'target/docs');
const scratch = fs.mkdtempSync(path.join(generatedRoot, 'snippet-check-'));
const sdks = [
  ['typescript', 'src/native/sdks/ts', '@oliphaunt/ts'],
  ['react-native', 'src/native/sdks/react-native', '@oliphaunt/react-native'],
  ['wasix-typescript', 'src/wasix/sdks/ts', '@oliphaunt/wasix-ts'],
];

try {
  for (const [slug, sdkPath, packageName] of sdks) {
    const sdkRoot = path.join(repoRoot, sdkPath);
    const markdown = fs.readFileSync(
      path.join(generatedRoot, `site-docs/sdk/${slug}/index.mdx`),
      'utf8',
    );
    const blocks = [...markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)\n```/gu)];
    if (blocks.length === 0) throw new Error(`${slug}: quickstart has no TypeScript example`);
    // WASIX also checks host directory storage and browser initialization/Worker recipes.
    const selected = slug === 'wasix-typescript' ? blocks : blocks.slice(0, 1);
    const files = selected.map((block, index) => {
      let code = block[1];
      if (slug === 'wasix-typescript' && !code.includes('import Oliphaunt')) {
        code = `import Oliphaunt from '${packageName}';\n${code}`;
      }
      const file = path.join(scratch, `${slug}-${index}.mts`);
      fs.writeFileSync(file, code);
      return file;
    });
    for (const [index, file] of files.entries()) {
      const config = path.join(scratch, `${slug}-${index}.json`);
      fs.writeFileSync(
        config,
        JSON.stringify({
          extends: path.join(sdkRoot, 'tsconfig.json'),
          compilerOptions: {
            rootDir: repoRoot,
            noEmit: true,
            noUnusedLocals: false,
            lib: [
              'ES2023',
              'ESNext.Disposable',
              'DOM',
              'DOM.Iterable',
              'DOM.AsyncIterable',
              'WebWorker',
            ],
            typeRoots: [path.join(sdkRoot, 'node_modules/@types')],
            types: ['node', 'bun'],
            paths: {
              [packageName]: [
                path.join(
                  sdkRoot,
                  slug === 'wasix-typescript' && !selected[index][1].includes('/storage/indexed-db')
                    ? 'src/index.node.ts'
                    : 'src/index.ts',
                ),
              ],
              ...(slug === 'wasix-typescript'
                ? {
                    [`${packageName}/worker`]: [path.join(sdkRoot, 'src/worker-entry.ts')],
                    [`${packageName}/storage/*`]: [path.join(sdkRoot, 'src/storage/*.ts')],
                  }
                : {}),
              '@oliphaunt/ts-query/*': [path.join(repoRoot, 'src/query/ts/src/*.ts')],
              '@oliphaunt/liboliphaunt-wasix': [
                path.join(repoRoot, 'src/wasix/sdks/ts/src/runtime-carrier-shim.d.ts'),
              ],
            },
          },
          include: [file],
          exclude: [],
        }),
      );
      execFileSync(path.join(docsRoot, 'node_modules/.bin/tsc'), ['-p', config], {
        stdio: 'inherit',
      });
    }
    console.log(
      `${slug} quickstart: ${files.length} examples type-checked against SDK source (not executed)`,
    );
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
