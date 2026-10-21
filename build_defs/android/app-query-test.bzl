"""The mobile example uses the actual selected or completed TS supplier."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts", "unittest")
load(":app.bzl", "android_app_configuration", "android_workspace_npm", "mobile_query_input")
load("@rules_android//rules:min_sdk_version.bzl", "min_sdk_version")
load("@rules_android//rules:android_platforms_transition.bzl", platforms_transition = "testing")
load("@rules_android//rules:desugar.bzl", "desugar")
load("@rules_android//rules:dex.bzl", "dex")
load("@rules_android//rules/android_binary:impl.bzl", "PROCESSORS")
load("@rules_android//android:rules.bzl", "android_binary")
load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo", "int_flag")
load("//build_defs/release:shipping.bzl", "ShippingExportInfo", "ShippingInfo")

def _query_input_test_impl(ctx):
    env = unittest.begin(ctx)
    owner = "oliphaunt-query-ts"
    key = owner + "/0.1.1/npm:@oliphaunt/ts-query"
    suppliers = {key: {
        "publication": {"product": owner, "version": "0.1.1"},
        "artifact": "npm:@oliphaunt/ts-query",
        "file": {"path": "@oliphaunt_metadata//:held-query.tgz", "sha256": "a" * 64, "size": 123},
    }}
    # Equal versions do not make unpublished bytes a completed supplier.
    held = mobile_query_input(owner, "0.1.1", "0.1.1", "0.1.1", [], suppliers)
    asserts.equals(env, "@oliphaunt_metadata//:held-query.tgz", held["archive"])
    asserts.equals(env, "completed-supplier", held["metadata"]["origin"])
    asserts.equals(env, "a" * 64, held["metadata"]["sourceSha256"])
    for selected in [[], [owner]]:
        major = mobile_query_input(owner, "0.1.1", "1.0.0", "1.0.0", selected, suppliers)
        asserts.equals(env, held, major)
    stale = mobile_query_input(owner, "0.1.1", "0.1.1", "0.2.0", [owner], suppliers)
    asserts.equals(env, held, stale)
    rust = mobile_query_input(owner, "0.1.1", "0.1.1", "0.1.1", ["oliphaunt-query"], suppliers)
    asserts.equals(env, held, rust)
    prepared = mobile_query_input(owner, "0.1.1", "0.1.1", "0.1.1", [owner], suppliers)
    asserts.equals(env, "//src/query/ts:npm", prepared["archive"])
    asserts.equals(env, "prepared-source", prepared["metadata"]["origin"])
    empty = mobile_query_input(owner, "0.1.1", "0.1.1", "0.1.1", [], {})
    asserts.equals(env, None, empty["archive"])
    asserts.equals(env, "Mobile app requires the genuine completed query supplier " + key, empty["error"])
    return unittest.end(env)

_query_input_test = unittest.make(_query_input_test_impl)

def _missing_query_test_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, "Mobile app requires the genuine completed query supplier oliphaunt-query-ts/0.1.1/npm:@oliphaunt/ts-query")
    return analysistest.end(env)

_missing_query_test = analysistest.make(_missing_query_test_impl, expect_failure = True)

def mobile_query_input_tests():
    _query_input_test(name = "mobile_query_input_test")
    missing = mobile_query_input("oliphaunt-query-ts", "0.1.1", "0.1.1", "0.1.1", [], {})
    android_workspace_npm(name = "missing_query_subject", archive = missing["archive"],
                          error = missing["error"], package_name = missing["metadata"]["package"],
                          version = missing["metadata"]["version"], tags = ["manual"])
    _missing_query_test(name = "missing_query_test", target_under_test = ":missing_query_subject")

def _android_min_sdk_test_impl(ctx):
    env = analysistest.begin(ctx)
    # Exercise the actual maintained provider reader, including its unchanged default.
    for configured, expected in [(0, 23), (23, 23), (24, 24), (26, 26)]:
        subject = struct(attr = struct(_min_sdk_version = {BuildSettingInfo: BuildSettingInfo(value = configured)}))
        asserts.equals(env, expected, min_sdk_version.get(subject))
    for abi, platform in [("arm64-v8a", "arm64"), ("x86_64", "x86_64")]:
        for minimum in [24, 26]:
            configuration = android_app_configuration({}, struct(abi = abi, min_sdk_version = minimum))
            asserts.equals(env, minimum, configuration[str(Label("@rules_android//rules:min_sdk_version"))])
            asserts.equals(env, ["//build_defs/android:android_" + platform], configuration["//command_line_option:android_platforms"])
            asserts.equals(env, "opt", configuration["//command_line_option:compilation_mode"])
            # The maintained dependency transition preserves an incoming SDK
            # rather than invoking its dormant clamp or lowering the setting.
            settings = {
                "//command_line_option:android_platforms": configuration["//command_line_option:android_platforms"],
                "//command_line_option:platforms": ["//build_defs/native:linux_x86_64_glibc_2_28"],
                min_sdk_version.SETTING: minimum,
            }
            for declared in [0, 24, 26]:
                transitioned = platforms_transition.impl(settings, struct(min_sdk_version = declared))
                asserts.equals(env, minimum, transitioned[min_sdk_version.SETTING])
                asserts.equals(env, configuration["//command_line_option:android_platforms"], transitioned["//command_line_option:platforms"])
            # An authored minimum also propagates from an unconfigured root.
            settings[min_sdk_version.SETTING] = 0
            transitioned = platforms_transition.impl(settings, struct(min_sdk_version = minimum))
            asserts.equals(env, minimum, transitioned[min_sdk_version.SETTING])

    subject = analysistest.target_under_test(env)
    cases = subject[_MinimumSdkCases].cases
    flags = {
        "Desugar": "--min_sdk_version",
        "DexBuilder": "--min_sdk_version",
        "DexMerger": "--min_sdk_version",
        "AndroidDexer": "--min-sdk-version",
    }
    observed = []
    for action in analysistest.target_actions(env):
        if action.mnemonic not in flags:
            continue
        output = action.outputs.to_list()[0]
        case = [name for name in cases if name in output.path.split("/")][0]
        minimum = cases[case]
        flag = flags[action.mnemonic]
        observed.append((case, action.mnemonic))
        if minimum:
            asserts.equals(env, 1, len([arg for arg in action.argv if arg == flag]))
            asserts.equals(env, str(minimum), action.argv[action.argv.index(flag) + 1])
        else:
            asserts.false(env, flag in action.argv)
        if action.mnemonic == "AndroidDexer":
            asserts.false(env, "--min_sdk_version" in action.argv)
    asserts.equals(env, sorted([(case, mnemonic) for case in cases for mnemonic in flags]), sorted(observed))
    return analysistest.end(env)

_MinimumSdkCases = provider(fields = ["cases"])

def _android_dex_actions_impl(ctx):
    tool = ctx.actions.declare_file(ctx.label.name + "/tool")
    source = ctx.actions.declare_file(ctx.label.name + "/input.jar")
    config = ctx.actions.declare_file(ctx.label.name + "/desugar.json")
    ctx.actions.write(tool, "#!/bin/sh\nexit 1\n", is_executable = True)
    ctx.actions.write(source, "analysis-only jar")
    ctx.actions.write(config, "{}")
    cases = {}
    outputs = []
    for index, (configured, declared, expected) in enumerate([(0, 0, 0), (23, 0, 23), (24, 0, 24), (26, 0, 26), (24, 26, 26)]):
        case = ctx.label.name + "_" + str(index)
        subject = struct(
            actions = ctx.actions,
            attr = struct(
                min_sdk_version = declared,
                manifest_values = {"minSdkVersion": str(expected)} if expected else {},
                _min_sdk_version = {BuildSettingInfo: BuildSettingInfo(value = configured)},
                _java_toolchain = ctx.attr._java_toolchain,
            ),
            file = struct(manifest = None),
            fragments = ctx.fragments,
            label = struct(name = case),
            var = ctx.var,
        )
        manifest = PROCESSORS["ManifestProcessor"](subject).value
        if manifest.processed_min_sdk_version != expected:
            fail("Configured/declared minimum SDK did not reach the app manifest processor")
        minimum = min_sdk_version.clamp(manifest.processed_min_sdk_version)
        cases[case] = expected
        desugared = ctx.actions.declare_file(case + "/desugared.jar")
        incremental = ctx.actions.declare_file(case + "/incremental.dex.zip")
        merged = ctx.actions.declare_file(case + "/merged.dex.zip")
        monolithic = ctx.actions.declare_file(case + "/monolithic.dex.zip")
        desugar.desugar(subject, input = source, output = desugared, classpath = depset(),
                        min_sdk_version = minimum, desugar_exec = tool, desugared_lib_config = config)
        dex.dex(subject, input = desugared, output = incremental, min_sdk_version = minimum, dex_exec = tool)
        dex.dex_merge(subject, inputs = [incremental], output = merged, min_sdk_version = minimum, dexmerger = tool)
        dex.process_monolithic_dexing(subject, input = desugared, output = monolithic,
                                      min_sdk_version = manifest.processed_min_sdk_version, dexbuilder = tool)
        outputs.extend([desugared, incremental, merged, monolithic])
    return [DefaultInfo(files = depset(outputs)), _MinimumSdkCases(cases = cases)]

_android_dex_actions = rule(
    implementation = _android_dex_actions_impl,
    attrs = {"_java_toolchain": attr.label(default = Label("@bazel_tools//tools/jdk:current_java_toolchain"))},
    fragments = ["android"],
    toolchains = ["@bazel_tools//tools/jdk:toolchain_type"],
)

_android_min_sdk_test = analysistest.make(_android_min_sdk_test_impl)

_FinalDataFiles = provider(fields = ["files", "attributes", "abis"])

def _final_data_files_impl(_target, ctx):
    inherited = []
    for name in ["apk", "deps", "assets", "aar"]:
        dependencies = getattr(ctx.rule.attr, name, [])
        if type(dependencies) != "list":
            dependencies = [dependencies] if dependencies else []
        inherited += [dependency[_FinalDataFiles] for dependency in dependencies if _FinalDataFiles in dependency]
    files, attributes, abis = [], [], []
    if ctx.rule.kind in ["android_final_aar", "android_app_runtime_assets"]:
        names = ["source"] if ctx.rule.kind == "android_final_aar" else ["payload", "icu", "leaves"]
        for name in names:
            dependencies = getattr(ctx.rule.attr, name)
            if type(dependencies) != "list":
                dependencies = [dependencies] if dependencies else []
            files += [file for dependency in dependencies for file in dependency[DefaultInfo].files.to_list()]
            attributes.append(name)
        if ctx.rule.kind == "android_app_runtime_assets":
            abis.append(ctx.rule.attr.abi)
    return [_FinalDataFiles(
        files = depset(files, transitive = [data.files for data in inherited]),
        attributes = depset(attributes, transitive = [data.attributes for data in inherited]),
        abis = depset(abis, transitive = [data.abis for data in inherited]),
    )]

_final_data_files = aspect(implementation = _final_data_files_impl, attr_aspects = ["apk", "deps", "assets", "aar"])

def _android_binary_min_sdk_test_impl(ctx):
    env = analysistest.begin(ctx)
    flags = {"AndroidDexer": "--min-sdk-version", "Desugar": "--min_sdk_version", "ValidateManifest": "--expected_min_sdk_version"}
    observed = {}
    for action in analysistest.target_actions(env):
        if action.mnemonic in flags:
            flag = flags[action.mnemonic]
            asserts.equals(env, "26", action.argv[action.argv.index(flag) + 1])
            observed[action.mnemonic] = True
    asserts.equals(env, sorted(flags), sorted(observed))
    # The existing Android qualifier already owns these apps and producers.
    # Inspect their configured Files without adding any app/producer outputs to
    # this analysis test's executable or runfiles.
    producers = {file: True for package in ctx.attr.shipping[ShippingExportInfo].packages for file in package[ShippingInfo].files.to_list()}
    producers.update({file: True for dependency in ctx.attr.shared_data for file in dependency[DefaultInfo].files.to_list()})
    data = [app[_FinalDataFiles] for app in ctx.attr.installed_apps]
    asserts.equals(env, ["arm64-v8a", "x86_64"], sorted(depset(transitive = [item.abis for item in data]).to_list()))
    asserts.equals(env, ["icu", "leaves", "payload", "source"], sorted(depset(transitive = [item.attributes for item in data]).to_list()))
    files = depset(transitive = [item.files for item in data]).to_list()
    asserts.true(env, bool(files), "installed Android apps must reach their actual final data")
    for file in files:
        asserts.true(env, file in producers, "installed Android final data differs from its original producer File: " + file.path)
    return analysistest.end(env)

_android_binary_min_sdk_test = analysistest.make(
    _android_binary_min_sdk_test_impl,
    config_settings = {
        str(Label("@rules_android//rules:min_sdk_version")): 26,
        "//command_line_option:android_platforms": [str(Label("//build_defs/android:android_x86_64"))],
    },
    attrs = {
        "installed_apps": attr.label_list(default = [Label("//src/examples/native/react-native-expo:" + name) for name in ["android_release", "android_release_x86_64"]], aspects = [_final_data_files]),
        "shipping": attr.label(default = Label("//:native_android_shipping_export"), providers = [ShippingExportInfo]),
        "shared_data": attr.label_list(default = [Label("//src/native/runtime:public_payload"), Label("//src/database-resources:icu_payload"), Label("//src/native/sdks/kotlin:android_maven_archive")]),
    },
)

def _android_manifest_subject_impl(ctx):
    PROCESSORS["ManifestProcessor"](ctx)
    return [DefaultInfo()]

_android_manifest_subject = rule(
    implementation = _android_manifest_subject_impl,
    attrs = {
        "_min_sdk_version": attr.label(default = Label(":android_min_sdk_conflict_setting"), providers = [BuildSettingInfo]),
        "min_sdk_version": attr.int(),
        "manifest_values": attr.string_dict(),
        "manifest": attr.label(allow_single_file = True),
    },
)

def _android_min_sdk_conflict_test_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, "Configured minimum SDK 26 exceeds authored min_sdk_version 24")
    return analysistest.end(env)

_android_min_sdk_conflict_test = analysistest.make(
    _android_min_sdk_conflict_test_impl,
    expect_failure = True,
)

def android_app_configuration_tests():
    _android_dex_actions(name = "android_min_sdk_actions", tags = ["manual"])
    _android_min_sdk_test(name = "android_min_sdk_test", target_under_test = ":android_min_sdk_actions")
    android_binary(name = "android_min_sdk_binary", manifest = "min-sdk-test.xml", custom_package = "dev.oliphaunt.min_sdk_test",
                   manifest_values = {"minSdkVersion": "26"}, multidex = "native", incremental_dexing = 0, tags = ["manual"])
    _android_binary_min_sdk_test(name = "android_binary_min_sdk_test", target_under_test = ":android_min_sdk_binary")
    # Upstream's private setting remains private; this is a real local provider.
    int_flag(name = "android_min_sdk_conflict_setting", build_setting_default = 26)
    _android_manifest_subject(name = "android_min_sdk_conflict", min_sdk_version = 24, tags = ["manual"])
    _android_min_sdk_conflict_test(name = "android_min_sdk_conflict_test", target_under_test = ":android_min_sdk_conflict")
