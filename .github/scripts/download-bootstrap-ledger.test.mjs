#!/usr/bin/env bun

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  restoreExactContinuationLedger,
  selectEarlierAttemptArtifact,
  validateAttemptMetadata,
} from "./download-bootstrap-ledger.mjs";

const SCRIPT = path.join(import.meta.dirname, "download-bootstrap-ledger.mjs");
const SHA = "a".repeat(40);
const ARTIFACT_NAME = "oliphaunt-bootstrap-ledger";
const BOOTSTRAP_LEDGER_PROCESS_TIMEOUT_MS = 20_000;

function artifact(id, runId, createdAt, updatedAt = createdAt, extra = {}) {
  return {
    digest: `sha256:${"a".repeat(64)}`,
    id,
    name: ARTIFACT_NAME,
    expired: false,
    size_in_bytes: 1,
    created_at: createdAt,
    updated_at: updatedAt,
    workflow_run: { id: runId },
    ...extra,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: BOOTSTRAP_LEDGER_PROCESS_TIMEOUT_MS,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result;
}

function checkpointName(sequence, fill) {
  return `checkpoint-${String(sequence).padStart(6, "0")}-${fill.repeat(64)}.json`;
}

function ledgerZip(root, label, sequence, fill) {
  const file = path.join(root, checkpointName(sequence, fill));
  const archive = path.join(root, `${label}.zip`);
  writeFileSync(file, `${JSON.stringify({ label, sequence })}\n`);
  run("zip", ["-q", "-j", archive, file]);
  rmSync(file);
  return archive;
}

function fakeGh(root) {
  const directory = path.join(root, "bin");
  const file = path.join(directory, "gh");
  run("mkdir", ["-p", directory]);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "api") throw new Error("unexpected gh command " + JSON.stringify(args));
const endpoint = args.at(-1);
const attempt = /\\/runs\\/([0-9]+)\\/attempts\\/([0-9]+)$/.exec(endpoint);
if (attempt) {
  process.stdout.write(process.env.FAKE_ATTEMPT_METADATA);
  process.exit(0);
}
const run = /\\/actions\\/runs\\/([0-9]+)$/.exec(endpoint);
if (run) {
  if (run[1] === "900") {
    process.stdout.write(process.env.FAKE_CURRENT_RUN);
    process.exit(0);
  }
  const row = JSON.parse(process.env.FAKE_RUNS)
    .find((candidate) => String(candidate.databaseId) === run[1]);
  if (!row) throw new Error("missing fake run metadata " + run[1]);
  process.stdout.write(JSON.stringify({
    id: Number(run[1]),
    workflow_id: row.workflowId ?? 42,
    head_sha: row.headSha ?? "${SHA}",
    event: row.event ?? "workflow_dispatch",
    created_at: row.createdAt,
    status: row.status,
    conclusion: row.conclusion ?? null,
  }));
  process.exit(0);
}
if (/\\/actions\\/workflows\\/42\\/runs[?]/.test(endpoint)) {
  const url = new URL("https://api.github.com/" + endpoint);
  const page = Number(url.searchParams.get("page"));
  const all = JSON.parse(process.env.FAKE_RUNS).map((row) => ({
    id: row.databaseId,
    workflow_id: row.workflowId ?? 42,
    head_sha: row.headSha ?? "${SHA}",
    event: row.event ?? "workflow_dispatch",
    created_at: row.createdAt,
    status: row.status,
    conclusion: row.conclusion ?? null,
  }));
  const workflow_runs = all.slice((page - 1) * 100, page * 100);
  let link = "";
  if (page * 100 < all.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    const last = new URL(url);
    last.searchParams.set("page", String(Math.ceil(all.length / 100)));
    link = \`Link: <\${next}>; rel="next", <\${last}>; rel="last"\\n\`;
  }
  process.stdout.write("HTTP/2.0 200 OK\\n" + link + "\\n" + JSON.stringify({ workflow_runs }));
  process.exit(0);
}
if (/\\/actions\\/artifacts[?]name=/.test(endpoint)) {
  const url = new URL("https://api.github.com/" + endpoint);
  const page = Number(url.searchParams.get("page"));
  const zips = JSON.parse(process.env.FAKE_ZIPS_BY_ARTIFACT);
  const all = Object.values(JSON.parse(process.env.FAKE_ARTIFACTS_BY_RUN))
    .flat()
    .map((artifact) => {
      const archive = zips[String(artifact.id)];
      const bytes = archive ? fs.readFileSync(archive) : null;
      return {
        ...artifact,
        ...(bytes === null ? {} : {
          size_in_bytes: bytes.length,
          digest: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
        }),
        workflow_run: { ...artifact.workflow_run, head_sha: "${SHA}" },
      };
    });
  const artifacts = all.slice((page - 1) * 100, page * 100);
  let link = "";
  if (page * 100 < all.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    const last = new URL(url);
    last.searchParams.set("page", String(Math.ceil(all.length / 100)));
    link = \`Link: <\${next}>; rel="next", <\${last}>; rel="last"\\n\`;
  }
  process.stdout.write("HTTP/2.0 200 OK\\n" + link + "\\n" + JSON.stringify({
    total_count: all.length,
    artifacts,
  }));
  process.exit(0);
}
const download = /\\/artifacts\\/([0-9]+)\\/zip$/.exec(endpoint);
if (download) {
  const archive = JSON.parse(process.env.FAKE_ZIPS_BY_ARTIFACT)[download[1]];
  if (!archive) throw new Error("missing fake artifact ZIP " + download[1]);
  const state = process.env.FAKE_DOWNLOAD_STATE;
  const count = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0;
  fs.writeFileSync(state, String(count + 1));
  if (process.env.FAKE_DOWNLOAD_MODE === "transient" && count === 0) {
    process.stderr.write("HTTP 503 unexpected EOF\\n");
    process.exit(1);
  }
  const bytes = fs.readFileSync(archive);
  if (process.env.FAKE_DOWNLOAD_MODE === "identity-mismatch") {
    const altered = Buffer.from(bytes);
    altered[Math.min(10, altered.length - 1)] ^= 0x01;
    process.stdout.write(altered);
  } else {
    process.stdout.write(process.env.FAKE_DOWNLOAD_MODE === "truncated" ? bytes.subarray(0, 3) : bytes);
  }
  process.exit(0);
}
throw new Error("unexpected gh api endpoint " + endpoint);
`,
  );
  chmodSync(file, 0o755);
  return directory;
}

async function fixture(t, label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-ledger-download-${label}-`));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = fakeGh(root);
  const output = path.join(root, "github-output");
  writeFileSync(output, "");
  return {
    bin,
    destination: path.join(root, "destination"),
    downloadState: path.join(root, "download-state"),
    log: path.join(root, "gh.log"),
    output,
    root,
  };
}

function invoke(fixture, {
  artifactsByRun = {},
  attempt = 1,
  attemptMetadata = {},
  currentRunMetadata = {
    id: 900,
    workflow_id: 42,
    head_sha: SHA,
    event: "workflow_dispatch",
    created_at: "2026-07-15T10:00:00Z",
    status: "in_progress",
  },
  runs = [],
  zipsByArtifact = {},
  downloadMode = "success",
} = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    timeout: BOOTSTRAP_LEDGER_PROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
      BOOTSTRAP_LEDGER_PATH: fixture.destination,
      FAKE_ARTIFACTS_BY_RUN: JSON.stringify(artifactsByRun),
      FAKE_ATTEMPT_METADATA: JSON.stringify(attemptMetadata),
      FAKE_CURRENT_RUN: JSON.stringify(currentRunMetadata),
      FAKE_DOWNLOAD_MODE: downloadMode,
      FAKE_DOWNLOAD_STATE: fixture.downloadState,
      FAKE_GH_LOG: fixture.log,
      FAKE_RUNS: JSON.stringify(runs),
      FAKE_ZIPS_BY_ARTIFACT: JSON.stringify(zipsByArtifact),
      GH_REPO: "f0rr0/oliphaunt",
      GITHUB_OUTPUT: fixture.output,
      GITHUB_RUN_ATTEMPT: String(attempt),
      GITHUB_RUN_ID: "900",
      RELEASE_HEAD_SHA: SHA,
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "0",
    },
  });
}

function calls(fixture) {
  return readFileSync(fixture.log, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function downloadedArtifactIds(fixture) {
  return calls(fixture)
    .map((args) => /\/artifacts\/([0-9]+)\/zip$/u.exec(args.at(-1))?.[1])
    .filter(Boolean);
}

function restoredNames(fixture) {
  return readdirSync(fixture.destination).sort();
}

test("rerun restores an earlier-attempt artifact by immutable artifact id and excludes current-attempt bytes", async (t) => {
  const f = await fixture(t, "earlier-attempt");
  const priorZip = ledgerZip(f.root, "prior-attempt", 0, "a");
  const currentZip = ledgerZip(f.root, "current-attempt", 1, "b");
  const result = invoke(f, {
    attempt: 2,
    attemptMetadata: {
      id: 900,
      run_attempt: 2,
      run_started_at: "2026-07-15T10:00:00Z",
      head_sha: SHA,
      event: "workflow_dispatch",
    },
    artifactsByRun: {
      900: [
        artifact(202, 900, "2026-07-15T10:00:01Z"),
        artifact(101, 900, "2026-07-15T09:50:00Z", "2026-07-15T09:51:00Z"),
      ],
    },
    runs: [{ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" }],
    zipsByArtifact: { 101: priorZip, 202: currentZip },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloadedArtifactIds(f), ["101"]);
  assert.deepEqual(restoredNames(f), [checkpointName(0, "a")]);
  assert.match(readFileSync(f.output, "utf8"), /^found=true\nrun_id=900\n$/u);
  assert.equal(calls(f).some((args) => args[0] === "run" && args[1] === "list"), false);
});

test("fresh attempt preserves recovery from the newest completed distinct dispatch", async (t) => {
  const f = await fixture(t, "fresh-dispatch");
  const priorZip = ledgerZip(f.root, "prior-dispatch", 3, "c");
  const result = invoke(f, {
    artifactsByRun: {
      800: [artifact(303, 800, "2026-07-14T10:05:00Z")],
      700: [artifact(404, 700, "2026-07-14T09:05:00Z")],
    },
    runs: [
      { databaseId: 900, createdAt: "2026-07-15T10:00:00Z", status: "in_progress", conclusion: null },
      { databaseId: 700, createdAt: "2026-07-14T09:00:00Z", status: "in_progress", conclusion: null },
      { databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" },
    ],
    zipsByArtifact: { 303: priorZip },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloadedArtifactIds(f), ["303"]);
  assert.deepEqual(restoredNames(f), [checkpointName(3, "c")]);
  assert.match(readFileSync(f.output, "utf8"), /^found=true\nrun_id=800\n$/u);
  assert.equal(
    calls(f).filter((args) => args.at(-1)?.includes("/actions/artifacts?name=oliphaunt-bootstrap-ledger")).length,
    1,
    "all candidate dispatches must share one repository-level named artifact inventory",
  );
  assert.equal(
    calls(f).some((args) => args.at(-1)?.includes("/runs/900/artifacts")),
    false,
    "attempt 1 must never inspect or download its own run artifact",
  );
});

test("paginated artifact/run recovery finds an eligible dispatch beyond one hundred newer retries", async (t) => {
  const f = await fixture(t, "beyond-one-hundred");
  const priorZip = ledgerZip(f.root, "beyond-one-hundred-prior", 13, "a");
  const artifactsByRun = {};
  const runs = [];
  for (let index = 0; index < 101; index += 1) {
    const runId = 1_000 + index;
    const timestamp = `2026-07-15T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`;
    artifactsByRun[runId] = [artifact(2_000 + index, runId, timestamp)];
    runs.push({ databaseId: runId, createdAt: timestamp, status: "in_progress", conclusion: null });
  }
  artifactsByRun[800] = [artifact(3_000, 800, "2026-07-14T10:05:00Z")];
  runs.push({ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" });
  const result = invoke(f, {
    artifactsByRun,
    runs,
    zipsByArtifact: { 3_000: priorZip },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloadedArtifactIds(f), ["3000"]);
  assert.deepEqual(restoredNames(f), [checkpointName(13, "a")]);
  const inventory = calls(f);
  assert.equal(
    inventory.filter((args) => /\/actions\/runs\/[0-9]+$/u.test(args.at(-1))).length,
    1,
    "only the current run needs an individual metadata read",
  );
  assert.equal(
    inventory.filter((args) => args.at(-1)?.includes("/actions/workflows/42/runs?")).length,
    2,
    "the exact-SHA workflow run inventory must traverse both pages",
  );
  assert.equal(
    inventory.filter((args) => args.at(-1)?.includes("/actions/artifacts?name=")).length,
    2,
    "the immutable named-artifact inventory must traverse both pages",
  );
  assert.equal(inventory.some((args) => args[0] === "run" && args[1] === "list"), false);
  assert.equal(inventory.flat().includes("--limit"), false);
});

test("a newer same-name artifact from another workflow cannot shadow the Release ledger", async (t) => {
  const f = await fixture(t, "wrong-workflow-shadow");
  const correctZip = ledgerZip(f.root, "correct-workflow", 14, "b");
  const result = invoke(f, {
    artifactsByRun: {
      850: [artifact(4_000, 850, "2026-07-15T09:05:00Z")],
      800: [artifact(4_001, 800, "2026-07-14T10:05:00Z")],
    },
    runs: [
      {
        databaseId: 850,
        createdAt: "2026-07-15T09:00:00Z",
        status: "completed",
        conclusion: "success",
        workflowId: 99,
      },
      {
        databaseId: 800,
        createdAt: "2026-07-14T10:00:00Z",
        status: "completed",
        conclusion: "failure",
      },
    ],
    zipsByArtifact: { 4_001: correctZip },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloadedArtifactIds(f), ["4001"]);
  assert.match(readFileSync(f.output, "utf8"), /^found=true\nrun_id=800\n$/u);
});

test("an artifact/run exact-SHA identity disagreement fails closed", async (t) => {
  const f = await fixture(t, "sha-disagreement");
  const result = invoke(f, {
    artifactsByRun: { 800: [artifact(5_000, 800, "2026-07-14T10:05:00Z")] },
    runs: [{
      databaseId: 800,
      createdAt: "2026-07-14T10:00:00Z",
      status: "completed",
      conclusion: "failure",
      headSha: "b".repeat(40),
    }],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disagrees with its exact-SHA artifact binding/u);
  assert.equal(readFileSync(f.output, "utf8"), "");
});

test("rerun falls back to a completed distinct dispatch without consuming a current-attempt artifact", async (t) => {
  const f = await fixture(t, "rerun-fallback");
  const currentZip = ledgerZip(f.root, "current", 4, "d");
  const priorZip = ledgerZip(f.root, "prior", 5, "e");
  const result = invoke(f, {
    attempt: 3,
    attemptMetadata: {
      id: 900,
      run_attempt: 3,
      run_started_at: "2026-07-15T11:00:00Z",
      head_sha: SHA,
      event: "workflow_dispatch",
    },
    artifactsByRun: {
      900: [artifact(202, 900, "2026-07-15T11:00:01Z")],
      800: [artifact(303, 800, "2026-07-14T10:05:00Z")],
    },
    runs: [{ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" }],
    zipsByArtifact: { 202: currentZip, 303: priorZip },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(downloadedArtifactIds(f), ["303"]);
  assert.deepEqual(restoredNames(f), [checkpointName(5, "e")]);
});

test("rerun refuses genesis when only an artifact from the current attempt is visible", async (t) => {
  const f = await fixture(t, "refuse-current");
  const currentZip = ledgerZip(f.root, "current-only", 6, "f");
  const result = invoke(f, {
    attempt: 2,
    attemptMetadata: {
      id: 900,
      run_attempt: 2,
      run_started_at: "2026-07-15T12:00:00Z",
      head_sha: SHA,
      event: "workflow_dispatch",
    },
    artifactsByRun: { 900: [artifact(202, 900, "2026-07-15T12:00:00Z")] },
    runs: [],
    zipsByArtifact: { 202: currentZip },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no artifact can be proven to predate the attempt.*refusing genesis/u);
  assert.deepEqual(downloadedArtifactIds(f), []);
  assert.equal(readFileSync(f.output, "utf8"), "");
});

test("attempt boundary uses both creation and update time and metadata validation fails closed", () => {
  const selected = selectEarlierAttemptArtifact(
    [
      artifact(101, 900, "2026-07-15T09:00:00Z", "2026-07-15T09:30:00Z"),
      artifact(102, 900, "2026-07-15T09:10:00Z", "2026-07-15T10:00:00Z"),
      artifact(103, 900, "2026-07-15T09:20:00Z", "2026-07-15T09:40:00Z"),
    ],
    { runId: "900", currentAttemptStartedAt: "2026-07-15T10:00:00Z" },
  );
  assert.equal(selected.artifact.id, 103);
  assert.deepEqual(selected.excludedCurrentAttemptIds, ["102"]);
  assert.throws(
    () => selectEarlierAttemptArtifact(
      [artifact(104, 900, "not-a-timestamp")],
      { runId: "900", currentAttemptStartedAt: "2026-07-15T10:00:00Z" },
    ),
    /created_at must be a UTC timestamp/u,
  );
  assert.throws(
    () => validateAttemptMetadata(
      {
        id: 900,
        run_attempt: 2,
        run_started_at: "2026-07-15T10:00:00Z",
        head_sha: "b".repeat(40),
        event: "workflow_dispatch",
      },
      { runId: "900", attempt: 2, sha: SHA },
    ),
    /wrong release SHA/u,
  );
});

test("artifact transport retries transient failure and restores only a complete checkpoint envelope", async (t) => {
  const f = await fixture(t, "transient-download");
  const archive = ledgerZip(f.root, "transient", 7, "a");
  const result = invoke(f, {
    artifactsByRun: { 800: [artifact(707, 800, "2026-07-14T10:05:00Z")] },
    downloadMode: "transient",
    runs: [{ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" }],
    zipsByArtifact: { 707: archive },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.downloadState, "utf8"), "2");
  assert.deepEqual(restoredNames(f), [checkpointName(7, "a")]);
  assert.equal(readdirSync(f.root).some((name) => name.startsWith(".destination.")), false);
});

test("repeated truncated ZIP responses preserve the durable checkpoint cache and clean all stages", async (t) => {
  const f = await fixture(t, "truncated-download");
  mkdirSync(f.destination, { recursive: true });
  const existing = checkpointName(8, "b");
  writeFileSync(path.join(f.destination, existing), "durable\n");
  const archive = ledgerZip(f.root, "truncated", 9, "c");
  const result = invoke(f, {
    artifactsByRun: { 800: [artifact(808, 800, "2026-07-14T10:05:00Z")] },
    downloadMode: "truncated",
    runs: [{ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" }],
    zipsByArtifact: { 808: archive },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /retry budget exhausted/u);
  assert.equal(readFileSync(f.downloadState, "utf8"), "4");
  assert.deepEqual(restoredNames(f), [existing]);
  assert.equal(readFileSync(path.join(f.destination, existing), "utf8"), "durable\n");
  assert.equal(readdirSync(f.root).some((name) => name.startsWith(".destination.")), false);
});

test("a valid-looking ZIP with the wrong immutable digest is never restored", async (t) => {
  const f = await fixture(t, "identity-mismatch");
  mkdirSync(f.destination, { recursive: true });
  const existing = checkpointName(11, "e");
  writeFileSync(path.join(f.destination, existing), "durable\n");
  const archive = ledgerZip(f.root, "identity-mismatch", 12, "f");
  const result = invoke(f, {
    artifactsByRun: { 800: [artifact(1001, 800, "2026-07-14T10:05:00Z")] },
    downloadMode: "identity-mismatch",
    runs: [{ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" }],
    zipsByArtifact: { 1001: archive },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /transport identity mismatch.*retry budget exhausted|retry budget exhausted.*transport identity mismatch/su);
  assert.equal(readFileSync(f.downloadState, "utf8"), "4");
  assert.deepEqual(restoredNames(f), [existing]);
  assert.equal(readdirSync(f.root).some((name) => name.startsWith(".destination.")), false);
});

test("checkpoint collision is validated before atomic promotion and preserves prior bytes", async (t) => {
  const f = await fixture(t, "collision");
  mkdirSync(f.destination, { recursive: true });
  const name = checkpointName(10, "d");
  writeFileSync(path.join(f.destination, name), "local-different-bytes\n");
  const archive = ledgerZip(f.root, "collision", 10, "d");
  const result = invoke(f, {
    artifactsByRun: { 800: [artifact(909, 800, "2026-07-14T10:05:00Z")] },
    runs: [{ databaseId: 800, createdAt: "2026-07-14T10:00:00Z", status: "completed", conclusion: "failure" }],
    zipsByArtifact: { 909: archive },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prior checkpoint conflicts/u);
  assert.equal(readFileSync(path.join(f.destination, name), "utf8"), "local-different-bytes\n");
  assert.equal(existsSync(path.join(f.destination, ".artifact.zip")), false);
  assert.equal(readdirSync(f.root).some((entry) => entry.startsWith(".destination.")), false);
});

test("exact continuation restore installs only immutable checkpoint entries and rejects collisions", async (t) => {
  const f = await fixture(t, "exact-continuation");
  const name = checkpointName(13, "a");
  restoreExactContinuationLedger({
    checkpointEntries: [{ name, bytes: Buffer.from("exact\n") }],
  }, f.destination);
  assert.deepEqual(restoredNames(f), [name]);
  assert.equal(readFileSync(path.join(f.destination, name), "utf8"), "exact\n");
  assert.throws(
    () => restoreExactContinuationLedger({
      checkpointEntries: [{ name, bytes: Buffer.from("changed\n") }],
    }, f.destination),
    /conflicts with local/u,
  );
  assert.equal(readFileSync(path.join(f.destination, name), "utf8"), "exact\n");
});
