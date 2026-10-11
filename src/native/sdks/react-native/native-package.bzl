"""Bounded React Native source-envelope actions; TypeScript owns compilation."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@javascript_compiler_packages//:roots.bzl", "COMPILER_PACKAGES", "COMPILER_TOOLS")
load("@bazel_lib//lib:copy_file.bzl", "COPY_FILE_TOOLCHAINS", "copy_file_action")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")

_PACKAGE_HELPERS = [
    ":tools/native-package.mts", ":tools/native-carrier-package.mts",
    "//build_defs/release:frozen-native-carrier.mts", "//build_defs/query:package.mts",
    "//src/native/sdks/swift:tools/native-legal-source-basis.mts",
    "//src/native/sdks/swift:tools/swift-native-carrier-contract.mts",
    "//:tools/packaging/source-only-sdk-package.mts", "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/portable-archive.mts", "//:tools/packaging/release-notices.mts",
    "//:tools/packaging/release-directory-safety.mts", "//:LICENSE", "//:THIRD_PARTY_NOTICES.md",
]

_PACKAGE_ATTRS = {
    "source_archive": attr.label(mandatory = True, allow_single_file = [".tgz"]),
    "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
    "carrier": attr.label(default = "@swift_frozen_native//:carrier", allow_single_file = True),
    "carrier_source": attr.label(default = "//build_defs/release:swift-0.8.2-source.json", allow_single_file = True),
    "native_version": attr.label(default = "//src/native/sdks/swift:LIBOLIPHAUNT_VERSION", allow_single_file = True),
    "native_releases": attr.label(default = "//build_defs/release:native-0.3.3-releases.json", allow_single_file = True),
    "native_completion": attr.label(default = "//build_defs/release:native-0.3.3-completed-publication.json", allow_single_file = True),
    "swift_source": attr.label(default = "//build_defs/release:swift-0.8.2-publication-source.json", allow_single_file = True),
    "xcframework": attr.label(default = "@swift_frozen_native//:xcframework_archive", allow_single_file = True),
    "ios_static_dependencies": attr.label(default = "//src/extensions/generated/sdk:ios-static-dependencies.json", allow_single_file = True),
    "_helpers": attr.label_list(default = _PACKAGE_HELPERS, allow_files = True),
}

def _package_spec(ctx, runfiles = False):
    fields = {"sourceArchive": "source_archive", "authoredManifest": "manifest", "carrier": "carrier", "carrierSource": "carrier_source", "nativeVersion": "native_version", "nativeReleases": "native_releases", "nativeCompletion": "native_completion", "swiftSource": "swift_source", "xcframework": "xcframework", "iosStaticDependencies": "ios_static_dependencies"}
    files = [getattr(ctx.file, field) for field in fields.values()]
    return {name: _runfile(ctx, getattr(ctx.file, field)) if runfiles else getattr(ctx.file, field).path for name, field in fields.items()}, files

def _package_impl(ctx):
    inputs, files = _package_spec(ctx)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(inputs))
    output = ctx.actions.declare_file(ctx.attr.out)
    bun_file_action(ctx, entry_point = ctx.file._writer, arguments = [spec.path, output.path], inputs = files + [spec] + ctx.files._helpers, source_files = ctx.files._helpers, outputs = [output], mnemonic = "ReactNativeNpmPackage")
    return [DefaultInfo(files = depset([output]))]

react_native_npm = rule(
    implementation = _package_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_PACKAGE_ATTRS, **{"out": attr.string(mandatory = True), "_writer": attr.label(default = ":tools/native-package.mts", allow_single_file = True)}),
)

def _package_test_impl(ctx):
    inputs, files = _package_spec(ctx, runfiles = True)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(inputs))
    return bun_test_entrypoint(ctx, ctx.file._runner, [spec, ctx.file.archive], files + [spec, ctx.file.archive, ctx.file._runner] + ctx.files._helpers, source_files = [ctx.file._runner] + ctx.files._helpers, runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_react_native_package_test = rule(
    implementation = _package_test_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **dict(_PACKAGE_ATTRS, **{"archive": attr.label(mandatory = True, allow_single_file = [".tgz"]), "_runner": attr.label(default = ":tools/native-package.test.mts", allow_single_file = True)})),
)

def react_native_package_test(name, args = [], **kwargs):
    _react_native_package_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def _manifest_impl(ctx):
    outputs = [ctx.actions.declare_file(ctx.label.name + "/" + name) for name in ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]]
    bun_file_action(
        ctx,
        entry_point = ctx.file._writer,
        arguments = [ctx.file.manifest.path, outputs[0].dirname],
        inputs = [ctx.file._writer, ctx.file.manifest] + ctx.files._helpers,
        source_files = [ctx.file._writer] + ctx.files._helpers,
        outputs = outputs,
        mnemonic = "ReactNativeSourceManifest",
    )
    return [DefaultInfo(files = depset(outputs)), OutputGroupInfo(manifest = depset([outputs[0]]), license = depset([outputs[1]]), notices = depset([outputs[2]]))]

react_native_manifest = rule(
    implementation = _manifest_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
        "_writer": attr.label(default = ":tools/native-manifest.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//:LICENSE", "//:THIRD_PARTY_NOTICES.md", "//:tools/packaging/source-only-sdk-package.mts", "//:tools/packaging/release-notices.mts", "//:tools/packaging/release-directory-safety.mts", "//:tools/packaging/portable-archive.mts"], allow_files = True),
    },
)

def _templates_impl(ctx):
    outputs = []
    prefix = ctx.attr.sources.label.package + "/Templates/OliphauntBroker/"
    for source in ctx.files.sources:
        if not source.short_path.startswith(prefix):
            fail("Broker template is outside the canonical Swift source template directory: " + source.short_path)
        output = ctx.actions.declare_file("ios/templates/OliphauntBroker/" + source.short_path[len(prefix):])
        copy_file_action(ctx, src = source, dst = output)
        outputs.append(output)
    return [DefaultInfo(files = depset(outputs))]

react_native_templates = rule(
    implementation = _templates_impl,
    attrs = {"sources": attr.label(mandatory = True, allow_files = True)},
    toolchains = COPY_FILE_TOOLCHAINS,
)

def _bundle_impl(ctx):
    binary = ctx.attr.binary[NpmPackageInfo].src
    sources = {}
    for target, destination in ctx.attr.sources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("Each helper source must declare exactly one file: " + str(target.label))
        sources[destination] = files[0].path
    specification = ctx.actions.declare_file(ctx.label.name + ".sources.json")
    ctx.actions.write(specification, json.encode(sources))
    output = ctx.actions.declare_file(ctx.attr.out)
    bun_file_action(
        ctx,
        entry_point = ctx.file._writer,
        arguments = [binary.path, specification.path, output.path],
        inputs = depset([ctx.file._writer, ctx.file._archive, binary, specification] + [file for target in ctx.attr.sources for file in target[DefaultInfo].files.to_list()]),
        source_files = [ctx.file._writer, ctx.file._archive],
        outputs = [output],
        mnemonic = "ReactNativeHelperBundle",
    )
    return [DefaultInfo(files = depset([output]))]

_react_native_bundle = rule(
    implementation = _bundle_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "binary": attr.label(mandatory = True, providers = [NpmPackageInfo], cfg = "exec"),
        "sources": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "out": attr.string(mandatory = True),
        "_writer": attr.label(default = ":tools/native-bundle.mts", allow_single_file = True),
        "_archive": attr.label(default = "//build_defs/wasix/browser:npm-archives.mts", allow_single_file = True),
    },
)

def react_native_bundle(name, **kwargs):
    binaries = {}
    tool = COMPILER_PACKAGES[COMPILER_TOOLS["esbuild"]]
    for dependency in tool["dependencies"].values():
        package = COMPILER_PACKAGES[dependency]
        if "os" not in package or "cpu" not in package:
            fail("esbuild optional binaries require canonical platform metadata")
        # Match the supported execution runtimes; source URLs/checksums/versions
        # come exclusively from the conventional lock projection.
        os = {"linux": "linux", "darwin": "macos", "win32": "windows"}.get(package["os"])
        cpu = {"x64": "x86_64", "arm64": "aarch64"}.get(package["cpu"])
        if not os or not cpu:
            continue
        setting = name + "_" + os + "_" + cpu
        native.config_setting(name = setting, constraint_values = ["@platforms//os:" + os, "@platforms//cpu:" + cpu])
        binaries[":" + setting] = "@javascript_compiler_packages//:" + dependency
    native.alias(name = name + "_compiler_binary", actual = select(binaries))
    _react_native_bundle(name = name, binary = ":" + name + "_compiler_binary", **kwargs)

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _consumer_impl(ctx):
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node
    packages = dict(ctx.attr.packages)
    files = []
    seen = {}
    for target, key in ctx.attr.inputs.items():
        if key in seen:
            fail("Installed compiler input ID was declared more than once: " + key)
        seen[key] = True
        source = target[NpmPackageInfo].src
        files.append(source)
        row = json.decode(packages[key])
        row["source"] = _runfile(ctx, source)
        row["package"] = target[NpmPackageInfo].package
        row["version"] = target[NpmPackageInfo].version
        packages[key] = row
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    carrier_inputs, carrier_files = _package_spec(ctx, runfiles = True) if ctx.attr.final_package else (None, [])
    ctx.actions.write(specification, json.encode({"name": ctx.attr.package_name, "version": ctx.attr.version, "packages": packages, "roots": ctx.attr.roots, "carrierInputs": carrier_inputs, "runtimeResources": _runfile(ctx, ctx.file.runtime_resources) if ctx.attr.final_package else None}))
    arguments = [ctx.file.archive, ctx.file.query, ctx.file.manifest, node, ctx.file.typescript, specification]
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files + arguments + carrier_files + ([ctx.file.runtime_resources] if ctx.attr.final_package else []) + [ctx.file._runner, ctx.file._archive, ctx.file._shipping_archive] + ctx.files._helpers, source_files = [ctx.file._runner, ctx.file._archive, ctx.file._shipping_archive] + ctx.files._helpers, runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_react_native_consumer_test = rule(
    implementation = _consumer_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + ["@rules_nodejs//nodejs:toolchain_type"],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **dict(_PACKAGE_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "query": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
        "typescript": attr.label(default = "@npm_typescript//:node_modules/typescript/dir", allow_single_file = True),
        "inputs": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "packages": attr.string_dict(mandatory = True), "roots": attr.string_dict(mandatory = True),
        "package_name": attr.string(mandatory = True), "version": attr.string(mandatory = True),
        "final_package": attr.bool(default = False),
        "source_archive": attr.label(allow_single_file = [".tgz"]),
        "carrier": attr.label(allow_single_file = True),
        "carrier_source": attr.label(allow_single_file = True),
        "native_version": attr.label(allow_single_file = True),
        "native_releases": attr.label(allow_single_file = True),
        "native_completion": attr.label(allow_single_file = True),
        "swift_source": attr.label(allow_single_file = True),
        "xcframework": attr.label(allow_single_file = True),
        "ios_static_dependencies": attr.label(allow_single_file = True),
        "runtime_resources": attr.label(allow_single_file = True),
        "_runner": attr.label(default = ":tools/native-consumer.mts", allow_single_file = True),
        "_archive": attr.label(default = "//build_defs/wasix/browser:npm-archives.mts", allow_single_file = True),
        "_shipping_archive": attr.label(default = "//:tools/packaging/portable-archive.mts", allow_single_file = True),
    })),
)

def react_native_consumer_test(name, args = [], **kwargs):
    _react_native_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
