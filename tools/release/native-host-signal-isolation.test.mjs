import { expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT } from "./release-graph.mjs";

const procSignalPatchPath = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0018-liboliphaunt-contain-embedded-proc-signals.patch",
);
const signalBoundaryPatchPath = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0020-liboliphaunt-enforce-embedded-signal-boundary.patch",
);
const embeddedRuntimeBuilderPaths = [
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1",
];
const staticExtensionBuilderPaths = [
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh",
  "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh",
  "src/runtimes/liboliphaunt/native/bin/build-macos-extension-archives.sh",
];

function changedLines(patchPath, prefix) {
  return readFileSync(patchPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .map((line) => line.slice(1));
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  expect(end, endMarker).toBeGreaterThan(start);
  return source.slice(start, end);
}

function continuedShellCommandContaining(source, needle) {
  const lines = source.split("\n");
  const needleLine = lines.findIndex((line) => line.includes(needle));
  expect(needleLine, needle).toBeGreaterThanOrEqual(0);

  let start = needleLine;
  while (start > 0 && lines[start - 1].trimEnd().endsWith("\\")) {
    start -= 1;
  }

  let end = needleLine;
  while (end < lines.length - 1 && lines[end].trimEnd().endsWith("\\")) {
    end += 1;
  }

  return lines.slice(start, end + 1).join("\n");
}

test("embedded PostgreSQL keeps process-directed ProcSignal traffic inside its host", () => {
  const added = changedLines(procSignalPatchPath, "+").join("\n");
  const removed = changedLines(procSignalPatchPath, "-").join("\n");

  expect(added).toContain("oliphaunt_send_proc_signal(pid_t pid)");
  expect(added).toContain("if (pid != MyProcPid)");
  expect(added).toContain("errno = ESRCH;");
  expect(added).toContain("save_errno = errno;");
  expect(added).toContain("procsignal_sigusr1_handler(SIGUSR1);");
  expect(added).toContain("errno = save_errno;");
  expect(added.match(/oliphaunt_send_proc_signal\(pid\)/gu) ?? []).toHaveLength(3);
  expect(removed.match(/kill\(pid, SIGUSR1\)/gu) ?? []).toHaveLength(3);

  // The only remaining raw kill is the normal-server branch of the helper.
  expect(added.match(/kill\(pid, SIGUSR1\)/gu) ?? []).toHaveLength(1);
  expect(added).toContain("#else\n\treturn kill(pid, SIGUSR1);\n#endif");
});

test("embedded PostgreSQL leaves the host SIGUSR1 disposition untouched", () => {
  const added = changedLines(procSignalPatchPath, "+").join("\n");
  expect(added).toContain("#ifndef OLIPHAUNT_EMBEDDED");
  expect(added).toContain("/* ProcSignal delivery is synchronous and the host owns SIGUSR1. */");
  expect(added).toContain("Assert(!IsUnderPostmaster);");
});

test("embedded backend and extension signal calls cross one provider boundary", () => {
  const added = changedLines(signalBoundaryPatchPath, "+").join("\n");

  expect(added).toContain("#if defined(OLIPHAUNT_EMBEDDED) && !defined(FRONTEND)");
  expect(added).toContain(
    "extern PGDLLIMPORT int oliphaunt_embedded_kill(pid_t pid, int signo);",
  );
  expect(added).toContain("extern PGDLLIMPORT int oliphaunt_embedded_raise(int signo);");
  expect(added).toContain(
    "#define kill(pid, signo) oliphaunt_embedded_kill((pid), (signo))",
  );
  expect(added).toContain("#define raise(signo) oliphaunt_embedded_raise((signo))");
});

test("embedded signal provider rejects SIGUSR1 and delegates every other signal", () => {
  const added = changedLines(signalBoundaryPatchPath, "+").join("\n");

  expect(added.match(/if \(signo == SIGUSR1\)/gu) ?? []).toHaveLength(3);
  expect(added.match(/errno = EPERM;/gu) ?? []).toHaveLength(2);
  expect(added.match(/return -1;/gu) ?? []).toHaveLength(2);
  expect(added).toContain("#ifdef WIN32\n\treturn pgkill(pid, signo);");
  expect(added).toContain("#else\n\treturn (kill)(pid, signo);");
  expect(added).toContain("return (raise)(signo);");
});

test("embedded pqsignal ignores SIGUSR1 without changing frontend behavior", () => {
  const added = changedLines(signalBoundaryPatchPath, "+").join("\n");

  expect(added).toContain(
    "#if defined(OLIPHAUNT_EMBEDDED) && !defined(FRONTEND)\n\tif (signo == SIGUSR1)\n\t\treturn;\n#endif",
  );
});

test("every embedded runtime builder verifies both provider exports", () => {
  const expectedOccurrences = new Map([
    ["src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh", 3],
    ["src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh", 3],
    ["src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh", 4],
  ]);
  for (const relativePath of embeddedRuntimeBuilderPaths) {
    const source = readFileSync(path.join(ROOT, relativePath), "utf8");
    const expectedCount = expectedOccurrences.get(relativePath) ?? 2;
    expect(source.match(/oliphaunt_embedded_kill/gu) ?? [], relativePath).toHaveLength(
      expectedCount,
    );
    expect(source.match(/oliphaunt_embedded_raise/gu) ?? [], relativePath).toHaveLength(
      expectedCount,
    );
  }
});

test("Linux and macOS compile every embedded dynamic module with the boundary enabled", () => {
  const linux = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh"),
    "utf8",
  );
  const macos = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"),
    "utf8",
  );

  expect(linux).toMatch(/native_cflags=.*-DOLIPHAUNT_EMBEDDED/u);
  expect(
    sliceBetween(linux, "build_contrib_extension() {", "pgxs_extension_link_args() {"),
  ).toContain('CUSTOM_COPT="$postgres_embedded_copt"');
  expect(
    sliceBetween(linux, "build_pgxs_extension() {", "native_postgis_dependency_root="),
  ).toContain('CUSTOM_COPT="$postgres_embedded_copt"');
  expect(
    sliceBetween(linux, "build_postgis_extension() {", "build_native_extension_artifacts() {"),
  ).toContain('CFLAGS="$native_cflags" BE_DLLLIBS="$embedded_module_be_dllibs"');
  expect(
    sliceBetween(linux, "build_embedded_plpgsql_module() {", "copy_embedded_modules_from_dir() {"),
  ).toContain('CUSTOM_COPT="$postgres_embedded_copt"');

  expect(macos).toMatch(/native_cflags=.*-DOLIPHAUNT_EMBEDDED/u);
  expect(
    sliceBetween(macos, "build_contrib_extension() {", "pgxs_extension_link_args() {"),
  ).toContain('CFLAGS="$native_cflags"');
  const macosPgxs = sliceBetween(
    macos,
    "build_pgxs_extension() {",
    "normalize_installed_module_suffix() {",
  );
  const normalPgxsBuild = continuedShellCommandContaining(
    macosPgxs,
    '"${normal_link_args[@]}"',
  );
  const embeddedPgxsBuild = continuedShellCommandContaining(
    macosPgxs,
    '"${embedded_link_args[@]}"',
  );
  expect(normalPgxsBuild).not.toContain('CFLAGS="$native_cflags"');
  expect(normalPgxsBuild).toContain("install");
  expect(embeddedPgxsBuild).toContain('CFLAGS="$native_cflags"');
  expect(embeddedPgxsBuild).toContain("all");
  expect(
    sliceBetween(macos, "build_postgis_extension() {", "build_embedded_plpgsql_module() {"),
  ).toContain('CFLAGS="$native_cflags" BE_DLLLIBS="$embedded_module_be_dllibs"');
  expect(
    sliceBetween(macos, "build_embedded_plpgsql_module() {", "build_native_extension_artifacts() {"),
  ).toContain('CFLAGS="$native_cflags"');
});

