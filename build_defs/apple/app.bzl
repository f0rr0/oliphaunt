"""Original Expo/RN generation; stock Apple and Swift rules own compilation."""
load("//build_defs/android:app.bzl", "APP_NODE_INPUT_ATTRS", "app_node_inputs")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load(":generated-files.bzl", "IOS_GENERATED_FILES")

_NODE = "@rules_nodejs//nodejs:toolchain_type"
_TAR = "@tar.bzl//tar/toolchain:type"
IosProjectInfo = provider(fields = {"files": "Original individual generator output Files"})

def ios_project_file_name(relative):
    return "ios_" + relative.replace("/", "_").replace(".", "_").replace(" ", "_").replace("-", "_")

def _action(ctx, operation, specification, inputs, outputs, mnemonic):
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(specification) + "\n")
    bun_file_action(
        ctx, entry_point = ctx.file._apple_runner, arguments = [operation, spec.path],
        inputs = inputs + [spec, ctx.file._apple_runner] + ctx.files._apple_helpers,
        source_files = [ctx.file._apple_runner] + ctx.files._apple_helpers,
        outputs = outputs, execution_requirements = {"block-network": "1"}, mnemonic = mnemonic,
    )

_APPLE_INPUTS = dict(APP_NODE_INPUT_ATTRS, **{
    "_apple_runner": attr.label(default = Label("//build_defs/apple:app.mts"), allow_single_file = True),
    "_apple_helpers": attr.label_list(default = [
        Label("//build_defs/android:app.mts"),
        Label("//:tools/packaging/archive-directory.mts"),
        Label("//:tools/packaging/portable-archive.mts"),
    ], allow_files = True),
})

def _project_impl(ctx):
    spec, inputs = app_node_inputs(ctx)
    outputs = {name: ctx.actions.declare_file(ctx.label.name + "/" + name) for name in IOS_GENERATED_FILES}
    resolved = ctx.actions.declare_file(ctx.label.name + "/autolinking.json")
    constants = ctx.actions.declare_file(ctx.label.name + "/constants/app.config")
    _action(ctx, "project", spec | {
        "targetName": ctx.attr.target_name, "expectedModules": ctx.attr.expected_modules,
        "outputs": {name: file.path for name, file in outputs.items()}, "autolinking": resolved.path,
        "constantsConfig": constants.path,
        "swiftSdkVersion": ctx.attr.swift_sdk_version,
    }, inputs, outputs.values() + [resolved, constants], "ExpoAppleOriginalSources")
    return [
        DefaultInfo(files = depset(outputs.values() + [resolved, constants])),
        IosProjectInfo(files = outputs),
        OutputGroupInfo(autolinking = depset([resolved]), constants = depset([constants])),
    ]

expo_ios_project = rule(
    implementation = _project_impl, toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE, _TAR],
    attrs = dict(_APPLE_INPUTS, **{
        "target_name": attr.string(mandatory = True),
        "expected_modules": attr.string_dict(mandatory = True),
        "swift_sdk_version": attr.string(mandatory = True),
    }),
)

def _file_impl(ctx):
    project = ctx.attr.project[IosProjectInfo]
    if ctx.attr.path not in project.files:
        fail("Original Expo/RN generation has no declared File " + ctx.attr.path)
    return [DefaultInfo(files = depset([project.files[ctx.attr.path]]))]

ios_project_file = rule(implementation = _file_impl, attrs = {
    "project": attr.label(mandatory = True, providers = [IosProjectInfo]),
    "path": attr.string(mandatory = True),
})

def _bundle_impl(ctx):
    spec, inputs = app_node_inputs(ctx)
    bundle = ctx.actions.declare_file(ctx.label.name + "/main.jsbundle")
    source_map = ctx.actions.declare_file(ctx.label.name + "/main.jsbundle.map")
    resources = ctx.actions.declare_directory(ctx.label.name + "/assets")
    _action(ctx, "bundle", spec | {
        "entry": ctx.attr.entry, "environment": ctx.attr.environment,
        "selectedExtensions": ctx.attr.selected_extensions, "catalogProfile": ctx.attr.catalog_profile,
        "profileProbe": ctx.file.catalog_profile_probe.path,
        "bundle": bundle.path, "sourceMap": source_map.path, "resources": resources.path,
    }, inputs + [ctx.file.catalog_profile_probe], [bundle, source_map, resources], "ExpoAppleHermesBundle")
    return [
        DefaultInfo(files = depset([bundle])),
        OutputGroupInfo(bundle = depset([bundle]), source_map = depset([source_map]), resources = depset([resources])),
    ]

expo_ios_bundle = rule(
    implementation = _bundle_impl, toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE, _TAR],
    attrs = dict(_APPLE_INPUTS, **{"entry": attr.string(default = "index.ts"), "environment": attr.string_dict(),
        "selected_extensions": attr.string_list(mandatory = True), "catalog_profile": attr.string(default = "standard", values = ["standard", "icu"]),
        "catalog_profile_probe": attr.label(default = Label("//src/database-resources:contracts/profile-probe.json"), allow_single_file = [".json"])}),
)
