import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Oliphaunt } from "@oliphaunt/ts";
import {
  installNativeDirectProcSignalSentinel,
  verifyNativeDirectProcSignalSurvival,
  withNativeDirectExtensionSignalIsolation,
} from "./js-exact-candidate-procsignal.mjs";

const OVERRIDE_ENV = [
  "LIBOLIPHAUNT_PATH",
  "OLIPHAUNT_BROKER",
  "OLIPHAUNT_EMBEDDED_MODULE_DIR",
  "OLIPHAUNT_ICU_DATA_DIR",
  "OLIPHAUNT_INSTALL_DIR",
  "OLIPHAUNT_NODE_ADDON",
  "OLIPHAUNT_POSTGRES",
  "OLIPHAUNT_POSTGRES_TOOL_DIR",
  "OLIPHAUNT_RUNTIME_DIR",
];

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function windowsStandardUserProof(candidate, target) {
  const proofPath = process.env.OLIPHAUNT_WINDOWS_STANDARD_USER_PROOF;
  if (process.platform !== "win32") {
    assert.equal(
      proofPath,
      undefined,
      "the Windows standard-user proof must not be injected on non-Windows hosts",
    );
    return undefined;
  }
  assert.equal(
    typeof proofPath,
    "string",
    "the Windows exact-candidate runtime must be launched through the standard-user proof boundary",
  );
  const proof = JSON.parse(await readFile(path.resolve(proofPath), "utf8"));
  assert.equal(proof.schema, "oliphaunt-windows-standard-user-proof-v1");
  assert.equal(proof.mechanism, "ephemeral-local-standard-user");
  assert.equal(proof.operation, "consumer");
  assert.match(proof.account?.name, /^[^\\/\s]+\\[^\\/\s]+$/u);
  assert.match(proof.account?.sid, /^S-1-[0-9-]+$/u);
  assert.equal(proof.token?.administrator, false);
  assert.deepEqual(proof.candidate, candidate);
  assert.equal(proof.target, target);
  return proof;
}

function detectedRuntime() {
  if (typeof globalThis.Deno?.version?.deno === "string") return "deno";
  if (typeof globalThis.Bun !== "undefined") return "bun";
  return "node";
}

async function close(database) {
  if (database !== undefined) await database.close();
}

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z0-9_-]+$/u, "extension SQL name must use the canonical safe identifier alphabet");
  return `"${value.replaceAll('"', '""')}"`;
}

