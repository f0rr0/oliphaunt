import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolatedGitHubTestEnvironment } from '../test/isolated-github-test-environment.mts';

import { AOT_TARGET_TRIPLES } from '../../src/runtimes/liboliphaunt/wasix/tools/wasix-cargo-artifact-contract.mts';
const downloadCount = 1 + Object.keys(AOT_TARGET_TRIPLES).length;
const script = '.github/scripts/download-wasix-runtime-build-artifacts.sh';
const artifactSha = 'b'.repeat(40);
const controllerSha = 'a'.repeat(40);
function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wasix-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const capture = path.join(root, 'commands');
  writeFileSync(capture, '');
  writeFileSync(
    path.join(bin, 'cargo'),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' cargo "$@" >>"$CAPTURE_PATH"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'bash'),
    `#!/bin/bash
if [ "$1" = .github/scripts/download-build-artifacts.sh ]; then
  printf '%s\\n' bash "$@" >>"$CAPTURE_PATH"
  exit "\${DOWNLOAD_FAILURE:-0}"
fi
exec "$TEST_REAL_BASH" "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' gh "$@" >>"$CAPTURE_PATH"
printf '777\\n'
`,
    { mode: 0o755 },
  );
  const env = isolatedGitHubTestEnvironment({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CAPTURE_PATH: capture,
    TEST_REAL_BASH: process.env.OLIPHAUNT_TEST_BASH ?? '/bin/bash',
    GITHUB_TOKEN: 'fixture-token',
    GH_REPO: 'fixture/oliphaunt',
    RELEASE_ARTIFACT_SHA: artifactSha,
    RELEASE_HEAD_SHA: controllerSha,
    ...overrides,
  });
  return { env, commands: () => readFileSync(capture, 'utf8') };
}

test('release handoff binds every artifact to the frozen SHA and exact run before installation', (t) => {
  const f = fixture(t, { CI_RUN_ID: '30358387218' });
  const result = spawnSync('bash', [script], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.equal(commands.split(`CI\n${artifactSha}\n`).length - 1, downloadCount);
  assert.equal(commands.split('--run-id\n30358387218\n--job\nBuilds\n').length - 1, downloadCount);
  assert.ok(!commands.includes(controllerSha));
  const install = commands.slice(commands.indexOf('import-download\n'));
  for (const [id, triple] of Object.entries(AOT_TARGET_TRIPLES)) {
    assert.ok(commands.includes('--artifact\nliboliphaunt-wasix-runtime-aot-' + id + '\n'));
    assert.ok(install.includes('--target-triple\n' + triple + '\n'));
  }
});

test('SHA selection pins one successful run for all payload downloads', (t) => {
  const f = fixture(t);
  const result = spawnSync('bash', [script], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.commands(), new RegExp(`--commit\n${artifactSha}\n--status\nsuccess`));
  assert.equal(f.commands().split('--run-id\n777\n').length - 1, downloadCount);
});

test('failed artifact download never installs a partial runtime', (t) => {
  const f = fixture(t, { CI_RUN_ID: '77', DOWNLOAD_FAILURE: '17' });
  const result = spawnSync('bash', [script], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 17, result.stderr);
  assert.ok(!f.commands().includes('import-download'));
});

test('public release downloads verify checksums before unpacking or installing', (t) => {
  for (const corrupt of [false, true]) {
    const f = fixture(t);
    const bin = f.env.PATH.split(path.delimiter)[0];
    writeFileSync(
      path.join(bin, 'curl'),
      `#!/usr/bin/env bash
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output="$2"; shift ;; https://*) url="$1" ;; esac
  shift
done
case "$url" in
  *sha256)
    if command -v sha256sum >/dev/null; then digest="$(printf payload | sha256sum)"; else digest="$(printf payload | shasum -a 256)"; fi
    digest="\${digest%% *}"
    ${corrupt ? 'digest="' + '0'.repeat(64) + '"' : ''}
    for target in portable ${Object.keys(AOT_TARGET_TRIPLES)
      .map((id) => 'aot-' + id)
      .join(' ')}; do
      printf '%s  %s\\n' "$digest" "liboliphaunt-wasix-1.0.0-runtime-$target.tar.zst"
    done >"$output" ;;
  *) printf payload >"$output" ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      'bash',
      [
        'src/runtimes/liboliphaunt/wasix/tools/download-assets.sh',
        '--release',
        'liboliphaunt-wasix-v1.0.0',
        '--all-targets',
      ],
      { env: f.env, encoding: 'utf8' },
    );
    if (corrupt) {
      assert.notEqual(result.status, 0);
      assert.ok(!f.commands().includes('unpack'));
      assert.ok(!f.commands().includes('import-download'));
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.commands().split('\nunpack\n').length - 1, downloadCount);
      assert.match(f.commands(), /import-download/);
    }
  }
});
