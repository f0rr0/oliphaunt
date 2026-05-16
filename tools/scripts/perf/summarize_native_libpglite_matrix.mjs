import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      continue
    }
    const value = argv[index + 1]
    if (value !== undefined && !value.startsWith('--')) {
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

function firstFinite(...values) {
  return values.find(Number.isFinite) ?? null
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

function fmtRatio(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return 'n/a'
  }
  return `${round(value / baseline, 3)}x`
}

function gateStatus(value, baseline, tolerance = 0.05) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) {
    return 'n/a'
  }
  return value <= baseline * (1 + tolerance) ? 'pass' : 'miss'
}

function speedSourceDescription(speedSource) {
  switch (speedSource) {
    case 'generated':
      return 'generated local SQL speed suite from `xtask perf --speed-source generated`.'
    case 'local':
      return 'repository-local SQL speed suite from `tools/perf/local-speed-suite`.'
    case 'pglite':
    case 'pglite-vendored':
    case 'upstream':
      return 'exact upstream PGlite SQL files from `assets/checkouts/pglite/packages/benchmark/src`.'
    default:
      return `\`${speedSource}\` SQL speed source.`
  }
}

function runtimeConfigSummary(runtime) {
  if (!runtime) {
    return null
  }
  const parts = []
  if (runtime.wasmerCompiler) {
    parts.push(`compiler=${runtime.wasmerCompiler}`)
  }
  if (runtime.wasmerLlvmOptLevel) {
    parts.push(`llvmOpt=${runtime.wasmerLlvmOptLevel}`)
  }
  if (runtime.wasmerCompilerThreads) {
    parts.push(`threads=${runtime.wasmerCompilerThreads}`)
  }
  if (runtime.wasmerBin) {
    parts.push(`wasmer=${runtime.wasmerBin}`)
  }
  return parts.length ? parts.join(', ') : null
}

function speedTotalMicros(run) {
  return run ? sum(run.tests.map((test) => test.elapsedMicros)) : null
}

function bytesToMb(value) {
  return value === null || value === undefined ? null : value / 1024 / 1024
}

function observedServerRssMb(run) {
  return bytesToMb(run?.observedServerPeakRssBytes)
}

function estimatedTotalMemoryMb(run, resource) {
  const serverRss = observedServerRssMb(run)
  if (Number.isFinite(serverRss)) {
    if (Number.isFinite(resource?.peakFootprintMb)) {
      return resource.peakFootprintMb + serverRss
    }
    if (Number.isFinite(resource?.peakRssMb)) {
      return resource.peakRssMb + serverRss
    }
    return serverRss
  }
  return firstFinite(resource?.peakRssMb, resource?.peakFootprintMb)
}

