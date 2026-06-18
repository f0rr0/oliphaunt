#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const SOURCE_INPUTS = [
  { type: 'file', path: 'Cargo.lock' },
  { type: 'file', path: 'Cargo.toml' },
  { type: 'file', path: 'src/sdks/rust/Cargo.toml' },
  { type: 'dir', path: 'src/sdks/rust/src', extensions: ['.rs'] },
  { type: 'dir', path: 'src/sdks/rust/tests', extensions: ['.rs'] },
  { type: 'dir', path: 'src/runtimes/liboliphaunt/native/bin', extensions: ['.sh'] },
  { type: 'dir', path: 'src/runtimes/liboliphaunt/native/include', extensions: ['.h'] },
  { type: 'dir', path: 'src/runtimes/liboliphaunt/native/patches', extensions: ['.patch'] },
  { type: 'dir', path: 'src/runtimes/liboliphaunt/native/postgres18', extensions: ['.toml'] },
  { type: 'dir', path: 'src/runtimes/liboliphaunt/native/src', extensions: ['.c', '.h'] },
  { type: 'file', path: 'tools/perf/runner/Cargo.toml' },
  { type: 'dir', path: 'tools/perf/runner/src', extensions: ['.rs'] },
  { type: 'dir', path: 'tools/perf/matrix', extensions: ['.mjs', '.sh'] },
]

const BENCHMARK_ENV_KEYS = [
  'OLIPHAUNT_PGDATA_COPY_MODE',
  'OLIPHAUNT_RUNTIME_CACHE_DIR',
  'OLIPHAUNT_PERF_DURABILITY',
  'OLIPHAUNT_PERF_RUNTIME_FOOTPRINT',
  'OLIPHAUNT_PERF_STARTUP_GUCS',
  'OLIPHAUNT_STREAM_QUEUE_MAX_BYTES',
  'OLIPHAUNT_TIMEOUT_MS',
  'OLIPHAUNT_STACK_BYTES',
]

function usage() {
  console.error(`usage:
  native_oliphaunt_provenance.mjs write --run-dir DIR --repo-root DIR [options]
  native_oliphaunt_provenance.mjs verify --run-dir DIR [--repo-root DIR] [--require-release-evidence]

write options:
  --run-id ID
  --native-engines LIST
  --suites LIST
  --durability PROFILE
  --runtime-footprint PROFILE
  --startup-gucs LIST
  --rtt-iterations N
  --rtt-repeats N
  --prepared-rows N
  --prepared-repeats N
  --speed-repeats N
  --backup-repeats N
  --run-sqlite 0|1
  --run-prepared 0|1
  --release-evidence 0|1
  --partial-report 0|1
  --diagnostic-run 0|1
  --release-min-rtt-iterations N
  --release-min-rtt-repeats N
  --release-min-prepared-rows N
  --release-min-prepared-repeats N
  --release-min-speed-repeats N
  --release-min-backup-repeats N
  --pgdata-copy-mode MODE
  --liboliphaunt PATH
  --postgres-bin PATH
  --initdb-bin PATH
  --perf-runner PATH`)
}

function parseArgs(argv) {
  const command = argv[0]
  const args = {}
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      throw new Error(`unexpected argument: ${key}`)
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
  return { command, args }
}

function requireArg(args, key) {
  const value = args[key]
  if (!value) {
    throw new Error(`${key} is required`)
  }
  return value
}

function optionalPath(value) {
  return value && value !== 'true' ? path.resolve(value) : null
}