test("macOS replaces normal support archives with embedded signal providers", () => {
  const macos = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"),
    "utf8",
  );
  const supportReadiness = sliceBetween(
    macos,
    "native_backend_support_libraries_ready() {",
    "build_native_backend_support_libraries() {",
  );
  const supportBuild = sliceBetween(
    macos,
    "build_native_backend_support_libraries() {",
    "native_backend_objects_ready() {",
  );
  const embeddedBackendBuild = sliceBetween(
    macos,
    "# Rebuild backend objects for the dylib only",
    "make -C src/timezone",
  );

  expect(supportReadiness).toContain("src/common/libpgcommon_srv.a");
  expect(supportReadiness).toContain("src/port/libpgport_srv.a");
  expect(supportReadiness).toContain("_oliphaunt_embedded_kill");
  expect(supportReadiness).toContain("_oliphaunt_embedded_raise");
  expect(supportBuild).toContain("make -C src/common clean");
  expect(supportBuild).toContain("make -C src/port clean");
  expect(supportBuild.match(/CFLAGS="\$native_cflags"/gu) ?? []).toHaveLength(2);
  expect(embeddedBackendBuild).toContain("build_native_backend_support_libraries");
  expect(embeddedBackendBuild.indexOf("build_native_backend_support_libraries")).toBeLessThan(
    embeddedBackendBuild.indexOf('make -j"$jobs" -C src/backend'),
  );

  const normalRuntime = sliceBetween(
    macos,
    "normal_runtime_avoids_embedded_signal_providers() {",
    "install_normal_plpgsql_module() {",
  );
  expect(normalRuntime).toContain('nm -gU "$install_dir/bin/postgres"');
  expect(normalRuntime).toContain("_oliphaunt_embedded_kill");
  expect(normalRuntime).toContain("_oliphaunt_embedded_raise");
  expect(
    sliceBetween(macos, "if ! runtime_installed; then", "if module_depends_on_liboliphaunt"),
  ).toContain("normal_runtime_avoids_embedded_signal_providers");
});

