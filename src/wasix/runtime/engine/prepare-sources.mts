import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  archiveTreeDigest,
  promotePathTransactional,
  sha256File,
} from '../../../third-party/tools/source-fetch-core.mts';
import { ENGINE_SOURCE_CRATES } from './contract.mts';

const root = path.resolve(import.meta.dir, '../../../..');
const owner = path.join(root, 'src/wasix/runtime/engine');
const pins = Bun.TOML.parse(readFileSync(path.join(owner, 'source.toml'), 'utf8'));

function inputs(name) {
  const directory = path.join(owner, 'patches', name);
  return existsSync(directory)
    ? readFileSync(path.join(directory, 'series'), 'utf8')
        .trim()
        .split('\n')
        .map((file) => path.join(directory, file))
    : [];
}

function prepare(name) {
  const source = path.join(root, 'target/oliphaunt-sources/checkouts', `sdk-${name}`);
  const directory = path.join(owner, 'crates', name);
  const output = path.join(directory, 'upstream');
  const signature = JSON.stringify([pins[name].sha256, ...inputs(name).map(sha256File)]);
  const stamp = path.join(directory, '.prepared.json');
  if (existsSync(stamp) && existsSync(output)) {
    const previous = JSON.parse(readFileSync(stamp, 'utf8'));
    if (previous.signature === signature && previous.tree === archiveTreeDigest(output)) return;
  }
  const stage = path.join(directory, `.upstream-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  try {
    cpSync(source, stage, { recursive: true });
    rmSync(path.join(stage, '.oliphaunt-source-pin'));
    for (const patch of inputs(name)) {
      const result = Bun.spawnSync(['git', 'apply', '--check', patch], { cwd: stage });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      const applied = Bun.spawnSync(['git', 'apply', patch], { cwd: stage });
      assert.equal(applied.exitCode, 0, applied.stderr.toString());
    }
    promotePathTransactional(stage, output);
    writeFileSync(stamp, JSON.stringify({ signature, tree: archiveTreeDigest(output) }) + '\n');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const [operation, plan] = Bun.argv.slice(2);
if (operation === 'plan' && plan) {
  mkdirSync(plan, { recursive: true });
  for (const name of ENGINE_SOURCE_CRATES) {
    const pin = pins[name];
    writeFileSync(
      path.join(plan, `${name}.json`),
      JSON.stringify({
        name: `sdk-${name}`,
        kind: 'archive',
        url: pin.url,
        branch: 'oliphaunt-pinned',
        commit: pin.sha256,
        sha256: pin.sha256,
        stripPrefix: `${name}-${pin.version}`,
      }),
    );
  }
  writeFileSync(
    path.join(plan, 'pins'),
    ENGINE_SOURCE_CRATES.map((name) => path.resolve(plan, `${name}.json`) + '\0').join(''),
  );
} else if (operation === 'prepare' && !plan) {
  for (const name of ENGINE_SOURCE_CRATES) prepare(name);
} else {
  throw new Error('usage: prepare-sources.mts plan DIRECTORY | prepare');
}
