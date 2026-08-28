import { describe, expect, test } from 'bun:test'

import {
  CLASSIFICATION,
  OPERATIONS,
  createPairSummary,
  renderMarkdown,
  validateRun,
} from './summarize.mjs'

function operation(name, scale = 1) {
  return {
    operation: name,
    samples: 10,
    totalMicros: 100 * scale,
    meanMicros: 10 * scale,
    operationsPerSecond: 100_000 / scale,
    minMicros: 5 * scale,
    p50Micros: 9 * scale,
    p95Micros: 14 * scale,
    p99Micros: 16 * scale,
    maxMicros: 18 * scale,
  }
}

function run(runtime, api, scale = 1) {
  const placement = {
    native: {
      sync: ['blocking', 'liboliphaunt-backend-thread', 'none'],
      async: [
        'awaited',
        'sdk-owner-thread-plus-liboliphaunt-backend-thread',
        'one-owner-fifo',
      ],
    },
    wasix: {
      sync: ['blocking', 'caller-thread', 'none'],
      async: ['awaited', 'sdk-owner-thread', 'one-owner-fifo'],
    },
  }[runtime][api]
  return {
    schema: 'oliphaunt.rust-api-model-run.v1',
    classification: CLASSIFICATION,
    releaseEvidence: false,
    runtime,
    api,
    callingContract: placement[0],
    executionOwner: placement[1],
    sdkQueue: placement[2],
    topology: 'direct',
    processModel: 'one-api-model-per-process',
    sql: 'SELECT 1::text AS value',
    iterations: 10,
    warmupIterations: 2,
    openMicros: 1_000 * scale,
    closeMicros: 100 * scale,
    operations: OPERATIONS.map((name) => operation(name, scale)),
  }
}

describe('Rust API model diagnostic summary', () => {
  for (const runtime of ['native', 'wasix']) {
    test(`validates and pairs explicit ${runtime} sync/async placement`, () => {
      const summary = createPairSummary(
        run(runtime, 'sync'),
        run(runtime, 'async', 1.5),
        runtime,
        '2026-08-28T00:00:00.000Z',
      )
      expect(summary.classification).toBe('diagnostic-only')
      expect(summary.releaseEvidence).toBe(false)
      expect(summary.ratios['query-select-1'].meanAsyncOverSync).toBe(1.5)
      expect(summary.methodology.startupIncludedInOperationSamples).toBe(false)
      expect(renderMarkdown(summary)).toContain(
        'This report is not release evidence and does not participate in performance gates.',
      )
    })
  }

  test('rejects release-evidence relabeling and execution-owner drift', () => {
    const mislabeled = run('native', 'sync')
    mislabeled.releaseEvidence = true
    expect(() => validateRun(mislabeled, 'native', 'sync')).toThrow('diagnostic-only')

    const wrongOwner = run('wasix', 'async')
    wrongOwner.executionOwner = 'caller-thread'
    expect(() => validateRun(wrongOwner, 'wasix', 'async')).toThrow(
      'executionOwner must be sdk-owner-thread',
    )
  })

  test('rejects incomparable pairs and malformed samples', () => {
    const asyncRun = run('native', 'async')
    asyncRun.iterations = 11
    expect(() =>
      createPairSummary(run('native', 'sync'), asyncRun, 'native'),
    ).toThrow('samples must equal iterations')

    const malformed = run('native', 'sync')
    malformed.operations[0].p50Micros = 20
    expect(() => validateRun(malformed, 'native', 'sync')).toThrow(
      'percentiles are not monotonic',
    )
  })
})
