import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function run(graph, head, options, operation, args) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'product-history-test-'));
  try {
    const file = path.join(scratch, 'graph.json');
    writeFileSync(file, JSON.stringify(graph));
    const script =
      operation === 'plan'
        ? 'const [graph, head, options] = JSON.parse(process.argv[1]); const {buildPlanFromProductTags} = await import("./src/shared/product-metadata/release-graph.mts"); console.log(JSON.stringify(buildPlanFromProductTags(graph, head, options)));'
        : 'const [entry, products, pending, options] = JSON.parse(process.argv[1]); const {compatibilityVersionSource} = await import("./src/shared/product-metadata/compatibility-version-policy.mts"); console.log(JSON.stringify(compatibilityVersionSource(entry, products, new Map(pending), options)));';
    const result = spawnSync(
      process.env.OLIPHAUNT_TEST_BASH ?? 'bash',
      [
        'src/shared/product-metadata/with-product-history.sh',
        options.root,
        head,
        '',
        file,
        'bash',
        'tools/dev/bun.sh',
        '-e',
        script,
        JSON.stringify(args),
      ],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 },
    );
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export function buildPlanFromProductTags(graph, head, options) {
  return run(graph, head, options, 'plan', [graph, head, options]);
}
export function compatibilityVersionSource(entry, products, pending, options) {
  return run({ products }, options.headRef ?? 'HEAD', options, 'compatibility', [
    entry,
    products,
    [...pending],
    options,
  ]);
}
