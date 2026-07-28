#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve(".github/scripts/download-build-artifacts.mjs");
const CHECKSUM_MERGER = path.resolve(".github/scripts/merge-checksum-manifest.mjs");
const SHA = "a".repeat(40);
const ARTIFACT = "exact-artifact";
const DOWNLOAD_PROCESS_TIMEOUT_MS = 10_000;

test("the workflow Node runtime reaches argument validation without a Bun global", () => {
  const result = spawnSync("node", [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: download-build-artifacts[.]mjs/u);
  assert.doesNotMatch(result.stderr, /Bun is not defined|ERR_INVALID_ARG_TYPE/u);
});

function fakeGh(root) {
  const bin = path.join(root, "bin");
  const executable = path.join(bin, "gh");
  const mkdir = spawnSync("mkdir", ["-p", bin]);
  assert.equal(mkdir.status, 0);
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  const endpoint = args.find((arg) => arg.startsWith("repos/"));
  if (/actions\\/workflows[?]/.test(endpoint)) {
    process.stdout.write("HTTP/2.0 200 OK\\n\\n" + JSON.stringify({ workflows: [{ id: 9, name: "CI" }] }));
    process.exit(0);
  }
  if (/actions\\/workflows\\/9\\/runs[?]/.test(endpoint)) {
    const url = new URL("https://api.github.com/" + endpoint);
    const page = Number(url.searchParams.get("page"));
    const selected = {
      id: 77,
      head_sha: "${SHA}",
      workflow_id: 9,
      status: "completed",
      conclusion: "success",
    };
    const workflow_runs = process.env.FAKE_CANDIDATE_MODE === "beyond-first-page"
      ? page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
            ...selected,
            id: 100 + index,
            conclusion: "failure",
          }))
        : [selected]
      : [selected];
    let link = "";
    if (process.env.FAKE_CANDIDATE_MODE === "beyond-first-page" && page === 1) {
      const next = new URL(url);
      next.searchParams.set("page", "2");
      link = \`Link: <\${next}>; rel="next", <\${next}>; rel="last"\\n\`;
    }
    process.stdout.write("HTTP/2.0 200 OK\\n" + link + "\\n" + JSON.stringify({ workflow_runs }));
    process.exit(0);
  }
  if (/actions\\/runs\\/77\\/artifacts/.test(endpoint)) {
    const bytes = fs.readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE);
    const identity = {
      id: Number(process.env.FAKE_ARTIFACT_ID || "101"),
      name: "${ARTIFACT}",
      size_in_bytes: bytes.length,
      expired: false,
      digest: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    process.stdout.write("HTTP/2.0 200 OK\\n\\n" + JSON.stringify({
      artifacts: [identity, { ...identity, id: 102, name: "${ARTIFACT}-near-match" }],
    }));
    process.exit(0);
  }
  if (/actions\\/runs\\/77\\/jobs/.test(endpoint)) {
    const jobs = [{ id: 501, name: "Qualified", status: "completed", conclusion: "success", run_attempt: 1 }];
    if (process.env.FAKE_DUPLICATE_JOB === "true") jobs.push({ ...jobs[0], id: 502 });
    process.stdout.write("HTTP/2.0 200 OK\\n\\n" + JSON.stringify({ jobs }));
    process.exit(0);
  }
  if (/actions\\/runs\\/77$/.test(endpoint)) {
    process.stdout.write(JSON.stringify({
      id: 77,
      head_sha: "${SHA}",
      workflow_id: 9,
      run_attempt: 1,
      status: process.env.FAKE_RUN_STATUS || "completed",
      conclusion: process.env.FAKE_RUN_CONCLUSION || "success",
    }));
    process.exit(0);
  }
  if (/actions\\/workflows\\/9$/.test(endpoint)) {
    process.stdout.write(JSON.stringify({ id: 9, name: "CI" }));
    process.exit(0);
  }
  if (/actions\\/artifacts\\/101\\/zip$/.test(endpoint)) {
    const state = process.env.FAKE_GH_STATE;
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0;
    fs.writeFileSync(state, String(count + 1));
    if (process.env.FAKE_MODE === "transient" && count === 0) {
      process.stderr.write("HTTP 503 unexpected EOF\\n");
      process.exit(1);
    }
    if (process.env.FAKE_MODE === "permanent") {
      process.stderr.write("HTTP 404 not found\\n");
      process.exit(1);
    }
    process.stdout.write(fs.readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE));
    process.exit(0);
  }
}
throw new Error("unexpected gh command " + JSON.stringify(args));
`);
  chmodSync(executable, 0o755);
  return bin;
}

