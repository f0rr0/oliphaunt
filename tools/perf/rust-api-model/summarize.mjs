#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const RUN_SCHEMA = 'oliphaunt.rust-api-model-run.v1'
export const PAIR_SCHEMA = 'oliphaunt.rust-api-model-pair.v1'
export const CLASSIFICATION = 'diagnostic-only'
export const OPERATIONS = ['query-select-1', 'raw-simple-query-select-1']

const EXPECTED_PLACEMENT = {
  native: {
    sync: {
      callingContract: 'blocking',
      executionOwner: 'liboliphaunt-backend-thread',
      sdkQueue: 'none',
    },
    async: {
      callingContract: 'awaited',
      executionOwner: 'sdk-owner-thread-plus-liboliphaunt-backend-thread',
      sdkQueue: 'one-owner-fifo',
    },
  },
  wasix: {
    sync: {
      callingContract: 'blocking',
      executionOwner: 'caller-thread',
      sdkQueue: 'none',
    },
    async: {
      callingContract: 'awaited',
      executionOwner: 'sdk-owner-thread',
      sdkQueue: 'one-owner-fifo',
    },
  },
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' must be a non-empty string')
  }
  return value
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(label + ' must be a positive integer')
  }
  return value
}

function requireFinite(value, label, positive = false) {
  if (!Number.isFinite(value) || value < 0 || (positive && value <= 0)) {
    throw new Error(label + ' must be a ' + (positive ? 'positive' : 'non-negative') + ' number')
  }
  return value
}

function validateOperation(operation, label, iterations) {
  requireString(operation?.operation, label + '.operation')
  if (!OPERATIONS.includes(operation.operation)) {
    throw new Error(label + '.operation is unsupported: ' + operation.operation)
  }
  if (operation.samples !== iterations) {
    throw new Error(label + '.samples must equal iterations')
  }
  for (const field of [
    'totalMicros',
    'meanMicros',
    'operationsPerSecond',
    'minMicros',
    'p50Micros',
    'p95Micros',
    'p99Micros',
    'maxMicros',
  ]) {
    requireFinite(operation[field], label + '.' + field, true)
  }
  if (
    !(
      operation.minMicros <= operation.p50Micros &&
      operation.p50Micros <= operation.p95Micros &&
      operation.p95Micros <= operation.p99Micros &&
      operation.p99Micros <= operation.maxMicros
    )
  ) {
    throw new Error(label + ' percentiles are not monotonic')
  }
  return operation
}

export function validateRun(run, runtime, api) {
  if (run?.schema !== RUN_SCHEMA) {
    throw new Error(api + ' run schema must be ' + RUN_SCHEMA)
  }
  if (run.classification !== CLASSIFICATION || run.releaseEvidence !== false) {
    throw new Error(api + ' run must be diagnostic-only and releaseEvidence=false')
  }
  if (run.runtime !== runtime || run.api !== api) {
    throw new Error(api + ' run labels do not match ' + runtime + '/' + api)
  }
  if (run.topology !== 'direct' || run.processModel !== 'one-api-model-per-process') {
    throw new Error(api + ' run must use direct topology in its own process')
  }
  if (run.sql !== 'SELECT 1::text AS value') {
    throw new Error(api + ' run SQL changed unexpectedly')
  }
  const placement = EXPECTED_PLACEMENT[runtime]?.[api]
  if (!placement) {
    throw new Error('unsupported runtime/API pair ' + runtime + '/' + api)
  }
  for (const [field, expected] of Object.entries(placement)) {
    if (run[field] !== expected) {
      throw new Error(api + ' run ' + field + ' must be ' + expected)
    }
  }
  requirePositiveInteger(run.iterations, api + '.iterations')
  requirePositiveInteger(run.warmupIterations, api + '.warmupIterations')
  requireFinite(run.openMicros, api + '.openMicros')
  requireFinite(run.closeMicros, api + '.closeMicros')
  if (!Array.isArray(run.operations) || run.operations.length !== OPERATIONS.length) {
    throw new Error(api + ' run must contain exactly ' + OPERATIONS.length + ' operations')
  }
  const byOperation = Object.fromEntries(
    run.operations.map((operation, index) => [
      operation.operation,
      validateOperation(operation, api + '.operations[' + index + ']', run.iterations),
    ]),
  )
  if (Object.keys(byOperation).length !== OPERATIONS.length) {
    throw new Error(api + ' run contains duplicate operations')
  }
  for (const operation of OPERATIONS) {
    if (!byOperation[operation]) {
      throw new Error(api + ' run is missing ' + operation)
    }
  }
  return { run, byOperation }
}

