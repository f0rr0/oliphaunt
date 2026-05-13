import { performance } from 'node:perf_hooks'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

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

function nowMicros() {
  return Math.round(performance.now() * 1000)
}

function elapsedMicros(startMicros) {
  return nowMicros() - startMicros
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const readyPath = requireArg(args, '--ready')
  const runId = requireArg(args, '--run-id')

  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, '../../..')
  const dataDir =
    args['--data-dir'] ??
    path.join(repoRoot, 'target/perf/node-bench/runtime', runId, 'pglite_nodefs_sqlx')

  await fs.mkdir(path.dirname(readyPath), { recursive: true })
  await fs.rm(readyPath, { force: true })
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.mkdir(dataDir, { recursive: true })

  const openStarted = nowMicros()
  const db = new PGlite(dataDir)
  await db.waitReady
  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 1,
  })
  await server.start()
  const openMicros = elapsedMicros(openStarted)

  const [host, port] = server.getServerConn().split(':')
  const databaseUrl = `postgresql://postgres:postgres@${host}:${port}/postgres?sslmode=disable`
  const ready = {
    databaseUrl,
    host,
    port: Number(port),
    dataDir,
    openMicros,
    node: process.version,
    package: '@electric-sql/pglite',
    version: '0.4.5',
    socketPackage: '@electric-sql/pglite-socket',
    socketVersion: '0.1.5',
  }
  await fs.writeFile(readyPath, `${JSON.stringify(ready, null, 2)}\n`)
  console.log(`PGlite NodeFS socket ready at ${host}:${port}`)

  let shuttingDown = false
  const stop = async () => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    await server.stop()
    await db.close()
  }

  await new Promise((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        resolve()
      })
    }
    process.once('disconnect', () => {
      resolve()
    })
  })
  await stop()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