function fixture(t, label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-build-download-${label}-`));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = fakeGh(root);
  const payload = path.join(root, "payload.txt");
  const archive = path.join(root, "artifact.zip");
  writeFileSync(payload, "correct");
  const zip = spawnSync("zip", ["-q", archive, "payload.txt"], { cwd: root });
  assert.equal(zip.status, 0, zip.stderr?.toString());
  return {
    archive,
    bin,
    destination: path.join(root, "durable"),
    log: path.join(root, "gh.log"),
    root,
    snapshots: path.join(root, "snapshots"),
    state: path.join(root, "state"),
  };
}

function invoke(f, mode, extra = [], environment = {}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "CI",
      SHA,
      f.destination,
      "--run-id",
      "77",
      "--job",
      "Qualified",
      "--artifact",
      ARTIFACT,
      ...extra,
    ],
    {
      encoding: "utf8",
      timeout: DOWNLOAD_PROCESS_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ARTIFACT_ARCHIVE: f.archive,
        FAKE_GH_LOG: f.log,
        FAKE_GH_STATE: f.state,
        FAKE_MODE: mode,
        ...environment,
        GH_REPO: "f0rr0/oliphaunt",
        GH_TOKEN: "test-token",
        OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: f.snapshots,
        OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
        OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "0",
      },
    },
  );
}

function invokeFallback(f, candidateMode) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "CI", SHA, f.destination, "--job", "Qualified", "--artifact", ARTIFACT],
    {
      encoding: "utf8",
      timeout: DOWNLOAD_PROCESS_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ARTIFACT_ARCHIVE: f.archive,
        FAKE_CANDIDATE_MODE: candidateMode,
        FAKE_GH_LOG: f.log,
        FAKE_GH_STATE: f.state,
        FAKE_MODE: "success",
        GH_REPO: "f0rr0/oliphaunt",
        GH_TOKEN: "test-token",
        OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: f.snapshots,
        OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
        OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "0",
      },
    },
  );
}

function temporarySiblings(f) {
  return readdirSync(f.root).filter((name) => name.startsWith(".durable."));
}

test("generic per-target checksum manifests merge deterministically and reject conflicts", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-checksum-merge-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const linux = path.join(root, "linux", "liboliphaunt-1.2.3-release-assets.sha256");
  const windows = path.join(root, "windows", "liboliphaunt-1.2.3-release-assets.sha256");
  const conflict = path.join(root, "conflict", "liboliphaunt-1.2.3-release-assets.sha256");
  for (const file of [linux, windows, conflict]) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const linuxDigest = "1".repeat(64);
  const windowsDigest = "2".repeat(64);
  writeFileSync(linux, `${linuxDigest}  ./liboliphaunt-1.2.3-linux-x64-gnu.tar.gz\n`);
  writeFileSync(windows, [
    `${windowsDigest}  liboliphaunt-1.2.3-windows-x64-msvc.zip`,
    `${linuxDigest}  ./liboliphaunt-1.2.3-linux-x64-gnu.tar.gz`,
    "",
  ].join("\n"));

  const merged = spawnSync(process.execPath, [CHECKSUM_MERGER, linux, windows], {
    encoding: "utf8",
  });
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(readFileSync(linux, "utf8"), [
    `${linuxDigest}  ./liboliphaunt-1.2.3-linux-x64-gnu.tar.gz`,
    `${windowsDigest}  ./liboliphaunt-1.2.3-windows-x64-msvc.zip`,
    "",
  ].join("\n"));

  const beforeConflict = readFileSync(linux, "utf8");
  writeFileSync(conflict, `${"3".repeat(64)}  ./liboliphaunt-1.2.3-linux-x64-gnu.tar.gz\n`);
  const rejected = spawnSync(process.execPath, [CHECKSUM_MERGER, linux, conflict], {
    encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /conflicting checksum for liboliphaunt-1[.]2[.]3-linux-x64-gnu[.]tar[.]gz/u);
  assert.equal(readFileSync(linux, "utf8"), beforeConflict);
  assert.equal(
    readdirSync(path.dirname(linux)).some((name) => name.startsWith(".oliphaunt-checksums-")),
    false,
  );
});

test("transient download retries in a fresh directory and promotes only the complete envelope", (t) => {
  const f = fixture(t, "transient");
  const result = invoke(f, "transient");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.destination, "payload.txt"), "utf8"), "correct");
  assert.equal(existsSync(path.join(f.destination, "partial.txt")), false);
  assert.equal(readFileSync(f.state, "utf8"), "2");
  assert.deepEqual(temporarySiblings(f), []);
});

test("permanent failure preserves the prior destination and leaves no partial durable state", (t) => {
  const f = fixture(t, "permanent");
  const mkdir = spawnSync("mkdir", ["-p", f.destination]);
  assert.equal(mkdir.status, 0);
  writeFileSync(path.join(f.destination, "existing.txt"), "preserve-me");
  const result = invoke(f, "permanent");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /permanent read failure[\s\S]*HTTP 404/iu);
  assert.equal(readFileSync(path.join(f.destination, "existing.txt"), "utf8"), "preserve-me");
  assert.equal(existsSync(path.join(f.destination, "partial.txt")), false);
  assert.equal(readFileSync(f.state, "utf8"), "1");
  assert.deepEqual(temporarySiblings(f), []);
});

test("different bytes at an existing path fail closed without changing the destination", (t) => {
  const f = fixture(t, "collision");
  const mkdir = spawnSync("mkdir", ["-p", f.destination]);
  assert.equal(mkdir.status, 0);
  writeFileSync(path.join(f.destination, "payload.txt"), "old-bytes");
  const result = invoke(f, "success");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /overwrite payload[.]txt with different bytes|conflicts with the durable destination/u);
  assert.equal(readFileSync(path.join(f.destination, "payload.txt"), "utf8"), "old-bytes");
  assert.deepEqual(temporarySiblings(f), []);
});

test("exact run, workflow, job, SHA, and artifact name remain mandatory", (t) => {
  const f = fixture(t, "identity");
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "CI", "b".repeat(40), f.destination, "--run-id", "77", "--job", "Qualified", "--artifact", ARTIFACT],
    {
      encoding: "utf8",
      timeout: DOWNLOAD_PROCESS_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_ARTIFACT_ARCHIVE: f.archive,
        FAKE_GH_LOG: f.log,
        FAKE_GH_STATE: f.state,
        FAKE_MODE: "success",
        GH_REPO: "f0rr0/oliphaunt",
        GH_TOKEN: "test-token",
        OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: f.snapshots,
        OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
        OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "0",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not belong to commit/u);
  assert.equal(existsSync(f.destination), false);
  assert.equal(existsSync(f.state), false, "identity rejection must happen before download");
});

test("approved artifact metadata pins exact id, compressed size, and digest", (t) => {
  const f = fixture(t, "approved-identity");
  const bytes = readFileSync(f.archive);
  const metadata = [{
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    id: 101,
    name: ARTIFACT,
    size: statSync(f.archive).size,
  }];
  const accepted = invoke(f, "success", ["--artifact-metadata-json", JSON.stringify(metadata)]);
  assert.equal(accepted.status, 0, accepted.stderr);

  rmSync(f.destination, { recursive: true, force: true });
  const rejected = invoke(
    f,
    "success",
    ["--artifact-metadata-json", JSON.stringify([{ ...metadata[0], id: 999 }])],
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /immutable identity drifted/u);
});

test("one approved artifact set may authorize a strict requested subset", (t) => {
  const f = fixture(t, "approved-subset");
  const bytes = readFileSync(f.archive);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const metadata = [
    { digest, id: 101, name: ARTIFACT, size: statSync(f.archive).size },
    { digest, id: 102, name: `${ARTIFACT}-near-match`, size: statSync(f.archive).size },
  ];
  const accepted = invoke(f, "success", ["--artifact-metadata-json", JSON.stringify(metadata)]);
  assert.equal(accepted.status, 0, accepted.stderr);

  rmSync(f.destination, { recursive: true, force: true });
  const duplicate = invoke(f, "success", [
    "--artifact-metadata-json",
    JSON.stringify([metadata[0], metadata[0]]),
  ]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /unique artifact names/u);
});

test("one immutable run snapshot is reused while each requested artifact is downloaded by exact id", (t) => {
  const f = fixture(t, "snapshot-cache");
  const first = invoke(f, "success");
  assert.equal(first.status, 0, first.stderr);
  const second = invoke(f, "success");
  assert.equal(second.status, 0, second.stderr);
  const calls = readFileSync(f.log, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  const endpoints = calls
    .filter((args) => args[0] === "api")
    .map((args) => args.find((arg) => arg.startsWith("repos/")));
  assert.equal(endpoints.filter((endpoint) => /actions\/runs\/77$/u.test(endpoint)).length, 1);
  assert.equal(endpoints.filter((endpoint) => /actions\/workflows\/9$/u.test(endpoint)).length, 1);
  assert.equal(endpoints.filter((endpoint) => /actions\/runs\/77\/jobs/u.test(endpoint)).length, 1);
  assert.equal(endpoints.filter((endpoint) => /actions\/runs\/77\/artifacts/u.test(endpoint)).length, 1);
  assert.equal(endpoints.filter((endpoint) => /actions\/artifacts\/101\/zip$/u.test(endpoint)).length, 2);
  const downloads = calls.filter((args) =>
    args.some((arg) => /actions\/artifacts\/101\/zip$/u.test(arg)));
  assert.ok(downloads.every((args) => args.includes("Accept: application/vnd.github+json")));
  assert.ok(downloads.every((args) => !args.includes("Accept: application/octet-stream")));
});

test("fallback discovery traverses exact-SHA workflow pages instead of truncating the latest runs", (t) => {
  const f = fixture(t, "fallback-pagination");
  const result = invokeFallback(f, "beyond-first-page");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.destination, "payload.txt"), "utf8"), "correct");
  const calls = readFileSync(f.log, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(
    calls.filter((args) => args.some((arg) => arg.includes("/actions/workflows/9/runs?"))).length,
    2,
  );
  assert.equal(calls.some((args) => args[0] === "run" && args[1] === "list"), false);
  assert.equal(calls.flat().includes("--limit"), false);
});

for (const [label, environment] of [
  ["in-progress", { FAKE_RUN_STATUS: "in_progress", FAKE_RUN_CONCLUSION: "" }],
  ["failed", { FAKE_RUN_STATUS: "completed", FAKE_RUN_CONCLUSION: "failure" }],
]) {
  test(`${label === "in-progress" ? "an" : "a"} ${label} enclosing workflow run cannot authorize artifact download`, (t) => {
    const f = fixture(t, `run-${label}`);
    const result = invoke(f, "success", [], environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed or not completed\/success|does not belong to commit/u);
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(f.state), false, "run rejection must happen before download");
  });
}

test("a duplicate named gate cannot authorize artifact download", (t) => {
  const f = fixture(t, "duplicate-job");
  const result = invoke(f, "success", [], { FAKE_DUPLICATE_JOB: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not satisfy required job Qualified/u);
  assert.equal(existsSync(f.destination), false);
  assert.equal(existsSync(f.state), false, "gate rejection must happen before download");
});
