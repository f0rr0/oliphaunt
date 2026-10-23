"""Declared PostgreSQL overlay paths fail before source acquisition."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts", "unittest")
load("//build_defs/native:repositories.bzl", "postgres_overlay_paths")

def _paths_test_impl(ctx):
    env = unittest.begin(ctx)
    asserts.equals(env, {}, postgres_overlay_paths({}))
    paths = postgres_overlay_paths({"template": "src/template/wasix-core", "header": "src/include/port/wasix-core.h"})
    asserts.equals(env, ["src/include/port/wasix-core.h", "src/template/wasix-core"], paths.keys())
    asserts.equals(env, "header", paths["src/include/port/wasix-core.h"])
    return unittest.end(env)

_paths_test = unittest.make(_paths_test_impl)

def _subject_impl(ctx):
    postgres_overlay_paths(ctx.attr.overlays)
    return []

_subject = rule(implementation = _subject_impl, attrs = {"overlays": attr.string_dict()})

def _rejected_test_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, ctx.attr.message)
    return analysistest.end(env)

_rejected_test = analysistest.make(_rejected_test_impl, expect_failure = True, attrs = {"message": attr.string()})

def postgres_overlay_tests():
    _paths_test(name = "postgres_overlay_paths_test")
    cases = {
        "traversal": {"one": "src/backend/../port/file.c"},
        "absolute": {"one": "/src/backend/file.c"},
        "empty_component": {"one": "src//backend/file.c"},
        "backslash": {"one": "src/backend\\file.c"},
        "duplicate": {"one": "src/backend/file.c", "two": "src/backend/file.c"},
    }
    for name, overlays in cases.items():
        _subject(name = "postgres_overlay_" + name + "_subject", overlays = overlays, tags = ["manual"])
        _rejected_test(
            name = "postgres_overlay_" + name + "_test",
            target_under_test = ":postgres_overlay_" + name + "_subject",
            message = "duplicate PostgreSQL overlay destination" if name == "duplicate" else "invalid PostgreSQL overlay destination",
        )
