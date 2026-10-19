import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrapPublicationSchedule } from './bootstrap-publication-plan.mts';

const [mode, root, scenario] = process.argv.slice(2);
if (mode === 'prepare') {
  const admittedPlan = Array.from({ length: 35 }, (_, index) => {
    const ecosystem = [1, 34].includes(index) ? 'npm' : 'cargo';
    const dependencies =
      index === 1
        ? ['cargo:p0']
        : index === 3
          ? ['npm:p1']
          : index >= 4
            ? [`cargo:p${index - 1}`]
            : [];
    return {
      id: `${ecosystem}:p${index}`,
      name: `p${index}`,
      ecosystem,
      publishOrder: index,
      dependencies,
    };
  });
  writeFileSync(
    path.join(root, 'plan.json'),
    JSON.stringify({ admittedPlan, dependencies: bootstrapPublicationSchedule(admittedPlan, []) }),
  );
} else if (mode === 'assert') {
  const events = readFileSync(path.join(root, `${scenario}.log`), 'utf8')
    .trim()
    .split('\n');
  assert(events.includes('cargo-drained'));
  const checkpoints = events.filter((event) => event.startsWith('checkpoint-'));
  if (scenario === 'success') {
    assert(checkpoints.length >= 2);
    assert.equal(checkpoints.at(-1), 'checkpoint-35');
  }
  if (['mutation-failure', 'authorization-failure', 'deferral'].includes(scenario)) {
    assert(!events.includes('cargo-3'));
    assert.equal(checkpoints.at(-1), 'checkpoint-2');
    assert(events.indexOf('cargo-drained') < events.indexOf('checkpoint-2'));
  }
  if (scenario === 'authorization-failure') {
    assert(!events.includes('npm-1'));
    assert(!events.includes('finish'));
    assert.equal(events.filter((event) => event === 'npm-publish').length, 1);
    const output = readFileSync(path.join(root, 'result'), 'utf8');
    assert(output.includes('npm error code E403'));
    assert(output.includes('npm publication authorization failed for @fixture/runtime@1.0.0'));
  }
  if (scenario === 'checkpoint-failure') {
    assert(checkpoints.length >= 2);
    assert(!events.includes('finish'));
  }
  if (scenario === 'deferral') {
    assert(events.includes('deferred'));
    assert(!events.includes('npm-publish'));
  }
} else throw Error('expected prepare or assert');