function numberArg(args, key) {
  const value = args[key]
  if (value === undefined) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be numeric`)
  }
  return parsed
}

function flagArg(args, key) {
  const value = args[key]
  if (value === undefined) {
    return null
  }
  return value === '1' || value === 'true'
}

function stringListArg(args, key) {
  const value = args[key]
  if (value === undefined || value === 'true') {
    return []
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function sameStringList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function repeatIndex(index, repeatCount) {
  return String(index).padStart(String(repeatCount).length, '0')
}

function benchmarkEnvironment(args) {
  const env = {}
  for (const key of BENCHMARK_ENV_KEYS) {
    env[key] = process.env[key] ?? null
  }
  env.OLIPHAUNT_PGDATA_COPY_MODE =
    args['--pgdata-copy-mode'] ?? env.OLIPHAUNT_PGDATA_COPY_MODE
  return env
}

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/')
}

async function fileSha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

function digestEntries(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.sha256)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function walkFiles(root, extensions) {
  const output = []

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!extensions || extensions.includes(path.extname(entry.name))) {
          output.push(absolute)
        }
      }
    }
  }

  await walk(root)
  return output.sort()
}

async function collectSource(repoRoot) {
  const paths = new Set()
  for (const input of SOURCE_INPUTS) {
    const absolute = path.join(repoRoot, input.path)
    const stat = await fs.stat(absolute)
    if (input.type === 'file') {
      if (!stat.isFile()) {
        throw new Error(`source input is not a file: ${input.path}`)
      }
      paths.add(input.path)
    } else {
      if (!stat.isDirectory()) {
        throw new Error(`source input is not a directory: ${input.path}`)
      }
      const files = await walkFiles(absolute, input.extensions)
      for (const file of files) {
        paths.add(posixRelative(repoRoot, file))
      }
    }
  }

  const entries = []
  for (const relativePath of [...paths].sort()) {
    const absolute = path.join(repoRoot, relativePath)
    const stat = await fs.stat(absolute)
    entries.push({
      path: relativePath,
      bytes: stat.size,
      sha256: await fileSha256(absolute),
    })
  }

  return {
    inputs: SOURCE_INPUTS,
    sourceSetSha256: digestEntries(entries),
    entries,
  }
}

async function hashDirectory(root) {
  const files = await walkFiles(root)
  const entries = []
  let bytes = 0
  for (const file of files) {
    const stat = await fs.lstat(file)
    const relativeFile = posixRelative(root, file)
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file)
      const targetBytes = Buffer.byteLength(target)
      bytes += targetBytes
      entries.push({
        path: relativeFile,
        kind: 'symlink',
        bytes: targetBytes,
        sha256: createHash('sha256').update(`symlink\0${target}`).digest('hex'),
      })
      continue
    }
    bytes += stat.size
    entries.push({
      path: relativeFile,
      kind: 'file',
      bytes: stat.size,
      sha256: await fileSha256(file),
    })
  }
  return {
    kind: 'directory',
    bytes,
    fileCount: entries.length,
    sha256: digestEntries(entries),
  }
}

async function hashArtifact(name, artifactPath) {
  const stat = await fs.stat(artifactPath)
  if (stat.isDirectory()) {
    const directory = await hashDirectory(artifactPath)
    return {
      name,
      path: artifactPath,
      ...directory,
    }
  }
  if (!stat.isFile()) {
    throw new Error(`artifact is neither a file nor directory: ${artifactPath}`)
  }
  return {
    name,
    path: artifactPath,
    kind: 'file',
    bytes: stat.size,
    sha256: await fileSha256(artifactPath),
  }
}

async function collectArtifacts(args) {
  const liboliphaunt = optionalPath(args['--liboliphaunt'])
  const postgresBin = optionalPath(args['--postgres-bin'])
  const initdbBin = optionalPath(args['--initdb-bin'])
  const perfRunner = optionalPath(args['--perf-runner'])
  const candidates = [
    ['liboliphaunt-native', liboliphaunt],
    ['postgres', postgresBin],
    ['initdb', initdbBin],
    ['oliphaunt-perf', perfRunner],
  ]

  if (liboliphaunt) {
    candidates.push(['embedded-modules', path.join(path.dirname(liboliphaunt), 'modules')])
  }
  if (postgresBin) {
    candidates.push(['native-postgres-install', path.dirname(path.dirname(postgresBin))])
  }

  const artifacts = []
  for (const [name, artifactPath] of candidates) {
    if (!artifactPath) {
      continue
    }
    try {
      artifacts.push(await hashArtifact(name, artifactPath))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        artifacts.push({
          name,
          path: artifactPath,
          missing: true,
          sha256: null,
        })
      } else {
        throw error
      }
    }
  }
  return artifacts
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) {
    return null
  }
  return result.stdout.trim()
}

function gitMetadata(repoRoot) {
  const status = runGit(repoRoot, ['status', '--porcelain', '--untracked-files=no']) ?? ''
  return {
    root: repoRoot,
    commit: runGit(repoRoot, ['rev-parse', 'HEAD']),
    branch: runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyTracked: status.length > 0,
    trackedStatusLineCount: status ? status.split('\n').length : 0,
  }
}

async function writeProvenance(args) {
  const runDir = path.resolve(requireArg(args, '--run-dir'))
  const repoRoot = path.resolve(args['--repo-root'] ?? process.cwd())
  const source = await collectSource(repoRoot)
  const artifacts = await collectArtifacts(args)
  const provenance = {
    schema: 'oliphaunt.native-perf.provenance.v1',
    generatedAt: new Date().toISOString(),
    runId: args['--run-id'] ?? path.basename(runDir),
    repo: gitMetadata(repoRoot),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: os.release(),
      host: os.hostname(),
    },
    benchmark: {
      nativeEngines: stringListArg(args, '--native-engines'),
      suites: stringListArg(args, '--suites'),
      durability: args['--durability'] ?? null,
      runtimeFootprint: args['--runtime-footprint'] ?? null,
      startupGucs: stringListArg(args, '--startup-gucs'),
      rttIterations: numberArg(args, '--rtt-iterations'),
      rttRepeats: numberArg(args, '--rtt-repeats'),
      preparedRows: numberArg(args, '--prepared-rows'),
      preparedRepeats: numberArg(args, '--prepared-repeats'),
      speedRepeats: numberArg(args, '--speed-repeats'),
      backupRepeats: numberArg(args, '--backup-repeats'),
      pgdataCopyMode: args['--pgdata-copy-mode'] ?? null,
      environment: benchmarkEnvironment(args),
      includes: {
        sqlite: flagArg(args, '--run-sqlite'),
        preparedUpdates: flagArg(args, '--run-prepared'),
      },
      quality: {
        releaseEvidence: flagArg(args, '--release-evidence'),
        partialReport: flagArg(args, '--partial-report'),
        diagnosticRun: flagArg(args, '--diagnostic-run'),
        releaseMinimums: {
          rttIterations: numberArg(args, '--release-min-rtt-iterations'),
          rttRepeats: numberArg(args, '--release-min-rtt-repeats'),
          preparedRows: numberArg(args, '--release-min-prepared-rows'),
          preparedRepeats: numberArg(args, '--release-min-prepared-repeats'),
          speedRepeats: numberArg(args, '--release-min-speed-repeats'),
          backupRepeats: numberArg(args, '--release-min-backup-repeats'),
        },
      },
    },
    source,
    artifacts,
  }
  await fs.mkdir(runDir, { recursive: true })
  const file = path.join(runDir, 'provenance.json')
  await fs.writeFile(file, `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(file)
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function readRequiredJson(runDir, relativeFile, failures) {
  const file = path.join(runDir, relativeFile)
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      failures.push(`missing benchmark output: ${relativeFile}`)
      return null
    }
    failures.push(`invalid benchmark JSON output ${relativeFile}: ${error.message}`)
    return null
  }
}

