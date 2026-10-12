"""The mobile example uses the actual selected or completed TS supplier."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts", "unittest")
load(":app.bzl", "android_workspace_npm", "mobile_query_input")

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
