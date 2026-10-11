/**
 * Actual pinned-Bazel SDK input regressions; no SDK or compiler required.
 * The selected SDK topology stays fixed during qualification. These regressions
 * exercise observable names, types, and bytes; Bazel 8.8 does not record a
 * directory symlink's canonical identity when those observations all match.
 */
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
function runBuild(outputBase: string) {
  return spawnSync(
    binary,
    [
      '--batch',
      '--nosystem_rc',
      '--nohome_rc',
      `--output_base=${outputBase}`,
      '--host_jvm_args=-Xmx512m',
      'build',
      '//:read_sdk',
      '--noshow_progress',
      '--lockfile_mode=off',
      '--incompatible_autoload_externally=',
      '--host_platform=//:host',
      '--platforms=//:host',
      `--execution_log_json_file=${path.join(workspace, 'execution.json')}`,
    ],
    { cwd: workspace, encoding: 'utf8', timeout: 60_000 },
  );
}
function build(outputBase = output) {
  const result = runBuild(outputBase);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  const repository = path.join(outputBase, 'external', '+_repo_rules+sdk');
  const rows = readFileSync(path.join(workspace, 'bazel-bin', 'read_sdk.txt'), 'utf8').trim();
  const prefix = 'external/+_repo_rules+sdk/sdk/';
  const files = Object.fromEntries(
    rows
      ? rows.split('\n').map((row) => {
          const separator = row.indexOf('\t');
          assert.ok(separator >= 0 && row.startsWith(prefix), `unexpected action output: ${row}`);
          return [row.slice(prefix.length, separator), row.slice(separator + 1)];
        })
      : [],
  );
  return {
    files,
    modified: statSync(path.join(repository, 'BUILD.bazel')).mtimeMs,
    executed: readFileSync(path.join(workspace, 'execution.json'), 'utf8').includes('SdkRead'),
  };
}
function check(name: string, verify: (files: Record<string, string>) => void) {
  console.log(JSON.stringify({ scenario: name }));
  const { files } = build();
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
  writeFileSync(
    path.join(workspace, 'BUILD.bazel'),
    'load(":read-sdk.bzl", "read_sdk")\nplatform(name="host")\nread_sdk(name="read_sdk", srcs=["@sdk//:all"])\nexports_files(["sdk-tree.bzl"])\n',
  );
  writeFileSync(
    path.join(workspace, 'read-sdk.bzl'),
    `def _impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".txt")
    inputs = ctx.files.srcs
    ctx.actions.run_shell(inputs = inputs, outputs = [output], arguments = [output.path] + [source.path for source in inputs], command = 'set -eu; output="$1"; shift; for source in "$@"; do printf "%s\\\\t" "$source"; cat "$source"; printf "\\\\n"; done > "$output"', mnemonic = "SdkRead")
    return [DefaultInfo(files = depset([output]))]
read_sdk = rule(implementation = _impl, attrs = {"srcs": attr.label_list(allow_files = True)})
`,
  );
  writeFileSync(
    path.join(workspace, 'MODULE.bazel'),
    `module(name = "sdk_tree_probe")\nsdk = use_repo_rule("//:sdk.bzl", "sdk_repo")\nsdk(name = "sdk", path = ${JSON.stringify(alias)})\n`,
  );
  writeFileSync(
    path.join(workspace, 'sdk.bzl'),
    `load(":sdk-tree.bzl", "apple_sdk_documentation_directories", "watch_sdk_directory")
def _impl(ctx):
    root = ctx.path(ctx.attr.path)
    files = watch_sdk_directory(ctx, root, apple_sdk_documentation_directories("sdk_macosx"))
    ctx.symlink(root, "sdk")
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
  file('Ordinary/A/header.h', 'same');
  file('Ordinary/B/header.h', 'same');
  mkdirSync(path.join(sdk, 'Ordinary/A/nested'), { recursive: true });
  file('Ordinary/B/nested/extra.h', 'extra');
  link('ordinary-alias', 'Ordinary/A');
  link('file-alias.h', 'Framework/Headers/ruby.h');
  link('dangling.h', path.join(scratch, 'missing.h'));
  file('type-switch', 'file');
  file('usr/share/man/man3/APR::Base64.3pm', 'manual');
  file('usr/include/api.h', 'sysroot-header');
  file('usr/lib/libSystem.tbd', 'sysroot-library');
  symlinkSync(sdk, alias);
  check(
    'colon manual-page documentation is excluded while sysroot inputs remain declared',
    (files) => {
      assert.equal(files['usr/include/api.h'], 'sysroot-header');
      assert.equal(files['usr/lib/libSystem.tbd'], 'sysroot-library');
      assert.ok(!Object.keys(files).some((name) => name.startsWith('usr/share/man/')));
    },
  );
  check('recursive SDK alias is finite; physical headers and framework aliases remain', (files) => {
    assert.equal(files['Framework/Versions/2.6/Headers/ruby.h'], 'first');
    assert.equal(files['Framework/Versions/2.7/Headers/ruby.h'], 'second');
    assert.equal(files['Framework/Versions/Current/Headers/ruby.h'], 'first');
    assert.equal(files['Framework/Headers/ruby.h'], 'first');
    assert.equal(files['file-alias.h'], 'first');
    assert.ok(!Object.keys(files).some((name) => name.includes('/ruby/')));
  });
  rmSync(path.join(sdk, 'type-switch'));
  file('type-switch/inside.h', 'directory');
  check('same-name file becomes a directory with declared child inputs', (files) => {
    assert.ok(!('type-switch' in files));
    assert.equal(files['type-switch/inside.h'], 'directory');
  });
  const warm = build();
  assert.equal(warm.executed, false, 'unchanged SDK must reuse the action cache');
  const unchanged = build();
  assert.equal(unchanged.modified, warm.modified, 'unchanged SDK must reuse repository');
  assert.equal(unchanged.executed, false, 'unchanged SDK must reuse the action cache');
  records.push('warm unchanged repository and action reuse');
  file('usr/share/man/man3/New::Manual.3pm', 'new-manual');
  file('usr/share/man/man3/APR::Base64.3pm', 'changed-manual');
  const manuals = build();
  assert.equal(manuals.executed, false, 'manual bytes and membership are not compiler inputs');
  assert.ok(!Object.keys(manuals.files).some((name) => name.startsWith('usr/share/man/')));
  records.push('manual-page edits do not alter the declared compiler action');
  file('usr/include/api.h', 'changed-sysroot-header');
  check('sysroot header content remains a declared action input', (files) =>
    assert.equal(files['usr/include/api.h'], 'changed-sysroot-header'),
  );
  link('ordinary-alias', 'Ordinary/B');
  check(
    'directory alias retarget declares existing target additions without byte edits',
    (files) => {
      assert.equal(files['ordinary-alias/header.h'], 'same');
      assert.equal(files['ordinary-alias/nested/extra.h'], 'extra');
    },
  );
  link('ordinary-alias', 'Ordinary/A');
  check('directory alias retarget removes existing target members without byte edits', (files) => {
    assert.equal(files['ordinary-alias/header.h'], 'same');
    assert.ok(!('ordinary-alias/nested/extra.h' in files));
  });
  file('Framework/Versions/2.6/Headers/ruby.h', 'changed');
  check('existing file contents invalidate the declared input action', (files) =>
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
  check('directory alias retarget updates action bytes with identical entry names', (files) =>
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
  file('missing.h', 'appeared', scratch);
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
  const replaced = runBuild(output);
  assert.equal(replaced.error, undefined, String(replaced.error));
  assert.notEqual(replaced.status, 0);
  assert.match(replaced.stderr, /no longer an existing directory/);
  records.push('structurally unrelated SDK replacement fails closed');
  assert.deepEqual(build(path.join(scratch, 'fresh-output')).files, { 'alternate.h': 'different' });
  records.push('fresh acquisition observes replaced SDK');
  file('usr/include/APR::Base64.h', 'usable-header', alternate);
  const illegalHeader = runBuild(path.join(scratch, 'illegal-header-output'));
  assert.equal(illegalHeader.error, undefined, String(illegalHeader.error));
  assert.notEqual(illegalHeader.status, 0);
  assert.match(illegalHeader.stderr, /invalid label .*usr\/include\/APR::Base64\.h/u);
  records.push('illegal labels outside documentation fail closed without dropping usable inputs');
  console.log(JSON.stringify({ passed: records.length, scenarios: records }));
} finally {
  if (process.env.OLIPHAUNT_KEEP_SDK_PROBE === '1') console.log(JSON.stringify({ scratch }));
  else rmSync(scratch, { recursive: true, force: true });
}