async function requireNonEmptyFile(runDir, relativeFile, failures) {
  const file = path.join(runDir, relativeFile)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) {
      failures.push(`benchmark output is not a file: ${relativeFile}`)
    } else if (stat.size === 0) {
      failures.push(`benchmark output is empty: ${relativeFile}`)
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      failures.push(`missing benchmark output: ${relativeFile}`)
    } else {
      throw error
    }
  }
}

function compareSource(expected, actual) {
  const failures = []
  if (expected.sourceSetSha256 !== actual.sourceSetSha256) {
    failures.push(
      `source set changed: expected ${expected.sourceSetSha256}, got ${actual.sourceSetSha256}`,
    )
  }

  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]))
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]))
  for (const [entryPath, entry] of expectedByPath) {
    const current = actualByPath.get(entryPath)
    if (!current) {
      failures.push(`source missing: ${entryPath}`)
    } else if (current.sha256 !== entry.sha256) {
      failures.push(`source changed: ${entryPath}`)
    }
  }
  for (const entryPath of actualByPath.keys()) {
    if (!expectedByPath.has(entryPath)) {
      failures.push(`source added: ${entryPath}`)
    }
  }
  return failures
}

async function compareArtifacts(expectedArtifacts) {
  const failures = []
  const checks = []
  for (const expected of expectedArtifacts ?? []) {
    if (expected.missing) {
      checks.push(`artifact skipped because original was missing: ${expected.name}`)
      continue
    }
    try {
      const actual = await hashArtifact(expected.name, expected.path)
      if (actual.sha256 === expected.sha256) {
        checks.push(`artifact ok: ${expected.name}`)
      } else {
        failures.push(
          `artifact changed: ${expected.name} expected ${expected.sha256}, got ${actual.sha256}`,
        )
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        failures.push(`artifact missing: ${expected.name} (${expected.path})`)
      } else {
        throw error
      }
    }
  }
  return { failures, checks }
}

