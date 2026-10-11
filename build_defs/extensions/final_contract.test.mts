/** Validate actual target carriers on the execution host; never execute target SQL. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type NativeOwnerSpec, validateNativeFinalLeaf } from './owner_carriers.mts';

const inventory = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(inventory.schema, 'oliphaunt-native-extension-final-contract-test-v1');
assert.equal(inventory.scope, 'construction');
assert(inventory.products.length > 0);
const runfiles = process.env.TEST_SRCDIR;
assert(runfiles, 'final contract requires declared Bazel runfiles');
const root = mkdtempSync(path.join(tmpdir(), 'native-final-contract-'));
const declared = (file: string) =>
  path.join(
    runfiles,
    process.env.TEST_WORKSPACE ?? '_main',
    file.replace(/^bazel-out\/[^/]+\/bin\//u, ''),
  );
try {
  const products = new Set<string>();
  const sqlNames: string[] = [];
  let members = 0;
  for (const spec of inventory.products as NativeOwnerSpec[]) {
    assert(!products.has(spec.product), 'final contract repeats a distribution');
    products.add(spec.product);
    assert.equal(spec.leaves.length, 1);
    const leaf = spec.leaves[0];
    assert.equal(leaf.target, inventory.target);
    spec.components = declared(spec.components);
    for (const group of ['github', 'npm', 'cargo'] as const)
      leaf[group] = leaf[group].map(declared);
    leaf.manifest = declared(leaf.manifest);
    leaf.frozen = declared(leaf.frozen);
    if (leaf.receipt) leaf.receipt = declared(leaf.receipt);
    const validated = validateNativeFinalLeaf(spec, leaf, path.join(root, spec.product));
    assert.equal(validated.members.length, spec.members.length);
    members += validated.members.length;
    sqlNames.push(...validated.members.map((member) => member.sqlName));
    console.log(
      `${spec.product}: actual ${inventory.target} GitHub/npm/Cargo files, exact member inventory, platform binaries, and legal bytes PASS`,
    );
  }
  assert.deepEqual(sqlNames.sort(), inventory.members);
  assert(inventory.excluded.every((name: string) => !sqlNames.includes(name)));
  console.log(
    `${products.size} native distributions / ${members} SQL members validated on ${process.platform}/${process.arch}; this content proof does not execute ${inventory.target} SQL.`,
  );
  if (inventory.excluded.length > 0)
    console.log(`Excluded canonical members: ${inventory.excluded.join(', ')}.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