export function createPairSummary(syncRun, asyncRun, runtime, generatedAt = new Date().toISOString()) {
  if (!['native', 'wasix'].includes(runtime)) {
    throw new Error('unsupported runtime ' + runtime)
  }
  const sync = validateRun(syncRun, runtime, 'sync')
  const async = validateRun(asyncRun, runtime, 'async')
  for (const field of ['iterations', 'warmupIterations', 'sql']) {
    if (syncRun[field] !== asyncRun[field]) {
      throw new Error('paired runs must use the same ' + field)
    }
  }

  const ratios = Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      {
        meanAsyncOverSync:
          async.byOperation[operation].meanMicros / sync.byOperation[operation].meanMicros,
        p50AsyncOverSync:
          async.byOperation[operation].p50Micros / sync.byOperation[operation].p50Micros,
        p95AsyncOverSync:
          async.byOperation[operation].p95Micros / sync.byOperation[operation].p95Micros,
        p99AsyncOverSync:
          async.byOperation[operation].p99Micros / sync.byOperation[operation].p99Micros,
      },
    ]),
  )

  return {
    schema: PAIR_SCHEMA,
    classification: CLASSIFICATION,
    releaseEvidence: false,
    runtime,
    topology: 'direct',
    generatedAt,
    methodology: {
      processModel: 'separate-process-per-api-model',
      startupIncludedInOperationSamples: false,
      validationIncludedInOperationSamples: false,
      concurrency: 'one-sequential-awaited-operation-at-a-time',
      sql: syncRun.sql,
      iterations: syncRun.iterations,
      warmupIterations: syncRun.warmupIterations,
    },
    runs: {
      sync: sync.run,
      async: async.run,
    },
    ratios,
  }
}

function fixed(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

export function renderMarkdown(summary) {
  const lines = [
    '# Rust ' + summary.runtime.toUpperCase() + ' sync-versus-async diagnostic',
    '',
    '> Diagnostic only. This report is not release evidence and does not participate in performance gates.',
    '',
    '- Runtime: ' + summary.runtime,
    '- Topology: direct',
    '- SQL: ' + summary.methodology.sql,
    '- Measured iterations per operation: ' + summary.methodology.iterations,
    '- Warmup iterations per operation: ' + summary.methodology.warmupIterations,
    '- Process model: one fresh process per API model',
    '- Open and close are reported separately and excluded from operation samples',
    '- Each measured call is sequential; this does not measure concurrent throughput',
    '',
    '| API | Calling contract | Execution owner | Open us | Close us |',
    '| --- | --- | --- | ---: | ---: |',
  ]
  for (const api of ['sync', 'async']) {
    const run = summary.runs[api]
    lines.push(
      '| ' +
        api +
        ' | ' +
        run.callingContract +
        ' | ' +
        run.executionOwner +
        ' | ' +
        fixed(run.openMicros) +
        ' | ' +
        fixed(run.closeMicros) +
        ' |',
    )
  }

  lines.push(
    '',
    '| Operation | API | mean us | p50 us | p95 us | p99 us | ops/s | async/sync mean |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const operation of OPERATIONS) {
    for (const api of ['sync', 'async']) {
      const result = summary.runs[api].operations.find((item) => item.operation === operation)
      const ratio =
        api === 'async' ? fixed(summary.ratios[operation].meanAsyncOverSync) + 'x' : '—'
      lines.push(
        '| ' +
          operation +
          ' | ' +
          api +
          ' | ' +
          fixed(result.meanMicros) +
          ' | ' +
          fixed(result.p50Micros) +
          ' | ' +
          fixed(result.p95Micros) +
          ' | ' +
          fixed(result.p99Micros) +
          ' | ' +
          fixed(result.operationsPerSecond, 1) +
          ' | ' +
          ratio +
          ' |',
      )
    }
  }
  lines.push(
    '',
    'The async/sync ratio includes the public async admission, owner-FIFO dispatch, wakeup, and reply path. It is not a claim about runtime topology, database concurrency, or application-level throughput.',
    '',
  )
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      throw new Error('unexpected argument ' + key)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(key + ' requires a value')
    }
    args[key] = value
    index += 1
  }
  return args
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runtime = requireString(args['--runtime'], '--runtime')
  const syncPath = path.resolve(requireString(args['--sync'], '--sync'))
  const asyncPath = path.resolve(requireString(args['--async'], '--async'))
  const outputDir = path.resolve(requireString(args['--output-dir'], '--output-dir'))
  const summary = createPairSummary(
    await readJson(syncPath),
    await readJson(asyncPath),
    runtime,
  )
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(
    path.join(outputDir, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  )
  await fs.writeFile(path.join(outputDir, 'report.md'), renderMarkdown(summary))
  console.log(path.join(outputDir, 'report.md'))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