function findBenchmarkRun(report, suite, mode) {
  if (!Array.isArray(report?.runs)) {
    return null
  }
  return report.runs.find((run) => run.suite === suite && run.mode === mode) ?? null
}

function validateBenchmarkRun(name, run, suite, mode, failures) {
  if (!run) {
    failures.push(`benchmark output ${name}.json is missing run suite=${suite} mode=${mode}`)
    return
  }
  if (!Array.isArray(run.tests) || run.tests.length === 0) {
    failures.push(`benchmark output ${name}.json run ${suite}/${mode} has no tests`)
    return
  }
  for (const test of run.tests) {
    const id = test?.id ?? '<unknown>'
    for (const field of ['elapsedMicros', 'p50Micros', 'p90Micros', 'p95Micros', 'p99Micros']) {
      if (!finiteNumber(test[field])) {
        failures.push(`benchmark output ${name}.json ${suite}/${mode}/${id} is missing ${field}`)
      }
    }
    if (!finiteNumber(test.sampleCount) || test.sampleCount < 1) {
      failures.push(`benchmark output ${name}.json ${suite}/${mode}/${id} has invalid sampleCount`)
    }
  }
}

async function benchmarkReportFailures(runDir, name, expectedRuns) {
  const failures = []
  const report = await readRequiredJson(runDir, `${name}.json`, failures)
  await requireNonEmptyFile(runDir, `${name}.resource.txt`, failures)
  if (!report) {
    return failures
  }
  if (!Array.isArray(report.runs)) {
    failures.push(`benchmark output ${name}.json does not contain a runs array`)
    return failures
  }
  for (const expected of expectedRuns) {
    validateBenchmarkRun(
      name,
      findBenchmarkRun(report, expected.suite, expected.mode),
      expected.suite,
      expected.mode,
      failures,
    )
  }
  return failures
}

function validatePreparedRun(name, run, mode, failures) {
  if (!run) {
    failures.push(`benchmark output ${name}.json is missing prepared-update mode=${mode}`)
    return
  }
  if (!Array.isArray(run.tests) || run.tests.length === 0) {
    failures.push(`benchmark output ${name}.json prepared mode ${mode} has no tests`)
    return
  }
  for (const test of run.tests) {
    const id = test?.id ?? '<unknown>'
    for (const field of [
      'openMicros',
      'connectMicros',
      'setupMicros',
      'elapsedMicros',
      'operationCount',
      'averageMicros',
    ]) {
      if (!finiteNumber(test[field])) {
        failures.push(`benchmark output ${name}.json ${mode}/${id} is missing ${field}`)
      }
    }
  }
}

async function preparedReportFailures(runDir, name, expectedModes) {
  const failures = []
  const report = await readRequiredJson(runDir, `${name}.json`, failures)
  await requireNonEmptyFile(runDir, `${name}.resource.txt`, failures)
  if (!report) {
    return failures
  }
  if (!Array.isArray(report.runs)) {
    failures.push(`benchmark output ${name}.json does not contain a runs array`)
    return failures
  }
  for (const mode of expectedModes) {
    const run = report.runs.find((entry) => entry.mode === mode) ?? null
    validatePreparedRun(name, run, mode, failures)
  }
  return failures
}

