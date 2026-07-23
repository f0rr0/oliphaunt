import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseWorkflow } from "../policy/assertions/workflow-semantics.mjs";
import { PLATFORM_COMPATIBILITY_POLICY } from "./platform-compatibility-policy.mjs";
import { ROOT } from "./release-graph.mjs";

const SETUP = path.join(ROOT, ".github/scripts/setup-native-build-tools.sh");
const BUILD = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh",
);
const CACHE = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/postgis-dependency-cache.sh",
);
const setupSource = readFileSync(SETUP, "utf8");
const buildSource = readFileSync(BUILD, "utf8");
const ci = parseWorkflow(ROOT, ".github/workflows/ci.yml");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "oliphaunt-postgis-cache-"));
  temporaryDirectories.push(directory);
  return directory;
}

function cacheOperation(operation, dependencyRoot, fingerprint, operationPaths = []) {
  return spawnSync(
    "bash",
    [
      "-c",
      String.raw`
set -euo pipefail
. "$1"
operation="$2"
dependency_root="$3"
fingerprint="$4"
shift 4
case "$operation" in
  prepare)
    oliphaunt_postgis_dependency_cache_prepare "$dependency_root" "$fingerprint" "$@"
    ;;
  commit)
    oliphaunt_postgis_dependency_cache_commit "$dependency_root" "$fingerprint" "$@"
    ;;
  *)
    exit 64
    ;;
esac
`,
      "postgis-cache-test",
      CACHE,
      operation,
      dependencyRoot,
      fingerprint,
      ...operationPaths,
    ],
    { encoding: "utf8" },
  );
}

describe("Linux native compiler compatibility contract", () => {
  test("pins GCC 12 for every Linux native build process", () => {
    expect(setupSource).toContain("g++-12");
    expect(setupSource).toContain("gcc-12");
    expect(setupSource).toContain('if [ "$cc_major" != "12" ] || [ "$cxx_major" != "12" ]');
    for (const variable of ["CC", "CXX", "OLIPHAUNT_CC", "OLIPHAUNT_CXX"]) {
      expect(setupSource).toContain(`printf '${variable}=%s\\n'`);
    }
  });

  test("all native producer jobs use the shared compiler setup", () => {
    for (const jobId of [
      "extension-artifacts-native",
      "liboliphaunt-native-desktop",
      "liboliphaunt-native-android",
      "liboliphaunt-native-ios",
    ]) {
      const step = ci.jobs[jobId].steps.find(
        ({ name }) => name === "Configure native compiler cache",
      );
      expect(step?.run).toContain(".github/scripts/setup-native-build-tools.sh");
    }
  });

  test("threads the exact C and C++ compilers through every CMake dependency build", () => {
    expect(buildSource).toContain(
      'fail "Linux release builds require GCC/G++ 12; run .github/scripts/setup-native-build-tools.sh"',
    );
    expect(buildSource).toContain(
      'fail "Linux release builds require GCC/G++ major 12, got $native_cc_major/$native_cxx_major"',
    );
    expect(buildSource).toContain('"-DCMAKE_C_COMPILER=$native_cc"');
    expect(buildSource).toContain('"-DCMAKE_CXX_COMPILER=$native_cxx"');
    expect(buildSource).toContain('"-DCMAKE_C_COMPILER_LAUNCHER=$ccache_bin"');
    expect(buildSource).toContain('"-DCMAKE_CXX_COMPILER_LAUNCHER=$ccache_bin"');
    expect(buildSource).toMatch(
      /native_postgis_cmake_install\(\)[\s\S]*?"\$\{cmake_compiler_args\[@\]\}"/u,
    );
  });

  test("keeps the published GNU C++ ABI ceiling at the GCC 12 level", () => {
    for (const target of ["linux-x64-gnu", "linux-arm64-gnu"]) {
      expect(
        PLATFORM_COMPATIBILITY_POLICY[target].elf.maximumRequiredVersions.GLIBCXX,
      ).toEqual([3, 4, 30]);
    }
  });
});

