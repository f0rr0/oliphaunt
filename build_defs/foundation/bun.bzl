"""Run authored TypeScript with the pinned Bun executable and declared runfiles."""

load(":bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

def _runfile_path(ctx, file):
    if file.short_path.startswith("../"):
        return file.short_path[3:]
    return ctx.workspace_name + "/" + file.short_path

def _bun_impl(ctx, arguments = []):
    runner = ctx.actions.declare_file(ctx.label.name + ".sh")
    script = _runfile_path(ctx, ctx.file.entry_point)
    executable = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun
    bun = _runfile_path(ctx, executable)
    command = "test " if ctx.attr._test_mode else ""
    working_directory = 'cd "$runfiles/%s"' % ctx.workspace_name if ctx.attr._test_mode else ""
    ctx.actions.write(runner, """#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${RUNFILES_DIR:-}" ]]; then
  runfiles="$RUNFILES_DIR"
elif [[ -d "$0.runfiles" ]]; then
  runfiles="$0.runfiles"
else
  echo "Bun launcher requires directory runfiles (enable --enable_runfiles)." >&2
  exit 1
fi
runfiles="$(cd "$runfiles" && pwd)"
%s
exec "$runfiles/%s" %s"$runfiles/%s" %s "$@"
""" % (working_directory, bun, command, script, " ".join(arguments)), is_executable = True)
    files = depset([ctx.file.entry_point, executable], transitive = [depset(ctx.files.data)])
    runfiles = ctx.runfiles(transitive_files = files)
    for dep in ctx.attr.data:
        runfiles = runfiles.merge(dep[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = runner, runfiles = runfiles)]

_ATTRS = {
    "entry_point": attr.label(allow_single_file = [".ts", ".mts"], mandatory = True),
    "data": attr.label_list(allow_files = True),
    "_test_mode": attr.bool(default = False),
}

bun_binary = rule(implementation = _bun_impl, attrs = _ATTRS, toolchains = [BUN_TOOLCHAIN_TYPE], executable = True)
bun_test = rule(implementation = _bun_impl, attrs = _ATTRS | {"_test_mode": attr.bool(default = True)}, toolchains = [BUN_TOOLCHAIN_TYPE], test = True)
bun_script_test = rule(implementation = _bun_impl, attrs = _ATTRS, toolchains = [BUN_TOOLCHAIN_TYPE], test = True)

def _bun_toolchain_test_impl(ctx):
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    return _bun_impl(ctx, [runtime.runtime_platform, runtime.binary_sha256])

bun_toolchain_test = rule(
    implementation = _bun_toolchain_test_impl,
    attrs = _ATTRS | {"entry_point": attr.label(default = Label("//build_defs/foundation:bun-toolchain-test.mts"), allow_single_file = True)},
    toolchains = [BUN_TOOLCHAIN_TYPE],
    test = True,
)