async function artifactSizesFailures(runDir) {
  const failures = []
  const report = await readRequiredJson(runDir, 'artifact-sizes.json', failures)
  if (!report) {
    return failures
  }
  if (!Array.isArray(report.artifacts)) {
    failures.push('artifact-sizes.json does not contain an artifacts array')
    return failures
  }
  const artifacts = new Map(report.artifacts.map((entry) => [entry.name, entry]))
  for (const name of ['liboliphaunt-native', 'embedded-modules', 'native-postgres-install']) {
    const artifact = artifacts.get(name)
    if (!artifact) {
      failures.push(`artifact-sizes.json is missing artifact ${name}`)
    } else if (!finiteNumber(artifact.bytes) || artifact.bytes < 0) {
      failures.push(`artifact-sizes.json artifact ${name} has invalid bytes`)
    }
  }
  return failures
}

function nativeBenchmarkMode(engine) {
  return `native_liboliphaunt_${engine}`
}

function nativeCaseName(engine, suite) {
  const directNames = {
    rtt: 'native-liboliphaunt-rtt',
    speed: 'native-liboliphaunt-speed',
    streaming: 'native-liboliphaunt-streaming',
    prepared: 'native-liboliphaunt-prepared-direct',
    backup: 'native-liboliphaunt-backup',
  }
  const prefixedNames = {
    rtt: `native-liboliphaunt-${engine}-rtt`,
    speed: `native-liboliphaunt-${engine}-speed`,
    streaming: `native-liboliphaunt-${engine}-streaming`,
    prepared: `native-liboliphaunt-prepared-${engine}`,
    backup: `native-liboliphaunt-${engine}-backup`,
  }
  return engine === 'direct' ? directNames[suite] : prefixedNames[suite]
}

function nativePreparedModes(engine) {
  const mode = nativeBenchmarkMode(engine)
  return [`${mode}_prepared`, `${mode}_pipelined_prepared`]
}

