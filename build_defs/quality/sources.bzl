"""Source-only quality ownership; the formatter applies conventional exclusions."""

def source_quality_files(name = "quality_sources", exclude = []):
    # Bazel output aliases are root entries; nested bazel-* names can be authored sources.
    output_excludes = ["bazel-*/**"] if native.package_name() == "" else []
    native.filegroup(
        name = name,
        srcs = native.glob(["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx", "**/*.json", "**/*.jsonc", "**/*.css", "**/.gitignore"], exclude = ["**/node_modules/**", "**/target/**", "**/.git/**"] + output_excludes + exclude, allow_empty = True),
        visibility = ["//visibility:public"],
    )

def rust_quality_files(name = "rustfmt_sources"):
    native.filegroup(
        name = name,
        srcs = native.glob(["**/*.rs"], exclude = ["**/target/**", "**/vendor/**", "**/generated/**", "**/fixtures/**"], allow_empty = True),
        visibility = ["//visibility:public"],
    )
