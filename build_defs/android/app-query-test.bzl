"""The mobile example uses the actual selected or completed TS supplier."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts", "unittest")
load(":app.bzl", "android_app_configuration", "android_workspace_npm", "mobile_query_input")
load("@rules_android//rules:min_sdk_version.bzl", "min_sdk_version")
load("@rules_android//rules:android_platforms_transition.bzl", platforms_transition = "testing")
load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo")

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
    env = unittest.begin(ctx)
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
    return unittest.end(env)

_android_min_sdk_test = unittest.make(_android_min_sdk_test_impl)

def android_app_configuration_tests():
    _android_min_sdk_test(name = "android_min_sdk_test")