async function benchmarkReleaseOutputFailures(runDir, provenance) {
  const benchmark = provenance.benchmark ?? {}
  const failures = []
  failures.push(...(await artifactSizesFailures(runDir)))
  await requireNonEmptyFile(runDir, 'report.md', failures)

  for (const engine of ['direct', 'broker', 'server']) {
    const mode = nativeBenchmarkMode(engine)
    for (const suite of ['rtt', 'speed', 'streaming']) {
      failures.push(
        ...(await benchmarkReportFailures(runDir, nativeCaseName(engine, suite), [
          { suite, mode },
        ])),
      )
    }
    failures.push(
      ...(await benchmarkReportFailures(runDir, nativeCaseName(engine, 'backup'), [
        { suite: 'backup-restore', mode },
      ])),
    )
    failures.push(
      ...(await preparedReportFailures(
        runDir,
        nativeCaseName(engine, 'prepared'),
        nativePreparedModes(engine),
      )),
    )
  }

  failures.push(
    ...(await benchmarkReportFailures(runDir, 'native-postgres-tokio-all', [
      { suite: 'rtt', mode: 'native_postgres' },
      { suite: 'speed', mode: 'native_postgres' },
    ])),
  )
  failures.push(
    ...(await benchmarkReportFailures(runDir, 'native-postgres-sqlx-all', [
      { suite: 'rtt', mode: 'native_postgres_sqlx' },
      { suite: 'speed', mode: 'native_postgres_sqlx' },
    ])),
  )
  failures.push(
    ...(await benchmarkReportFailures(runDir, 'native-postgres-streaming', [
      { suite: 'streaming', mode: 'native_postgres_raw' },
    ])),
  )
  failures.push(
    ...(await benchmarkReportFailures(runDir, 'sqlite-speed', [
      { suite: 'speed', mode: 'sqlite' },
    ])),
  )
  failures.push(
    ...(await benchmarkReportFailures(runDir, 'native-postgres-backup', [
      { suite: 'backup-restore', mode: 'native_postgres' },
      { suite: 'backup-restore', mode: 'native_postgres_physical' },
    ])),
  )
  failures.push(
    ...(await benchmarkReportFailures(runDir, 'sqlite-backup', [
      { suite: 'backup-restore', mode: 'sqlite' },
    ])),
  )
  failures.push(
    ...(await preparedReportFailures(runDir, 'native-postgres-prepared', [
      'native_postgres_tokio_prepared',
      'native_postgres_tokio_pipelined_prepared',
    ])),
  )

  for (let index = 1; index <= benchmark.rttRepeats; index += 1) {
    const repeat = repeatIndex(index, benchmark.rttRepeats)
    for (const engine of ['direct', 'broker', 'server']) {
      failures.push(
        ...(await benchmarkReportFailures(
          runDir,
          `repeats/${nativeCaseName(engine, 'rtt')}-${repeat}`,
          [{ suite: 'rtt', mode: nativeBenchmarkMode(engine) }],
        )),
      )
    }
    failures.push(
      ...(await benchmarkReportFailures(runDir, `repeats/native-postgres-tokio-rtt-${repeat}`, [
        { suite: 'rtt', mode: 'native_postgres' },
      ])),
    )
  }

  for (let index = 1; index <= benchmark.speedRepeats; index += 1) {
    const repeat = repeatIndex(index, benchmark.speedRepeats)
    for (const engine of ['direct', 'broker', 'server']) {
      failures.push(
        ...(await benchmarkReportFailures(
          runDir,
          `repeats/${nativeCaseName(engine, 'speed')}-${repeat}`,
          [{ suite: 'speed', mode: nativeBenchmarkMode(engine) }],
        )),
      )
    }
    failures.push(
      ...(await benchmarkReportFailures(runDir, `repeats/native-postgres-tokio-speed-${repeat}`, [
        { suite: 'speed', mode: 'native_postgres' },
      ])),
    )
    failures.push(
      ...(await benchmarkReportFailures(runDir, `repeats/sqlite-speed-${repeat}`, [
        { suite: 'speed', mode: 'sqlite' },
      ])),
    )
  }

  for (let index = 1; index <= benchmark.preparedRepeats; index += 1) {
    const repeat = repeatIndex(index, benchmark.preparedRepeats)
    failures.push(
      ...(await preparedReportFailures(runDir, `repeats/native-postgres-prepared-${repeat}`, [
        'native_postgres_tokio_prepared',
        'native_postgres_tokio_pipelined_prepared',
      ])),
    )
    for (const engine of ['direct', 'broker', 'server']) {
      failures.push(
        ...(await preparedReportFailures(
          runDir,
          `repeats/${nativeCaseName(engine, 'prepared')}-${repeat}`,
          nativePreparedModes(engine),
        )),
      )
    }
  }

  for (let index = 1; index <= benchmark.backupRepeats; index += 1) {
    const repeat = repeatIndex(index, benchmark.backupRepeats)
    for (const engine of ['direct', 'broker', 'server']) {
      failures.push(
        ...(await benchmarkReportFailures(
          runDir,
          `repeats/${nativeCaseName(engine, 'backup')}-${repeat}`,
          [{ suite: 'backup-restore', mode: nativeBenchmarkMode(engine) }],
        )),
      )
    }
    failures.push(
      ...(await benchmarkReportFailures(runDir, `repeats/native-postgres-backup-${repeat}`, [
        { suite: 'backup-restore', mode: 'native_postgres' },
        { suite: 'backup-restore', mode: 'native_postgres_physical' },
      ])),
    )
    failures.push(
      ...(await benchmarkReportFailures(runDir, `repeats/sqlite-backup-${repeat}`, [
        { suite: 'backup-restore', mode: 'sqlite' },
      ])),
    )
  }

  return failures
}

