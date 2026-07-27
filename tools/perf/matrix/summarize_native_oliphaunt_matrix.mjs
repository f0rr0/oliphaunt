import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      continue
    }
    const hasValue = index + 1 < argv.length
    const value = argv[index + 1]
    if (hasValue && !value.startsWith('--')) {
      args[key] = value
      index += 1
    } else {
      args[key] = 'true'
    }
  }
  return args
}

function requireArg(args, key) {
  const value = args[key]
  if (!value) {
    throw new Error(`${key} is required`)
  }
  return value
}

function boolValue(value) {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'boolean') {
    return value
  }
  return value === '1' || value === 'true'
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

function collectRun(report, suite, mode) {
  if (!report) {
    return null
  }
  return report.runs.find((entry) => entry.suite === suite && entry.mode === mode) ?? null
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function mean(values) {
  return values.length === 0 ? null : sum(values) / values.length
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.round((sorted.length - 1) * ratio)
  return sorted[index]
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null
  }
  return Number(value.toFixed(digits))
}

function fmtMsFromMicros(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value / 1000, 2)}`
}

function fmtSecFromMicros(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value / 1_000_000, 3)}`
}

function fmtMb(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value, 1)}`
}

function fmtSec(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value, 2)}`
}

function fmtBytes(value) {
  if (value === null || value === undefined) {
    return 'n/a'
  }
  if (value >= 1024 * 1024 * 1024) {
    return `${round(value / 1024 / 1024 / 1024, 2)} GB`
  }
  if (value >= 1024 * 1024) {
    return `${round(value / 1024 / 1024, 2)} MB`
  }
  if (value >= 1024) {
    return `${round(value / 1024, 2)} KB`
  }
  return `${value} B`
}

function shortSha(value) {
  return value ? value.slice(0, 12) : 'n/a'
}

function fmtRatio(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return 'n/a'
  }
  return `${round(value / baseline, 3)}x`
}

function fmtRate(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value, 1)}`
}

function fmtMbPerSec(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value / 1024 / 1024, 1)}`
}

function fmtMbFromBytes(value) {
  return value === null || value === undefined ? 'n/a' : `${round(value / 1024 / 1024, 2)}`
}

function ratioNumber(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return null
  }
  return value / baseline
}

function gateStatus(value, baseline, tolerance = 0.05) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) {
    return 'n/a'
  }
  return value <= baseline * (1 + tolerance) ? 'pass' : 'miss'
}

function gateStatusHigher(value, baseline, tolerance = 0.05) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) {
    return 'n/a'
  }
  return value >= baseline * (1 - tolerance) ? 'pass' : 'miss'
}

function speedTotalMicros(run) {
  return run ? sum(run.tests.map((test) => test.elapsedMicros)) : null
}

function benchmarkRunOperationCount(run) {
  return run ? sum(run.tests.map((test) => test.operationCount ?? 0)) : null
}

function benchmarkRunThroughputPerSecond(run) {
  const totalMicros = speedTotalMicros(run)
  const operationCount = benchmarkRunOperationCount(run)
  if (!Number.isFinite(totalMicros) || !Number.isFinite(operationCount) || totalMicros <= 0) {
    return null
  }
  return operationCount / (totalMicros / 1_000_000)
}

function bytesToMb(value) {
  return value === null || value === undefined ? null : value / 1024 / 1024
}

function rttSummary(run) {
  if (!run) {
    return null
  }
  const p50s = run.tests.map((test) => test.p50Micros).filter(Number.isFinite)
  const p90s = run.tests.map((test) => test.p90Micros).filter(Number.isFinite)
  const p95s = run.tests.map((test) => test.p95Micros).filter(Number.isFinite)
  const p99s = run.tests.map((test) => test.p99Micros).filter(Number.isFinite)
  return {
    openMicros: run.openMicros,
    connectMicros: run.connectMicros,
    setupMicros: run.setupMicros,
    medianP50Us: percentile(p50s, 0.5),
    medianP90Us: percentile(p90s, 0.5),
    medianP95Us: percentile(p95s, 0.5),
    medianP99Us: percentile(p99s, 0.5),
    maxP90Us: p90s.length ? Math.max(...p90s) : null,
    maxP99Us: p99s.length ? Math.max(...p99s) : null,
    observedServerPeakRssMb: bytesToMb(run.observedServerPeakRssBytes),
  }
}

function parseResource(text) {
  const resource = {
    realSec: null,
    userSec: null,
    sysSec: null,
    cpuSec: null,
    peakRssMb: null,
    peakFootprintMb: null,
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    let darwinMatch = line.match(
      /^([0-9.]+)\s+real\s+([0-9.]+)\s+user\s+([0-9.]+)\s+sys$/,
    )
    if (darwinMatch) {
      resource.realSec = Number(darwinMatch[1])
      resource.userSec = Number(darwinMatch[2])
      resource.sysSec = Number(darwinMatch[3])
      continue
    }
    let match = line.match(/^([0-9.]+)\s+real$/)
    if (match) {
      resource.realSec = Number(match[1])
      continue
    }
    match = line.match(/^([0-9.]+)\s+user$/)
    if (match) {
      resource.userSec = Number(match[1])
      continue
    }
    match = line.match(/^([0-9.]+)\s+sys$/)
    if (match) {
      resource.sysSec = Number(match[1])
      continue
    }
    match = line.match(/^([0-9]+)\s+maximum resident set size$/)
    if (match) {
      resource.peakRssMb = Number(match[1]) / 1024 / 1024
      continue
    }
    match = line.match(/^([0-9]+)\s+peak memory footprint$/)
    if (match) {
      resource.peakFootprintMb = Number(match[1]) / 1024 / 1024
      continue
    }
    match = line.match(/^Maximum resident set size .*:\s*([0-9]+)$/)
    if (match) {
      resource.peakRssMb = Number(match[1]) / 1024
    }
  }
  if (resource.userSec !== null || resource.sysSec !== null) {
    resource.cpuSec = (resource.userSec ?? 0) + (resource.sysSec ?? 0)
  }
  return resource
}

async function loadMeasuredRun(runDir, name) {
  const report = await readJsonIfExists(path.join(runDir, `${name}.json`))
  const resource = parseResource(await readTextIfExists(path.join(runDir, `${name}.resource.txt`)))
  return { report, resource }
}

async function loadFirstMeasuredRun(runDir, names) {
  let first = null
  for (const name of names) {
    const measurement = await loadMeasuredRun(runDir, name)
    if (!first) {
      first = measurement
    }
    if (measurement.report) {
      return measurement
    }
  }
  return first ?? { report: null, resource: parseResource('') }
}

async function loadRttRepeatMeasurements(runDir, prefix, mode) {
  const repeatDir = path.join(runDir, 'repeats')
  let entries = []
  try {
    entries = await fs.readdir(repeatDir)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  const files = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))
    .sort()
  const measurements = []
  for (const file of files) {
    const jsonPath = path.join(repeatDir, file)
    const report = await readJsonIfExists(jsonPath)
    const run = report?.runs?.find((entry) => entry.suite === 'rtt' && entry.mode === mode)
    if (run) {
      const resourcePath = jsonPath.replace(/\.json$/, '.resource.txt')
      const resource = parseResource(await readTextIfExists(resourcePath))
      measurements.push({ file, run, resource })
    }
  }
  return measurements
}

async function loadSpeedRepeatMeasurements(runDir, prefix) {
  return loadBenchmarkRepeatMeasurements(runDir, prefix, 'speed')
}

async function loadBackupRepeatMeasurements(runDir, prefix, mode = null) {
  return loadBenchmarkRepeatMeasurements(runDir, prefix, 'backup-restore', mode)
}

async function loadBenchmarkRepeatMeasurements(runDir, prefix, suite, mode = null) {
  const repeatDir = path.join(runDir, 'repeats')
  let entries = []
  try {
    entries = await fs.readdir(repeatDir)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  const files = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))
    .sort()
  const measurements = []
  for (const file of files) {
    const jsonPath = path.join(repeatDir, file)
    const report = await readJsonIfExists(jsonPath)
    const run = report?.runs?.find(
      (entry) => entry.suite === suite && (mode === null || entry.mode === mode),
    )
    if (run) {
      const resourcePath = jsonPath.replace(/\.json$/, '.resource.txt')
      const resource = parseResource(await readTextIfExists(resourcePath))
      measurements.push({ file, run, resource })
    }
  }
  return measurements
}

