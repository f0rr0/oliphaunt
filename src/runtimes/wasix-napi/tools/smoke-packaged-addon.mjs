#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { portableCommand } from "./portable-command.mjs";

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGE_ROOT = path.join(WORKSPACE_ROOT, "src/runtimes/wasix-napi");
const PACKAGE_OUTPUT = path.join(WORKSPACE_ROOT, "target/oliphaunt-wasix-napi/npm-packages");
const BINARY = "oliphaunt_wasix_napi.node";
const PGWIRE_CLIENT = pathToFileURL(
  path.join(WORKSPACE_ROOT, "src/bindings/wasix-ts/tools/pgwire-client.mjs"),
).href;
const ELECTRON_ASAR_VERSION = "3.4.1";
const ELECTRON_VERSION = "39.2.5";
const TARGET_PACKAGES = Object.freeze({
  "linux-arm64-gnu": "linux-arm64-gnu",
  "linux-x64-gnu": "linux-x64-gnu",
  "macos-arm64": "darwin-arm64",
  "windows-x64-msvc": "win32-x64-msvc",
});

function parseArguments(argv) {
  const options = { packageManager: "pnpm" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--package-manager", "--runtime", "--target"].includes(argument) || !value) {
      throw new Error(
        "usage: smoke-packaged-addon.mjs --target TARGET --runtime node|bun|deno|electron [--package-manager npm|pnpm]",
      );
    }
    options[argument.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (!Object.hasOwn(TARGET_PACKAGES, options.target)) {
    throw new Error(`unsupported WASIX Node-API smoke target ${options.target}`);
  }
  if (!["bun", "deno", "electron", "node"].includes(options.runtime)) {
    throw new Error(`unsupported WASIX Node-API smoke runtime ${options.runtime}`);
  }
  if (!["npm", "pnpm"].includes(options.packageManager)) {
    throw new Error(`unsupported WASIX Node-API smoke package manager ${options.packageManager}`);
  }
  return options;
}

async function run(command, args, cwd, extraEnv = {}) {
  const invocation = portableCommand(command, args);
  return execFileAsync(invocation.command, invocation.args, {
    cwd,
    env: {
      ...process.env,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      PNPM_CONFIG_IGNORE_SCRIPTS: "true",
      ...extraEnv,
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
}

function tarballName(manifest) {
  return `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
}

function runtimeCommand(runtime, verification) {
  if (runtime === "node") return [process.execPath, [verification], {}];
  if (runtime === "bun") {
    return [path.join(WORKSPACE_ROOT, "tools/dev/bun.sh"), [verification], {}];
  }
  if (runtime === "deno") {
    return [
      path.join(WORKSPACE_ROOT, "tools/dev/deno.sh"),
      [
        "run",
        "--allow-env",
        "--allow-ffi",
        "--allow-net=127.0.0.1",
        "--allow-read",
        verification,
      ],
      {},
    ];
  }
  return [
    "npm",
    ["exec", "--yes", `--package=electron@${ELECTRON_VERSION}`, "--", "electron", verification],
    {
      ELECTRON_RUN_AS_NODE: "1",
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
      PNPM_CONFIG_IGNORE_SCRIPTS: "false",
    },
  ];
}

async function runElectronAsarSmoke(scratch, carrierManifest) {
  const require = createRequire(path.join(scratch, "package.json"));
  const installedManifest = require.resolve(`${carrierManifest.name}/package.json`);
  const installedCarrier = await realpath(path.dirname(installedManifest));
  const source = path.join(scratch, "asar-source");
  const archive = path.join(scratch, "app.asar");
  const scopedDirectory = carrierManifest.name;
  const archivedCarrier = path.join(source, "node_modules", scopedDirectory);
  await mkdir(path.dirname(archivedCarrier), { recursive: true });
  await cp(installedCarrier, archivedCarrier, { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    `${JSON.stringify({ name: "oliphaunt-wasix-napi-asar-smoke", main: "main.cjs" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(source, "main.cjs"),
    `const addonPath = require.resolve(${JSON.stringify(`${carrierManifest.name}/${BINARY}`)});
if (!addonPath.includes('app.asar')) {
  throw new Error('ASAR smoke resolved the addon outside app.asar: ' + addonPath);
}
const addon = require(addonPath);
if (
  addon.addonAbiVersion() !== 1 ||
  addon.nodeApiVersion() !== 8 ||
  JSON.stringify(addon.supportedProfiles()) !== JSON.stringify(['standard', 'icu'])
) {
  throw new Error('ASAR-unpacked addon reports incompatible metadata');
}
console.log('oliphaunt-wasix-napi-asar-unpacked:PASS');
`,
  );
  await run(
    "npm",
    [
      "exec",
      "--yes",
      `--package=@electron/asar@${ELECTRON_ASAR_VERSION}`,
      "--",
      "asar",
      "pack",
      source,
      archive,
      "--unpack",
      "**/prebuilds/**",
    ],
    scratch,
  );

  const unpackedBinary = path.join(
    `${archive}.unpacked`,
    "node_modules",
    scopedDirectory,
    "prebuilds",
    BINARY,
  );
  const installedPrebuilds = path.join(installedCarrier, "prebuilds");
  const unpackedPrebuilds = path.dirname(unpackedBinary);
  const packagedCompanions = await readdir(installedPrebuilds);
  await Promise.all(
    packagedCompanions.map((name) => access(path.join(unpackedPrebuilds, name))),
  );
  const heldBinary = `${unpackedBinary}.missing`;
  const verification = path.join(archive, "main.cjs");
  const [command, args, env] = runtimeCommand("electron", verification);
  await rename(unpackedBinary, heldBinary);
  let missingCompanionRejected = false;
  try {
    await run(command, args, scratch, env);
  } catch {
    missingCompanionRejected = true;
  } finally {
    await rename(heldBinary, unpackedBinary);
  }
  if (!missingCompanionRejected) {
    throw new Error("Electron loaded an ASAR-unpacked addon without its unpacked .node companion");
  }

  const { stdout } = await run(command, args, scratch, env);
  if (!stdout.includes("oliphaunt-wasix-napi-asar-unpacked:PASS")) {
    throw new Error(`Electron ASAR-unpacked smoke returned unexpected output: ${stdout.trim()}`);
  }
}

async function runWorkerUnloadSmoke(scratch, carrierManifest, runtime) {
  const verification = path.join(scratch, "worker-unload.mjs");
  await writeFile(
    verification,
    `import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const addonPath = require.resolve(${JSON.stringify(`${carrierManifest.name}/${BINARY}`)});
const openOptions = ${JSON.stringify({
  profile: "standard",
  storage: { kind: "memory" },
  username: "postgres",
  database: "postgres",
  startupGucs: {},
  extensions: [],
})};
const naturalExitSource = [
  "import { createRequire } from 'node:module';",
  "import { parentPort, workerData } from 'node:worker_threads';",
  "const addon = createRequire(workerData.addonPath)(workerData.addonPath);",
  "const database = addon.NativeWasixDatabase.open(workerData.openOptions);",
  "try {",
  "  const query = new TextEncoder().encode('SELECT 42::text\\0');",
  "  const request = new Uint8Array(5 + query.length);",
  "  request[0] = 0x51;",
  "  new DataView(request.buffer).setUint32(1, 4 + query.length, false);",
  "  request.set(query, 5);",
  "  const response = database.execProtocolRaw(request);",
  "  if (!new TextDecoder().decode(response).includes('42')) throw new Error('worker query omitted 42');",
  "} finally {",
  "  database.close();",
  "}",
  "if (!database.closed) throw new Error('worker direct database did not close');",
  "parentPort.postMessage('closed');",
  "if (workerData.runtime === 'bun') process.exit(0);",
  "else {",
  "  parentPort.close?.();",
  "  parentPort.unref();",
  "}",
].join('\\n');
const terminateSource = [
  "import { createRequire } from 'node:module';",
  "import { parentPort, workerData } from 'node:worker_threads';",
  "const addon = createRequire(workerData.addonPath)(workerData.addonPath);",
  "globalThis.database = addon.NativeWasixDatabase.open(workerData.openOptions);",
  "parentPort.postMessage('opened');",
  "setInterval(() => undefined, 60_000);",
].join('\\n');

function spawn(source, name) {
  return new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), {
    name,
    workerData: { addonPath, openOptions, runtime: ${JSON.stringify(runtime)} },
  });
}

async function awaitNaturalExit(iteration) {
  const worker = spawn(naturalExitSource, 'oliphaunt-wasix-direct-unload-' + iteration);
  let exitObserved = false;
  try {
    await new Promise((resolve, reject) => {
      let message;
      worker.once('message', (value) => {
        message = value;
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        exitObserved = true;
        if (code !== 0) reject(new Error('direct worker exited with code ' + code));
        else if (message !== 'closed') reject(new Error('direct worker omitted close acknowledgement'));
        else resolve();
      });
    });
  } finally {
    // Forced termination is only failure cleanup. Bun does not settle a
    // redundant terminate() after a Worker has emitted its exit event.
    if (!exitObserved) await worker.terminate();
  }
}

for (let iteration = 1; iteration <= 20; iteration += 1) {
  await awaitNaturalExit(iteration);
}

const terminated = spawn(terminateSource, 'oliphaunt-wasix-direct-terminate-after-open');
await new Promise((resolve, reject) => {
  terminated.once('message', (message) => {
    if (message !== 'opened') {
      reject(new Error('terminate-after-open worker returned an unexpected message'));
      return;
    }
    void terminated.terminate().then(resolve, reject);
  });
  terminated.once('error', reject);
});

console.log(${JSON.stringify(`oliphaunt-wasix-napi-worker-unload-${runtime}:PASS`)});
`,
  );
  const [command, args, env] = runtimeCommand(runtime, verification);
  const { stdout } = await run(command, args, scratch, env);
  const marker = `oliphaunt-wasix-napi-worker-unload-${runtime}:PASS`;
  if (!stdout.includes(marker)) {
    throw new Error(`${runtime} Worker unload smoke returned unexpected output: ${stdout.trim()}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const carrierDirectory = TARGET_PACKAGES[options.target];
  const carrierManifest = JSON.parse(
    await readFile(path.join(PACKAGE_ROOT, "packages", carrierDirectory, "package.json"), "utf8"),
  );
  const tarball = path.join(PACKAGE_OUTPUT, tarballName(carrierManifest));
  await readFile(tarball);

  const scratch = await mkdtemp(path.join(tmpdir(), `oliphaunt-wasix-napi-${options.runtime}-`));
  try {
    await writeFile(
      path.join(scratch, "package.json"),
      `${JSON.stringify({
        name: "oliphaunt-wasix-napi-smoke",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { [carrierManifest.name]: pathToFileURL(tarball).href },
      }, null, 2)}\n`,
    );
    if (options.packageManager === "pnpm") {
      await writeFile(
        path.join(scratch, "pnpm-workspace.yaml"),
        "packages:\n  - .\nminimumReleaseAge: 0\nallowBuilds: {}\n",
      );
      await run("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], scratch);
    } else {
      await run(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
        scratch,
      );
    }

    await runWorkerUnloadSmoke(scratch, carrierManifest, options.runtime);

    const verification = path.join(scratch, "verify.mjs");
    await writeFile(
      verification,
      `import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const {
  connect,
  onceClosed,
  onceConnected,
  readExchange,
  simpleQuery: wireSimpleQuery,
  startupPacket,
} = await import(${JSON.stringify(PGWIRE_CLIENT)});

const require = createRequire(import.meta.url);
const packageName = ${JSON.stringify(carrierManifest.name)};
const expectedTarget = ${JSON.stringify(options.target)};
const expectedElectron = ${JSON.stringify(ELECTRON_VERSION)};
const manifestPath = require.resolve(packageName + '/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const prebuilds = join(dirname(manifestPath), 'prebuilds');
const nativeFiles = readdirSync(prebuilds).filter((name) => name.endsWith('.node'));
if (
  manifest.name !== packageName ||
  manifest.oliphaunt?.target !== expectedTarget ||
  manifest.oliphaunt?.addonAbiVersion !== 1 ||
  manifest.oliphaunt?.nodeApiVersion !== 8 ||
  JSON.stringify(manifest.oliphaunt?.profiles) !== JSON.stringify(['standard', 'icu']) ||
  JSON.stringify(nativeFiles) !== JSON.stringify([${JSON.stringify(BINARY)}])
) {
  throw new Error('installed WASIX Node-API carrier has incompatible metadata or binary inventory');
}
const addon = require(packageName + '/${BINARY}');
for (const name of [
  'addonAbiVersion',
  'extensionIdentity',
  'nodeApiVersion',
  'payloadIdentity',
  'restore',
  'restoreDirect',
  'runtimeVersion',
  'supportedProfiles',
  'toolIdentity',
]) {
  if (typeof addon[name] !== 'function') throw new Error('addon is missing function ' + name);
}
if (
  addon.addonAbiVersion() !== manifest.oliphaunt.addonAbiVersion ||
  addon.nodeApiVersion() !== manifest.oliphaunt.nodeApiVersion ||
  addon.runtimeVersion() !== manifest.oliphaunt.runtimeVersion ||
  JSON.stringify(addon.supportedProfiles()) !== JSON.stringify(manifest.oliphaunt.profiles)
) {
  throw new Error('addon self-reported metadata differs from its carrier');
}
for (const constructor of ['NativeWasixActorDatabase', 'NativeWasixDatabase']) {
  if (typeof addon[constructor]?.open !== 'function') {
    throw new Error('addon is missing ' + constructor + '.open');
  }
  for (const method of ['backup', 'close', 'execProtocolRaw', 'execProtocolRawStream', 'pgDump', 'psql']) {
    if (typeof addon[constructor].prototype[method] !== 'function') {
      throw new Error('addon is missing ' + constructor + '.prototype.' + method);
    }
  }
}
if (typeof addon.NativeWasixServer?.open !== 'function' || typeof addon.NativeWasixServer.prototype.close !== 'function') {
  throw new Error('addon is missing NativeWasixServer');
}
if (process.versions.electron !== undefined && process.versions.electron !== expectedElectron) {
  throw new Error('unexpected Electron version ' + process.versions.electron);
}

const runtime = ${JSON.stringify(options.runtime)};
const decoder = new TextDecoder();
const openOptions = {
  profile: 'standard',
  storage: { kind: 'memory' },
  username: 'postgres',
  database: 'postgres',
  startupGucs: {},
  extensions: [],
};

function simpleQuery(sql) {
  const query = new TextEncoder().encode(sql);
  const message = new Uint8Array(1 + 4 + query.byteLength + 1);
  message[0] = 'Q'.charCodeAt(0);
  new DataView(message.buffer).setUint32(1, 4 + query.byteLength + 1, false);
  message.set(query, 5);
  return message;
}

function verifySimpleQuery(response, owner) {
  let answer = false;
  let ready = false;
  for (let offset = 0; offset < response.byteLength;) {
    if (offset + 5 > response.byteLength) throw new Error(owner + ' returned a truncated frame');
    const tag = String.fromCharCode(response[offset]);
    const length = new DataView(
      response.buffer,
      response.byteOffset + offset + 1,
      4,
    ).getUint32(0, false);
    const end = offset + 1 + length;
    if (length < 4 || end > response.byteLength) throw new Error(owner + ' returned an invalid frame');
    if (tag === 'D') {
      const view = new DataView(response.buffer, response.byteOffset + offset + 5, length - 4);
      const fields = view.getUint16(0, false);
      const valueLength = view.getInt32(2, false);
      if (fields === 1 && valueLength === 2) {
        const value = response.subarray(offset + 11, offset + 13);
        answer = decoder.decode(value) === '42';
      }
    }
    if (tag === 'Z') ready = true;
    offset = end;
  }
  if (!answer || !ready) throw new Error(owner + ' failed the PostgreSQL Simple Query roundtrip');
}

function transferResponse(response, owner) {
  if (!(response instanceof Uint8Array) || !(response.buffer instanceof ArrayBuffer)) {
    throw new Error(owner + ' did not return a V8-owned Uint8Array');
  }
  const transferred = structuredClone(response, { transfer: [response.buffer] });
  if (response.byteLength !== 0 || !(transferred instanceof Uint8Array)) {
    throw new Error(owner + ' response ArrayBuffer was not transferable');
  }
  return transferred;
}

async function exerciseDatabase(constructor, owner) {
  const database = await constructor.open(openOptions);
  try {
    const response = await database.execProtocolRaw(simpleQuery('SELECT 42::text AS answer'));
    verifySimpleQuery(transferResponse(response, owner), owner);
  } finally {
    await database.close();
  }
  if (!database.closed) throw new Error(owner + ' did not reach its closed state');
}

await exerciseDatabase(addon.NativeWasixActorDatabase, runtime + '-actor');
await exerciseDatabase(addon.NativeWasixDatabase, runtime + '-direct');

async function exerciseServer() {
  const server = await addon.NativeWasixServer.open({
    ...openOptions,
    listen: { transport: 'tcp' },
  });
  if (
    server.closed ||
    typeof server.connectionString !== 'string' ||
    server.connectionString.length === 0
  ) {
    throw new Error(runtime + ' server did not expose a live connection string');
  }
  const socket = connect(server.connectionString);
  let startup;
  let query;
  try {
    await onceConnected(socket);
    const startupResponse = readExchange(socket);
    socket.write(startupPacket('postgres', 'postgres'));
    startup = await startupResponse;
    const queryResponse = readExchange(socket);
    socket.write(wireSimpleQuery('SELECT 42::int AS answer'));
    query = await queryResponse;
  } finally {
    socket.end();
    await onceClosed(socket);
    await server.close();
  }
  if (!server.closed || startup.messages < 1 || query.messages < 3 || query.totalBytes < 6) {
    throw new Error(
      runtime + ' server wire roundtrip failed: ' +
        JSON.stringify({ closed: server.closed, startup, query }),
    );
  }
}
await exerciseServer();
console.log(JSON.stringify({
  addonAbiVersion: addon.addonAbiVersion(),
  nodeApiVersion: addon.nodeApiVersion(),
  profiles: addon.supportedProfiles(),
  runtime,
  roundtrip: 'actor+direct+server-wire',
  target: expectedTarget,
}));
`,
    );
    const [command, args, env] = runtimeCommand(options.runtime, verification);
    const { stdout } = await run(command, args, scratch, env);
    if (options.runtime === "electron") {
      await runElectronAsarSmoke(scratch, carrierManifest);
    }
    process.stdout.write(
      `WASIX Node-API packaged ${options.runtime}/${options.packageManager} smoke passed: ${stdout.trim()}\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`smoke-packaged-addon: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