function benchmarkReleaseFailures(provenance) {
  const benchmark = provenance.benchmark ?? {}
  const quality = benchmark.quality ?? {}
  const minimums = quality.releaseMinimums ?? {
    rttIterations: 100,
    rttRepeats: 10,
    preparedRows: 25000,
    preparedRepeats: 10,
    speedRepeats: 20,
    backupRepeats: 10,
  }
  const failures = []

  if (quality.releaseEvidence !== true) {
    failures.push('benchmark provenance is not marked as releaseEvidence=true')
  }
  if (quality.partialReport !== false) {
    failures.push('benchmark provenance is partial; release evidence must cover the default matrix')
  }
  if (quality.diagnosticRun !== false) {
    failures.push('benchmark provenance is diagnostic; release evidence must come from the default matrix')
  }
  if (!sameStringList(benchmark.nativeEngines, ['direct', 'broker', 'server'])) {
    failures.push(
      `benchmark native engines are ${JSON.stringify(benchmark.nativeEngines)}, expected ["direct","broker","server"]`,
    )
  }
  if (!sameStringList(benchmark.suites, ['rtt', 'speed', 'streaming', 'prepared', 'backup'])) {
    failures.push(
      `benchmark suites are ${JSON.stringify(benchmark.suites)}, expected ["rtt","speed","streaming","prepared","backup"]`,
    )
  }
  if (benchmark.includes?.sqlite !== true) {
    failures.push('benchmark provenance does not include the SQLite embedded control')
  }
  if (benchmark.includes?.preparedUpdates !== true) {
    failures.push('benchmark provenance does not include prepared-update suites')
  }

  const numericChecks = [
    ['rttIterations', 'RTT samples'],
    ['rttRepeats', 'RTT repeats'],
    ['preparedRows', 'prepared-update rows'],
    ['preparedRepeats', 'prepared-update repeats'],
    ['speedRepeats', 'speed repeats'],
    ['backupRepeats', 'backup/restore repeats'],
  ]
  for (const [key, label] of numericChecks) {
    const actual = benchmark[key]
    const minimum = minimums[key]
    if (!Number.isFinite(actual) || !Number.isFinite(minimum) || actual < minimum) {
      failures.push(`${label} ${actual ?? 'missing'} is below release minimum ${minimum ?? 'missing'}`)
    }
  }

  return failures
}

async function verifyProvenance(args) {
  const runDir = path.resolve(requireArg(args, '--run-dir'))
  const provenance = await readJson(path.join(runDir, 'provenance.json'))
  const repoRoot = path.resolve(args['--repo-root'] ?? provenance.repo?.root ?? process.cwd())
  const source = await collectSource(repoRoot)
  const sourceFailures = compareSource(provenance.source, source)
  const artifactResult = await compareArtifacts(provenance.artifacts)
  const requireReleaseEvidence = flagArg(args, '--require-release-evidence') === true
  const releaseFailures = requireReleaseEvidence ? benchmarkReleaseFailures(provenance) : []
  const releaseOutputFailures = requireReleaseEvidence
    ? await benchmarkReleaseOutputFailures(runDir, provenance)
    : []
  const failures = [
    ...sourceFailures,
    ...artifactResult.failures,
    ...releaseFailures,
    ...releaseOutputFailures,
  ]

  console.log(`run: ${provenance.runId}`)
  console.log(`generated: ${provenance.generatedAt}`)
  console.log(`repo commit: ${provenance.repo?.commit ?? 'n/a'}`)
  console.log(`source set: ${provenance.source?.sourceSetSha256 ?? 'n/a'}`)
  console.log(
    `release evidence: ${provenance.benchmark?.quality?.releaseEvidence === true ? 'yes' : 'no'}`,
  )
  console.log(
    `partial report: ${provenance.benchmark?.quality?.partialReport === true ? 'yes' : 'no'}`,
  )
  console.log(
    `diagnostic run: ${provenance.benchmark?.quality?.diagnosticRun === true ? 'yes' : 'no'}`,
  )
  for (const check of artifactResult.checks) {
    console.log(check)
  }

  if (failures.length > 0) {
    console.error('\nprovenance verification failed:')
    for (const failure of failures.slice(0, 40)) {
      console.error(`- ${failure}`)
    }
    if (failures.length > 40) {
      console.error(`- ... ${failures.length - 40} more`)
    }
    process.exitCode = 1
    return
  }

  console.log('provenance verification passed')
}

const { command, args } = parseArgs(process.argv.slice(2))

try {
  if (command === 'write') {
    await writeProvenance(args)
  } else if (command === 'verify') {
    await verifyProvenance(args)
  } else {
    usage()
    process.exitCode = 2
  }
} catch (error) {
  console.error(error)
  usage()
  process.exitCode = 1
}
