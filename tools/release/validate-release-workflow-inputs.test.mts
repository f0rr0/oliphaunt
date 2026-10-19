import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dir, '../..');
test('publication scopes tag planning to the verified Release Please candidate', () => {
  const { steps } = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  ).jobs['plan-candidate'];
  const identity = steps.findIndex((step) => step.id === 'release_scope');
  const plan = steps.findIndex((step) => step.id === 'release_plan');
  assert.ok(identity >= 0 && identity < plan);
  assert.match(steps[identity].run, /--derive-products/u);
  assert.equal(steps[plan].env.PRODUCTS_JSON, `\${{ steps.release_scope.outputs.products_json }}`);
  assert.match(steps[plan].run, /--products-json "\$PRODUCTS_JSON"/u);
  const proof = steps.findIndex((step) => step.id === 'verify_publication_candidate');
  assert.ok(proof > plan);
  assert.equal(steps[proof].env.PRODUCTS_JSON, `\${{ steps.release_plan.outputs.products_json }}`);
});
test('registry bootstrap remains eligible when qualification dispatch was skipped', () => {
  const { jobs } = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  assert.ok(jobs['prepare-candidate'].needs.includes('request-qualification'));
  const bootstrap = jobs['publish-bootstrap'];
  assert.ok(bootstrap.needs.includes('prepare-candidate'));
  assert.match(bootstrap.if, /!cancelled\(\)/u);
  assert.match(bootstrap.if, /needs\.prepare-candidate\.result == 'success'/u);
  assert.match(bootstrap.if, /needs\.prepare-candidate\.outputs\.bootstrap_required == 'true'/u);
});
test('both npm publication jobs can generate required provenance', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  for (const job of ['publish', 'publish-bootstrap']) {
    assert.equal(
      workflow.jobs[job].permissions['id-token'],
      'write',
      `${job} requires OIDC for npm --provenance even with token authentication`,
    );
  }
});
test('qualified recovery packages the original source and restores its checked controller', () => {
  const { jobs } = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  const steps = jobs['prepare-candidate'].steps;
  const checkout = steps.findIndex(
    (step) => step.name === 'Checkout qualified source for unchanged packaging',
  );
  const registry = steps.findIndex((step) => step.id === 'validate_release_registry_state');
  const pack = steps.findIndex((step) => step.name === 'Package public release carriers');
  const freeze = steps.findIndex((step) => step.id === 'freeze_publication_candidate');
  const restore = steps.findIndex((step) => step.name === 'Restore checked publication controller');
  const credentials = steps.findIndex((step) => step.id === 'bootstrap_credentials');
  assert.ok(
    registry < checkout &&
      checkout < pack &&
      pack < freeze &&
      freeze < restore &&
      restore < credentials,
  );
  for (const index of [checkout, restore])
    assert.equal(steps[index].if, `\${{ inputs.qualification_run_id != '' }}`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-qualified-recovery-'));
  const run = (command, args, env = {}) =>
    spawnSync(command, args, {
      cwd: scratch,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const shell = (script, env) => run('bash', ['-euo', 'pipefail', '-c', script], env);
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', scratch);
    for (const file of [
      'tools/release/publication-controller.sh',
      'tools/release/publication-controller.mts',
      'tools/release/qualified-release-replay.sh',
      '.github/scripts/require-current-main.sh',
    ]) {
      mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
      cpSync(path.join(ROOT, file), path.join(scratch, file));
    }
    writeFileSync(path.join(scratch, '.gitignore'), 'target/\n');
    writeFileSync(path.join(scratch, 'product'), 'qualified product bytes');
    writeFileSync(
      path.join(scratch, '.github/scripts/require-workflow-success.sh'),
      'printf "%s\\n" "$2" > target/checked-controller\nexit "${FIXTURE_CI_STATUS:-0}"\n',
    );
    git('add', '.');
    git('commit', '-qm', 'source');
    const source = git('rev-parse', 'HEAD');
    writeFileSync(
      path.join(scratch, 'tools/release/check_release_versions.mts'),
      '// corrected registry validation\n',
    );
    git('add', '.');
    git('commit', '-qm', 'controller');
    const controller = git('rev-parse', 'HEAD');
    const env = { GITHUB_SHA: controller, GITHUB_REF: 'refs/heads/main', RELEASE_HEAD_SHA: source };
    mkdirSync(path.join(scratch, 'target'));
    writeFileSync(path.join(scratch, 'target/producer'), 'qualified binary');
    const guard = jobs['plan-candidate'].steps.find(
      (step) => step.name === 'Require unpublished recovery source and checked current controller',
    );
    let result = shell(guard.run, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(path.join(scratch, 'target/checked-controller'), 'utf8').trim(),
      controller,
    );
    result = shell(guard.run, { ...env, FIXTURE_CI_STATUS: '1' });
    assert.notEqual(result.status, 0, 'unchecked controller must be rejected');
    git('update-ref', 'refs/heads/main', source);
    result = shell(guard.run, env);
    assert.notEqual(result.status, 0, 'controller must still be current main');
    git('update-ref', 'refs/heads/main', controller);
    git('tag', `oliphaunt-release-transport/${source}`, source);
    result = shell(guard.run, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recover with approval_run_id/u);
    git('tag', '-d', `oliphaunt-release-transport/${source}`);
    git('remote', 'set-url', 'origin', path.join(scratch, 'missing-origin'));
    result = shell(guard.run, env);
    assert.notEqual(result.status, 0);
    git('remote', 'set-url', 'origin', scratch);
    result = shell(steps[checkout].run, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git('rev-parse', 'HEAD'), source);
    assert.equal(readFileSync(path.join(scratch, 'product'), 'utf8'), 'qualified product bytes');
    assert.equal(readFileSync(path.join(scratch, 'target/producer'), 'utf8'), 'qualified binary');
    result = shell(steps[restore].run, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git('rev-parse', 'HEAD'), controller);
    assert.match(
      readFileSync(path.join(scratch, 'tools/release/check_release_versions.mts'), 'utf8'),
      /corrected/u,
    );
    writeFileSync(path.join(scratch, 'product'), 'uncommitted source change');
    result = shell(steps[checkout].run, env);
    assert.notEqual(result.status, 0);
    assert.equal(git('rev-parse', 'HEAD'), controller);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