describe("Windows native toolchain bootstrap contract", () => {
  test("uses the pinned verified winflexbison asset instead of Chocolatey", () => {
    expect(setupSource).toContain(
      'bash "$repo_root/tools/dev/install-pinned-winflexbison.sh"',
    );
    expect(setupSource).toContain(
      'OLIPHAUNT_PINNED_NATIVE_TOOL_CACHE_ROOT="$cache_root"',
    );
    expect(setupSource).toContain('[ -x "$winflex_dir/win_flex.exe" ]');
    expect(setupSource).toContain('[ -x "$winflex_dir/win_bison.exe" ]');
    expect(setupSource).not.toContain("winflexbison3");
  });

  test("does not accept Chocolatey's success status without the requested executable", () => {
    expect(setupSource).toContain(
      'choco install -y "$package" --no-progress --limit-output &&\n      [ -x "$expected_executable" ]',
    );
    expect(setupSource).toContain(
      "install_choco_package strawberryperl /c/Strawberry/perl/bin/perl.exe",
    );
    expect(setupSource).toContain(
      "Chocolatey did not install $expected_executable after 3 attempts",
    );
  });
});

describe("PostGIS native dependency cache", () => {
  test("retains an exact-fingerprint cache and atomically records completion", () => {
    const root = temporaryDirectory();
    const dependencyRoot = path.join(root, "dependencies");
    const buildRoot = path.join(root, "geos-build");
    const fingerprint = "a".repeat(64);
    mkdirSync(dependencyRoot, { recursive: true });
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(path.join(dependencyRoot, "archive.a"), "valid");
    writeFileSync(path.join(buildRoot, "object.o"), "valid");

    const committed = cacheOperation("commit", dependencyRoot, fingerprint);
    expect(committed.status, committed.stderr).toBe(0);
    const prepared = cacheOperation("prepare", dependencyRoot, fingerprint, [buildRoot]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(readFileSync(path.join(dependencyRoot, "archive.a"), "utf8")).toBe("valid");
    expect(readFileSync(path.join(buildRoot, "object.o"), "utf8")).toBe("valid");
    expect(
      existsSync(path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.sha256")),
    ).toBe(false);
    expect(
      existsSync(path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.manifest")),
    ).toBe(true);

    const recommitted = cacheOperation("commit", dependencyRoot, fingerprint, [
      path.join(dependencyRoot, "archive.a"),
    ]);
    expect(recommitted.status, recommitted.stderr).toBe(0);
    expect(
      readFileSync(
        path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.sha256"),
        "utf8",
      ).trim(),
    ).toBe(fingerprint);
  });

  test("removes stale installed dependencies and build trees before reuse", () => {
    const root = temporaryDirectory();
    const dependencyRoot = path.join(root, "dependencies");
    const buildRoots = [path.join(root, "geos-build"), path.join(root, "proj-build")];
    const previous = "b".repeat(64);
    const wanted = "c".repeat(64);
    mkdirSync(dependencyRoot, { recursive: true });
    for (const buildRoot of buildRoots) mkdirSync(buildRoot, { recursive: true });
    writeFileSync(path.join(dependencyRoot, "libgeos.a"), "compiled-with-old-g++");
    for (const buildRoot of buildRoots) writeFileSync(path.join(buildRoot, "stale.o"), "stale");
    expect(cacheOperation("commit", dependencyRoot, previous).status).toBe(0);

    const prepared = cacheOperation("prepare", dependencyRoot, wanted, buildRoots);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(path.join(dependencyRoot, "libgeos.a"))).toBe(false);
    for (const buildRoot of buildRoots) expect(existsSync(buildRoot)).toBe(false);
    expect(
      existsSync(path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.sha256")),
    ).toBe(false);

    writeFileSync(path.join(dependencyRoot, "libgeos.a"), "rebuilt-with-current-g++");
    const committed = cacheOperation("commit", dependencyRoot, wanted, [
      path.join(dependencyRoot, "libgeos.a"),
    ]);
    expect(committed.status, committed.stderr).toBe(0);
    expect(
      readFileSync(
        path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.sha256"),
        "utf8",
      ).trim(),
    ).toBe(wanted);
  });

  test("discards an interrupted dependency cache that has no completion stamp", () => {
    const root = temporaryDirectory();
    const dependencyRoot = path.join(root, "dependencies");
    const buildRoot = path.join(root, "proj-build");
    const wanted = "e".repeat(64);
    mkdirSync(dependencyRoot, { recursive: true });
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(path.join(dependencyRoot, "partial.a"), "interrupted");
    writeFileSync(path.join(buildRoot, "partial.o"), "interrupted");

    const prepared = cacheOperation("prepare", dependencyRoot, wanted, [buildRoot]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(path.join(dependencyRoot, "partial.a"))).toBe(false);
    expect(existsSync(buildRoot)).toBe(false);
    expect(
      existsSync(path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.sha256")),
    ).toBe(false);
  });

  test("purges a matching-fingerprint cache when any committed output is tampered", () => {
    const root = temporaryDirectory();
    const dependencyRoot = path.join(root, "dependencies");
    const buildRoot = path.join(root, "geos-build");
    const archive = path.join(dependencyRoot, "libgeos.a");
    const fingerprint = "f".repeat(64);
    mkdirSync(dependencyRoot, { recursive: true });
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(archive, "exact-output");
    writeFileSync(path.join(buildRoot, "object.o"), "reusable-object");
    const committed = cacheOperation("commit", dependencyRoot, fingerprint, [archive]);
    expect(committed.status, committed.stderr).toBe(0);

    writeFileSync(archive, "tampered-output");
    const prepared = cacheOperation("prepare", dependencyRoot, fingerprint, [buildRoot]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(existsSync(archive)).toBe(false);
    expect(existsSync(buildRoot)).toBe(false);
  });

  test("never commits an empty required output or reuses an interrupted repair", () => {
    const root = temporaryDirectory();
    const dependencyRoot = path.join(root, "dependencies");
    const archive = path.join(dependencyRoot, "libproj.a");
    const fingerprint = "9".repeat(64);
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(archive, "");
    const emptyCommit = cacheOperation("commit", dependencyRoot, fingerprint, [archive]);
    expect(emptyCommit.status).toBe(1);
    expect(
      existsSync(path.join(dependencyRoot, ".oliphaunt-postgis-native-dependencies.sha256")),
    ).toBe(false);

    writeFileSync(archive, "partial-repair");
    const firstPrepare = cacheOperation("prepare", dependencyRoot, fingerprint);
    expect(firstPrepare.status, firstPrepare.stderr).toBe(0);
    expect(existsSync(archive)).toBe(false);
    writeFileSync(archive, "interrupted-again");
    const secondPrepare = cacheOperation("prepare", dependencyRoot, fingerprint);
    expect(secondPrepare.status, secondPrepare.stderr).toBe(0);
    expect(existsSync(archive)).toBe(false);
  });

  test("fails closed without deleting data for an invalid fingerprint or root", () => {
    const root = temporaryDirectory();
    const dependencyRoot = path.join(root, "dependencies");
    const buildRoot = path.join(root, "geos-build");
    mkdirSync(dependencyRoot, { recursive: true });
    mkdirSync(buildRoot, { recursive: true });
    writeFileSync(path.join(dependencyRoot, "keep"), "keep");
    writeFileSync(path.join(buildRoot, "keep"), "keep");

    const invalidFingerprint = cacheOperation("prepare", dependencyRoot, "not-a-hash", [
      buildRoot,
    ]);
    expect(invalidFingerprint.status).toBe(2);
    expect(existsSync(path.join(dependencyRoot, "keep"))).toBe(true);
    expect(existsSync(path.join(buildRoot, "keep"))).toBe(true);

    const unsafeRoot = cacheOperation("prepare", "/", "d".repeat(64), [buildRoot]);
    expect(unsafeRoot.status).toBe(2);
    expect(existsSync(path.join(buildRoot, "keep"))).toBe(true);
  });

  test("keys both the extension stamp and dependency cache to compiler identity", () => {
    expect(buildSource).toContain(
      'postgis_dependency_hash="$(native_postgis_dependency_fingerprint)" || return 1',
    );
    expect(buildSource).toContain(
      'printf \'postgis-dependency-fingerprint=%s\\n\' "$postgis_dependency_hash"',
    );
    expect(buildSource).toContain("native_postgis_compiler_identity cc \"$native_cc\"");
    expect(buildSource).toContain("native_postgis_compiler_identity cxx \"$native_cxx\"");
    expect(buildSource).toContain("oliphaunt_postgis_dependency_cache_prepare");
    expect(buildSource).toContain("oliphaunt_postgis_dependency_cache_commit");
  });
});
