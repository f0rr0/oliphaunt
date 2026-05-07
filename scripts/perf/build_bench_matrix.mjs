import fs from 'node:fs/promises'
import process from 'node:process'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      continue
    }
    const value = argv[index + 1]
    if (value && !value.startsWith('--')) {
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

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function mean(values) {
  return sum(values) / values.length
}

function round(value, decimals = 2) {
  return Number(value.toFixed(decimals))
}

function formatMicros(value) {
  return `${round(value)} us`
}

function formatMillis(value) {
  return `${round(value)} ms`
}

function formatMillisFromMicros(value) {
  if (value === null || value === undefined) {
    return '-'
  }
  return formatMillis(value / 1000)
}

function formatSecondsFromMicros(value) {
  return `${round(value / 1_000_000, 3)} s`
}

function formatRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return '-'
  }
  return `${round(numerator / denominator, 2)}x`
}

function readJson(jsonPath) {
  return fs.readFile(jsonPath, 'utf8').then((text) => JSON.parse(text))
}

function collectRun(report, suite, mode) {
  const run = report.runs.find((entry) => entry.suite === suite && entry.mode === mode)
  if (!run) {
    throw new Error(`missing ${suite}/${mode} run`)
  }
  return run
}

function rttAverageMicros(run) {
  return mean(run.tests.map((test) => test.averageMicros ?? test.trimmedAverageMicros))
}

function speedTotalMicros(run) {
  return sum(run.tests.map((test) => test.elapsedMicros))
}

