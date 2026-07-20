#!/usr/bin/env bun

import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';

import {ROOT} from './release-graph.mjs';

const NODE_FALLBACK_PROCESS_TIMEOUT_MS = 15_000;

test('Node fallback downloads fail closed before cache promotion', () => {
  const script = path.join(
    ROOT,
    'src/runtimes/node-direct/tools/install-node-fallback.test.sh',
  );
  const result = spawnSync('bash', [script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: NODE_FALLBACK_PROCESS_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Node fallback fault suite failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
});
