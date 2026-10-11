/** Actual pinned-Bazel SDK repository regressions; no SDK or compiler required. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [binary] = process.argv.slice(2);
assert.ok(binary && path.isAbsolute(binary), 'pass the absolute pinned Bazel executable');
const sourceRoot = process.env.BUILD_WORKSPACE_DIRECTORY ?? path.resolve(import.meta.dir, '../..');
const version = readFileSync(path.join(sourceRoot, '.bazelversion'), 'utf8').trim();
const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-sdk-tree-'));
const workspace = path.join(scratch, 'workspace');
const output = path.join(scratch, 'output');
const sdk = path.join(scratch, 'sdk');
const alias = path.join(scratch, 'selected-sdk');
const records: string[] = [];

function file(relative: string, content: string, root = sdk) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function link(relative: string, target: string, root = sdk) {
  const destination = path.join(root, relative);
  rmSync(destination, { force: true });
  symlinkSync(target, destination);
}
function runQuery(outputBase: string) {
  return spawnSync(
    binary,
    [
      '--batch',
      '--nosystem_rc',
      '--nohome_rc',
      `--output_base=${outputBase}`,
      '--host_jvm_args=-Xmx512m',
      'query',
      'deps(@sdk//:all)',
      '--noshow_progress',
      '--lockfile_mode=off',
    ],
    { cwd: workspace, encoding: 'utf8', timeout: 60_000 },
  );
}
function query(outputBase = output) {
  const result = runQuery(outputBase);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  const snapshot = path.join(outputBase, 'external', '+_repo_rules+sdk', 'snapshot.json');
  return {
    files: JSON.parse(readFileSync(snapshot, 'utf8')) as Record<string, string>,
    modified: statSync(snapshot).mtimeMs,
  };
}
function check(name: string, verify: (files: Record<string, string>) => void) {
  console.log(JSON.stringify({ scenario: name }));
  const { files } = query();
  verify(files);
  records.push(name);
}

try {
  mkdirSync(workspace, { recursive: true });
  const identity = spawnSync(
    binary,
    ['--batch', '--host_jvm_args=-Xmx512m', 'version', '--gnu_format'],
    {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(identity.status, 0, identity.stderr);
  assert.ok(identity.stdout.includes(`bazel ${version}`), 'Bazel must match the repository pin');
  copyFileSync(path.join(import.meta.dir, 'sdk-tree.bzl'), path.join(workspace, 'sdk-tree.bzl'));
  writeFileSync(path.join(workspace, 'BUILD.bazel'), 'exports_files(["sdk-tree.bzl"])\n');
  writeFileSync(
    path.join(workspace, 'MODULE.bazel'),
    `module(name = "sdk_tree_probe")\nsdk = use_repo_rule("//:sdk.bzl", "sdk_repo")\nsdk(name = "sdk", path = ${JSON.stringify(alias)})\n`,
  );
  writeFileSync(
    path.join(workspace, 'sdk.bzl'),
    `load(":sdk-tree.bzl", "watch_sdk_directory")
def _impl(ctx):
    root = ctx.path(ctx.attr.path)
    files = watch_sdk_directory(ctx, root)
    # These reads deliberately add no watches: the production walker must do it.
    snapshot = {relative: ctx.read(root.get_child(relative), watch = "no") for relative in files}
    ctx.symlink(root, "sdk")
    ctx.file("snapshot.json", json.encode(snapshot))
    ctx.file("BUILD.bazel", 'filegroup(name="all", srcs=' + repr(["sdk/" + relative for relative in files]) + ', visibility=["//visibility:public"])')
sdk_repo = repository_rule(implementation = _impl, attrs = {"path": attr.string()})
`,
  );
  for (const [version, content] of [
    ['2.6', 'first'],
    ['2.7', 'second'],
  ]) {
    file(`Framework/Versions/${version}/Headers/ruby.h`, content);
    link(`Framework/Versions/${version}/Headers/ruby`, '.');
  }
  link('Framework/Versions/Current', '2.6');
  link('Framework/Headers', 'Versions/Current/Headers');
  link('file-alias.h', 'Framework/Headers/ruby.h');
  link('dangling.h', 'missing.h');
  symlinkSync(sdk, alias);
  check('recursive SDK alias is finite; physical headers and framework aliases remain', (files) => {
    assert.equal(files['Framework/Versions/2.6/Headers/ruby.h'], 'first');
    assert.equal(files['Framework/Versions/2.7/Headers/ruby.h'], 'second');
    assert.equal(files['Framework/Versions/Current/Headers/ruby.h'], 'first');
    assert.equal(files['Framework/Headers/ruby.h'], 'first');
    assert.equal(files['file-alias.h'], 'first');
    assert.ok(!Object.keys(files).some((name) => name.includes('/ruby/')));
  });
  const warm = query();
  assert.equal(query().modified, warm.modified, 'unchanged SDK must reuse repository');
  records.push('warm unchanged repository reuse');
  file('Framework/Versions/2.6/Headers/ruby.h', 'changed');
  check('existing file contents invalidate', (files) =>
    assert.equal(files['Framework/Headers/ruby.h'], 'changed'),
  );
  file('extra header.h', 'new');
  check('file addition invalidates', (files) => assert.equal(files['extra header.h'], 'new'));
  renameSync(path.join(sdk, 'extra header.h'), path.join(sdk, 'renamed header.h'));
  check('file rename invalidates', (files) => {
    assert.equal(files['renamed header.h'], 'new');
    assert.ok(!('extra header.h' in files));
  });
  rmSync(path.join(sdk, 'renamed header.h'));
  check('file deletion invalidates', (files) => assert.ok(!('renamed header.h' in files)));
  link('Framework/Versions/Current', '2.7');
  check('directory alias retarget observes changed bytes with identical entry names', (files) =>
    assert.equal(files['Framework/Headers/ruby.h'], 'second'),
  );
  link('file-alias.h', 'Framework/Versions/2.6/Headers/ruby.h');
  check('file alias retarget invalidates', (files) =>
    assert.equal(files['file-alias.h'], 'changed'),
  );
  link('Framework/Versions/2.6/Headers/ruby', '../../2.7/Headers');
  check('cycle alias retarget observes newly reachable files', (files) =>
    assert.equal(files['Framework/Versions/2.6/Headers/ruby/ruby.h'], 'second'),
  );
  file('missing.h', 'appeared');
  check('dangling alias becomes a declared file', (files) =>
    assert.equal(files['dangling.h'], 'appeared'),
  );
  const alternate = path.join(scratch, 'alternate-sdk');
  file('alternate.h', 'different', alternate);
  rmSync(alias);
  symlinkSync(alternate, alias);
  // Bazel 8's recorded directory-listing watcher cannot transparently refetch
  // after a previously watched directory disappears. It must fail closed;
  // reacquiring into a fresh output base observes the newly selected SDK.
  const replaced = runQuery(output);
  assert.equal(replaced.error, undefined, String(replaced.error));
  assert.notEqual(replaced.status, 0);
  assert.match(replaced.stderr, /no longer an existing directory/);
  records.push('structurally unrelated SDK replacement fails closed');
  assert.deepEqual(query(path.join(scratch, 'fresh-output')).files, { 'alternate.h': 'different' });
  records.push('fresh acquisition observes replaced SDK');
  console.log(JSON.stringify({ passed: records.length, scenarios: records }));
} finally {
  if (process.env.OLIPHAUNT_KEEP_SDK_PROBE === '1') console.log(JSON.stringify({ scratch }));
  else rmSync(scratch, { recursive: true, force: true });
}
