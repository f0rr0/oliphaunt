"""Final Android runtime carriers over the existing configured native producers."""

load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_RUNTIME_ARTIFACTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/android:toolchain.bzl", "android_artifact")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "BunScriptInfo", "bun_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/native/carriers:defs.bzl", "native_carrier_legal_inputs")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")

_LINUX = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
_TARGETS = {"android-arm64-v8a": "arm64", "android-x86_64": "x86_64"}
_AndroidRuntimeAssetsInfo = provider(fields = ["metadata", "assets", "maven"])

def _sources(entries, inputs):
    result = {}
    for target, member in entries.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or member in result:
            fail("Android runtime carrier input needs one unique declared File: " + str(target.label))
        result[member] = files[0].path
        inputs += files
    return result

def _runtime_impl(ctx):
    inputs = ctx.files.payload + ctx.files._strip
    if len(ctx.files.payload) != 1 or not ctx.files.payload[0].is_directory:
        fail("Android runtime resources require the actual declared Linux native payload tree")
    strip = [file for file in ctx.files._strip if file.basename == "llvm-strip"]
    if len(strip) != 1:
        fail("Android runtime envelopes require the actual NDK strip tool and its closure")
    metadata = json.decode(ctx.attr.metadata)
    outputs = {row["target"]: ctx.actions.declare_file(row["asset"].replace("{version}", metadata["version"])) for row in metadata["artifacts"]}
    maven = {row["name"]: ctx.actions.declare_directory(ctx.label.name + "/maven/" + row["name"].replace(":", "/")) for row in metadata["carriers"]}
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode(metadata | {
        "payload": ctx.files.payload[0].path,
        "libraries": _sources(ctx.attr.libraries, inputs),
        "receipts": _sources(ctx.attr.receipts, inputs),
        "headers": _sources(ctx.attr.headers, inputs),
        "notices": _sources(ctx.attr.notices, inputs),
        "resources": outputs["android-datum64"].path,
        "outputs": {target: file.path for target, file in outputs.items()},
        "mavenOutputs": {coordinate: file.path for coordinate, file in maven.items()},
        "formatter": ctx.executable._formatter.path,
        "strip": strip[0].path,
    }) + "\n")
    bun_action(ctx, ctx.attr._tool, arguments = [specification.path],
               inputs = inputs + [specification], tools = [ctx.attr._formatter[DefaultInfo].files_to_run],
               outputs = outputs.values() + maven.values(), mnemonic = "NativeAndroidRuntimeEnvelope")
    groups = {target.replace("-", "_"): depset([file]) for target, file in outputs.items()}
    for coordinate, file in maven.items():
        groups["maven_" + coordinate.split(":")[1].replace("-", "_")] = depset([file])
    return [DefaultInfo(files = depset(outputs.values() + maven.values())), OutputGroupInfo(**groups),
            _AndroidRuntimeAssetsInfo(metadata = ctx.attr.metadata, assets = outputs, maven = maven)]

_runtime_envelopes = rule(implementation = _runtime_impl, attrs = {
    "metadata": attr.string(mandatory = True),
    "payload": attr.label(default = "//src/native/runtime:public_payload"),
    "libraries": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
    "receipts": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
    "headers": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
    "notices": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
    "_formatter": attr.label(default = "//src/native/runtime/packaging:resources", executable = True, cfg = "exec"),
    "_strip": attr.label(default = "@android_ndk//:strip_files", allow_files = True, cfg = "exec"),
    "_tool": attr.label(default = "//build_defs/native/android:runtime_envelope", providers = [BunScriptInfo], cfg = "exec"),
})

def _assets_test_impl(ctx):
    info = ctx.attr.assets[_AndroidRuntimeAssetsInfo]
    arguments = [info.metadata]
    for target, file in info.assets.items():
        arguments += ["asset", target, file, file.path]
    for coordinate, file in info.maven.items():
        arguments += ["maven", coordinate, file, file.path]
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments,
                               info.assets.values() + info.maven.values() + ctx.files._helpers,
                               source_files = [ctx.file._runner] + ctx.files._helpers)

