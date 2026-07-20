#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOT } from "./release-graph.mjs";

const RUST_IMAGE = "rust@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea";
const FEDORA_IMAGE = "fedora@sha256:d63d63fe593749a5e8dbc8152427d40bbe0ece53d884e00e5f3b44859efa5077";

function fakeDocker(directory) {
  const script = path.join(directory, "docker");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  case "$*" in
    *rust@sha256:*) printf '%s\\n' '${RUST_IMAGE}' ;;
    *fedora@sha256:*) printf '%s\\n' '${FEDORA_IMAGE}' ;;
  esac
  exit 0
fi
if [ "\${1:-}" = run ]; then
  case "$*" in
    *'cargo build -p oliphaunt-broker'*)
      mkdir -p "$FAKE_TARGET_DIR/release"
      printf '#!/usr/bin/env sh\\nexit 0\\n' >"$FAKE_TARGET_DIR/release/oliphaunt-broker"
      chmod 0755 "$FAKE_TARGET_DIR/release/oliphaunt-broker"
      ;;
  esac
  exit 0
fi
exit 1
`,
  );
  chmodSync(script, 0o755);
  return script;
}

test("Linux broker build is exact, isolated, offline, and non-privileged", () => {
  if (process.platform !== "linux") return;
  const fixture = path.join(ROOT, "target", `linux-abi-build-test-${process.pid}`);
  const fakeBin = path.join(fixture, "bin");
  const cargoHome = path.join(fixture, "cargo-home");
  const targetDir = path.join(fixture, "output");
  const log = path.join(fixture, "docker.log");
  mkdirSync(fakeBin, { recursive: true });
  fakeDocker(fakeBin);
  try {
    const result = spawnSync(
      "bash",
      [path.join(ROOT, "tools/release/build-linux-broker-baseline.sh"), targetDir],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          CARGO_HOME: cargoHome,
          FAKE_DOCKER_LOG: log,
          FAKE_TARGET_DIR: targetDir,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, new RegExp(RUST_IMAGE.replaceAll(".", "\\."), "u"));
    assert.match(calls, /--pull never/u);
    assert.match(calls, /--network none/u);
    assert.match(calls, /--read-only/u);
    assert.match(calls, /--cap-drop ALL/u);
    assert.match(calls, /--security-opt no-new-privileges/u);
    assert.match(calls, /:\/workspace:ro/u);
    assert.match(calls, /CARGO_NET_OFFLINE=true/u);
    assert.match(calls, /RUSTUP_TOOLCHAIN=1\.93\.1-/u);
    assert.doesNotMatch(calls, /docker\.sock|credentials|config\.json/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Linux ABI rehearsal pins Fedora and executes without network or privilege", () => {
  if (process.platform !== "linux") return;
  const fixture = path.join(ROOT, "target", `linux-abi-consumer-test-${process.pid}`);
  const fakeBin = path.join(fixture, "bin");
  const consumer = path.join(fixture, "consumer");
  const log = path.join(fixture, "docker.log");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  fakeDocker(fakeBin);
  try {
    const result = spawnSync(
      "bash",
      [
        path.join(ROOT, "tools/release/check-linux-consumer-baseline.sh"),
        "--target",
        os.arch() === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu",
        "--root",
        consumer,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_DOCKER_LOG: log,
          FAKE_TARGET_DIR: path.join(fixture, "unused"),
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, new RegExp(FEDORA_IMAGE.replaceAll(".", "\\."), "u"));
    assert.match(calls, /EXPECTED_GLIBC=glibc 2\.38/u);
    assert.match(calls, /--pull never/u);
    assert.match(calls, /--network none/u);
    assert.match(calls, /--read-only/u);
    assert.match(calls, /--cap-drop ALL/u);
    assert.match(calls, /--security-opt no-new-privileges/u);
    assert.match(calls, /:\/consumer:ro/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("release producers cannot bypass the Linux ABI build and rehearsal", () => {
  const broker = readFileSync(path.join(ROOT, "tools/release/package-broker-assets.sh"), "utf8");
  const native = readFileSync(path.join(ROOT, "tools/release/package-liboliphaunt-linux-assets.sh"), "utf8");
  const node = readFileSync(path.join(ROOT, "src/runtimes/node-direct/tools/build-node-addon.sh"), "utf8");
  const extensions = readFileSync(
    path.join(ROOT, "src/extensions/artifacts/native/tools/package-release-assets.sh"),
    "utf8",
  );
  assert.match(broker, /build-linux-broker-baseline\.sh/u);
  for (const source of [broker, native, node, extensions]) {
    assert.match(source, /check-linux-consumer-baseline\.sh/u);
  }

  const rehearsal = readFileSync(path.join(ROOT, "tools/release/check-linux-consumer-baseline.sh"), "utf8");
  assert.match(rehearsal, /getconf GNU_LIBC_VERSION/u);
  assert.match(rehearsal, /observed_glibc.*EXPECTED_GLIBC/u);
  const releaseGuide = readFileSync(path.join(ROOT, "docs/maintainers/release.md"), "utf8");
  assert.match(releaseGuide, /Fedora 39 is retained\s+solely as a reproducible ABI fixture/u);
  assert.match(releaseGuide, /end-of-life/u);
});

test("baseline scripts reject arbitrary host mounts", () => {
  if (process.platform !== "linux") return;
  for (const [script, args] of [
    ["build-linux-broker-baseline.sh", [path.join(os.tmpdir(), "oliphaunt-outside-build")]],
    [
      "check-linux-consumer-baseline.sh",
      ["--target", os.arch() === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu", "--root", os.tmpdir()],
    ],
  ]) {
    const result = spawnSync("bash", [path.join(ROOT, "tools/release", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${script} unexpectedly accepted an outside mount`);
    assert.match(result.stderr, /must be below/u);
  }
});
