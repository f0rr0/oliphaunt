"""Actual native Bun entrypoints owned by an injected external repository."""

load("@oliphaunt//build_defs/foundation:bun.bzl", "bun_binary", "bun_script_test", "bun_test", "bun_toolchain_test")

def external_bun_entries():
    bun_test(
        name = "test",
        entry_point = "//:entry.test.mts",
        data = ["//:helper.mts"],
        size = "small",
    )
    bun_script_test(
        name = "script_test",
        entry_point = "//:script.mts",
        data = ["//:helper.mts"],
        args = ['"external literal"'],
        size = "small",
    )
    bun_binary(
        name = "binary",
        entry_point = "//:script.mts",
        data = ["//:helper.mts"],
        args = ['"external literal"'],
    )
    bun_toolchain_test(name = "toolchain_test", size = "small")
