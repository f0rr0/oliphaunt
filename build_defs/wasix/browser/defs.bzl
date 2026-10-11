"""Bounded browser compiler actions over the isolated canonical source context."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("//build_defs/foundation:bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/foundation:bun-sources.bzl", "bun_source_path", "bun_source_runfile", "bun_source_tree")

_NODE_TOOLCHAIN = "@rules_nodejs//nodejs:toolchain_type"

def _browser_wasm_transition_impl(settings, attr):
    return {
        "//command_line_option:platforms": "@rules_rust//rust/platform:wasm32",
        "//command_line_option:compilation_mode": "opt",
        "@rules_rust//rust/toolchain/channel:channel": "nightly",
        "@rules_rust//rust/settings:lto": attr.lto,
    }

_browser_wasm_transition = transition(
    implementation = _browser_wasm_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms", "//command_line_option:compilation_mode", "@rules_rust//rust/toolchain/channel:channel", "@rules_rust//rust/settings:lto"],
)

def _browser_wasm_impl(ctx):
    return [DefaultInfo(files = ctx.attr.crate[0][DefaultInfo].files)]

browser_wasm = rule(
    implementation = _browser_wasm_impl,
    attrs = {
        "crate": attr.label(mandatory = True, cfg = _browser_wasm_transition),
        "lto": attr.string(mandatory = True, values = ["fat", "off"]),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _bindings_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    bun_file_action(
        ctx,
        ctx.file._runner,
        arguments = [ctx.attr.mode, ctx.file.input.path, output.path, ctx.file.compiler.path, ctx.file.context.path],
        inputs = [ctx.file.input, ctx.file.context],
        source_files = [],
        tools = [ctx.file.compiler],
        outputs = [output],
        mnemonic = "BrowserWasmBindgen" if ctx.attr.mode == "bindgen" else "BrowserWasmOptimize",
    )
    return [DefaultInfo(files = depset([output]))]

browser_bindings = rule(
    implementation = _bindings_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "input": attr.label(mandatory = True, allow_single_file = True),
        "compiler": attr.label(mandatory = True, allow_single_file = True, cfg = "exec"),
        "context": attr.label(default = "@browser_sources//:metadata.json", allow_single_file = True),
        "mode": attr.string(mandatory = True, values = ["bindgen", "optimize"]),
        "_runner": attr.label(default = "//build_defs/wasix/browser:compile.mts", allow_single_file = True),
    },
)

def _bundle_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("Browser bundling requires the pinned Node toolchain")
    sources = {}
    for file in ctx.files.sources:
        parts = file.path.split("/wasmer-js/")
        if len(parts) != 2:
            fail("Browser source is outside the immutable JS package: " + file.path)
        sources[parts[1]] = file.path
    packages = {}
    package_files = []
    for target, key in ctx.attr.packages.items():
        source = target[NpmPackageInfo].src
        packages[key] = source.path
        package_files.append(source)
    specification = ctx.actions.declare_file(ctx.label.name + ".compiler-inputs.json")
    # IDs and physical package paths come from the same canonical npm lock.
    ctx.actions.write(specification, json.encode({"sources": sources, "packages": packages}))
    output = ctx.actions.declare_directory(ctx.label.name)
    code = bun_source_tree(ctx, ctx.label.name + ".sources", [ctx.file._runner, ctx.file._driver, ctx.file._archives])
    bun_file_action(
        ctx,
        ctx.file._runner,
        sources = code,
        arguments = [ctx.file.bindings.path, output.path, node.path, ctx.file.context.path, specification.path, bun_source_path(ctx, code, ctx.file._driver)],
        inputs = [ctx.file.bindings, ctx.file.context, specification] + ctx.files.sources + package_files,
        tools = [node],
        outputs = [output],
        mnemonic = "BrowserRollup",
    )
    return [DefaultInfo(files = depset([output]))]

browser_bundle = rule(
    implementation = _bundle_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = {
        "bindings": attr.label(mandatory = True, allow_single_file = True),
        "sources": attr.label_list(mandatory = True, allow_files = True),
        "packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "context": attr.label(default = "@browser_sources//:metadata.json", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix/browser:bundle.mts", allow_single_file = True),
        "_driver": attr.label(default = "//build_defs/wasix/browser:rollup-compile.mts", allow_single_file = True),
        "_archives": attr.label(default = "//build_defs/wasix/browser:npm-archives.mts", allow_single_file = True),
    },
)

def _host_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("Browser ABI admission requires the pinned Node toolchain")
    package_files = []
    packages = {}
    for target, key in ctx.attr.packages.items():
        source = target[NpmPackageInfo].src
        package_files.append(source)
        packages[key] = source.path
    specification = ctx.actions.declare_file(ctx.label.name + ".compiler-inputs.json")
    ctx.actions.write(specification, json.encode({"packages": packages}))
    output = ctx.actions.declare_directory(ctx.label.name)
    inputs = [ctx.file.dist, ctx.file.curated, ctx.file.license, ctx.file.std_receipt, ctx.file.context, ctx.file._node_version, specification] + package_files
    code = bun_source_tree(ctx, ctx.label.name + ".sources", [ctx.file._runner, ctx.file._driver] + ctx.files._helpers)
    bun_file_action(
        ctx,
        ctx.file._runner,
        sources = code,
        arguments = [ctx.file.dist.path, ctx.file.curated.path, ctx.file.license.path, ctx.file.std_receipt.path, ctx.file.context.path, node.path, ctx.file._node_version.path, specification.path, bun_source_path(ctx, code, ctx.file._driver), output.path],
        inputs = inputs,
        tools = [node],
        outputs = [output],
        mnemonic = "BrowserHostEnvelope",
    )
    return [DefaultInfo(files = depset([output]))]

browser_host_package = rule(
    implementation = _host_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = {
        "dist": attr.label(mandatory = True, allow_single_file = True),
        "curated": attr.label(default = "//src/wasix/sdks/ts/src/host:index.d.mts", allow_single_file = True),
        "license": attr.label(default = "@browser_sources//:wasmer-js/LICENSE", allow_single_file = True),
        "std_receipt": attr.label(mandatory = True, allow_single_file = True),
        "context": attr.label(default = "@browser_sources//:metadata.json", allow_single_file = True),
        "packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "_node_version": attr.label(default = "@oliphaunt_toolchain_metadata//:node-version", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix/browser:package-host.mts", allow_single_file = True),
        "_driver": attr.label(default = "//build_defs/wasix/browser:check-host-abi.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/wasix/browser:npm-archives.mts", "//build_defs/wasix/browser:provenance.mts", "//build_defs/wasix/browser:metadata.mts"], allow_files = True),
    },
)

def _host_assets_impl(ctx):
    outputs = [ctx.actions.declare_file("lib/host/" + name) for name in ["index.mjs", "worker.mjs", "wasmer_js_bg.wasm", "index.d.mts", "LICENSE", "provenance.json"]]
    bun_file_action(
        ctx,
        ctx.file._copier,
        arguments = [ctx.file.host.path] + [file.path for file in outputs],
        inputs = [ctx.file.host],
        source_files = ctx.files._helpers,
        outputs = outputs,
        mnemonic = "BrowserSdkHostAssets",
    )
    return [DefaultInfo(files = depset(outputs))]

browser_host_assets = rule(
    implementation = _host_assets_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "host": attr.label(mandatory = True, allow_single_file = True),
        "_copier": attr.label(default = "//build_defs/wasix/browser:copy-host-assets.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/wasix/browser:provenance.mts", "//build_defs/wasix/browser:metadata.mts"], allow_files = True),
    },
)

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _consumer_launcher(ctx, mode, extra):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("Browser consumers require the pinned Node toolchain")
    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun
    packages = {}
    sources = []
    for target, key in ctx.attr.packages.items():
        source = target[NpmPackageInfo].src
        packages[key] = _runfile(ctx, source)
        sources.append(source)
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    data = {"packages": packages, "roots": ctx.attr.roots}
    if mode != "tools":
        data["runtime"] = ctx.attr.runtime_packages
        data["runtimeAcquisition"] = _runfile(ctx, ctx.file.runtime_acquisition)
        data["manifest"] = _runfile(ctx, ctx.file.manifest)
        sources += [ctx.file.runtime_acquisition, ctx.file.manifest]
        data["storageFixtures"] = {file.basename: _runfile(ctx, file) for file in ctx.files.storage_fixtures}
        data["seedArchive"] = _runfile(ctx, ctx.file.seed_archive)
        data["seedManifest"] = _runfile(ctx, ctx.file.seed_manifest)
        sources += ctx.files.storage_fixtures + [ctx.file.seed_archive, ctx.file.seed_manifest]
    ctx.actions.write(specification, json.encode(data))
    arguments = [ctx.file._runner, specification, ctx.file.acquisition, node, ctx.file._driver] + extra
    code = bun_source_tree(ctx, ctx.label.name + ".sources", [ctx.file._runner, ctx.file._driver] + ctx.files._helpers)
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    command = ['"$runfiles_dir/%s"' % bun_source_runfile(ctx, code, ctx.file._runner), mode] + ['"$runfiles_dir/%s"' % (bun_source_runfile(ctx, code, file) if file == ctx.file._driver else _runfile(ctx, file)) for file in arguments[1:]]
    ctx.actions.write(launcher, """#!/usr/bin/env bash
