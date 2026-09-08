#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(docsRoot, '../..');
const generatedRoot = path.join(repoRoot, 'target/docs');
const scratch = fs.mkdtempSync(path.join(generatedRoot, 'snippet-check-'));
const sdks = [
  ['typescript', 'src/sdks/js', '@oliphaunt/ts'],
  ['react-native', 'src/sdks/react-native', '@oliphaunt/react-native'],
  ['wasix-typescript', 'src/bindings/wasix-ts', '@oliphaunt/wasix-ts'],
];

try {
  for (const [slug, sdkPath, packageName] of sdks) {
    const sdkRoot = path.join(repoRoot, sdkPath);
    const markdown = fs.readFileSync(
      path.join(generatedRoot, `site-docs/sdk/${slug}/index.mdx`),
      'utf8',
    );
    const code = markdown.match(/```(?:ts|typescript)\n([\s\S]*?)\n```/u)?.[1];
    if (!code) throw new Error(`${slug}: quickstart has no TypeScript example`);
    const file = path.join(scratch, `${slug}.mts`);
    fs.writeFileSync(file, code);
    const config = path.join(scratch, `${slug}.json`);
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
          types: ['node'],
          paths: {
            [packageName]: [path.join(sdkRoot, 'src/index.ts')],
            '@oliphaunt/js-core/*': [path.join(repoRoot, 'src/shared/js-core/src/*.ts')],
            '@oliphaunt/liboliphaunt-wasix': [
              path.join(repoRoot, 'src/bindings/wasix-ts/src/runtime-carrier-shim.d.ts'),
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
    console.log(`${slug} quickstart: type-checked against SDK source (not executed)`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