async function loadPreparedRepeatMeasurements(runDir, prefix) {
  const repeatDir = path.join(runDir, 'repeats')
  let entries = []
  try {
    entries = await fs.readdir(repeatDir)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  const files = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))
    .sort()
  const measurements = []
  for (const file of files) {
    const jsonPath = path.join(repeatDir, file)
    const report = await readJsonIfExists(jsonPath)
    if (report?.runs?.length) {
      const resourcePath = jsonPath.replace(/\.json$/, '.resource.txt')
      const resource = parseResource(await readTextIfExists(resourcePath))
      measurements.push({ file, report, resource })
    }
  }
  return measurements
}

function repeatedRttSummary(primaryRun, primaryResource, repeatMeasurements) {
  const runs = repeatMeasurements.length
    ? repeatMeasurements.map((measurement) => measurement.run)
    : primaryRun
      ? [primaryRun]
      : []
  const resources = repeatMeasurements.length
    ? repeatMeasurements.map((measurement) => measurement.resource)
    : primaryResource
      ? [primaryResource]
      : []
  const summaries = runs.map(rttSummary).filter(Boolean)
  const opens = summaries.map((summary) => summary.openMicros).filter(Number.isFinite)
  const connects = summaries.map((summary) => summary.connectMicros).filter(Number.isFinite)
  const medianP50s = summaries.map((summary) => summary.medianP50Us).filter(Number.isFinite)
  const medianP90s = summaries.map((summary) => summary.medianP90Us).filter(Number.isFinite)
  const medianP95s = summaries.map((summary) => summary.medianP95Us).filter(Number.isFinite)
  const medianP99s = summaries.map((summary) => summary.medianP99Us).filter(Number.isFinite)
  const maxP90s = summaries.map((summary) => summary.maxP90Us).filter(Number.isFinite)
  const maxP99s = summaries.map((summary) => summary.maxP99Us).filter(Number.isFinite)
  const rss = resources.map((resource) => resource.peakRssMb).filter(Number.isFinite)
  const cpus = resources.map((resource) => resource.cpuSec).filter(Number.isFinite)
  const observedServerRss = summaries
    .map((summary) => summary.observedServerPeakRssMb)
    .filter(Number.isFinite)
  return {
    n: runs.length,
    openMicros: percentile(opens, 0.5),
    openP90Micros: percentile(opens, 0.9),
    connectMicros: percentile(connects, 0.5),
    medianP50Us: percentile(medianP50s, 0.5),
    medianP90Us: percentile(medianP90s, 0.5),
    medianP95Us: percentile(medianP95s, 0.5),
    medianP99Us: percentile(medianP99s, 0.5),
    gateMedianP90Us: percentile(medianP90s, runs.length >= 10 ? 0.9 : 0.5),
    maxP90Us: maxP90s.length ? Math.max(...maxP90s) : null,
    maxP99Us: maxP99s.length ? Math.max(...maxP99s) : null,
    peakRssMb: percentile(rss, 0.9),
    observedServerPeakRssMb: percentile(observedServerRss, 0.9),
    cpuSec: percentile(cpus, 0.9),
  }
}

function repeatedSpeedSummary(primaryRun, primaryResource, repeatMeasurements) {
  const runs = repeatMeasurements.length
    ? repeatMeasurements.map((measurement) => measurement.run)
    : primaryRun
      ? [primaryRun]
      : []
  const resources = repeatMeasurements.length
    ? repeatMeasurements.map((measurement) => measurement.resource)
    : primaryResource
      ? [primaryResource]
      : []
  const totals = runs.map(speedTotalMicros)
  const finiteTotals = totals.filter(Number.isFinite)
  const throughputs = runs.map(benchmarkRunThroughputPerSecond).filter(Number.isFinite)
  const operationCounts = runs.map(benchmarkRunOperationCount).filter(Number.isFinite)
  const opens = runs.map((run) => run.openMicros).filter(Number.isFinite)
  const rss = resources.map((resource) => resource.peakRssMb).filter(Number.isFinite)
  const footprints = resources
    .map((resource) => resource.peakFootprintMb)
    .filter(Number.isFinite)
  const cpus = resources.map((resource) => resource.cpuSec).filter(Number.isFinite)
  const observedServerRss = runs
    .map((run) => bytesToMb(run.observedServerPeakRssBytes))
    .filter(Number.isFinite)
  const p90RssMb = percentile(rss, 0.9)
  const p90ObservedServerRssMb = percentile(observedServerRss, 0.9)
  const p99RssMb = percentile(rss, 0.99)
  const p99ObservedServerRssMb = percentile(observedServerRss, 0.99)
  return {
    n: runs.length,
    minTotalMicros: finiteTotals.length ? Math.min(...finiteTotals) : null,
    maxTotalMicros: finiteTotals.length ? Math.max(...finiteTotals) : null,
    p50TotalMicros: percentile(finiteTotals, 0.5),
    p90TotalMicros: percentile(finiteTotals, 0.9),
    p95TotalMicros: percentile(finiteTotals, 0.95),
    p99TotalMicros: percentile(finiteTotals, 0.99),
    p50OperationCount: percentile(operationCounts, 0.5),
    p90OperationCount: percentile(operationCounts, 0.9),
    p50ThroughputPerSecond: percentile(throughputs, 0.5),
    tailP10ThroughputPerSecond: percentile(throughputs, 0.1),
    p50OpenMicros: percentile(opens, 0.5),
    p90OpenMicros: percentile(opens, 0.9),
    p99OpenMicros: percentile(opens, 0.99),
    p90RssMb,
    p90ObservedServerRssMb,
    p90MemoryBaselineRssMb: Math.max(p90RssMb ?? 0, p90ObservedServerRssMb ?? 0) || null,
    p99RssMb,
    p99ObservedServerRssMb,
    p99MemoryBaselineRssMb: Math.max(p99RssMb ?? 0, p99ObservedServerRssMb ?? 0) || null,
    p90FootprintMb: percentile(footprints, 0.9),
    p99FootprintMb: percentile(footprints, 0.99),
    p90CpuSec: percentile(cpus, 0.9),
    p99CpuSec: percentile(cpus, 0.99),
  }
}

function runQuality(summary) {
  if (!summary || summary.n === 0 || !Number.isFinite(summary.p50TotalMicros)) {
    return { status: 'n/a', reason: 'missing speed measurements' }
  }
  if (summary.n < 10) {
    return { status: 'insufficient', reason: 'fewer than ten fresh-process repeats' }
  }
  if (summary.n < 20) {
    return { status: 'insufficient', reason: 'fewer than twenty repeats; tail quality is not release-grade' }
  }
  const p90ToP50 = ratioNumber(summary.p90TotalMicros, summary.p50TotalMicros)
  const p95ToP50 = ratioNumber(summary.p95TotalMicros, summary.p50TotalMicros)
  const p99ToP50 = ratioNumber(summary.p99TotalMicros, summary.p50TotalMicros)
  if ((p90ToP50 ?? 0) > 1.2 || (p95ToP50 ?? 0) > 1.3 || (p99ToP50 ?? 0) > 1.5) {
    return { status: 'noisy', reason: 'tail spread is too high for release parity claims' }
  }
  if ((p90ToP50 ?? 0) > 1.12 || (p95ToP50 ?? 0) > 1.2 || (p99ToP50 ?? 0) > 1.35) {
    return { status: 'watch', reason: 'tail spread is elevated; repeat on an idle host' }
  }
  return { status: 'stable', reason: 'tail spread is within release-evidence bounds' }
}

function speedCaseRows(modes) {
  const base = modes.find((mode) => mode.run)?.run
  if (!base) {
    return []
  }
  return base.tests.map((test) => {
    const values = modes.map((mode) => {
      if (mode.repeats.length > 0) {
        const repeatedValues = mode.repeats
          .map((measurement) =>
            measurement.run.tests.find((candidate) => candidate.id === test.id)?.elapsedMicros,
          )
          .filter(Number.isFinite)
        return fmtMsFromMicros(percentile(repeatedValues, 0.9))
      }
      const match = mode.run?.tests.find((candidate) => candidate.id === test.id)
      return fmtMsFromMicros(match?.elapsedMicros)
    })
    return `| ${test.id} | ${test.label} | ${values.join(' | ')} |`
  })
}

