#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WRITER = path.join(ROOT, '.github/scripts/write-affected-moon-target-matrices.sh');

test('affected matrix preserves task capabilities and stops on failed or truncated Moon output', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-affected-matrices-'));
  try {
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
    const query = path.join(root, 'query.json');
    const graph = path.join(root, 'graph.json');
    const log = path.join(root, 'commands');
    const output = path.join(root, 'github-output');
    const stub = path.join(root, 'moon');
    const version = readFileSync(path.join(ROOT, '.prototools'), 'utf8').match(
      /^moon\s*=\s*"([^"]+)"/mu,
    )[1];
    writeFileSync(query, JSON.stringify({ tasks: { alpha: tasks } }));
    writeFileSync(graph, JSON.stringify({ data: { ...tasks, internal } }));
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$QUERY_LOG"
case "$1" in
  --version) printf 'moon %s\\n' "$QUERY_VERSION" ;;
  query)
    if read -r unexpected; then echo "query inherited stdin: $unexpected" >&2; exit 2; fi
    cat "$QUERY_FILE"; exit "\${QUERY_EXIT:-0}" ;;
  task-graph) cat "$QUERY_GRAPH" ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(stub, 0o755);
    const invoke = (extra = {}) => {
      rmSync(output, { force: true });
      rmSync(log, { force: true });
      return spawnSync('bash', [WRITER], {
        cwd: ROOT,
        encoding: 'utf8',
        input: 'caller input must not replace the requested commit range\n',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          MOON_BIN: stub,
          MOON_BASE: '',
          MOON_HEAD: '',
          QUERY_FILE: query,
          QUERY_GRAPH: graph,
          QUERY_LOG: log,
          QUERY_VERSION: version,
          QUERY_EXIT: '0',
          ...extra,
        },
      });
    };
    let result = invoke({ MOON_BASE: 'base', MOON_HEAD: 'head' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      '--version',
      'query tasks --affected --upstream none --downstream direct',
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
    assert.equal(values.get('check_count'), '2');
    assert.equal(values.get('test_count'), '2');
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

    result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(log, 'utf8').includes('\nquery tasks\n'));
    result = invoke({ QUERY_EXIT: '7' });
    assert.equal(result.status, 7);
    assert.equal(readFileSync(log, 'utf8').includes('task-graph'), false);
    writeFileSync(query, '{"tasks":');
    result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /returned invalid JSON/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