set -euo pipefail
runfiles_dir="$(cd "${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}" && pwd)"
cd "$runfiles_dir/%s"
export OLIPHAUNT_BAZEL_RUNFILES="$runfiles_dir"
exec "$runfiles_dir/%s" --no-install --no-env-file %s "$@"
""" % (ctx.workspace_name, _runfile(ctx, bun), " ".join(command)), is_executable = True)
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = arguments + sources + ctx.files._helpers + [bun], transitive_files = code.files))]

def _consumer_tools_impl(ctx):
    return _consumer_launcher(ctx, "tools", [])

_CONSUMER_ATTRS = {
    "packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
    "roots": attr.string_dict(mandatory = True),
    "acquisition": attr.label(default = "@javascript_consumer_packages//:acquisition.json", allow_single_file = True),
    "_runner": attr.label(default = "//build_defs/wasix/browser:consumer.mts", allow_single_file = True),
    "_driver": attr.label(default = "//build_defs/wasix/browser:consumer-tools-driver.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = ["//build_defs/wasix/browser:npm-archives.mts", "//build_defs/wasix/browser:chrome-receipt.mts", "//build_defs/wasix/browser:provenance.mts", "//build_defs/wasix/browser:metadata.mts"], allow_files = True),
}

browser_consumer_tools_test = rule(
    implementation = _consumer_tools_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = _CONSUMER_ATTRS,
)

def _consumer_impl(ctx):
    return _consumer_launcher(ctx, "package", [ctx.file.sdk, ctx.file.query, ctx.file.runtime, ctx.file.fixture, ctx.file.cdp, ctx.file.extensions])

_SQL_CONSUMER_ATTRS = _CONSUMER_ATTRS | {
    "storage_fixtures": attr.label(default = "//src/examples/wasix/browser:opfs_fixtures"),
    "seed_archive": attr.label(default = "//src/database-resources:wasix_standard_archive", allow_single_file = True),
    "seed_manifest": attr.label(default = "//src/database-resources:wasix_standard_manifest", allow_single_file = True),
    "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
    "fixture": attr.label(mandatory = True, allow_single_file = [".mts"]),
    "cdp": attr.label(mandatory = True, allow_single_file = [".mts"]),
    "extensions": attr.label(default = "//tools/release:frozen-extension-consumer.mts", allow_single_file = [".mts"]),
    "runtime_acquisition": attr.label(default = "@javascript_packages//:acquisition.json", allow_single_file = True),
    "runtime_packages": attr.string_dict(mandatory = True),
}

browser_sql_consumer = rule(
    implementation = _consumer_impl,
    executable = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = _SQL_CONSUMER_ATTRS | {
        "sdk": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "query": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "runtime": attr.label(mandatory = True, allow_single_file = [".tgz"]),
    },
)

def _consumer_lifecycle_impl(ctx):
    return _consumer_launcher(ctx, "archives", [ctx.file.fixture, ctx.file.cdp, ctx.file.extensions])

browser_sql_lifecycle = rule(
    implementation = _consumer_lifecycle_impl,
    executable = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = _SQL_CONSUMER_ATTRS,
)
