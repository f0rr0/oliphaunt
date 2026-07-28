#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve(".github/scripts/require-workflow-success.sh");
const SHA = "a".repeat(40);
const WORKFLOW_HELPER_PROCESS_TIMEOUT_MS = 15_000;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-workflow-waiter-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = path.join(root, "bin");
  const mkdir = spawnSync("mkdir", ["-p", bin]);
  assert.equal(mkdir.status, 0);
  const gh = path.join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "view") {
  const jobs = [{ name: "Qualified", conclusion: "success" }];
  if (process.env.FAKE_MODE === "duplicate-job") jobs.push({ ...jobs[0] });
  process.stdout.write(JSON.stringify({ jobs }));
  process.exit(0);
}
if (args[0] === "api") {
  const endpoint = args.find((arg) => arg.startsWith("repos/"));
  if (/actions\\/workflows[?]/.test(endpoint)) {
    process.stdout.write("HTTP/2.0 200 OK\\n\\n" + JSON.stringify({ workflows: [{ id: 9, name: "CI" }] }));
    process.exit(0);
  }
  if (/actions\\/workflows\\/9\\/runs[?]/.test(endpoint)) {
    const state = process.env.FAKE_STATE;
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0;
    fs.writeFileSync(state, String(count + 1));
    if (process.env.FAKE_MODE === "transient" && count === 0) {
      process.stderr.write("HTTP 503 temporary failure\\n");
      process.exit(1);
    }
    if (process.env.FAKE_MODE === "permanent") {
      process.stderr.write("HTTP 401 Bad credentials\\n");
      process.exit(1);
    }
    const selected = {
      id: 77,
      head_sha: "${SHA}",
      status: "completed",
      conclusion: "success",
      html_url: "https://example.invalid/run/77",
      event: "push",
    };
    const page = new URL("https://api.github.com/" + endpoint).searchParams.get("page");
    const workflow_runs = process.env.FAKE_MODE === "beyond-first-page"
      ? page === "1"
        ? Array.from({ length: 100 }, (_, index) => ({
            ...selected,
            id: 100 + index,
            conclusion: "failure",
          }))
        : [selected]
      : [selected];
    const link = process.env.FAKE_MODE === "beyond-first-page" && page === "1"
      ? 'Link: <https://api.github.com/repos/f0rr0/oliphaunt/actions/workflows/9/runs?head_sha=${SHA}&page=2&per_page=100>; rel="next", <https://api.github.com/repos/f0rr0/oliphaunt/actions/workflows/9/runs?head_sha=${SHA}&page=2&per_page=100>; rel="last"\\n'
      : "";
    process.stdout.write("HTTP/2.0 200 OK\\n" + link + "\\n" + JSON.stringify({ workflow_runs }));
    process.exit(0);
  }
  if (/actions\\/runs\\/77\\/artifacts/.test(endpoint)) {
    const artifact = {
      id: 901,
      name: "required-artifact",
      size_in_bytes: 123,
      digest: "sha256:" + "1".repeat(64),
      expired: false,
    };
    const artifacts = process.env.FAKE_MODE === "duplicate-artifact"
      ? [artifact, { ...artifact, id: 902 }]
      : process.env.FAKE_MODE === "expired-artifact"
        ? [{ ...artifact, expired: true }]
        : process.env.FAKE_MODE === "malformed-artifact-metadata"
          ? [{ ...artifact, digest: undefined }]
          : [artifact];
    process.stdout.write("HTTP/2.0 200 OK\\n\\n" + JSON.stringify({ artifacts }));
    process.exit(0);
  }
  if (/actions\\/runs\\/77$/.test(endpoint)) {
    const sha = process.env.FAKE_MODE === "wrong-sha"
      ? "${"b".repeat(40)}"
      : process.env.FAKE_MODE === "upper-sha"
        ? "${SHA.toUpperCase()}"
        : "${SHA}";
    const status = process.env.FAKE_MODE === "in-progress-run" ? "in_progress" : "completed";
    const conclusion = process.env.FAKE_MODE === "in-progress-run"
      ? ""
      : process.env.FAKE_MODE === "failed-run"
        ? "failure"
        : "success";
    process.stdout.write(sha + "\\t9\\tpush\\t" + status + "\\t" + conclusion + "\\n");
    process.exit(0);
  }
  if (/actions\\/workflows\\/9$/.test(endpoint)) {
    process.stdout.write("CI\\n");
    process.exit(0);
  }
}
throw new Error("unexpected gh call " + JSON.stringify(args));
`);
  chmodSync(gh, 0o755);
  const sleep = path.join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(sleep, 0o755);
  const output = path.join(root, "output");
  writeFileSync(output, "");
  return { bin, log: path.join(root, "log"), output, root, state: path.join(root, "state") };
}

function invoke(f, mode, args = ["CI", SHA, "10", "--job", "Qualified", "--artifact", "required-artifact"]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
      FAKE_LOG: f.log,
      FAKE_MODE: mode,
      FAKE_STATE: f.state,
      GH_REPO: "f0rr0/oliphaunt",
      GH_TOKEN: "test-token",
      GITHUB_OUTPUT: f.output,
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
      OLIPHAUNT_GITHUB_READ_DEADLINE_MS: "1000",
      OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: "1",
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "0",
    },
    timeout: WORKFLOW_HELPER_PROCESS_TIMEOUT_MS,
  });
}

test("a transient exact-SHA run-inventory failure does not abort the long-lived workflow waiter", (t) => {
  const f = fixture(t);
  const result = invoke(f, "transient");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /waiter remains active/u);
  assert.match(result.stdout, /selected CI run 77/u);
  assert.equal(
    readFileSync(f.output, "utf8"),
    `run_id=77\nartifact_metadata_json=${JSON.stringify([{
      digest: `sha256:${"1".repeat(64)}`,
      id: 901,
      name: "required-artifact",
      size: 123,
    }])}\n`,
  );
  assert.equal(readFileSync(f.state, "utf8"), "2");
});

test("permanent authentication failures abort immediately with a distinct status", (t) => {
  const f = fixture(t);
  const result = invoke(f, "permanent");
  assert.equal(result.status, 64);
  assert.match(result.stderr, /permanent GitHub read failure/u);
  assert.equal(readFileSync(f.state, "utf8"), "1");
});

test("exact-SHA REST pagination discovers a qualifying run beyond the first 100 newer failures", (t) => {
  const f = fixture(t);
  const result = invoke(f, "beyond-first-page");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /selected CI run 77/u);
  const log = readFileSync(f.log, "utf8");
  assert.doesNotMatch(log, /\["run","list"|"--limit"/u);
  assert.match(log, /actions\/workflows\/9\/runs/u);
  assert.equal(readFileSync(f.state, "utf8"), "2");
});

test("an explicitly selected run still fails closed on an exact-SHA mismatch", (t) => {
  const f = fixture(t);
  const result = invoke(
    f,
    "wrong-sha",
    ["CI", SHA, "0", "--run-id", "77", "--job", "Qualified", "--artifact", "required-artifact"],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /belongs to .* not/u);
  assert.equal(readFileSync(f.output, "utf8"), "");
});

test("SHA comparison remains case-insensitive without Bash 4 substitutions", (t) => {
  const f = fixture(t);
  const result = invoke(
    f,
    "upper-sha",
    ["CI", SHA, "0", "--run-id", "77", "--job", "Qualified", "--artifact", "required-artifact"],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /\$\{[^}\n]+,,\}/u);
});

test("successful named jobs cannot authorize a non-terminal or failed workflow run", (t) => {
  for (const mode of ["in-progress-run", "failed-run"]) {
    const f = fixture(t);
    const result = invoke(
      f,
      mode,
      ["CI", SHA, "0", "--run-id", "77", "--job", "Qualified", "--artifact", "required-artifact"],
    );
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, /not completed\/success/u);
    assert.equal(readFileSync(f.output, "utf8"), "");
  }
});

test("artifact gates require exactly one non-expired artifact identity", (t) => {
  for (const mode of ["duplicate-artifact", "expired-artifact"]) {
    const f = fixture(t);
    const result = invoke(
      f,
      mode,
      ["CI", SHA, "0", "--run-id", "77", "--job", "Qualified", "--artifact", "required-artifact"],
    );
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, /exactly one non-expired artifact/u);
    assert.equal(readFileSync(f.output, "utf8"), "");
  }
});

test("malformed artifact metadata is a permanent protocol failure, not a retryable absence", (t) => {
  const f = fixture(t);
  const result = invoke(f, "malformed-artifact-metadata");
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /artifact inventory contains malformed metadata/u);
  assert.match(result.stderr, /permanent GitHub read failure/u);
  assert.equal(readFileSync(f.state, "utf8"), "1");
  assert.equal(readFileSync(f.output, "utf8"), "");
});

test("job gates require exactly one successful named job identity", (t) => {
  const f = fixture(t);
  const result = invoke(
    f,
    "duplicate-job",
    ["CI", SHA, "0", "--run-id", "77", "--job", "Qualified", "--artifact", "required-artifact"],
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Qualified=count-2/u);
  assert.equal(readFileSync(f.output, "utf8"), "");
});