test("macOS normal-runtime provider exclusion fails closed when nm fails", () => {
  const macos = readFileSync(
    path.join(ROOT, "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh"),
    "utf8",
  );
  const normalRuntime = sliceBetween(
    macos,
    "normal_runtime_avoids_embedded_signal_providers() {",
    "install_normal_plpgsql_module() {",
  );
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-normal-runtime-signal-"));
  const binDir = path.join(fixtureRoot, "bin");
  const postgres = path.join(binDir, "postgres");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(postgres, "fixture\n");
  chmodSync(postgres, 0o755);

  const probe = `
set -euo pipefail
install_dir="$1"
nm() {
  case "$NM_MODE" in
    fail) return 17 ;;
    clean) return 0 ;;
    forbidden) printf '%s\\n' '0000000000000000 T _oliphaunt_embedded_kill' ;;
    *) return 18 ;;
  esac
}
${normalRuntime}
normal_runtime_avoids_embedded_signal_providers
`;
  const run = (mode) =>
    spawnSync("bash", ["-c", probe, "bash", fixtureRoot], {
      encoding: "utf8",
      env: { ...process.env, NM_MODE: mode },
    });

  try {
    expect(run("fail").status).not.toBe(0);
    expect(run("clean").status).toBe(0);
    expect(run("forbidden").status).not.toBe(0);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("iOS rebuilds support archives unless they provide the embedded signal boundary", () => {
  for (const relativePath of [
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh",
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh",
  ]) {
    const source = readFileSync(path.join(ROOT, relativePath), "utf8");
    const supportReadiness = sliceBetween(
      source,
      "support_libraries_ready() {",
      "plpgsql_objects_ready() {",
    );
    const supportBuild = sliceBetween(
      source,
      "build_support_libraries() {",
      "build_timezone_objects() {",
    );

    expect(supportReadiness, relativePath).toContain("src/common/libpgcommon_srv.a");
    expect(supportReadiness, relativePath).toContain("src/port/libpgport_srv.a");
    expect(supportReadiness, relativePath).toContain("nm -gU src/port/libpgport_srv.a");
    expect(supportReadiness, relativePath).toContain("_oliphaunt_embedded_kill");
    expect(supportReadiness, relativePath).toContain("_oliphaunt_embedded_raise");
    expect(supportBuild, relativePath).toContain("if ! support_libraries_ready; then");
    expect(supportBuild, relativePath).toContain("make -C src/common clean");
    expect(supportBuild, relativePath).toContain("make -C src/port clean");
    expect(supportBuild.match(/CFLAGS="\$native_cflags"/gu) ?? [], relativePath).toHaveLength(
      2,
    );
    expect(supportBuild, relativePath).toContain(
      "support libraries do not provide the embedded signal boundary",
    );
  }
});

test("mobile and macOS static extensions inherit the embedded boundary flag", () => {
  for (const relativePath of staticExtensionBuilderPaths) {
    const source = readFileSync(path.join(ROOT, relativePath), "utf8");
    expect(source, relativePath).toMatch(/native_cflags=.*-DOLIPHAUNT_EMBEDDED/u);
    expect(source, relativePath).toContain('pg_extension_cflags="$native_cflags');
  }
});