function speedCaseMicros(mode, testId) {
  if (mode.repeats.length > 0) {
    const repeatedValues = mode.repeats
      .map((measurement) =>
        measurement.run.tests.find((candidate) => candidate.id === testId)?.elapsedMicros,
      )
      .filter(Number.isFinite)
    return percentile(repeatedValues, 0.9)
  }
  return mode.run?.tests.find((candidate) => candidate.id === testId)?.elapsedMicros ?? null
}

function speedCaseGateMisses(nativeMode, baselineMode, tolerance = 0.05) {
  if (!nativeMode?.run || !baselineMode?.run) {
    return []
  }
  const misses = []
  for (const test of nativeMode.run.tests) {
    const nativeMicros = speedCaseMicros(nativeMode, test.id)
    const baselineMicros = speedCaseMicros(baselineMode, test.id)
    if (gateStatus(nativeMicros, baselineMicros, tolerance) === 'miss') {
      misses.push({
        id: test.id,
        label: test.label,
        nativeMicros,
        baselineMicros,
      })
    }
  }
  return misses
}

function slowestRepeatRows(modes, count = 3) {
  const rows = []
  for (const mode of modes) {
    if (!mode.run) {
      continue
    }
    const measurements = mode.repeats.length
      ? mode.repeats
      : [{ file: 'primary', run: mode.run, resource: mode.resource }]
    const summary = repeatedSpeedSummary(mode.run, mode.resource, mode.repeats)
    const totals = measurements
      .map((measurement) => ({
        file: measurement.file ?? 'primary',
        totalMicros: speedTotalMicros(measurement.run),
        openMicros: measurement.run.openMicros,
      }))
      .filter((entry) => Number.isFinite(entry.totalMicros))
      .sort((a, b) => b.totalMicros - a.totalMicros)
      .slice(0, count)
    for (const entry of totals) {
      rows.push(
        `| ${mode.label} | \`${entry.file}\` | ${fmtSecFromMicros(entry.totalMicros)} | ${fmtRatio(entry.totalMicros, summary.p50TotalMicros)} | ${fmtMsFromMicros(entry.openMicros)} |`,
      )
    }
  }
  return rows
}

function preparedTest(run, id) {
  return run?.tests?.find((test) => test.id === id) ?? null
}

function preparedBaselineMode(mode) {
  return mode.includes('pipelined')
    ? 'native_postgres_tokio_pipelined_prepared'
    : 'native_postgres_tokio_prepared'
}

function repeatedPreparedSummary(primaryMeasurement, repeatMeasurements, mode) {
  const measurements = repeatMeasurements.length
    ? repeatMeasurements
    : primaryMeasurement.report
      ? [primaryMeasurement]
      : []
  const matched = measurements
    .map((measurement) => ({
      run: measurement.report?.runs?.find((entry) => entry.mode === mode) ?? null,
      resource: measurement.resource,
    }))
    .filter((measurement) => measurement.run)
  const runs = matched.map((measurement) => measurement.run)
  const resources = matched.map((measurement) => measurement.resource)
  const numeric = runs
    .map((run) => preparedTest(run, 'numeric_indexed')?.elapsedMicros)
    .filter(Number.isFinite)
  const text = runs
    .map((run) => preparedTest(run, 'text_indexed')?.elapsedMicros)
    .filter(Number.isFinite)
  const rss = resources.map((resource) => resource.peakRssMb).filter(Number.isFinite)
  const footprints = resources
    .map((resource) => resource.peakFootprintMb)
    .filter(Number.isFinite)
  const cpus = resources.map((resource) => resource.cpuSec).filter(Number.isFinite)
  const reals = resources.map((resource) => resource.realSec).filter(Number.isFinite)
  return {
    n: runs.length,
    numericP50Micros: percentile(numeric, 0.5),
    numericP90Micros: percentile(numeric, 0.9),
    numericP95Micros: percentile(numeric, 0.95),
    numericP99Micros: percentile(numeric, 0.99),
    textP50Micros: percentile(text, 0.5),
    textP90Micros: percentile(text, 0.9),
    textP95Micros: percentile(text, 0.95),
    textP99Micros: percentile(text, 0.99),
    p90RssMb: percentile(rss, 0.9),
    p99RssMb: percentile(rss, 0.99),
    p90FootprintMb: percentile(footprints, 0.9),
    p99FootprintMb: percentile(footprints, 0.99),
    p90CpuSec: percentile(cpus, 0.9),
    p99CpuSec: percentile(cpus, 0.99),
    p90RealSec: percentile(reals, 0.9),
    p99RealSec: percentile(reals, 0.99),
  }
}

