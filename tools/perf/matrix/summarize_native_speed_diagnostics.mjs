#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function usage() {
  console.error(`usage:
  summarize_native_speed_diagnostics.mjs --run-dir DIR --ids LIST --repeats N`)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      throw new Error(`unexpected argument: ${key}`)
    }
    const value = argv[index + 1]
    if (index + 1 < argv.length && !value.startsWith('--')) {
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
  if (!value || value === 'true') {
    throw new Error(`${key} is required`)
  }
  return value
}

function parseIds(value) {
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0) {
    throw new Error('--ids must contain at least one speed case id')
  }
  return ids
}

function parsePositiveInt(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function safeId(id) {
  return id.replaceAll('.', '_')
}

function percentile(values, p) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.round((sorted.length - 1) * p)
  return sorted[index]
}

function stats(values) {
  return {
    n: values.length,
    minMicros: percentile(values, 0),
    p50Micros: percentile(values, 0.5),
    p90Micros: percentile(values, 0.9),
    p95Micros: percentile(values, 0.95),
    p99Micros: percentile(values, 0.99),
    maxMicros: percentile(values, 1),
  }
}

function fmtMs(micros) {
  if (micros === null || micros === undefined) {
    return 'n/a'
  }
  return `${(micros / 1000).toFixed(3)}`
}

function fmtRatio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return 'n/a'
  }
  return `${(a / b).toFixed(3)}x`
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function firstCase(report, id, engine) {
  const found = report.cases?.find((item) => item.id === id)
  if (!found) {
    throw new Error(`${engine} diagnostic report missing case ${id}`)
  }
  return found
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = path.resolve(requireArg(args, '--run-dir'))
  const ids = parseIds(requireArg(args, '--ids'))
  const repeats = parsePositiveInt(requireArg(args, '--repeats'), '--repeats')

  const cases = []
  for (const id of ids) {
    const direct = []
    const nativePostgres = []
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const index = String(repeat).padStart(String(repeats).length, '0')
      const directReport = await readJson(
        path.join(runDir, 'direct', `native-liboliphaunt-speed-case-${safeId(id)}-${index}.json`),
      )
      const pgReport = await readJson(
        path.join(runDir, 'native-postgres', `native-postgres-speed-cases-${index}.json`),
      )
      direct.push(firstCase(directReport, id, 'native-liboliphaunt'))
      nativePostgres.push(firstCase(pgReport, id, 'native-postgres'))
    }

    const directElapsed = stats(direct.map((item) => item.elapsed_micros))
    const pgElapsed = stats(nativePostgres.map((item) => item.elapsed_micros))
    const directOpen = stats(direct.map((item) => item.open_micros).filter((item) => item !== null))
    const pgOpen = stats(nativePostgres.map((item) => item.open_micros).filter((item) => item !== null))
    const directSetup = stats(direct.map((item) => item.setup_micros))
    const pgSetup = stats(nativePostgres.map((item) => item.setup_micros))
    const directRss = stats(
      direct
        .map((item) => item.observed_server_peak_rss_bytes)
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.round(item / 1024 / 1024 * 1000)),
    )
    const pgRss = stats(
      nativePostgres
        .map((item) => item.observed_server_peak_rss_bytes)
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.round(item / 1024 / 1024 * 1000)),
    )

    cases.push({
      id,
      label: direct[0].label,
      repeats,
      operationCount: direct[0].operation_count,
      direct: {
        elapsed: directElapsed,
        open: directOpen,
        setup: directSetup,
        observedServerRssMbTimes1000: directRss,
        settings: direct[0].settings,
      },
      nativePostgres: {
        elapsed: pgElapsed,
        open: pgOpen,
        setup: pgSetup,
        observedServerRssMbTimes1000: pgRss,
        settings: nativePostgres[0].settings,
      },
      ratios: {
        elapsedP90: directElapsed.p90Micros / pgElapsed.p90Micros,
        elapsedP99: directElapsed.p99Micros / pgElapsed.p99Micros,
      },
    })
  }

  const summary = {
    schema: 'oliphaunt.native-speed-diagnostics.v1',
    runDir,
    ids,
    repeats,
    cases,
  }
  await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  const lines = []
  lines.push(`# Native Speed Diagnostics`)
  lines.push('')
  lines.push(`Run directory: \`${runDir}\``)
  lines.push('')
  lines.push('| ID | Test | n | Direct p50 ms | Direct p90 ms | Direct p99 ms | Native PG p50 ms | Native PG p90 ms | Native PG p99 ms | p90 ratio | p99 ratio | Direct open p90 ms | Native PG open p90 ms |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const item of cases) {
    lines.push(
      `| ${item.id} | ${item.label} | ${item.repeats} | ${fmtMs(item.direct.elapsed.p50Micros)} | ${fmtMs(item.direct.elapsed.p90Micros)} | ${fmtMs(item.direct.elapsed.p99Micros)} | ${fmtMs(item.nativePostgres.elapsed.p50Micros)} | ${fmtMs(item.nativePostgres.elapsed.p90Micros)} | ${fmtMs(item.nativePostgres.elapsed.p99Micros)} | ${fmtRatio(item.direct.elapsed.p90Micros, item.nativePostgres.elapsed.p90Micros)} | ${fmtRatio(item.direct.elapsed.p99Micros, item.nativePostgres.elapsed.p99Micros)} | ${fmtMs(item.direct.open.p90Micros)} | ${fmtMs(item.nativePostgres.open.p90Micros)} |`,
    )
  }
  lines.push('')
  lines.push('## Setup And RSS')
  lines.push('')
  lines.push('| ID | Direct setup p90 ms | Native PG setup p90 ms | Direct observed RSS p90 MB | Native PG observed RSS p90 MB |')
  lines.push('| --- | ---: | ---: | ---: | ---: |')
  for (const item of cases) {
    lines.push(
      `| ${item.id} | ${fmtMs(item.direct.setup.p90Micros)} | ${fmtMs(item.nativePostgres.setup.p90Micros)} | ${fmtMs(item.direct.observedServerRssMbTimes1000.p90Micros)} | ${fmtMs(item.nativePostgres.observedServerRssMbTimes1000.p90Micros)} |`,
    )
  }
  lines.push('')
  lines.push('NativeDirect diagnostics run one fresh process per case/repeat because direct mode owns one process-lifetime embedded backend.')
  await fs.writeFile(path.join(runDir, 'summary.md'), `${lines.join('\n')}\n`)
}

main().catch((error) => {
  usage()
  console.error(error)
  process.exit(1)
})
