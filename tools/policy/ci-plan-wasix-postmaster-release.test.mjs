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
      label: `moon WASIX postmaster release fixture ${relativePath}`,
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

function assertReleaseSelection(relativePath) {
  const effects = directEffects(relativePath);
  assert.equal(effects.projects.includes('liboliphaunt-wasix-postmaster'), true);
  assert.equal(effects.jobs.includes('wasix-postmaster'), true);

  const releasePlan = buildPlan(
    loadGraph('ci-plan-wasix-postmaster-release.test.mjs'),
    normalizeFiles([relativePath]),
    'ci-plan-wasix-postmaster-release.test.mjs',
  );
  assert.equal(releasePlan.hasReleaseChanges, true);
  assert.equal(
    releasePlan.releaseProducts.includes('liboliphaunt-wasix-postmaster'),
    true,
  );
}

test('postmaster source pins select its production builder and release', () => {
  assertReleaseSelection('src/sources/third-party/wasix-postmaster/wasmer.toml');
});

test('postmaster runtime changes select its production builder and release', () => {
  assertReleaseSelection(
    'src/runtimes/liboliphaunt/wasix-postmaster/runtime/capabilities.tsv',
  );
});
