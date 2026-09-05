#!/usr/bin/env bun

import assert from 'node:assert/strict';
import test from 'node:test';

import { coveragePolicyWarnings } from './coverage.mjs';

const config = { line_threshold: 80, per_file_line_warning: 50 };
const summary = {
  covered_lines: 80,
  total_lines: 100,
  line_coverage: 80,
  files: [
    { path: 'src/healthy.rs', covered_lines: 76, total_lines: 80 },
    { path: 'src/storage.rs', covered_lines: 4, total_lines: 20 },
  ],
};

test('low per-file coverage warns while low overall and missing evidence fail', () => {
  assert.deepEqual(coveragePolicyWarnings('sdk', summary, config), [
    'sdk: src/storage.rs line coverage 20.00% is below advisory 50.00%',
  ]);
  assert.throws(
    () => coveragePolicyWarnings('sdk', { ...summary, covered_lines: 79, line_coverage: 79 }, config),
    /below threshold/u,
  );
  assert.throws(
    () => coveragePolicyWarnings('sdk', { ...summary, files: [] }, config),
    /no measured source files/u,
  );
});
