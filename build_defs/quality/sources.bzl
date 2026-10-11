"""Source-only quality ownership; the formatter applies conventional exclusions."""

def source_quality_files(name = "quality_sources"):
    native.filegroup(
        name = name,
        srcs = native.glob(["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx", "**/*.json", "**/*.jsonc", "**/*.css", "**/.gitignore"], exclude = ["**/node_modules/**", "**/target/**", "**/.git/**", "**/bazel-*/**"], allow_empty = True),
        visibility = ["//visibility:public"],
    )

def rust_quality_files(name = "rustfmt_sources"):
    native.filegroup(
        name = name,
        srcs = native.glob(["**/*.rs"], exclude = ["**/target/**", "**/vendor/**", "**/generated/**", "**/fixtures/**"], allow_empty = True),
        visibility = ["//visibility:public"],
    )
