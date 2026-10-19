import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dir, '../..');
const yaml = (file) => Bun.YAML.parse(readFileSync(path.join(root, file), 'utf8'));
const workflow = yaml('.github/workflows/ci.yml');
const common = 'source src/wasix/postmaster/lib/common.sh\n';

test('the shared builder label satisfies Postmaster without a second Docker build', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-builder-cache-'));
  try {
    const action = yaml('.github/actions/setup-wasix-builder/action.yml');
    const output = path.join(scratch, 'output');
    execFileSync('bash', ['-eu', '-c', action.runs.steps[0].run], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    const recipe = readFileSync(output, 'utf8').trim().split('=')[1];
    assert.match(recipe, /^[a-f0-9]{64}$/u);
    const build = action.runs.steps.find(({ uses }) =>
      uses?.startsWith('docker/build-push-action@'),
    );
    const label = build.with.labels.replace('${{ steps.recipe.outputs.sha256 }}', recipe);
    const docker = path.join(scratch, 'docker');
    // A cache hit may inspect the image, but must not invoke Docker build.
    writeFileSync(
      docker,
      `#!/usr/bin/env bash
set -eu
test "$1 $2" = 'image inspect'
test "$4" = '{{ index .Config.Labels "dev.oliphaunt.wasix-builder.recipe-sha256" }}'
test "$5" = "$EXPECTED_IMAGE"
test "\${BUILDER_LABEL%%=*}" = dev.oliphaunt.wasix-builder.recipe-sha256
printf '%s\\n' "\${BUILDER_LABEL#*=}"
`,
      { mode: 0o755 },
    );
    const image = execFileSync(
      'bash',
      ['-eu', '-c', `${common}printf '%s' "$FRESH_WASIX_DOCKER_IMAGE"`],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.ok(build.with.tags.trim().split('\n').includes(image));
    execFileSync(
      'bash',
      [
        '-eu',
        '-c',
        `${common}fresh_docker_bin() { printf '%s' "$FAKE_DOCKER"; }; fresh_ensure_docker_image`,
      ],
      {
        cwd: root,
        env: { ...process.env, FAKE_DOCKER: docker, BUILDER_LABEL: label, EXPECTED_IMAGE: image },
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Postmaster caches Cargo target directories without cleaning their shared parent', () => {
  const targets = execFileSync(
    'bash',
    [
      '-eu',
      '-c',
      `${common}printf '%s\\n' "$FRESH_WORK_ROOT/runtime/wasmer/target" "$FRESH_POSTMASTER_EXECUTOR_TARGET_DIR" "$FRESH_POSTMASTER_COMPILER_TARGET_DIR"`,
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  for (const id of ['wasix-postmaster-portable', 'wasix-postmaster-target']) {
    const steps = workflow.jobs[id].steps;
    const rustIndex = steps.findIndex(({ uses }) => uses === './.github/actions/setup-rust');
    const mappings = steps[rustIndex].with['cache-workspaces']
      .trim()
      .split('\n')
      .map((line) => {
        const [workspace, target] = line.split('->').map((part) => part.trim());
        return {
          workspace: path.resolve(root, workspace),
          target: path.resolve(root, workspace, target),
        };
      });
    for (const target of targets)
      assert.ok(
        mappings.some((mapping) => mapping.target === target),
        `${id}: missing ${target}`,
      );
    for (const a of mappings) {
      for (const b of mappings) {
        if (a !== b)
          assert.ok(
            !b.target.startsWith(`${a.target}${path.sep}`),
            'a parent Cargo cleanup would delete the nested cache',
          );
      }
    }
    for (const { workspace } of mappings)
      assert.ok(readFileSync(path.join(workspace, 'Cargo.toml'), 'utf8'));
  }
});

test('Cargo cache metadata needs no generated Wasmer checkout at restore time', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-cache-workspace-'));
  try {
    const executor = path.join(root, 'src/wasix/postmaster/executor');
    for (const entry of ['Cargo.toml', 'Cargo.lock', 'src'])
      cpSync(path.join(executor, entry), path.join(scratch, entry), { recursive: true });
    const lock = readFileSync(path.join(scratch, 'Cargo.lock'), 'utf8');
    // rust-cache collects workspace members without dependency resolution on restore.
    const metadata = JSON.parse(
      execFileSync('cargo', ['metadata', '--all-features', '--no-deps', '--format-version', '1'], {
        cwd: scratch,
        encoding: 'utf8',
      }),
    );
    assert.equal(metadata.workspace_members.length, 1);
    assert.equal(readFileSync(path.join(scratch, 'Cargo.lock'), 'utf8'), lock);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Rust setup follows the repository pin and rejects an unpinned override', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-rust-pin-'));
  try {
    const step = yaml('.github/actions/setup-rust-tools/action.yml').runs.steps.find(
      ({ id }) => id === 'toolchain',
    );
    const output = path.join(scratch, 'output');
    writeFileSync(path.join(scratch, 'rust-toolchain.toml'), '[toolchain]\nchannel = "9.8.7"\n');
    const run = (version) =>
      execFileSync('bash', ['-eu', '-c', step.run], {
        cwd: scratch,
        env: { ...process.env, TOOLCHAIN_INPUT: version, GITHUB_OUTPUT: output },
        stdio: 'pipe',
      });
    run('');
    assert.equal(readFileSync(output, 'utf8'), 'version=9.8.7\n');
    run('1.99.0');
    assert.match(readFileSync(output, 'utf8'), /version=1[.]99[.]0/u);
    assert.throws(() => run('stable'), /expected a pinned Rust version/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
