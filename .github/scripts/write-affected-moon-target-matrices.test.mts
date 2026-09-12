#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [phase, root] = process.argv.slice(2);
assert.ok(root);
if (phase === 'prepare') {
  const tasks = Object.fromEntries(
    [
      ['compile', ['quality', 'static'], {}],
      ['smoke', ['quality', 'smoke'], {}],
      ['unit', ['quality', 'unit'], {}],
      ['coverage', ['coverage'], {}],
      ['local-unit', ['quality', 'unit'], { runInCI: false }],
      ['skipped-unit', ['quality', 'unit'], { runInCI: 'skip' }],
    ].map(([id, tags, options]) => [
      id,
      {
        id,
        tags,
        options,
        target: `alpha:${id}`,
        command: 'node',
        args: [`${id}.mts`],
        deps: id === 'unit' ? [{ target: 'alpha:internal' }] : [],
      },
    ]),
  );
  const internal = {
    target: 'alpha:internal',
    command: 'cargo',
    args: ['test'],
    deps: [],
    options: { internal: true },
    tags: ['requires-rust'],
  };
  tasks.format = {
    target: 'release-tools:format-check',
    command: 'bunx',
    args: ['biome', 'format', '.'],
    tags: ['quality', 'format'],
  };
  tasks.extension = {
    target: 'alpha:extension',
    command: 'bash',
    args: ['extensions/tools/check-extension-example.sh'],
    tags: ['quality', 'static'],
  };
  tasks.policy = {
    target: 'alpha:policy',
    command: 'bun',
    args: ['check.mts'],
    tags: ['quality', 'static', 'policy'],
    deps: ['alpha:internal'],
  };

  writeFileSync(path.join(root, 'query.json'), JSON.stringify({ tasks: { alpha: tasks } }));
  writeFileSync(path.join(root, 'graph.json'), JSON.stringify({ data: { ...tasks, internal } }));
  writeFileSync(
    path.join(root, 'plan.json'),
    JSON.stringify({ qualification_mode: 'selected-products', tasks: ['alpha:unit'] }),
  );
  const version = readFileSync('.prototools', 'utf8').match(/^moon\s*=\s*"([^"]+)"/mu)?.[1];
  assert.ok(version);
  writeFileSync(path.join(root, 'version'), version);
} else if (phase === 'verify') {
  const log = path.join(root, 'commands');
  const output = path.join(root, 'github-output');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    '--version',
    'query tasks --affected --upstream none --downstream deep',
    'task-graph --json',
  ]);
  const values = new Map(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(values.get('check_count'), '4');
  assert.equal(values.get('test_count'), '2');
  const policies = JSON.parse(values.get('policy_matrix')).include;
  assert.deepEqual(
    policies.map(({ target }) => target),
    ['alpha:policy'],
  );
  assert.equal(policies[0].upstream, 'deep');
  assert.equal(policies[0].requires_rust, true);
  const groups = JSON.parse(values.get('test_matrix')).include;
  assert.deepEqual(
    groups
      .flatMap(({ targets_json }) => JSON.parse(targets_json).include.map(({ target }) => target))
      .sort(),
    ['alpha:coverage', 'alpha:unit'],
  );
  assert.equal(
    groups.find(({ targets_json }) => targets_json.includes('alpha:unit')).requires_rust,
    true,
  );
} else {
  throw new Error('unknown phase');
}