function rttSummary(run) {
  if (!run) {
    return null
  }
  const p50s = run.tests.map((test) => test.p50Micros).filter(Number.isFinite)
  const p90s = run.tests
    .map((test) => firstFinite(test.p90Micros, test.p95Micros, test.p50Micros))
    .filter(Number.isFinite)
  const p95s = run.tests
    .map((test) => firstFinite(test.p95Micros, test.p90Micros, test.p50Micros))
    .filter(Number.isFinite)
  return {
    openMicros: run.openMicros,
    connectMicros: run.connectMicros,
    setupMicros: run.setupMicros,
    medianP50Us: percentile(p50s, 0.5),
    medianP90Us: percentile(p90s, 0.5),
    medianP95Us: percentile(p95s, 0.5),
    maxP90Us: p90s.length ? Math.max(...p90s) : null,
    observedServerPeakRssMb: observedServerRssMb(run),
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

async function loadSpeedRepeatMeasurements(runDir, prefix) {
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
    const run = report?.runs?.find((entry) => entry.suite === 'speed')
    if (run) {
      const resourcePath = jsonPath.replace(/\.json$/, '.resource.txt')
      const resource = parseResource(await readTextIfExists(resourcePath))
      measurements.push({ run, resource })
    }
  }
  return measurements
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
  const opens = runs.map((run) => run.openMicros).filter(Number.isFinite)
  const rss = resources.map((resource) => resource.peakRssMb).filter(Number.isFinite)
  const footprints = resources
    .map((resource) => resource.peakFootprintMb)
    .filter(Number.isFinite)
  const cpus = resources.map((resource) => resource.cpuSec).filter(Number.isFinite)
  const observedServerRss = runs
    .map((run) => observedServerRssMb(run))
    .filter(Number.isFinite)
  const totalRss = runs
    .map((run, index) => estimatedTotalMemoryMb(run, resources[index]))
    .filter(Number.isFinite)
  const p90RssMb = percentile(rss, 0.9)
  const p90ObservedServerRssMb = percentile(observedServerRss, 0.9)
  const p90TotalRssMb = percentile(totalRss, 0.9)
  return {
    n: runs.length,
    p50TotalMicros: percentile(totals, 0.5),
    p90TotalMicros: percentile(totals, 0.9),
    p95TotalMicros: percentile(totals, 0.95),
    p50OpenMicros: percentile(opens, 0.5),
    p90OpenMicros: percentile(opens, 0.9),
    p90RssMb,
    p90ObservedServerRssMb,
    p90TotalRssMb,
    p90FootprintMb: percentile(footprints, 0.9),
    p90CpuSec: percentile(cpus, 0.9),
  }
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

function speedCaseGateRows(nativeMode, baselineMode, tolerance = 0.05) {
  if (!nativeMode?.run || !baselineMode?.run) {
    return []
  }
  const misses = []
  for (const test of nativeMode.run.tests) {
    const nativeMicros = speedCaseMicros(nativeMode, test.id)
    const baselineMicros = speedCaseMicros(baselineMode, test.id)
    if (gateStatus(nativeMicros, baselineMicros, tolerance) === 'miss') {
      misses.push(
        `| ${test.id} | ${test.label} | ${fmtMsFromMicros(nativeMicros)} | ${fmtMsFromMicros(baselineMicros)} | ${fmtRatio(nativeMicros, baselineMicros)} |`,
      )
    }
  }
  return misses
}

function preparedRows(report) {
  if (!report) {
    return []
  }
  return report.runs.map((run) => {
    const numeric = run.tests.find((test) => test.id === 'numeric_indexed')
    const text = run.tests.find((test) => test.id === 'text_indexed')
    return `| ${run.mode} | ${fmtSecFromMicros(numeric?.elapsedMicros)} | ${fmtSecFromMicros(text?.elapsedMicros)} |`
  })
}

function sdkRows(report, resource) {
  const run = report?.runs?.find((entry) => entry.suite === 'sdk_prepared')
  if (!run) {
    return []
  }
  return run.tests.map((test) => {
    const avg = Number.isFinite(test.averageMicros) ? round(test.averageMicros, 2) : 'n/a'
    return `| ${test.id} | ${test.label} | ${test.operationCount ?? 'n/a'} | ${avg} | ${test.p50Micros ?? 'n/a'} | ${test.p90Micros ?? 'n/a'} | ${test.p95Micros ?? 'n/a'} | ${fmtMsFromMicros(run.openMicros)} | ${fmtMsFromMicros(run.setupMicros)} | ${fmtMb(resource?.peakRssMb)} | ${fmtSec(resource?.cpuSec)} |`
  })
}

function openProfileRows(measurements) {
  const rows = []
  for (const [label, measured] of measurements) {
    const run = measured.report?.runs?.[0]
    if (!run) {
      continue
    }
    const observedServerRss = observedServerRssMb(run)
    const estimatedTotal = estimatedTotalMemoryMb(run, measured.resource)
    const phases = Array.isArray(run.phases) && run.phases.length > 0
      ? run.phases
      : [{ name: 'n/a', elapsedMicros: null }]
    for (const phase of phases) {
      rows.push(
        `| ${label} | ${fmtMsFromMicros(run.openMicros)} | ${fmtMsFromMicros(run.connectMicros)} | ${run.firstQueryMicros ?? 'n/a'} | ${phase.name} | ${fmtMsFromMicros(phase.elapsedMicros)} | ${fmtMb(measured.resource?.peakRssMb)} | ${fmtMb(observedServerRss)} | ${fmtMb(estimatedTotal)} | ${fmtSec(measured.resource?.cpuSec)} |`,
      )
    }
  }
  return rows
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = requireArg(args, '--run-dir')
  const runId = requireArg(args, '--run-id')
  const postgresVersion = requireArg(args, '--postgres-version')
  const speedRepeats = Number(args['--speed-repeats'] ?? '1')
  const speedSource = args['--speed-source'] ?? 'pglite'
  const currentRuntimeKind = args['--current-runtime-kind'] ?? ''
  const stableWorktree = args['--stable-worktree'] ?? ''
  const stableBranch = args['--stable-branch'] ?? ''
  const stableRevision = args['--stable-revision'] ?? ''
  const stableDirty = args['--stable-dirty'] === '1'

  const nativeLibRtt = await loadMeasuredRun(runDir, 'native-libpglite-rtt')
  const nativeLibOpen = await loadMeasuredRun(runDir, 'native-libpglite-open')
  const nativeLibSpeed = await loadMeasuredRun(runDir, 'native-libpglite-speed')
  const nativePostgresOpen = await loadMeasuredRun(runDir, 'native-postgres-open')
  const nativeTokio = await loadMeasuredRun(runDir, 'native-postgres-tokio-all')
  const nativeSqlx = await loadMeasuredRun(runDir, 'native-postgres-sqlx-all')
  const wasixServerOpen = await loadMeasuredRun(runDir, 'wasix-server-open')
  const wasixDirect = await loadMeasuredRun(runDir, 'wasix-direct-all')
  const wasixServerSqlx = await loadMeasuredRun(runDir, 'wasix-server-sqlx-all')
  let wasixServerTokio = await loadMeasuredRun(runDir, 'wasix-server-tokio-all')
  if (!wasixServerTokio.report) {
    wasixServerTokio = await loadMeasuredRun(runDir, 'wasix-server-tokio-rtt')
  }
  const stableWasixDirect = await loadMeasuredRun(runDir, 'stable-wasix-direct-all')
  const stableWasixServerSqlx = await loadMeasuredRun(runDir, 'stable-wasix-server-sqlx-all')
  let stableWasixServerTokio = await loadMeasuredRun(runDir, 'stable-wasix-server-tokio-all')
  if (!stableWasixServerTokio.report) {
    stableWasixServerTokio = await loadMeasuredRun(runDir, 'stable-wasix-server-tokio-rtt')
  }
  const nativeSdk = await loadMeasuredRun(runDir, 'native-libpglite-sdk')
  const nativePrepared = await loadMeasuredRun(runDir, 'native-libpglite-prepared')
  const prepared = await loadMeasuredRun(runDir, 'prepared-updates')
  const stablePrepared = await loadMeasuredRun(runDir, 'stable-prepared-updates')

  const rttModes = [
    ['Native libpglite direct', collectRun(nativeLibRtt.report, 'rtt', 'native_libpglite_direct'), nativeLibRtt.resource],
    ['Native Postgres tokio simple', collectRun(nativeTokio.report, 'rtt', 'native_postgres'), nativeTokio.resource],
    ['Native Postgres SQLx', collectRun(nativeSqlx.report, 'rtt', 'native_postgres_sqlx'), nativeSqlx.resource],
    ['WASIX direct', collectRun(wasixDirect.report, 'rtt', 'direct'), wasixDirect.resource],
    ['WASIX server SQLx', collectRun(wasixServerSqlx.report, 'rtt', 'server_sqlx'), wasixServerSqlx.resource],
    ['WASIX server tokio simple', collectRun(wasixServerTokio.report, 'rtt', 'server_tokio_postgres_simple'), wasixServerTokio.resource],
    ['Stable worktree WASIX direct', collectRun(stableWasixDirect.report, 'rtt', 'direct'), stableWasixDirect.resource],
    ['Stable worktree WASIX server SQLx', collectRun(stableWasixServerSqlx.report, 'rtt', 'server_sqlx'), stableWasixServerSqlx.resource],
    ['Stable worktree WASIX server tokio simple', collectRun(stableWasixServerTokio.report, 'rtt', 'server_tokio_postgres_simple'), stableWasixServerTokio.resource],
  ]

  const speedModes = [
    {
      label: 'Native libpglite direct',
      run: collectRun(nativeLibSpeed.report, 'speed', 'native_libpglite_direct'),
      resource: nativeLibSpeed.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'native-libpglite-speed-'),
    },
    {
      label: 'Native Postgres tokio simple',
      run: collectRun(nativeTokio.report, 'speed', 'native_postgres'),
      resource: nativeTokio.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'native-postgres-tokio-speed-'),
    },
    {
      label: 'Native Postgres SQLx',
      run: collectRun(nativeSqlx.report, 'speed', 'native_postgres_sqlx'),
      resource: nativeSqlx.resource,
      repeats: [],
    },
    {
      label: 'WASIX direct',
      run: collectRun(wasixDirect.report, 'speed', 'direct'),
      resource: wasixDirect.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'wasix-direct-speed-'),
    },
    {
      label: 'WASIX server SQLx',
      run: collectRun(wasixServerSqlx.report, 'speed', 'server_sqlx'),
      resource: wasixServerSqlx.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'wasix-server-sqlx-speed-'),
    },
    {
      label: 'WASIX server tokio simple',
      run: collectRun(wasixServerTokio.report, 'speed', 'server_tokio_postgres_simple'),
      resource: wasixServerTokio.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'wasix-server-tokio-speed-'),
    },
    {
      label: 'Stable worktree WASIX direct',
      run: collectRun(stableWasixDirect.report, 'speed', 'direct'),
      resource: stableWasixDirect.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'stable-wasix-direct-speed-'),
    },
    {
      label: 'Stable worktree WASIX server SQLx',
      run: collectRun(stableWasixServerSqlx.report, 'speed', 'server_sqlx'),
      resource: stableWasixServerSqlx.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'stable-wasix-server-sqlx-speed-'),
    },
    {
      label: 'Stable worktree WASIX server tokio simple',
      run: collectRun(stableWasixServerTokio.report, 'speed', 'server_tokio_postgres_simple'),
      resource: stableWasixServerTokio.resource,
      repeats: await loadSpeedRepeatMeasurements(runDir, 'stable-wasix-server-tokio-speed-'),
    },
  ]
  const nativeDirectSpeed = speedModes[0]
  const nativePostgresSpeed = speedModes[1]
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
  const nativeDirectRttSummary = rttSummary(rttModes[0][1])
  const nativePostgresRttSummary = rttSummary(rttModes[1][1])
  const currentWasixDirectSpeed = speedModes.find((mode) => mode.label === 'WASIX direct')
  const currentWasixServerSpeed = speedModes.find((mode) => mode.label === 'WASIX server SQLx')
  const currentWasixServerTokioSpeed = speedModes.find((mode) => mode.label === 'WASIX server tokio simple')
  const stableWasixDirectSpeed = speedModes.find((mode) => mode.label === 'Stable worktree WASIX direct')
  const stableWasixServerSpeed = speedModes.find((mode) => mode.label === 'Stable worktree WASIX server SQLx')
  const stableWasixServerTokioSpeed = speedModes.find((mode) => mode.label === 'Stable worktree WASIX server tokio simple')
  const currentWasixDirectSpeedSummary = repeatedSpeedSummary(
    currentWasixDirectSpeed?.run,
    currentWasixDirectSpeed?.resource,
    currentWasixDirectSpeed?.repeats ?? [],
  )
  const currentWasixServerSpeedSummary = repeatedSpeedSummary(
    currentWasixServerSpeed?.run,
    currentWasixServerSpeed?.resource,
    currentWasixServerSpeed?.repeats ?? [],
  )
  const currentWasixServerTokioSpeedSummary = repeatedSpeedSummary(
    currentWasixServerTokioSpeed?.run,
    currentWasixServerTokioSpeed?.resource,
    currentWasixServerTokioSpeed?.repeats ?? [],
  )
  const stableWasixDirectSpeedSummary = repeatedSpeedSummary(
    stableWasixDirectSpeed?.run,
    stableWasixDirectSpeed?.resource,
    stableWasixDirectSpeed?.repeats ?? [],
  )
  const stableWasixServerSpeedSummary = repeatedSpeedSummary(
    stableWasixServerSpeed?.run,
    stableWasixServerSpeed?.resource,
    stableWasixServerSpeed?.repeats ?? [],
  )
  const stableWasixServerTokioSpeedSummary = repeatedSpeedSummary(
    stableWasixServerTokioSpeed?.run,
    stableWasixServerTokioSpeed?.resource,
    stableWasixServerTokioSpeed?.repeats ?? [],
  )
  const currentWasixDirectRttSummary = rttSummary(collectRun(wasixDirect.report, 'rtt', 'direct'))
  const currentWasixServerRttSummary = rttSummary(collectRun(wasixServerSqlx.report, 'rtt', 'server_sqlx'))
  const currentWasixServerTokioRttSummary = rttSummary(collectRun(wasixServerTokio.report, 'rtt', 'server_tokio_postgres_simple'))
  const stableWasixDirectRttSummary = rttSummary(collectRun(stableWasixDirect.report, 'rtt', 'direct'))
  const stableWasixServerRttSummary = rttSummary(collectRun(stableWasixServerSqlx.report, 'rtt', 'server_sqlx'))
  const stableWasixServerTokioRttSummary = rttSummary(collectRun(stableWasixServerTokio.report, 'rtt', 'server_tokio_postgres_simple'))

  const lines = []
  lines.push(`# Native libpglite Perf Matrix ${runId}`)
  lines.push('')
  lines.push(`Run directory: \`${runDir}\``)
  lines.push('')
  lines.push('## Method')
  lines.push('')
  lines.push('- Release binary: `target/release/xtask`; Cargo build time is excluded from benchmark timings.')
  lines.push(`- Native control: \`${postgresVersion}\`.`)
  lines.push('- Native direct: `EngineKind::NativeLibPglite` with one embedded PostgreSQL backend per benchmark process.')
  if (currentRuntimeKind) {
    lines.push(`- Current WASIX runtime kind: \`${currentRuntimeKind}\`.`)
  }
  const currentWasixRuntimeConfig = runtimeConfigSummary(
    wasixServerSqlx.report?.runtime ?? wasixServerOpen.report?.runtime,
  )
  if (currentWasixRuntimeConfig) {
    lines.push(`- Current WASIX server runtime config: ${currentWasixRuntimeConfig}.`)
  }
  if (stableWorktree) {
    const stableRef = [stableBranch, stableRevision].filter(Boolean).join('@')
    const stableSuffix = stableRef ? ` at ${stableRef}` : ''
    const dirtySuffix = stableDirty ? ' (dirty; smoke/provenance run only)' : ''
    lines.push(`- Stable worktree control: \`${stableWorktree}\`${stableSuffix}${dirtySuffix}.`)
  } else {
    lines.push('- Stable worktree control: not measured; pass `--stable-worktree` to include current stable pglite-oxide controls.')
  }
  lines.push(`- Speed source: ${speedSourceDescription(speedSource)}`)
  lines.push(`- RTT samples per case: ${nativeLibRtt.report?.rttIterations ?? 'n/a'}.`)
  lines.push(`- Speed repeats: ${speedRepeats}. p50/p90/p95 collapse fresh-process suite totals when repeats are present; speed case rows use per-case p90 when repeats are present.`)
  lines.push('- Resource metrics come from `/usr/bin/time`; observed server RSS is sampled from the live server process tree. On macOS, `/usr/bin/time -l` maximum RSS can reflect the child server rather than only the xtask client, so estimated total memory uses client peak footprint plus observed server RSS when both are available; on platforms without peak footprint it falls back to process RSS plus observed server RSS.')
  lines.push('')
  lines.push('## Coverage')
  lines.push('')
  lines.push('| Mode | Status |')
  lines.push('| --- | --- |')
  lines.push('| NativeDirect | measured via native libpglite |')
  lines.push('| NativeServer | measured through native PostgreSQL server control |')
  lines.push('| NativeBroker | not implemented yet; no benchmarkable broker binary exists |')
  lines.push('| Rust SDK high-level API | measured through `xtask perf native-libpglite-sdk` |')
  lines.push(
    currentRuntimeKind === 'wasix-postgres-server'
      ? '| WASIX direct/server | server measured when not skipped; direct intentionally unavailable for PG18 server-core assets |'
      : '| WASIX direct/server | measured when not skipped |',
  )
  lines.push('| Stable pglite-oxide worktree | measured when `--stable-worktree` is provided |')
  lines.push('')
  lines.push('## Open Phase Profile')
  lines.push('')
  lines.push('| Mode | open ms | connect ms | first query us | phase | phase ms | peak RSS MB | observed server RSS MB | estimated total MB | CPU s |')
  lines.push('| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |')
  const openRows = openProfileRows([
    ['Native libpglite SDK', nativeLibOpen],
    ['Native PostgreSQL control', nativePostgresOpen],
    ['Current WASIX PgliteServer', wasixServerOpen],
  ])
  lines.push(...openRows)
  if (openRows.length === 0) {
    lines.push('| n/a | n/a | n/a | n/a | not measured | n/a | n/a | n/a | n/a | n/a |')
  }
  lines.push('')
  lines.push('## RTT Summary')
  lines.push('')
  lines.push('| Mode | open ms | connect ms | median p50 us | median p90 us | median p95 us | max p90 us | peak RSS MB | observed server RSS MB | estimated total MB | CPU s |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [label, run, resource] of rttModes) {
    if (!run) {
      continue
    }
    const summary = rttSummary(run)
    const estimatedTotal = estimatedTotalMemoryMb(run, resource)
    lines.push(
      `| ${label} | ${fmtMsFromMicros(summary.openMicros)} | ${fmtMsFromMicros(summary.connectMicros)} | ${summary.medianP50Us ?? 'n/a'} | ${summary.medianP90Us ?? 'n/a'} | ${summary.medianP95Us ?? 'n/a'} | ${summary.maxP90Us ?? 'n/a'} | ${fmtMb(resource.peakRssMb)} | ${fmtMb(summary.observedServerPeakRssMb)} | ${fmtMb(estimatedTotal)} | ${fmtSec(resource.cpuSec)} |`,
    )
  }
  lines.push('')
  lines.push('## Speed Summary')
  lines.push('')
  lines.push('| Mode | n | suite p50 s | suite p90 s | suite p95 s | open p50 ms | open p90 ms | p90 process RSS MB | p90 observed server RSS MB | p90 estimated total MB | p90 footprint MB | p90 CPU s |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const mode of speedModes) {
    if (!mode.run) {
      continue
    }
    const summary = repeatedSpeedSummary(mode.run, mode.resource, mode.repeats)
    lines.push(
      `| ${mode.label} | ${summary.n} | ${fmtSecFromMicros(summary.p50TotalMicros)} | ${fmtSecFromMicros(summary.p90TotalMicros)} | ${fmtSecFromMicros(summary.p95TotalMicros)} | ${fmtMsFromMicros(summary.p50OpenMicros)} | ${fmtMsFromMicros(summary.p90OpenMicros)} | ${fmtMb(summary.p90RssMb)} | ${fmtMb(summary.p90ObservedServerRssMb)} | ${fmtMb(summary.p90TotalRssMb)} | ${fmtMb(summary.p90FootprintMb)} | ${fmtSec(summary.p90CpuSec)} |`,
    )
  }
  lines.push('')
  lines.push('## Native Direct Gate')
  lines.push('')
  lines.push('| Metric | Native libpglite direct | Native Postgres tokio simple | Ratio | Status |')
  lines.push('| --- | ---: | ---: | ---: | --- |')
  lines.push(
    `| RTT median p90 | ${nativeDirectRttSummary?.medianP90Us ?? 'n/a'} us | ${nativePostgresRttSummary?.medianP90Us ?? 'n/a'} us | ${fmtRatio(nativeDirectRttSummary?.medianP90Us, nativePostgresRttSummary?.medianP90Us)} | ${gateStatus(nativeDirectRttSummary?.medianP90Us, nativePostgresRttSummary?.medianP90Us)} |`,
  )
  lines.push(
    `| Speed suite p90 | ${fmtSecFromMicros(nativeDirectSpeedSummary.p90TotalMicros)} s | ${fmtSecFromMicros(nativePostgresSpeedSummary.p90TotalMicros)} s | ${fmtRatio(nativeDirectSpeedSummary.p90TotalMicros, nativePostgresSpeedSummary.p90TotalMicros)} | ${gateStatus(nativeDirectSpeedSummary.p90TotalMicros, nativePostgresSpeedSummary.p90TotalMicros)} |`,
  )
  lines.push(
    `| Speed open p90 | ${fmtMsFromMicros(nativeDirectSpeedSummary.p90OpenMicros)} ms | ${fmtMsFromMicros(nativePostgresSpeedSummary.p90OpenMicros)} ms | ${fmtRatio(nativeDirectSpeedSummary.p90OpenMicros, nativePostgresSpeedSummary.p90OpenMicros)} | ${gateStatus(nativeDirectSpeedSummary.p90OpenMicros, nativePostgresSpeedSummary.p90OpenMicros)} |`,
  )
  lines.push(
    `| Speed p90 estimated total memory | ${fmtMb(nativeDirectSpeedSummary.p90TotalRssMb)} MB | ${fmtMb(nativePostgresSpeedSummary.p90TotalRssMb)} MB | ${fmtRatio(nativeDirectSpeedSummary.p90TotalRssMb, nativePostgresSpeedSummary.p90TotalRssMb)} | ${gateStatus(nativeDirectSpeedSummary.p90TotalRssMb, nativePostgresSpeedSummary.p90TotalRssMb)} |`,
  )
  lines.push('')
  const gateMisses = speedCaseGateRows(nativeDirectSpeed, nativePostgresSpeed)
  if (gateMisses.length === 0) {
    lines.push('- No speed case misses above the 5% native PostgreSQL tolerance.')
  } else {
    lines.push('Speed case misses above the 5% native PostgreSQL tolerance:')
    lines.push('')
    lines.push('| ID | Test | Native libpglite direct p90 ms | Native Postgres tokio simple p90 ms | Ratio |')
    lines.push('| --- | --- | ---: | ---: | ---: |')
    lines.push(...gateMisses)
  }
  lines.push('')
  lines.push('## PG18 WASIX vs Stable Worktree Gate')
  lines.push('')
  if (!stableWasixDirect.report && !stableWasixServerSqlx.report) {
    lines.push('- Stable worktree controls were not measured in this run.')
  } else {
    lines.push('| Metric | PG18 branch | Stable worktree | Ratio | Status |')
    lines.push('| --- | ---: | ---: | ---: | --- |')
    lines.push(
      `| Direct RTT median p90 | ${currentWasixDirectRttSummary?.medianP90Us ?? 'n/a'} us | ${stableWasixDirectRttSummary?.medianP90Us ?? 'n/a'} us | ${fmtRatio(currentWasixDirectRttSummary?.medianP90Us, stableWasixDirectRttSummary?.medianP90Us)} | ${gateStatus(currentWasixDirectRttSummary?.medianP90Us, stableWasixDirectRttSummary?.medianP90Us)} |`,
    )
    lines.push(
      `| Server SQLx RTT median p90 | ${currentWasixServerRttSummary?.medianP90Us ?? 'n/a'} us | ${stableWasixServerRttSummary?.medianP90Us ?? 'n/a'} us | ${fmtRatio(currentWasixServerRttSummary?.medianP90Us, stableWasixServerRttSummary?.medianP90Us)} | ${gateStatus(currentWasixServerRttSummary?.medianP90Us, stableWasixServerRttSummary?.medianP90Us)} |`,
    )
    lines.push(
      `| Server tokio simple RTT median p90 | ${currentWasixServerTokioRttSummary?.medianP90Us ?? 'n/a'} us | ${stableWasixServerTokioRttSummary?.medianP90Us ?? 'n/a'} us | ${fmtRatio(currentWasixServerTokioRttSummary?.medianP90Us, stableWasixServerTokioRttSummary?.medianP90Us)} | ${gateStatus(currentWasixServerTokioRttSummary?.medianP90Us, stableWasixServerTokioRttSummary?.medianP90Us)} |`,
    )
    lines.push(
      `| Direct speed suite p90 | ${fmtSecFromMicros(currentWasixDirectSpeedSummary.p90TotalMicros)} s | ${fmtSecFromMicros(stableWasixDirectSpeedSummary.p90TotalMicros)} s | ${fmtRatio(currentWasixDirectSpeedSummary.p90TotalMicros, stableWasixDirectSpeedSummary.p90TotalMicros)} | ${gateStatus(currentWasixDirectSpeedSummary.p90TotalMicros, stableWasixDirectSpeedSummary.p90TotalMicros)} |`,
    )
    lines.push(
      `| Server SQLx speed suite p90 | ${fmtSecFromMicros(currentWasixServerSpeedSummary.p90TotalMicros)} s | ${fmtSecFromMicros(stableWasixServerSpeedSummary.p90TotalMicros)} s | ${fmtRatio(currentWasixServerSpeedSummary.p90TotalMicros, stableWasixServerSpeedSummary.p90TotalMicros)} | ${gateStatus(currentWasixServerSpeedSummary.p90TotalMicros, stableWasixServerSpeedSummary.p90TotalMicros)} |`,
    )
    lines.push(
      `| Server tokio simple speed suite p90 | ${fmtSecFromMicros(currentWasixServerTokioSpeedSummary.p90TotalMicros)} s | ${fmtSecFromMicros(stableWasixServerTokioSpeedSummary.p90TotalMicros)} s | ${fmtRatio(currentWasixServerTokioSpeedSummary.p90TotalMicros, stableWasixServerTokioSpeedSummary.p90TotalMicros)} | ${gateStatus(currentWasixServerTokioSpeedSummary.p90TotalMicros, stableWasixServerTokioSpeedSummary.p90TotalMicros)} |`,
    )
  }
  lines.push('')
  lines.push('## Speed Cases')
  lines.push('')
  lines.push('| ID | Test | Native libpglite direct p90 ms | Native Postgres tokio simple p90 ms | Native Postgres SQLx ms | WASIX direct p90 ms | WASIX server SQLx p90 ms | WASIX server tokio simple p90 ms | Stable direct p90 ms | Stable server SQLx p90 ms | Stable server tokio simple p90 ms |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  lines.push(...speedCaseRows(speedModes))
  lines.push('')
  lines.push('## Rust SDK API Latency')
  lines.push('')
  lines.push('| ID | Test | samples | average us | p50 us | p90 us | p95 us | open ms | setup ms | peak RSS MB | CPU s |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  lines.push(...sdkRows(nativeSdk.report, nativeSdk.resource))
  if (!nativeSdk.report) {
    lines.push('| n/a | not measured | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |')
  }
  lines.push('')
  lines.push('## Prepared Updates')
  lines.push('')
  lines.push('| Mode | numeric indexed s | text indexed s |')
  lines.push('| --- | ---: | ---: |')
  lines.push(...preparedRows(nativePrepared.report))
  lines.push(...preparedRows(prepared.report))
  lines.push(...preparedRows(stablePrepared.report))
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- Native libpglite v1 is deliberately process-lifetime scoped; same-process reopen is not measured as a supported path.')
  lines.push('- Native broker is reported as unavailable until a real broker binary/runtime exists. No direct-mode multiplexing is counted as broker performance.')
  lines.push('- Native PostgreSQL `observed server RSS` is sampled from the live server process tree during each suite. It is reported separately from `/usr/bin/time` process RSS because the control server runs out of process.')
  lines.push('- Compare direct mode with native PostgreSQL simple-query controls for backend execution parity; SQLx rows include client abstraction overhead.')
  lines.push('')

  console.log(lines.join('\n'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