async function activateAndVerifyExtensions(
  database,
  extensions,
  checkpoint,
  procSignalSentinel,
) {
  if (extensions.length === 0) return { activated: [], catalog: [], loaded: [] };
  const loaded = [];
  for (const extension of extensions) {
    const detail = { sqlName: extension.sqlName };
    await withNativeDirectExtensionSignalIsolation(
      procSignalSentinel,
      checkpoint,
      detail,
      async () => {
        await checkpoint("extension-activate-before", detail);
        if (extension.createsExtension) {
          await database.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.sqlName)} CASCADE`);
        } else {
          assert.ok(extension.loadSql.length > 0, `${extension.sqlName} must declare activation SQL`);
          for (const sql of extension.loadSql) await database.query(sql);
          loaded.push(extension.sqlName);
        }
        await checkpoint("extension-activate-after", detail);
      },
    );
  }
  const expectedCatalog = extensions
    .filter((extension) => extension.createsExtension)
    .map((extension) => extension.sqlName)
    .sort();
  const result = await database.query(
    "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname",
  );
  const catalog = result.rows.map((row) => row.text(0));
  assert.deepEqual(catalog, expectedCatalog, "the database extension catalog must match the exact promoted set");
  await checkpoint("extension-catalog-verified", { count: catalog.length });
  return {
    activated: extensions.map((extension) => extension.sqlName).sort(),
    catalog,
    loaded: loaded.sort(),
  };
}

async function main() {
  const runtime = requiredEnv("OLIPHAUNT_CONSUMER_RUNTIME");
  const engine = requiredEnv("OLIPHAUNT_CONSUMER_ENGINE");
  const runRoot = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_RUN_ROOT"));
  const receiptPath = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_RECEIPT"));
  const candidateSha = requiredEnv("OLIPHAUNT_CANDIDATE_SHA");
  const candidateTree = requiredEnv("OLIPHAUNT_CANDIDATE_TREE");
  const extensionContractPath = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_EXTENSION_CONTRACT"));
  const phase = requiredEnv("OLIPHAUNT_CONSUMER_PHASE");
  const progressPath = path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_PROGRESS"));
  let progressSequence = 0;
  const checkpoint = async (event, detail = {}) => {
    const row = {
      schemaVersion: 1,
      sequence: ++progressSequence,
      event,
      phase,
      runtime,
      engine,
      ...detail,
    };
    await mkdir(path.dirname(progressPath), { recursive: true });
    await appendFile(progressPath, `${JSON.stringify(row)}\n`, "utf8");
    console.error(`OLIPHAUNT_JS_EXACT_PROGRESS ${JSON.stringify(row)}`);
  };
  await checkpoint("process-started", { pid: process.pid });
  assert.equal(detectedRuntime(), runtime, "the invoked runtime must match the requested consumer case");
  assert.match(candidateSha, /^[0-9a-f]{40}$/u, "candidate SHA must be a full Git commit SHA");
  assert.match(candidateTree, /^[0-9a-f]{40}$/u, "candidate tree must be a full Git tree ID");
  for (const name of OVERRIDE_ENV) {
    assert.equal(process.env[name], undefined, `${name} must be absent so package resolution is exercised`);
  }
  assert.ok(["nativeDirect", "nativeBroker", "nativeServer"].includes(engine));
  assert.ok(["produce", "verify-restored"].includes(phase));
  const extensionContractBytes = await readFile(extensionContractPath);
  const extensionContract = JSON.parse(extensionContractBytes.toString());
  assert.deepEqual(extensionContract.candidate, { sha: candidateSha, tree: candidateTree });
  const standardUserProof = await windowsStandardUserProof(
    extensionContract.candidate,
    extensionContract.target,
  );
  const extensions = extensionContract.extensions;
  const runtimeDirectory = runtime === "deno"
    ? path.resolve(requiredEnv("OLIPHAUNT_CONSUMER_RUNTIME_DIRECTORY"))
    : undefined;
  const runtimeDirectoryMode = runtimeDirectory === undefined
    ? "package-managed"
    : "exact-candidate-prepared";
  const extensionContractSha256 = createHash("sha256").update(extensionContractBytes).digest("hex");

  const sourceRoot = path.join(runRoot, "source");
  const restoredRoot = path.join(runRoot, "restored");
  const statePath = path.join(runRoot, "state.json");
  if (phase === "verify-restored") {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await checkpoint("restore-state-loaded");
    assert.equal(state.candidateSha, candidateSha);
    assert.equal(state.candidateTree, candidateTree);
    assert.equal(state.runtime, runtime);
    assert.equal(state.engine, engine);
    assert.equal(state.runtimeDirectoryMode, runtimeDirectoryMode);
    assert.equal(state.extensionContractSha256, extensionContractSha256);
    assert.deepEqual(
      state.windowsStandardUserProof,
      standardUserProof,
      "fresh restore verification must use the same Windows standard-user token proof",
    );
    let restored;
    let extensionProof;
    const procSignalSentinel = engine === "nativeDirect"
      ? await installNativeDirectProcSignalSentinel(runtime, checkpoint, { root: "restored" })
      : undefined;
    try {
      await checkpoint("database-open-before", { root: "restored" });
      restored = await Oliphaunt.open({
        engine,
        root: restoredRoot,
        extensions: extensions.map((entry) => entry.sqlName),
        ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
      });
      await checkpoint("database-open-after", { root: "restored" });
      const selected = await restored.query("SELECT value FROM exact_candidate_proof");
      assert.equal(selected.getText(0, "value"), state.queryMarker);
      await checkpoint("restored-query-verified");
      if (engine === "nativeDirect") {
        await verifyNativeDirectProcSignalSurvival(
          restored,
          procSignalSentinel,
          checkpoint,
          { root: "restored" },
        );
      }
      extensionProof = await activateAndVerifyExtensions(
        restored,
        extensions,
        checkpoint,
        procSignalSentinel,
      );
      assert.deepEqual(extensionProof.activated, state.extensionProof.activated);
      assert.deepEqual(extensionProof.catalog, state.extensionProof.catalog);
    } finally {
      try {
        await checkpoint("database-close-before", { root: "restored" });
        await close(restored);
        await checkpoint("database-close-after", { root: "restored" });
      } finally {
        await procSignalSentinel?.dispose();
      }
    }
    const receipt = {
      schemaVersion: 1,
      ...state,
      packageManaged: true,
      runtimeDirectoryMode,
      overridesAbsent: OVERRIDE_ENV,
      restoredQueryVerified: true,
      extensionProof,
      closed: true,
      verifiedInFreshProcess: true,
    };
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await checkpoint("receipt-written");
    return;
  }

  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });

  await checkpoint("supported-modes-before");
  const support = (await Oliphaunt.supportedModes(
    runtimeDirectory === undefined ? {} : { runtimeDirectory },
  )).find((entry) => entry.engine === engine);
  assert.equal(support?.available, true, `${runtime}/${engine} must be package-available: ${support?.unavailableReason ?? "missing mode"}`);
  await checkpoint("supported-modes-after");

  const marker = `exact-candidate:${runtime}:${engine}`;
  let database;
  let archive;
  let sqlBackupBytes = 0;
  let extensionProof;
  const procSignalSentinel = engine === "nativeDirect"
    ? await installNativeDirectProcSignalSentinel(runtime, checkpoint, { root: "source" })
    : undefined;
  try {
    await checkpoint("database-open-before", { root: "source" });
    database = await Oliphaunt.open({
      engine,
      root: sourceRoot,
      extensions: extensions.map((entry) => entry.sqlName),
      ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
    });
    await checkpoint("database-open-after", { root: "source" });
    await database.query("CREATE TABLE exact_candidate_proof (value text NOT NULL)");
    await database.query(`INSERT INTO exact_candidate_proof (value) VALUES ('${marker}')`);
    const selected = await database.query("SELECT value FROM exact_candidate_proof");
    assert.equal(selected.getText(0, "value"), marker);
    await checkpoint("source-query-verified");
    if (engine === "nativeDirect") {
      await verifyNativeDirectProcSignalSurvival(
        database,
        procSignalSentinel,
        checkpoint,
        { root: "source" },
      );
    }
    extensionProof = await activateAndVerifyExtensions(
      database,
      extensions,
      checkpoint,
      procSignalSentinel,
    );

    await checkpoint("capabilities-before");
    const capabilities = await database.capabilities();
    assert.equal(capabilities.engine, engine);
    assert.equal(capabilities.simpleQuery, true);
    assert.equal(capabilities.backupRestore, true);
    assert.ok(capabilities.backupFormats.includes("physicalArchive"));
    assert.ok(capabilities.restoreFormats.includes("physicalArchive"));
    await checkpoint("capabilities-after");

    if (engine === "nativeServer") {
      await checkpoint("sql-backup-before");
      const sql = await database.backup("sql");
      assert.equal(sql.format, "sql");
      assert.ok(new TextDecoder().decode(sql.bytes).includes("exact_candidate_proof"));
      sqlBackupBytes = sql.bytes.byteLength;
      await checkpoint("sql-backup-after", { bytes: sqlBackupBytes });
    }

    await checkpoint("physical-backup-before");
    archive = await database.backup("physicalArchive");
    assert.equal(archive.format, "physicalArchive");
    assert.ok(archive.bytes.byteLength >= 1024);
    await checkpoint("physical-backup-after", { bytes: archive.bytes.byteLength });
  } finally {
    try {
      await checkpoint("database-close-before", { root: "source" });
      await close(database);
      await checkpoint("database-close-after", { root: "source" });
    } finally {
      await procSignalSentinel?.dispose();
    }
  }

  assert.ok(archive !== undefined);
  const restoreEngine = engine === "nativeDirect" ? "nativeDirect" : "nativeBroker";
  await checkpoint("restore-before", { restoreEngine });
  await Oliphaunt.restore({
    engine: restoreEngine,
    root: restoredRoot,
    artifact: archive,
  });
  await checkpoint("restore-after", { restoreEngine });
  assert.match(await readFile(path.join(restoredRoot, "pgdata", "PG_VERSION"), "utf8"), /^\d+\n$/u);

  const state = {
    candidateSha,
    candidateTree,
    runtime,
    engine,
    queryMarker: marker,
    physicalBackupBytes: archive.bytes.byteLength,
    sqlBackupBytes,
    restoreEngine,
    runtimeDirectoryMode,
    extensionContractSha256,
    extensionProof,
    ...(standardUserProof === undefined ? {} : { windowsStandardUserProof: standardUserProof }),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await checkpoint("state-written");
}

await main();