_assets_test = rule(implementation = _assets_test_impl, test = True,
                   toolchains = BUN_SOURCE_TOOLCHAINS,
                   attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
                       "assets": attr.label(mandatory = True, providers = [_AndroidRuntimeAssetsInfo]),
                       "_runner": attr.label(default = "//build_defs/native/android:runtime-assets.test.mts", allow_single_file = True),
                       "_helpers": attr.label(default = "//build_defs/native/android:runtime_helpers"),
                   }))

def native_android_runtime_targets():
    """Construction follows the canonical runtime artifacts and Maven identities."""
    product = "liboliphaunt-native"
    rows = [row for row in NATIVE_RUNTIME_ARTIFACTS if row["product"] == product and (row["kind"] == "native-runtime" and row["target"] in _TARGETS or row["kind"] == "runtime-resources" and row["target"] == "android-datum64")]
    if len(rows) != len(_TARGETS) + 1:
        fail("Android runtime requires exactly its canonical ABI and physical-domain artifacts")
    runtime_maven = [name[len("maven:"):] for name in PRODUCTS[product]["registry_packages"] if name.startswith("maven:")]
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == product and row["ecosystem"] == "maven" and row["name"] in runtime_maven]
    if len(carriers) != len(rows):
        fail("Android runtime must retain one canonical Maven identity per final artifact")
    libraries = {}
    for target, platform in _TARGETS.items():
        name = "android_runtime_" + platform
        android_artifact(name = name, artifact = ":runtime_shared", platform = "//build_defs/android:android_" + platform, target_compatible_with = _LINUX)
        libraries[":" + name] = target
    _runtime_envelopes(name = "android_release_assets", metadata = json.encode({"version": PRODUCTS[product]["version"], "artifacts": rows, "carriers": carriers}),
                       libraries = libraries, receipts = {
                           "//src/database-resources:android_arm64_abi": "android-arm64-v8a",
                           "//src/database-resources:android_x86_64_abi": "android-x86_64",
                           "//src/database-resources:native_target_abi": "linux-x64-gnu",
                       }, headers = {file: file[len("include/"):] for file in native.glob(["include/*.h"])},
                       notices = native_carrier_legal_inputs(), target_compatible_with = _LINUX)
    packages = []
    for row in rows:
        name = "android_" + row["target"].replace("android-", "").replace("-", "_")
        native.filegroup(name = name + "_archive", srcs = [":android_release_assets"], output_group = row["target"].replace("-", "_"), target_compatible_with = _LINUX)
        shipping_package(name = name + "_github_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":" + name + "_archive"],
                         ecosystem = "github", package_name = row["asset"].replace("{version}", PRODUCTS[product]["version"]), configuration = row["target"], role = "github-release-asset")
        packages.append(":" + name + "_github_shipping")
    for row in carriers:
        artifact = row["name"].split(":")[1]
        name = "android_maven_" + artifact.replace("-", "_")
        native.filegroup(name = name, srcs = [":android_release_assets"], output_group = "maven_" + artifact.replace("-", "_"), target_compatible_with = _LINUX)
        configuration = row["target"] if row["target"] != None else "android-datum64"
        shipping_package(name = name + "_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":" + name],
                         ecosystem = "maven", package_name = row["name"], configuration = configuration, role = row["role"])
        packages.append(":" + name + "_shipping")
    _assets_test(name = "android_runtime_assets_test", assets = ":android_release_assets", args = bun_test_entrypoint_args("android_runtime_assets_test"),
                 target_compatible_with = _LINUX, size = "small")
    shipping_export(name = "android_shipping_export", packages = packages, qualification = [":android_runtime_assets_test", "//src/examples/native/react-native-expo:android_installed_test", "//src/examples/native/react-native-expo:android_cpp_reuse_test"], testonly = True, target_compatible_with = _LINUX)
