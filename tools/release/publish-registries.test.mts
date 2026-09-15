import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalPublicationSchedule } from './normal-publication-executor.mts';

const [mode, root, scenario] = process.argv.slice(2);
if (mode === 'prepare') {
  const operations = ['cargo', 'npm', 'cargo', 'maven', 'npm'].map((ecosystem, operationOrder) => ({
    id: `op${operationOrder}`,
    ecosystem,
    operationOrder,
    dependencies: [[], ['op0'], ['op1'], ['op1'], ['op2', 'op3']][operationOrder],
    ...(ecosystem === 'maven'
      ? { kind: 'maven-atomic-deployment', carrierIds: ['maven:fixture'] }
      : { kind: 'carrier', carrierId: `${ecosystem}:fixture-${operationOrder}` }),
  }));
  const plan = { operations };
  writeFileSync(
    path.join(root, 'plan.json'),
    JSON.stringify({ plan, schedule: normalPublicationSchedule(plan) }),
  );
} else if (mode === 'assert') {
  const events = readFileSync(path.join(root, `events-${scenario}`), 'utf8')
    .trim()
    .split('\n');
  assert(events.indexOf('cargo-0') < events.indexOf('npm-before-1'));
  assert(events.indexOf('npm-reconciled-1') < events.indexOf('maven-start'));
  assert(events.indexOf('maven-start') < events.indexOf('cargo-drained'));
  assert(events.includes('cargo-drained'));
  assert.equal(events.includes('npm-before-4'), scenario === 'success');
  assert.equal(events.includes('finish'), scenario === 'success');
  assert.equal(
    events.filter((event) => event === 'npm-push').length,
    scenario === 'success' ? 2 : 1,
  );
} else throw Error('expected prepare or assert');
