"""SDK-owned source/relink delivery and its genuine Windows toolchain smoke."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "WASIX_ARTIFACTS")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/native/carriers:defs.bzl", "native_checksum_manifest")
load("//build_defs/release:shipping.bzl", "shipping_package")

_PRODUCT = "oliphaunt-wasix-rust"
_WINDOWS = ["@platforms//os:windows", "@platforms//cpu:x86_64"]
_HELPERS = [
    "//src/wasix/runtime/engine:relink.mts",
    "//build_defs/wasix/engine:generate.mts",
    "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/portable-archive.mts",
]

def _kit_impl(ctx):
    version = PRODUCTS[_PRODUCT]["version"]
    rows = [row for row in WASIX_ARTIFACTS if row["product"] == _PRODUCT and row["kind"] == "windows-v8-relink"]
    if len(rows) != 1:
        fail("SDK requires its declared Windows V8 relink delivery")
    output = ctx.actions.declare_file(rows[0]["asset"].replace("{version}", version))
    inputs = ctx.files.packages + ctx.files.sources + [ctx.file.source_pins, ctx.file.engine_pins, ctx.file.upstream_archive, ctx.file.notices]
    glue = {}
    for name in ["bridge", "header", "exports", "bindings", "generator", "loader", "build_script"]:
        file = getattr(ctx.file, name)
        glue["buildScript" if name == "build_script" else name] = file.path
        inputs.append(file)
    suffix = "-" + version + ".crate"
    crates = {}
    for file in ctx.files.packages:
        if not file.basename.endswith(suffix):
            fail("Relink kit requires the actual owner-version Cargo archives")
        name = file.basename[:-len(suffix)]
        if name in crates:
            fail("Relink kit repeats a Cargo identity")
        crates[name] = file.path
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "version": version,
        "sourcePinsFile": ctx.file.source_pins.path,
        "enginePinsFile": ctx.file.engine_pins.path,
        "sourceDirectory": ctx.file.source_pins.dirname,
        "upstreamArchiveFile": ctx.file.upstream_archive.path,
        "glue": glue, "crates": crates,
        "noticesFile": ctx.file.notices.path,
        "output": output.path,
    }))
    bun_file_action(ctx, ctx.file._runner, arguments = [spec.path], inputs = inputs + [spec], source_files = ctx.files._helpers,
                    outputs = [output], mnemonic = "WindowsEngineRelinkDelivery")
    return [DefaultInfo(files = depset([output]))]

_kit = rule(implementation = _kit_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "packages": attr.label(mandatory = True),
    "sources": attr.label(default = "@wasix_engine_relink_sources//:sources"),
    "source_pins": attr.label(default = "@wasix_engine_relink_sources//:relink.json", allow_single_file = True),
    "engine_pins": attr.label(default = "//src/wasix/runtime/engine:sources.json", allow_single_file = True),
    "upstream_archive": attr.label(default = "@windows_wee8//:v8-windows-amd64.tar.xz", allow_single_file = True),
    "notices": attr.label(default = "@wasix_engine_notices//:THIRD_PARTY_NOTICES.md", allow_single_file = True),
    "bridge": attr.label(default = "//build_defs/wasix/engine:bridge.cc", allow_single_file = True),
    "header": attr.label(default = "@windows_wee8//:wasm.hh", allow_single_file = True),
    "exports": attr.label(mandatory = True, allow_single_file = True, cfg = "exec"),
    "bindings": attr.label(mandatory = True, allow_single_file = True),
    "generator": attr.label(default = "//build_defs/wasix/engine:generate.mts", allow_single_file = True),
    "loader": attr.label(default = "//build_defs/wasix/engine:embedded-engine.rs", allow_single_file = True),
    "build_script": attr.label(default = "//build_defs/wasix/engine:build.rs.tpl", allow_single_file = True),
    "_runner": attr.label(default = Label(":relink-package.mts"), allow_single_file = True),
    "_helpers": attr.label_list(default = _HELPERS, allow_files = True),
})

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _sdk_directory(value):
    if not value.startswith("external/"):
        fail("Relink smoke requires a declared external SDK directory: " + value)
    return value[len("external/"):]

def _smoke_impl(ctx):
    compiler = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = compiler, requested_features = ["static_link_msvcrt"], unsupported_features = [])
    environment = dict(cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = cc_common.create_compile_variables(cc_toolchain = compiler, feature_configuration = features)))
    environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_dynamic_library, variables = cc_common.create_link_variables(cc_toolchain = compiler, feature_configuration = features, output_file = "relinked.dll", is_linking_dynamic_library = True)))
    llvm = ctx.files.llvm
    clang = [file for file in llvm if file.basename.lower() == "clang-cl.exe"]
    if len(clang) != 1:
        fail("Relink smoke requires the pinned LLVM clang-cl executable")
    tools = {"clangCl": _runfile(ctx, clang[0]), "library": _runfile(ctx, ctx.file.library)}
    tool_actions = {"cl": ACTION_NAMES.c_compile, "lib": ACTION_NAMES.cpp_link_static_library, "link": ACTION_NAMES.cpp_link_dynamic_library}
    compiler_files = compiler.all_files.to_list()
    for name, action in tool_actions.items():
        selected = cc_common.get_tool_for_action(feature_configuration = features, action_name = action)
        files = [file for file in compiler_files if file.path == selected]
        if len(files) != 1:
            fail("Relink tool must be an actual declared compiler File: " + selected)
        tools[name] = _runfile(ctx, files[0])
    spec = ctx.actions.declare_file(ctx.label.name + ".tools.json")
    ctx.actions.write(spec, json.encode({"tools": tools, "environment": {name: [_sdk_directory(directory) for directory in environment[name].split(";")] for name in ["INCLUDE", "LIB", "PATH"]}}))
    llvm_runtime = [file for file in llvm if "/bin/" in file.path or "/lib/clang/" in file.path]
    files = [ctx.file.kit, spec, ctx.executable.loader, ctx.file.library] + compiler_files + llvm_runtime + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [ctx.file.kit, spec, ctx.executable.loader], files,
                               source_files = ctx.files._helpers + [ctx.file._runner], runfiles_argument = True)

_smoke_test = rule(implementation = _smoke_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS + use_cc_toolchain(), fragments = ["cpp"], attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
    "kit": attr.label(mandatory = True, allow_single_file = True),
    "loader": attr.label(default = "//src/wasix/runtime/engine:relink_loader", executable = True, cfg = "target"),
    "library": attr.label(default = "@windows_wee8//:lib/v8.lib", allow_single_file = True),
    "llvm": attr.label(default = "@wasmer_llvm_windows_x64//:files", allow_files = True),
    "_runner": attr.label(default = Label(":relink-smoke.mts"), allow_single_file = True),
    "_helpers": attr.label_list(default = _HELPERS, allow_files = True),
}))

def windows_engine_relink(available):
    if available:
        return
    _kit(name = "relink_kit", packages = ":packages", exports = ":oliphaunt_wee8_def", bindings = ":v8_c_bindings", target_compatible_with = _WINDOWS, exec_compatible_with = _WINDOWS)
    _smoke_test(name = "relink_smoke_test", kit = ":relink_kit", args = bun_test_entrypoint_args("relink_smoke_test"), target_compatible_with = _WINDOWS, exec_compatible_with = _WINDOWS, size = "large", timeout = "long", tags = ["manual"])
    native_checksum_manifest(name = "relink_release_assets", product = _PRODUCT, archives = [":relink_kit"], artifact_rows = WASIX_ARTIFACTS, assemble = True)
    assets = {row["kind"]: row["asset"].replace("{version}", PRODUCTS[_PRODUCT]["version"]) for row in WASIX_ARTIFACTS if row["product"] == _PRODUCT}
    for name, kind in [("relink", "windows-v8-relink"), ("relink_checksums", "checksums")]:
        native.filegroup(name = name, srcs = [":relink_release_assets"], output_group = "checksums" if kind == "checksums" else assets[kind])
        shipping_package(name = name + "_shipping", owner = "@oliphaunt_metadata//:product_" + _PRODUCT, artifacts = [":" + name], ecosystem = "github", package_name = assets[kind], configuration = "windows-x64-msvc" if name == "relink" else "portable", role = "github-release-asset", suppliers = "//build_defs/release:no_suppliers")
