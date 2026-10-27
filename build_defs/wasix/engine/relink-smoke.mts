import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRelinkKit, type RelinkTools } from '../../../src/wasix/runtime/engine/relink.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';

const [archive, specification, loader, runfiles] = process.argv.slice(2);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'engine-relink-'));
const kit = path.join(root, 'kit');
extractPortableArchiveTree(realpathSync(archive), kit);
const sources = path.join(root, 'modified source');
cpSync(path.join(kit, 'source'), sources, { recursive: true });
const recipe = JSON.parse(readFileSync(path.join(kit, 'relink.json'), 'utf8'));
const modified = path.join(sources, recipe.objects[0].source);
writeFileSync(
  modified,
  `${readFileSync(modified, 'utf8')}\n/* Relink qualification uses a private modified source copy. */\n`,
);
const config = JSON.parse(readFileSync(specification, 'utf8'));
const resolve = (file: string) => path.join(runfiles, file);
for (const [name, directories] of Object.entries(config.environment) as [string, string[]][])
  process.env[name] = directories.map(resolve).join(';');
process.env.TEMP = root;
process.env.TMP = root;
const tools: RelinkTools = {
  clangCl: resolve(config.tools.clangCl),
  cl: resolve(config.tools.cl),
  lib: resolve(config.tools.lib),
  link: resolve(config.tools.link),
  library: resolve(config.tools.library),
};
const result = buildRelinkKit(kit, sources, path.join(root, 'rebuilt'), tools);
const loaded = spawnSync(loader, [path.join(root, 'rebuilt/oliphaunt_wee8.dll')], {
  encoding: 'utf8',
});
assert.equal(
  loaded.status,
  0,
  `${loaded.error?.message ?? ''}\n${loaded.stdout}\n${loaded.stderr}`,
);
console.log(JSON.stringify({ dllSha256: result.dllSha256, execution: loaded.stdout.trim() }));