function preparedRows(measurement, repeatMeasurements, baselineMeasurement, baselineRepeatMeasurements) {
  if (!measurement.report && repeatMeasurements.length === 0) {
    return []
  }
  const modes = new Set()
  for (const run of measurement.report?.runs ?? []) {
    modes.add(run.mode)
  }
  for (const repeat of repeatMeasurements) {
    for (const run of repeat.report?.runs ?? []) {
      modes.add(run.mode)
    }
  }
  return [...modes].map((mode) => {
    const summary = repeatedPreparedSummary(measurement, repeatMeasurements, mode)
    const baseline = repeatedPreparedSummary(
      baselineMeasurement,
      baselineRepeatMeasurements,
      preparedBaselineMode(mode),
    )
    return `| ${mode} | ${summary.n} | ${fmtSecFromMicros(summary.numericP50Micros)} | ${fmtSecFromMicros(summary.numericP90Micros)} | ${fmtSecFromMicros(summary.numericP95Micros)} | ${fmtSecFromMicros(summary.numericP99Micros)} | ${fmtRatio(summary.numericP90Micros, baseline.numericP90Micros)} | ${fmtSecFromMicros(summary.textP50Micros)} | ${fmtSecFromMicros(summary.textP90Micros)} | ${fmtSecFromMicros(summary.textP95Micros)} | ${fmtSecFromMicros(summary.textP99Micros)} | ${fmtRatio(summary.textP90Micros, baseline.textP90Micros)} | ${fmtMb(summary.p90RssMb)} | ${fmtMb(summary.p99RssMb)} | ${fmtMb(summary.p90FootprintMb)} | ${fmtMb(summary.p99FootprintMb)} | ${fmtSec(summary.p90CpuSec)} | ${fmtSec(summary.p99CpuSec)} | ${fmtSec(summary.p90RealSec)} | ${fmtSec(summary.p99RealSec)} |`
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = requireArg(args, '--run-dir')
  const runId = requireArg(args, '--run-id')
  const postgresVersion = requireArg(args, '--postgres-version')
  const durability = args['--durability'] ?? 'safe'
  const runtimeFootprint = args['--runtime-footprint'] ?? 'throughput'
  const startupGucs = args['--startup-gucs'] ?? ''

  const nativeLibRtt = await loadMeasuredRun(runDir, 'native-liboliphaunt-rtt')
  const nativeLibSpeed = await loadMeasuredRun(runDir, 'native-liboliphaunt-speed')
  const nativeLibStreaming = await loadMeasuredRun(runDir, 'native-liboliphaunt-streaming')
  const nativeLibBackup = await loadMeasuredRun(runDir, 'native-liboliphaunt-backup')
  const nativeBrokerRtt = await loadMeasuredRun(runDir, 'native-liboliphaunt-broker-rtt')
  const nativeBrokerSpeed = await loadMeasuredRun(runDir, 'native-liboliphaunt-broker-speed')
  const nativeBrokerStreaming = await loadMeasuredRun(runDir, 'native-liboliphaunt-broker-streaming')
  const nativeBrokerBackup = await loadMeasuredRun(runDir, 'native-liboliphaunt-broker-backup')
  const nativeServerRtt = await loadMeasuredRun(runDir, 'native-liboliphaunt-server-rtt')
  const nativeServerSpeed = await loadMeasuredRun(runDir, 'native-liboliphaunt-server-speed')
  const nativeServerStreaming = await loadMeasuredRun(runDir, 'native-liboliphaunt-server-streaming')
  const nativeServerBackup = await loadMeasuredRun(runDir, 'native-liboliphaunt-server-backup')
  const nativeTokioRtt = await loadFirstMeasuredRun(runDir, [
    'native-postgres-tokio-all',
    'native-postgres-tokio-rtt',
  ])
  const nativeTokioSpeed = await loadFirstMeasuredRun(runDir, [
    'native-postgres-tokio-all',
    'native-postgres-tokio-speed',
  ])
  const nativeSqlxRtt = await loadFirstMeasuredRun(runDir, [
    'native-postgres-sqlx-all',
    'native-postgres-sqlx-rtt',
  ])
  const nativeSqlxSpeed = await loadFirstMeasuredRun(runDir, [
    'native-postgres-sqlx-all',
    'native-postgres-sqlx-speed',
  ])
  const nativePostgresStreaming = await loadMeasuredRun(runDir, 'native-postgres-streaming')
  const nativePostgresBackup = await loadMeasuredRun(runDir, 'native-postgres-backup')
  const sqliteSpeed = await loadMeasuredRun(runDir, 'sqlite-speed')
  const sqliteBackup = await loadMeasuredRun(runDir, 'sqlite-backup')
  const artifactSizes = await readJsonIfExists(path.join(runDir, 'artifact-sizes.json'))
  const provenance = await readJsonIfExists(path.join(runDir, 'provenance.json'))
  const pgdataCopyMode = args['--pgdata-copy-mode'] ?? provenance?.benchmark?.pgdataCopyMode ?? 'n/a'
  const selectedNativeEngines = args['--native-engines'] ?? provenance?.benchmark?.nativeEngines?.join(',') ?? 'direct,broker,server'
  const selectedSuites = args['--suites'] ?? provenance?.benchmark?.suites?.join(',') ?? 'rtt,speed,streaming,prepared,backup'
  const isPartialCoverage =
    boolValue(args['--partial-report']) ??
    provenance?.benchmark?.quality?.partialReport ??
    (selectedNativeEngines !== 'direct,broker,server' ||
      selectedSuites !== 'rtt,speed,streaming,prepared,backup')
  const releaseMinimums = provenance?.benchmark?.quality?.releaseMinimums ?? {
    rttIterations: 100,
    rttRepeats: 10,
    preparedRows: 25000,
    preparedRepeats: 10,
    speedRepeats: 20,
    backupRepeats: 10,
  }
  const rttRepeats = Number(args['--rtt-repeats'] ?? provenance?.benchmark?.rttRepeats ?? '1')
  const speedRepeats = Number(args['--speed-repeats'] ?? provenance?.benchmark?.speedRepeats ?? '1')
  const backupRepeats = Number(args['--backup-repeats'] ?? provenance?.benchmark?.backupRepeats ?? '1')
  const preparedRepeats = Number(args['--prepared-repeats'] ?? provenance?.benchmark?.preparedRepeats ?? '1')
  const releaseEvidenceInput =
    boolValue(args['--release-evidence']) ?? provenance?.benchmark?.quality?.releaseEvidence ?? null
  const releaseEvidence =
    releaseEvidenceInput ??
    (!isPartialCoverage &&
      Number(args['--rtt-iterations'] ?? provenance?.benchmark?.rttIterations ?? '0') >=
        releaseMinimums.rttIterations &&
      rttRepeats >= releaseMinimums.rttRepeats &&
      Number(args['--prepared-rows'] ?? provenance?.benchmark?.preparedRows ?? '0') >=
        releaseMinimums.preparedRows &&
      preparedRepeats >= releaseMinimums.preparedRepeats &&
      speedRepeats >= releaseMinimums.speedRepeats &&
      backupRepeats >= (releaseMinimums.backupRepeats ?? 10))
  const nativePostgresPrepared = await loadMeasuredRun(runDir, 'native-postgres-prepared')
  const nativePreparedDirect = await loadMeasuredRun(runDir, 'native-liboliphaunt-prepared-direct')
  const nativePreparedBroker = await loadMeasuredRun(runDir, 'native-liboliphaunt-prepared-broker')
  const nativePreparedServer = await loadMeasuredRun(runDir, 'native-liboliphaunt-prepared-server')
  const nativeBackupDirectRepeats = await loadBackupRepeatMeasurements(runDir, 'native-liboliphaunt-backup-')
  const nativeBackupBrokerRepeats = await loadBackupRepeatMeasurements(runDir, 'native-liboliphaunt-broker-backup-')
  const nativeBackupServerRepeats = await loadBackupRepeatMeasurements(runDir, 'native-liboliphaunt-server-backup-')
  const nativePostgresBackupRepeats = await loadBackupRepeatMeasurements(runDir, 'native-postgres-backup-', 'native_postgres')
  const nativePostgresPhysicalBackupRepeats = await loadBackupRepeatMeasurements(runDir, 'native-postgres-backup-', 'native_postgres_physical')
  const sqliteBackupRepeats = await loadBackupRepeatMeasurements(runDir, 'sqlite-backup-')
  const nativePostgresPreparedRepeats = await loadPreparedRepeatMeasurements(runDir, 'native-postgres-prepared-')
  const nativePreparedDirectRepeats = await loadPreparedRepeatMeasurements(runDir, 'native-liboliphaunt-prepared-direct-')
  const nativePreparedBrokerRepeats = await loadPreparedRepeatMeasurements(runDir, 'native-liboliphaunt-prepared-broker-')
  const nativePreparedServerRepeats = await loadPreparedRepeatMeasurements(runDir, 'native-liboliphaunt-prepared-server-')

  const rttModes = [
    {
      label: 'Native liboliphaunt direct',
      run: collectRun(nativeLibRtt.report, 'rtt', 'native_liboliphaunt_direct'),
      resource: nativeLibRtt.resource,
      repeats: await loadRttRepeatMeasurements(runDir, 'native-liboliphaunt-rtt-', 'native_liboliphaunt_direct'),
    },
    {
      label: 'Native liboliphaunt broker',
      run: collectRun(nativeBrokerRtt.report, 'rtt', 'native_liboliphaunt_broker'),
      resource: nativeBrokerRtt.resource,
      repeats: await loadRttRepeatMeasurements(runDir, 'native-liboliphaunt-broker-rtt-', 'native_liboliphaunt_broker'),
    },
    {
      label: 'Native liboliphaunt server',
      run: collectRun(nativeServerRtt.report, 'rtt', 'native_liboliphaunt_server'),
      resource: nativeServerRtt.resource,
      repeats: await loadRttRepeatMeasurements(runDir, 'native-liboliphaunt-server-rtt-', 'native_liboliphaunt_server'),
    },
    {
      label: 'Native Postgres tokio simple',
      run: collectRun(nativeTokioRtt.report, 'rtt', 'native_postgres'),
      resource: nativeTokioRtt.resource,
      repeats: await loadRttRepeatMeasurements(runDir, 'native-postgres-tokio-rtt-', 'native_postgres'),
    },
    {
      label: 'Native Postgres SQLx',
      run: collectRun(nativeSqlxRtt.report, 'rtt', 'native_postgres_sqlx'),
      resource: nativeSqlxRtt.resource,
      repeats: [],
    },
  ]

  const speedModes = [
    {
      label: 'Native liboliphaunt direct',
      run: collectRun(nativeLibSpeed.report, 'speed', 'native_liboliphaunt_direct'),
      resource: nativeLibSpeed.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'native-liboliphaunt-speed-'),
    },
    {
      label: 'Native liboliphaunt broker',
      run: collectRun(nativeBrokerSpeed.report, 'speed', 'native_liboliphaunt_broker'),
      resource: nativeBrokerSpeed.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'native-liboliphaunt-broker-speed-'),
    },
    {
      label: 'Native liboliphaunt server',
      run: collectRun(nativeServerSpeed.report, 'speed', 'native_liboliphaunt_server'),
      resource: nativeServerSpeed.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'native-liboliphaunt-server-speed-'),
    },
    {
      label: 'Native Postgres tokio simple',
      run: collectRun(nativeTokioSpeed.report, 'speed', 'native_postgres'),
      resource: nativeTokioSpeed.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'native-postgres-tokio-speed-'),
    },
    {
      label: 'Native Postgres SQLx',
      run: collectRun(nativeSqlxSpeed.report, 'speed', 'native_postgres_sqlx'),
      resource: nativeSqlxSpeed.resource,
      repeats: [],
    },
    {
      label: 'SQLite embedded',
      run: collectRun(sqliteSpeed.report, 'speed', 'sqlite'),
      resource: sqliteSpeed.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'sqlite-speed-'),
    },
  ]
  const activeSpeedModes = speedModes.filter((mode) => mode.run)
  const streamingModes = [
    ['Native liboliphaunt direct', collectRun(nativeLibStreaming.report, 'streaming', 'native_liboliphaunt_direct'), nativeLibStreaming.resource],
    ['Native liboliphaunt broker', collectRun(nativeBrokerStreaming.report, 'streaming', 'native_liboliphaunt_broker'), nativeBrokerStreaming.resource],
    ['Native liboliphaunt server', collectRun(nativeServerStreaming.report, 'streaming', 'native_liboliphaunt_server'), nativeServerStreaming.resource],
    ['Native Postgres raw', collectRun(nativePostgresStreaming.report, 'streaming', 'native_postgres_raw'), nativePostgresStreaming.resource],
  ]
  const backupModes = [
    {
      label: 'Native liboliphaunt direct',
      run: collectRun(nativeLibBackup.report, 'backup-restore', 'native_liboliphaunt_direct'),
      resource: nativeLibBackup.resource,
      repeats: nativeBackupDirectRepeats,
    },
    {
      label: 'Native liboliphaunt broker',
      run: collectRun(nativeBrokerBackup.report, 'backup-restore', 'native_liboliphaunt_broker'),
      resource: nativeBrokerBackup.resource,
      repeats: nativeBackupBrokerRepeats,
    },
    {
      label: 'Native liboliphaunt server',
      run: collectRun(nativeServerBackup.report, 'backup-restore', 'native_liboliphaunt_server'),
      resource: nativeServerBackup.resource,
      repeats: nativeBackupServerRepeats,
    },
    {
      label: 'Native Postgres physical archive',
      run: collectRun(nativePostgresBackup.report, 'backup-restore', 'native_postgres_physical'),
      resource: nativePostgresBackup.resource,
      repeats: nativePostgresPhysicalBackupRepeats,
    },
    {
      label: 'Native Postgres pg_dump/pg_restore',
      run: collectRun(nativePostgresBackup.report, 'backup-restore', 'native_postgres'),
      resource: nativePostgresBackup.resource,
      repeats: nativePostgresBackupRepeats,
    },
    {
      label: 'SQLite VACUUM/file restore',
      run: collectRun(sqliteBackup.report, 'backup-restore', 'sqlite'),
      resource: sqliteBackup.resource,
      repeats: sqliteBackupRepeats,
    },
  ]
  const nativeDirectSpeed = speedModes[0]
  const nativePostgresSpeed = speedModes.find(
    (mode) => mode.label === 'Native Postgres tokio simple',
  )
  const nativeDirectSpeedSummary = repeatedSpeedSummary(
    nativeDirectSpeed.run,
    nativeDirectSpeed.resource,
    nativeDirectSpeed.repeats,
  )
  const nativePostgresSpeedSummary = repeatedSpeedSummary(
    nativePostgresSpeed.run,
    nativePostgresSpeed.resource,
    nativePostgresSpeed.repeats,
  )
  const sqliteEmbeddedSpeed = speedModes.find((mode) => mode.label === 'SQLite embedded')
  const sqliteEmbeddedSpeedSummary = repeatedSpeedSummary(
    sqliteEmbeddedSpeed.run,
    sqliteEmbeddedSpeed.resource,
    sqliteEmbeddedSpeed.repeats,
  )
  const nativeDirectRtt = rttModes[0]
  const nativePostgresRtt = rttModes.find(
    (mode) => mode.label === 'Native Postgres tokio simple',
  )
  const nativeDirectRttSummary = repeatedRttSummary(
    nativeDirectRtt.run,
    nativeDirectRtt.resource,
    nativeDirectRtt.repeats,
  )
  const nativePostgresRttSummary = repeatedRttSummary(
    nativePostgresRtt.run,
    nativePostgresRtt.resource,
    nativePostgresRtt.repeats,
  )
  const nativeDirectBackupSummary = repeatedSpeedSummary(
    backupModes[0].run,
    backupModes[0].resource,
    backupModes[0].repeats,
  )
  const nativePostgresBackupSummary = repeatedSpeedSummary(
    backupModes[3].run,
    backupModes[3].resource,
    backupModes[3].repeats,
  )
  const nativeDirectGateRows = [
    {
      metric: 'RTT repeat p90 median-p90',
      nativeDisplay: `${nativeDirectRttSummary?.gateMedianP90Us ?? 'n/a'} us`,
      baselineDisplay: `${nativePostgresRttSummary?.gateMedianP90Us ?? 'n/a'} us`,
      ratio: fmtRatio(nativeDirectRttSummary?.gateMedianP90Us, nativePostgresRttSummary?.gateMedianP90Us),
      status: gateStatus(nativeDirectRttSummary?.gateMedianP90Us, nativePostgresRttSummary?.gateMedianP90Us),
      diagnostic: 'Run focused RTT repeats for direct and native PostgreSQL to confirm the transport tail before changing code.',
    },
    {
      metric: 'Speed suite p90',
      nativeDisplay: `${fmtSecFromMicros(nativeDirectSpeedSummary.p90TotalMicros)} s`,
      baselineDisplay: `${fmtSecFromMicros(nativePostgresSpeedSummary.p90TotalMicros)} s`,
      ratio: fmtRatio(nativeDirectSpeedSummary.p90TotalMicros, nativePostgresSpeedSummary.p90TotalMicros),
      status: gateStatus(nativeDirectSpeedSummary.p90TotalMicros, nativePostgresSpeedSummary.p90TotalMicros),
      diagnostic: 'Run `oliphaunt-perf diagnose-speed-cases` for the missed case ids below, then compare with the native PostgreSQL diagnostic engine.',
    },
    {
      metric: 'Speed tail throughput p10',
      nativeDisplay: `${fmtRate(nativeDirectSpeedSummary.tailP10ThroughputPerSecond)} ops/s`,
      baselineDisplay: `${fmtRate(nativePostgresSpeedSummary.tailP10ThroughputPerSecond)} ops/s`,
      ratio: fmtRatio(nativeDirectSpeedSummary.tailP10ThroughputPerSecond, nativePostgresSpeedSummary.tailP10ThroughputPerSecond),
      status: gateStatusHigher(nativeDirectSpeedSummary.tailP10ThroughputPerSecond, nativePostgresSpeedSummary.tailP10ThroughputPerSecond),
      diagnostic: 'Run speed-case diagnostics; throughput misses usually need the same per-SQL investigation as speed-suite p90 misses.',
    },
    {
      metric: 'Speed open p90',
      nativeDisplay: `${fmtMsFromMicros(nativeDirectSpeedSummary.p90OpenMicros)} ms`,
      baselineDisplay: `${fmtMsFromMicros(nativePostgresSpeedSummary.p90OpenMicros)} ms`,
      ratio: fmtRatio(nativeDirectSpeedSummary.p90OpenMicros, nativePostgresSpeedSummary.p90OpenMicros),
      status: gateStatus(nativeDirectSpeedSummary.p90OpenMicros, nativePostgresSpeedSummary.p90OpenMicros),
      diagnostic: 'Compare runtime-footprint and startup-GUC sweeps; cold open is expected to differ from SQLite but should not regress against native PostgreSQL controls.',
    },
    {
      metric: 'Speed p90 RSS',
      nativeDisplay: `${fmtMb(nativeDirectSpeedSummary.p90RssMb)} MB`,
      baselineDisplay: `${fmtMb(nativePostgresSpeedSummary.p90MemoryBaselineRssMb)} MB`,
      ratio: fmtRatio(nativeDirectSpeedSummary.p90RssMb, nativePostgresSpeedSummary.p90MemoryBaselineRssMb),
      status: gateStatus(nativeDirectSpeedSummary.p90RssMb, nativePostgresSpeedSummary.p90MemoryBaselineRssMb),
      diagnostic: 'Run the mobile/runtime-footprint matrix before source cuts; RSS misses should be attributed to specific GUCs first.',
    },
    {
      metric: 'Backup/restore physical total p90',
      nativeDisplay: `${fmtSecFromMicros(nativeDirectBackupSummary.p90TotalMicros)} s`,
      baselineDisplay: `${fmtSecFromMicros(nativePostgresBackupSummary.p90TotalMicros)} s`,
      ratio: fmtRatio(nativeDirectBackupSummary.p90TotalMicros, nativePostgresBackupSummary.p90TotalMicros),
      status: gateStatus(nativeDirectBackupSummary.p90TotalMicros, nativePostgresBackupSummary.p90TotalMicros),
      diagnostic: 'Run the backup suite in isolation and inspect physical archive bytes, PGDATA copy mode, and restore verification timings.',
    },
    {
      metric: 'Backup/restore tail throughput p10',
      nativeDisplay: `${fmtMbPerSec(nativeDirectBackupSummary.tailP10ThroughputPerSecond)} MB/s`,
      baselineDisplay: `${fmtMbPerSec(nativePostgresBackupSummary.tailP10ThroughputPerSecond)} MB/s`,
      ratio: fmtRatio(nativeDirectBackupSummary.tailP10ThroughputPerSecond, nativePostgresBackupSummary.tailP10ThroughputPerSecond),
      status: gateStatusHigher(nativeDirectBackupSummary.tailP10ThroughputPerSecond, nativePostgresBackupSummary.tailP10ThroughputPerSecond),
      diagnostic: 'Run backup suite isolation; tail throughput misses are usually archive/copy-mode issues rather than SQL execution issues.',
    },
  ]
  const nativeDirectGateMisses = nativeDirectGateRows.filter((row) => row.status === 'miss')
  const firstRttReport = [
    nativeLibRtt,
    nativeBrokerRtt,
    nativeServerRtt,
    nativeTokioRtt,
    nativeSqlxRtt,
  ].find((measurement) => measurement.report)?.report
  const selectedEngineSet = new Set(
    selectedNativeEngines.split(',').filter((engine) => engine.length > 0),
  )
  const coverageStatus = (measured, selected, detail) => {
    if (measured) {
      return `measured via ${detail}`
    }
    return selected ? `selected but missing; expected via ${detail}` : 'not selected'
  }
  const nativeDirectMeasured = Boolean(
    nativeLibRtt.report ||
      nativeLibSpeed.report ||
      nativeLibStreaming.report ||
      nativeLibBackup.report ||
      nativePreparedDirect.report ||
      nativeBackupDirectRepeats.length ||
      nativePreparedDirectRepeats.length,
  )
  const nativeBrokerMeasured = Boolean(
    nativeBrokerRtt.report ||
      nativeBrokerSpeed.report ||
      nativeBrokerStreaming.report ||
      nativeBrokerBackup.report ||
      nativePreparedBroker.report ||
      nativeBackupBrokerRepeats.length ||
      nativePreparedBrokerRepeats.length,
  )
  const nativeServerMeasured = Boolean(
    nativeServerRtt.report ||
      nativeServerSpeed.report ||
      nativeServerStreaming.report ||
      nativeServerBackup.report ||
      nativePreparedServer.report ||
      nativeBackupServerRepeats.length ||
      nativePreparedServerRepeats.length,
  )

  const lines = []
  lines.push(`# Native liboliphaunt Perf Matrix ${runId}`)
  lines.push('')
  lines.push(`Run directory: \`${runDir}\``)
  lines.push('')
  lines.push('## Method')
  lines.push('')
  lines.push('- Release binary: `target/release/oliphaunt-perf`; Cargo build time is excluded from benchmark timings.')
  lines.push(`- Native control: \`${postgresVersion}\`.`)
  lines.push('- Native direct: `oliphaunt` with one embedded PostgreSQL backend per benchmark process.')
  lines.push('- Native broker: `oliphaunt` helper-process mode with local IPC to one embedded PostgreSQL backend.')
  lines.push('- Native server: `oliphaunt` true local PostgreSQL server mode.')
  lines.push(`- Native durability profile: \`${durability}\`.`)
  lines.push(`- Native runtime footprint profile: \`${runtimeFootprint}\`.`)
  if (startupGucs.length > 0) {
    lines.push(`- Native startup GUC overrides: \`${startupGucs}\`.`)
  }
  lines.push(`- PGDATA template hydration: \`${pgdataCopyMode}\`.`)
  lines.push(`- Selected native engines: \`${selectedNativeEngines}\`.`)
  lines.push(`- Selected suites: \`${selectedSuites}\`.`)
  lines.push(
    `- Run classification: ${
      releaseEvidence === true
        ? 'release evidence'
        : 'diagnostic; do not use for release claims without a default release-evidence matrix'
    }.`,
  )
  if (isPartialCoverage) {
    lines.push('- Coverage scope: partial focused run; use the default all-engine/all-suite matrix for release evidence.')
  }
  lines.push('- Speed source: exact Oliphaunt fixture SQL files from `benchmarks/native/sql`.')
  lines.push(`- RTT samples per case: ${firstRttReport?.rttIterations ?? 'n/a'}.`)
  lines.push(`- RTT repeats: ${rttRepeats}. When repeats are present, RTT summary columns report p50 across fresh-process run summaries and the native direct gate uses p90 across repeated median-p90 RTT summaries.`)
  lines.push(`- Prepared-update repeats: ${preparedRepeats}. Prepared rows report p50/p90/p95/p99 across fresh-process prepared-update suite runs when repeats are present.`)
  lines.push(`- Speed repeats: ${speedRepeats}. p50/p90/p95/p99 collapse fresh-process suite totals when repeats are present; speed case rows use per-case p90 when repeats are present.`)
  lines.push(`- Backup/restore repeats: ${backupRepeats}. Backup rows report p50/p90/p95/p99 across fresh-process physical archive or control backup/restore runs when repeats are present.`)
  lines.push(
    `- Release-evidence minimums: ${releaseMinimums.rttIterations} RTT samples, ${releaseMinimums.rttRepeats} RTT repeats, ${releaseMinimums.preparedRows} prepared rows, ${releaseMinimums.preparedRepeats} prepared repeats, ${releaseMinimums.speedRepeats} speed repeats, and ${releaseMinimums.backupRepeats ?? 10} backup/restore repeats across the default all-engine/all-suite matrix.`,
  )
  lines.push('- Resource metrics come from `/usr/bin/time`; RSS and peak footprint are process-level values. Native broker/server `observed server RSS` is sampled separately from child process trees during xtask execution.')
  if (provenance) {
    lines.push(`- Provenance: \`provenance.json\` records source/artifact SHA-256s. Verify with \`node tools/perf/matrix/native_oliphaunt_provenance.mjs verify --run-dir ${runDir}\`.`)
  } else {
    lines.push('- Provenance: no `provenance.json` was found; rerun the matrix with the current harness before using this report as release evidence.')
  }
  lines.push('')
  lines.push('## Coverage')
  lines.push('')
  lines.push('| Mode | Status |')
  lines.push('| --- | --- |')
  lines.push(`| NativeDirect | ${coverageStatus(nativeDirectMeasured, selectedEngineSet.has('direct'), 'native liboliphaunt')} |`)
  lines.push(`| NativeBroker | ${coverageStatus(nativeBrokerMeasured, selectedEngineSet.has('broker'), 'oliphaunt broker helper process')} |`)
  lines.push(`| NativeServer | ${coverageStatus(nativeServerMeasured, selectedEngineSet.has('server'), 'oliphaunt local PostgreSQL server mode; native PostgreSQL control remains the baseline')} |`)
  if (sqliteSpeed.report) {
    lines.push('| SQLite embedded | measured through rusqlite |')
  }
  lines.push('')
  lines.push('## RTT Summary')
  lines.push('')
  lines.push('| Mode | n | open p50 ms | open p90 ms | connect p50 ms | median p50 us | median p90 us | gate p90 us | median p95 us | median p99 us | max p90 us | max p99 us | peak RSS MB | observed server RSS MB | CPU s |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const mode of rttModes) {
    if (!mode.run) {
      continue
    }
    const summary = repeatedRttSummary(mode.run, mode.resource, mode.repeats)
    lines.push(
      `| ${mode.label} | ${summary.n} | ${fmtMsFromMicros(summary.openMicros)} | ${fmtMsFromMicros(summary.openP90Micros)} | ${fmtMsFromMicros(summary.connectMicros)} | ${summary.medianP50Us ?? 'n/a'} | ${summary.medianP90Us ?? 'n/a'} | ${summary.gateMedianP90Us ?? 'n/a'} | ${summary.medianP95Us ?? 'n/a'} | ${summary.medianP99Us ?? 'n/a'} | ${summary.maxP90Us ?? 'n/a'} | ${summary.maxP99Us ?? 'n/a'} | ${fmtMb(summary.peakRssMb)} | ${fmtMb(summary.observedServerPeakRssMb)} | ${fmtSec(summary.cpuSec)} |`,
    )
  }
  lines.push('')
  lines.push('## Speed Summary')
  lines.push('')
  lines.push('| Mode | n | suite p50 s | suite p90 s | suite p95 s | suite p99 s | throughput p50 ops/s | tail throughput p10 ops/s | open p50 ms | open p90 ms | open p99 ms | p90 RSS MB | p99 RSS MB | p90 observed server RSS MB | p99 observed server RSS MB | p90 footprint MB | p99 footprint MB | p90 CPU s | p99 CPU s |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const mode of speedModes) {
    if (!mode.run) {
      continue
    }
    const summary = repeatedSpeedSummary(mode.run, mode.resource, mode.repeats)
    lines.push(
      `| ${mode.label} | ${summary.n} | ${fmtSecFromMicros(summary.p50TotalMicros)} | ${fmtSecFromMicros(summary.p90TotalMicros)} | ${fmtSecFromMicros(summary.p95TotalMicros)} | ${fmtSecFromMicros(summary.p99TotalMicros)} | ${fmtRate(summary.p50ThroughputPerSecond)} | ${fmtRate(summary.tailP10ThroughputPerSecond)} | ${fmtMsFromMicros(summary.p50OpenMicros)} | ${fmtMsFromMicros(summary.p90OpenMicros)} | ${fmtMsFromMicros(summary.p99OpenMicros)} | ${fmtMb(summary.p90RssMb)} | ${fmtMb(summary.p99RssMb)} | ${fmtMb(summary.p90ObservedServerRssMb)} | ${fmtMb(summary.p99ObservedServerRssMb)} | ${fmtMb(summary.p90FootprintMb)} | ${fmtMb(summary.p99FootprintMb)} | ${fmtSec(summary.p90CpuSec)} | ${fmtSec(summary.p99CpuSec)} |`,
    )
  }
  lines.push('')
  lines.push('## Backup/Restore Summary')
  lines.push('')
  lines.push('| Mode | n | total p50 s | total p90 s | total p95 s | total p99 s | payload p50 MB | throughput p50 MB/s | tail throughput p10 MB/s | open p50 ms | open p90 ms | open p99 ms | p90 RSS MB | p99 RSS MB | p90 observed server RSS MB | p99 observed server RSS MB | p90 footprint MB | p99 footprint MB | p90 CPU s | p99 CPU s |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const mode of backupModes) {
    if (!mode.run) {
      continue
    }
    const summary = repeatedSpeedSummary(mode.run, mode.resource, mode.repeats)
    const payloadBytes = Number.isFinite(summary.p50OperationCount)
      ? summary.p50OperationCount / 2
      : null
    lines.push(
      `| ${mode.label} | ${summary.n} | ${fmtSecFromMicros(summary.p50TotalMicros)} | ${fmtSecFromMicros(summary.p90TotalMicros)} | ${fmtSecFromMicros(summary.p95TotalMicros)} | ${fmtSecFromMicros(summary.p99TotalMicros)} | ${fmtMbFromBytes(payloadBytes)} | ${fmtMbPerSec(summary.p50ThroughputPerSecond)} | ${fmtMbPerSec(summary.tailP10ThroughputPerSecond)} | ${fmtMsFromMicros(summary.p50OpenMicros)} | ${fmtMsFromMicros(summary.p90OpenMicros)} | ${fmtMsFromMicros(summary.p99OpenMicros)} | ${fmtMb(summary.p90RssMb)} | ${fmtMb(summary.p99RssMb)} | ${fmtMb(summary.p90ObservedServerRssMb)} | ${fmtMb(summary.p99ObservedServerRssMb)} | ${fmtMb(summary.p90FootprintMb)} | ${fmtMb(summary.p99FootprintMb)} | ${fmtSec(summary.p90CpuSec)} | ${fmtSec(summary.p99CpuSec)} |`,
    )
  }
  lines.push('')
  lines.push('## Run Quality')
  lines.push('')
  lines.push('| Mode | n | min s | p50 s | p90/p50 | p95/p50 | p99/p50 | max s | status | reason |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |')
  for (const mode of speedModes) {
    if (!mode.run) {
      continue
    }
    const summary = repeatedSpeedSummary(mode.run, mode.resource, mode.repeats)
    const quality = runQuality(summary)
    lines.push(
      `| ${mode.label} | ${summary.n} | ${fmtSecFromMicros(summary.minTotalMicros)} | ${fmtSecFromMicros(summary.p50TotalMicros)} | ${fmtRatio(summary.p90TotalMicros, summary.p50TotalMicros)} | ${fmtRatio(summary.p95TotalMicros, summary.p50TotalMicros)} | ${fmtRatio(summary.p99TotalMicros, summary.p50TotalMicros)} | ${fmtSecFromMicros(summary.maxTotalMicros)} | ${quality.status} | ${quality.reason} |`,
    )
  }
  lines.push('')
  lines.push('## Slowest Speed Repeats')
  lines.push('')
  lines.push('Use this table to distinguish host-wide pauses from engine-specific tail events. Repeated indices that recur across engines usually indicate host noise; isolated rows point at an engine path that needs focused diagnostics.')
  lines.push('')
  lines.push('| Mode | Repeat | suite s | ratio vs mode p50 | open ms |')
  lines.push('| --- | --- | ---: | ---: | ---: |')
  lines.push(...slowestRepeatRows(speedModes))
  lines.push('')
  if (artifactSizes?.artifacts?.length) {
    lines.push('## Artifact Sizes')
    lines.push('')
    lines.push('| Artifact | Size | Path |')
    lines.push('| --- | ---: | --- |')
    for (const artifact of artifactSizes.artifacts) {
      lines.push(`| ${artifact.name} | ${fmtBytes(artifact.bytes)} | \`${artifact.path}\` |`)
    }
    lines.push('')
  }
  if (provenance) {
    lines.push('## Provenance')
    lines.push('')
    lines.push('| Item | Value |')
    lines.push('| --- | --- |')
    lines.push(`| Generated | ${provenance.generatedAt ?? 'n/a'} |`)
    lines.push(`| Git commit | \`${shortSha(provenance.repo?.commit)}\` |`)
    lines.push(`| Tracked dirty | ${provenance.repo?.dirtyTracked ? 'yes' : 'no'} |`)
    lines.push(`| Source set SHA-256 | \`${shortSha(provenance.source?.sourceSetSha256)}\` |`)
    lines.push(`| Source files | ${provenance.source?.entries?.length ?? 'n/a'} |`)
    lines.push(`| PGDATA copy mode | \`${provenance.benchmark?.pgdataCopyMode ?? 'n/a'}\` |`)
    lines.push('')
    if (provenance.artifacts?.length) {
      lines.push('| Artifact | SHA-256 | Path |')
      lines.push('| --- | --- | --- |')
      for (const artifact of provenance.artifacts) {
        lines.push(
          `| ${artifact.name} | \`${shortSha(artifact.sha256)}\` | \`${artifact.path}\` |`,
        )
      }
      lines.push('')
    }
  }
  lines.push('## Native Direct Gate')
  lines.push('')
  lines.push('| Metric | Native liboliphaunt direct | Native Postgres control | Ratio | Status |')
  lines.push('| --- | ---: | ---: | ---: | --- |')
  for (const row of nativeDirectGateRows) {
    lines.push(
      `| ${row.metric} | ${row.nativeDisplay} | ${row.baselineDisplay} | ${row.ratio} | ${row.status} |`,
    )
  }
  lines.push('')
  if (sqliteEmbeddedSpeed?.run) {
    lines.push('## SQLite Comparison')
    lines.push('')
    lines.push('| Metric | Native liboliphaunt direct | SQLite embedded | Ratio |')
    lines.push('| --- | ---: | ---: | ---: |')
    lines.push(
      `| Speed suite p90 | ${fmtSecFromMicros(nativeDirectSpeedSummary.p90TotalMicros)} s | ${fmtSecFromMicros(sqliteEmbeddedSpeedSummary.p90TotalMicros)} s | ${fmtRatio(nativeDirectSpeedSummary.p90TotalMicros, sqliteEmbeddedSpeedSummary.p90TotalMicros)} |`,
    )
    lines.push(
      `| Speed tail throughput p10 | ${fmtRate(nativeDirectSpeedSummary.tailP10ThroughputPerSecond)} ops/s | ${fmtRate(sqliteEmbeddedSpeedSummary.tailP10ThroughputPerSecond)} ops/s | ${fmtRatio(nativeDirectSpeedSummary.tailP10ThroughputPerSecond, sqliteEmbeddedSpeedSummary.tailP10ThroughputPerSecond)} |`,
    )
    lines.push(
      `| Speed open p90 | ${fmtMsFromMicros(nativeDirectSpeedSummary.p90OpenMicros)} ms | ${fmtMsFromMicros(sqliteEmbeddedSpeedSummary.p90OpenMicros)} ms | ${fmtRatio(nativeDirectSpeedSummary.p90OpenMicros, sqliteEmbeddedSpeedSummary.p90OpenMicros)} |`,
    )
    lines.push(
      `| Speed p90 RSS | ${fmtMb(nativeDirectSpeedSummary.p90RssMb)} MB | ${fmtMb(sqliteEmbeddedSpeedSummary.p90RssMb)} MB | ${fmtRatio(nativeDirectSpeedSummary.p90RssMb, sqliteEmbeddedSpeedSummary.p90RssMb)} |`,
    )
    lines.push('')
  }
  const speedGateMissDetails = speedCaseGateMisses(nativeDirectSpeed, nativePostgresSpeed)
  const gateMisses = speedGateMissDetails.map(
    (miss) =>
      `| ${miss.id} | ${miss.label} | ${fmtMsFromMicros(miss.nativeMicros)} | ${fmtMsFromMicros(miss.baselineMicros)} | ${fmtRatio(miss.nativeMicros, miss.baselineMicros)} |`,
  )
  if (gateMisses.length === 0) {
    lines.push('- No speed case misses above the 5% native PostgreSQL tolerance.')
  } else {
    lines.push('Speed case misses above the 5% native PostgreSQL tolerance:')
    lines.push('')
    lines.push('| ID | Test | Native liboliphaunt direct p90 ms | Native Postgres tokio simple p90 ms | Ratio |')
    lines.push('| --- | --- | ---: | ---: | ---: |')
    lines.push(...gateMisses)
  }
  lines.push('')
  if (nativeDirectGateMisses.length || speedGateMissDetails.length) {
    lines.push('## Native Direct Regression Diagnostics')
    lines.push('')
    lines.push(
      'Run these diagnostics before changing PostgreSQL patches or source/build flags. They keep direct-mode regressions tied to a measured suite, case id, or runtime GUC instead of broad speculation.',
    )
    lines.push('')
    if (nativeDirectGateMisses.length) {
      lines.push('| Missed gate | Diagnostic action |')
      lines.push('| --- | --- |')
      for (const miss of nativeDirectGateMisses) {
        lines.push(`| ${miss.metric} | ${miss.diagnostic} |`)
      }
      lines.push('')
    }
    if (speedGateMissDetails.length) {
      const ids = speedGateMissDetails.map((miss) => miss.id).join(',')
      lines.push('Speed-case diagnostic commands:')
      lines.push('')
      lines.push('```sh')
      lines.push(
        `tools/perf/matrix/run_native_speed_diagnostics.sh --ids ${ids} --repeats 10 --skip-build`,
      )
      lines.push(
        `cargo run --release -p oliphaunt-perf -- diagnose-speed-cases --engine native-liboliphaunt --ids ${ids}`,
      )
      lines.push(
        `cargo run --release -p oliphaunt-perf -- diagnose-speed-cases --engine native-postgres --ids ${ids}`,
      )
      lines.push('```')
      lines.push('')
    }
    if (nativeDirectGateMisses.some((miss) => miss.metric.includes('RTT'))) {
      lines.push('RTT tail diagnostic command:')
      lines.push('')
      lines.push('```sh')
      lines.push(
        'tools/perf/matrix/run_native_oliphaunt_matrix.sh --quick --engines direct --suites rtt --skip-sqlite --skip-prepared',
      )
      lines.push('```')
      lines.push('')
    }
    if (nativeDirectGateMisses.some((miss) => miss.metric.includes('RSS') || miss.metric.includes('open'))) {
      lines.push('Runtime-footprint diagnostic command:')
      lines.push('')
      lines.push('```sh')
      lines.push(
        'tools/perf/matrix/run_native_oliphaunt_matrix.sh --quick --engines direct --suites speed --runtime-footprint balanced-mobile --startup-guc shared_buffers=32MB --startup-guc wal_buffers=-1 --skip-sqlite --skip-prepared',
      )
      lines.push('```')
      lines.push('')
    }
    if (nativeDirectGateMisses.some((miss) => miss.metric.includes('Backup/restore'))) {
      lines.push('Backup/restore diagnostic command:')
      lines.push('')
      lines.push('```sh')
      lines.push(
        'tools/perf/matrix/run_native_oliphaunt_matrix.sh --quick --engines direct --suites backup --skip-sqlite --skip-prepared',
      )
      lines.push('```')
      lines.push('')
    }
  }
  lines.push('')
  lines.push('## Speed Cases')
  lines.push('')
  if (activeSpeedModes.length) {
    lines.push(
      `| ID | Test | ${activeSpeedModes.map((mode) => `${mode.label} p90 ms`).join(' | ')} |`,
    )
    lines.push(`| --- | --- | ${activeSpeedModes.map(() => '---:').join(' | ')} |`)
    lines.push(...speedCaseRows(activeSpeedModes))
  } else {
    lines.push('No speed suite measurements were selected for this run.')
  }
  lines.push('')
  lines.push('## Streaming')
  lines.push('')
  lines.push('| Mode | open ms | case | elapsed ms | bytes | peak RSS MB | observed server RSS MB | CPU s |')
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |')
  for (const [label, run, resource] of streamingModes) {
    if (!run) {
      continue
    }
    for (const test of run.tests) {
      lines.push(
        `| ${label} | ${fmtMsFromMicros(run.openMicros)} | ${test.id} | ${fmtMsFromMicros(test.elapsedMicros)} | ${test.operationCount ?? 'n/a'} | ${fmtMb(resource.peakRssMb)} | ${fmtMb(run.observedServerPeakRssBytes ? run.observedServerPeakRssBytes / 1024 / 1024 : undefined)} | ${fmtSec(resource.cpuSec)} |`,
      )
    }
  }
  lines.push('')
  lines.push('## Prepared Updates')
  lines.push('')
  lines.push('| Mode | n | numeric p50 s | numeric p90 s | numeric p95 s | numeric p99 s | numeric p90/native | text p50 s | text p90 s | text p95 s | text p99 s | text p90/native | p90 command RSS MB | p99 command RSS MB | p90 command footprint MB | p99 command footprint MB | p90 command CPU s | p99 command CPU s | p90 command wall s | p99 command wall s |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  lines.push(...preparedRows(nativePostgresPrepared, nativePostgresPreparedRepeats, nativePostgresPrepared, nativePostgresPreparedRepeats))
  lines.push(...preparedRows(nativePreparedDirect, nativePreparedDirectRepeats, nativePostgresPrepared, nativePostgresPreparedRepeats))
  lines.push(...preparedRows(nativePreparedBroker, nativePreparedBrokerRepeats, nativePostgresPrepared, nativePostgresPreparedRepeats))
  lines.push(...preparedRows(nativePreparedServer, nativePreparedServerRepeats, nativePostgresPrepared, nativePostgresPreparedRepeats))
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- Native liboliphaunt v1 is deliberately process-lifetime scoped; same-process reopen is not measured as a supported path.')
  lines.push('- Native broker and native server are measured as their own SDK modes. No direct-mode multiplexing is counted as broker or server performance.')
  lines.push('- Native PostgreSQL `observed server RSS` is sampled from the live server process tree during each suite. It is reported separately from `/usr/bin/time` process RSS because the control server runs out of process.')
  lines.push('- SQLite embedded uses the same durability label mapped to explicit SQLite PRAGMAs inside xtask; it is a product comparison baseline, not the release gate for PostgreSQL execution parity.')
  lines.push('- Compare direct mode with native PostgreSQL simple-query controls for backend execution parity; SQLx rows include client abstraction overhead.')
  lines.push('')

  console.log(lines.join('\n'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
