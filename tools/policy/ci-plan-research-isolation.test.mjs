import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';

import {captureCommandOutput} from '../dev/capture-command-output.mjs';
import {moonCommand} from '../dev/moon-command.mjs';
import {affectedNames, triggeringProjectNames} from '../graph/affected.mjs';
import {planJobsForAffected} from '../graph/ci_plan.mjs';
import {buildPlan, loadGraph, normalizeFiles} from '../release/release-graph.mjs';

const ROOT = path.resolve(import.meta.dir, '../..');

function directEffects(relativePath) {
  const environment = {...process.env, MOON_CACHE: 'off'};
  delete environment.MOON_BASE;
  delete environment.MOON_HEAD;
  const result = captureCommandOutput(
    moonCommand(environment),
    ['query', 'affected', 'stdin', '--upstream', 'none', '--downstream', 'none'],
    {
      cwd: ROOT,
      env: environment,
      input: `${relativePath}\n`,
      label: `moon research-isolation fixture ${relativePath}`,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const affected = JSON.parse(result.stdout);
  const projects = triggeringProjectNames(affected.projects);
  const tasks = affectedNames(affected.tasks);
  const jobs = [...planJobsForAffected(new Set(projects), new Set(tasks))].sort();
  return {projects, tasks, jobs};
}

function assertResearchIsolation(relativePath) {
  const effects = directEffects(relativePath);
  assert.equal(effects.projects.includes('liboliphaunt-wasix-postmaster'), true);
  assert.deepEqual(effects.jobs, ['affected']);
  assert.equal(
    effects.tasks.some((task) => task.startsWith('liboliphaunt-wasix:')),
    false,
  );

  const releasePlan = buildPlan(
    loadGraph('ci-plan-research-isolation.test.mjs'),
    normalizeFiles([relativePath]),
    'ci-plan-research-isolation.test.mjs',
  );
  assert.equal(releasePlan.hasReleaseChanges, false);
  assert.deepEqual(releasePlan.releaseProducts, []);
}

test('research source pins never select production builders or releases', () => {
  assertResearchIsolation('src/sources/third-party/wasix-postmaster/wasmer.toml');
});

test('research runtime changes never select production builders or releases', () => {
  assertResearchIsolation(
    'src/runtimes/liboliphaunt/wasix-postmaster/runtime/capabilities.tsv',
  );
});