function indexTestsById(run) {
  return new Map(run.tests.map((test) => [test.id, test]))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const output = requireArg(args, '--output')
  const oxidePath = requireArg(args, '--oxide')
  const nativePath = requireArg(args, '--native')
  const nodePath = requireArg(args, '--node')
  const nodeServerPath = requireArg(args, '--node-server')
  const runId = requireArg(args, '--run-id')
  const nativeVersion = requireArg(args, '--native-version')
  const machineOs = requireArg(args, '--machine-os')
  const machineCpu = requireArg(args, '--machine-cpu')
  const machineRam = requireArg(args, '--machine-ram')
  const machineCores = requireArg(args, '--machine-cores')

  const [oxide, native, node, nodeServer] = await Promise.all([
    readJson(oxidePath),
    readJson(nativePath),
    readJson(nodePath),
    readJson(nodeServerPath),
  ])

  const oxideRttSqlx = collectRun(oxide, 'rtt', 'server_sqlx')
  const oxideSpeedSqlx = collectRun(oxide, 'speed', 'server_sqlx')
  const nativeRttSqlx = collectRun(native, 'rtt', 'native_postgres_sqlx')
  const nativeSpeedSqlx = collectRun(native, 'speed', 'native_postgres_sqlx')
  const nodeRttNodefsSqlx = collectRun(node, 'rtt', 'pglite_nodefs_sqlx')
  const nodeSpeedNodefsSqlx = collectRun(node, 'speed', 'pglite_nodefs_sqlx')

  const headlineModes = [
    {
      label: 'native pg + SQLx',
      rttRun: nativeRttSqlx,
      speedRun: nativeSpeedSqlx,
      openMicros: nativeRttSqlx.openMicros,
      connectMicros: nativeRttSqlx.connectMicros,
      setupMicros: nativeRttSqlx.setupMicros,
    },
    {
      label: 'pglite-oxide + SQLx',
      rttRun: oxideRttSqlx,
      speedRun: oxideSpeedSqlx,
      openMicros: oxideRttSqlx.openMicros,
      connectMicros: oxideRttSqlx.connectMicros,
      setupMicros: oxideRttSqlx.setupMicros,
    },
    {
      label: 'vanilla PGlite + SQLx',
      rttRun: nodeRttNodefsSqlx,
      speedRun: nodeSpeedNodefsSqlx,
      openMicros: nodeRttNodefsSqlx.openMicros,
      connectMicros: nodeRttNodefsSqlx.connectMicros,
      setupMicros: nodeRttNodefsSqlx.setupMicros,
    },
  ]

  const speedMaps = {
    oxideSqlx: indexTestsById(oxideSpeedSqlx),
    nativeSqlx: indexTestsById(nativeSpeedSqlx),
    nodeNodefsSqlx: indexTestsById(nodeSpeedNodefsSqlx),
  }

  const lines = []
  lines.push(`# Benchmark Matrix ${runId}`)
  lines.push('')
  lines.push('Machine-local comparison for the current checkout. Each mode runs serially, never in parallel, so no benchmark shares CPU, disk, or memory pressure with another run.')
  lines.push('')
  lines.push('## Environment')
  lines.push('')
  lines.push(`- OS: \`${machineOs}\``)
  lines.push(`- CPU: \`${machineCpu}\``)
  lines.push(`- RAM: \`${machineRam}\``)
  lines.push(`- Logical cores: \`${machineCores}\``)
  lines.push(`- Node: \`${nodeServer.node}\``)
  lines.push(
    `- npm packages: \`${nodeServer.package}@${nodeServer.version}\`, \`${nodeServer.socketPackage}@${nodeServer.socketVersion}\``,
  )
  lines.push(`- Native Postgres: \`${nativeVersion}\``)
  lines.push(`- Oxide Wasmer: \`${oxide.wasmerVersion}\``)
  lines.push(`- Oxide Wasmer WASIX: \`${oxide.wasmerWasixVersion}\``)
  lines.push(`- RTT iterations: \`${oxide.rttIterations}\``)
  lines.push(`- Speed source: exact upstream SQL from \`assets/checkouts/pglite/packages/benchmark/src\``)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push('| Metric | native pg + SQLx | pglite-oxide + SQLx | vanilla PGlite + SQLx |')
  lines.push('|---|---:|---:|---:|')

  lines.push(
    `| Open | ${formatMillisFromMicros(headlineModes[0].openMicros)} | ${formatMillisFromMicros(headlineModes[1].openMicros)} | ${formatMillisFromMicros(headlineModes[2].openMicros)} |`,
  )

  lines.push(
    `| Connect | ${formatMillisFromMicros(headlineModes[0].connectMicros)} | ${formatMillisFromMicros(headlineModes[1].connectMicros)} | ${formatMillisFromMicros(headlineModes[2].connectMicros)} |`,
  )

  const rttMetrics = headlineModes.map((mode) => ({
    label: mode.label,
    value: rttAverageMicros(mode.rttRun),
  }))
  lines.push(
    `| RTT mean | ${formatMicros(rttMetrics[0].value)} | ${formatMicros(rttMetrics[1].value)} | ${formatMicros(rttMetrics[2].value)} |`,
  )

  const speedMetrics = headlineModes.map((mode) => ({
    label: mode.label,
    value: speedTotalMicros(mode.speedRun),
  }))
  lines.push(
    `| Speed total | ${formatSecondsFromMicros(speedMetrics[0].value)} | ${formatSecondsFromMicros(speedMetrics[1].value)} | ${formatSecondsFromMicros(speedMetrics[2].value)} |`,
  )

  lines.push('')
  lines.push('## Relative view')
  lines.push('')
  lines.push(`- pglite-oxide + SQLx RTT vs vanilla PGlite + SQLx: ${formatRatio(rttAverageMicros(oxideRttSqlx), rttAverageMicros(nodeRttNodefsSqlx))}`)
  lines.push(`- pglite-oxide + SQLx RTT vs native pg + SQLx: ${formatRatio(rttAverageMicros(oxideRttSqlx), rttAverageMicros(nativeRttSqlx))}`)
  lines.push(`- pglite-oxide + SQLx speed total vs vanilla PGlite + SQLx: ${formatRatio(speedTotalMicros(oxideSpeedSqlx), speedTotalMicros(nodeSpeedNodefsSqlx))}`)
  lines.push(`- pglite-oxide + SQLx speed total vs native pg + SQLx: ${formatRatio(speedTotalMicros(oxideSpeedSqlx), speedTotalMicros(nativeSpeedSqlx))}`)
  lines.push('')
  lines.push('## Speed Suite')
  lines.push('')
  lines.push('| ID | Test | native pg + SQLx | pglite-oxide + SQLx | vanilla PGlite + SQLx |')
  lines.push('|---|---|---:|---:|---:|')

  for (const test of oxideSpeedSqlx.tests) {
    const oxideSqlx = speedMaps.oxideSqlx.get(test.id).elapsedMicros
    const nativeSqlx = speedMaps.nativeSqlx.get(test.id).elapsedMicros
    const nodeNodefsSqlx = speedMaps.nodeNodefsSqlx.get(test.id).elapsedMicros
    lines.push(
      `| ${test.id} | ${test.label} | ${formatMillis(nativeSqlx / 1000)} | ${formatMillis(oxideSqlx / 1000)} | ${formatMillis(nodeNodefsSqlx / 1000)} |`,
    )
  }

  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- This matrix is meant for local reproducibility, not universal absolute claims. Different CPUs, filesystems, Node versions, and native Postgres builds will move the numbers.')
  lines.push('- The serial runner intentionally avoids parallel execution so disk caches, CPU scheduling, and memory pressure stay isolated by mode.')
  lines.push('- The SQLx-to-SQLx comparison to focus on in product docs is `native pg + SQLx` vs `pglite-oxide + SQLx` vs `vanilla PGlite + SQLx`.')
  lines.push('')

  await fs.writeFile(output, `${lines.join('\n')}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
