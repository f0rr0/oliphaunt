"""Import immutable external extension sources from the canonical metadata."""

load("@bazel_tools//tools/build_defs/repo:git.bzl", "new_git_repository")
load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")
load("@oliphaunt_metadata//:extension-sources.bzl", "EXTENSION_DEPENDENCIES", "EXTENSION_SOURCES")

_BUILD = """
package(default_visibility = ["//visibility:public"])
exports_files(glob(["**"], exclude = ["BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"], allow_empty = True))
filegroup(
    name = "sql_inputs",
    srcs = glob(["*.control", "sql/*.sql", "sql/*.sql.in", "compat/install-*.patch", "compat/gencore", "Makefile"], allow_empty = True),
)
filegroup(name = "headers", srcs = glob(["src/**/*.h"], allow_empty = True))
filegroup(name = "sql_resources", srcs = glob(["*.control", "*--*.sql", "sql/*--*.sql"], allow_empty = True))
"""

_DEPENDENCY_BUILD = """
package(default_visibility = ["//visibility:public"])
exports_files(glob(["**"], exclude = ["BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"], allow_empty = True))
filegroup(name = "all_sources", srcs = glob(["**"], exclude = ["BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"], allow_empty = True))
filegroup(name = "headers", srcs = glob(["**/*.h", "**/*.hpp", "**/*.inl", "**/*.inc"], allow_empty = True))
"""

_DEPENDENCY_INPUTS = {
    "geos": '\nfilegroup(name = "native_sources", srcs = glob(["src/**/*.cpp", "capi/*.cpp"]))\nfilegroup(name = "native_c_sources", srcs = glob(["src/deps/**/*.c"]))\nfilegroup(name = "native_core_sources", srcs = glob(["src/**/*.cpp"]))\nfilegroup(name = "native_capi_sources", srcs = glob(["capi/*.cpp"]))\n',
    "proj": '\nfilegroup(name = "native_sources", srcs = glob(["src/*.cpp", "src/projections/*.cpp", "src/conversions/*.cpp", "src/transformations/*.cpp", "src/iso19111/**/*.cpp"]))\nfilegroup(name = "native_c_sources", srcs = glob(["src/*.c"], exclude = ["src/embedded_resources.c", "src/memvfs.c"]))\n',
}

_POSTGIS_INPUTS = """
filegroup(name = "postgis_headers", srcs = glob(["**/*.h", "**/*.hpp", "**/*.inl", "**/*.inc"], allow_empty = True))
filegroup(name = "postgis_sql_inputs", srcs = glob(["Version.config", "postgis/*.sql.in", "postgis/*.sql.in.*", "postgis/*.sql", "postgis/*.h", "libpgcommon/*.h", "extensions/**/*.sql", "extensions/**/*.sql.in", "extensions/**/Makefile.in", "extensions/upgrade-paths-rules.mk", "utils/*.pl", "raster/rt_pg/*.sql.in", "raster/rt_pg/*.sql.in.*", "raster/rt_pg/*.sql", "postgis/Makefile.in", "raster/rt_pg/Makefile.in"], allow_empty = True))
"""

def _git_commit(commit, description):
    if len(commit) != 40 or any([character not in "0123456789abcdef" for character in commit.elems()]):
        fail("%s requires an immutable full Git commit" % description)

def _extension_sources_impl(module_ctx):
    for sql_name, source in EXTENSION_SOURCES.items():
        commit = source.get("commit", "")
        _git_commit(commit, "extension " + sql_name)
        new_git_repository(
            name = source["name"],
            remote = source["url"],
            commit = commit,
            build_file_content = _BUILD + (_POSTGIS_INPUTS if sql_name == "postgis" else ""),
        )
    for sql_name, dependencies in EXTENSION_DEPENDENCIES.items():
        for directory, source in dependencies.items():
            name = sql_name.replace("-", "_") + "_" + directory.replace("-", "_")
            kind = source.get("kind", "git")
            if kind == "git":
                _git_commit(source.get("commit", ""), "dependency %s/%s" % (sql_name, directory))
                new_git_repository(
                    name = name,
                    remote = source["url"],
                    commit = source["commit"],
                    build_file_content = _DEPENDENCY_BUILD + _DEPENDENCY_INPUTS.get(directory, ""),
                )
            elif kind == "archive":
                digest = source.get("sha256", "")
                if len(digest) != 64 or any([character not in "0123456789abcdef" for character in digest.elems()]):
                    fail("dependency %s/%s requires an immutable archive SHA256" % (sql_name, directory))
                http_archive(
                    name = name,
                    urls = [source["url"]] + ([source["mirror_url"]] if source.get("mirror_url") else []),
                    sha256 = digest,
                    strip_prefix = source["strip_prefix"],
                    build_file_content = _DEPENDENCY_BUILD + _DEPENDENCY_INPUTS.get(directory, ""),
                )
            else:
                fail("unsupported dependency source kind %s for %s/%s" % (kind, sql_name, directory))

extension_sources = module_extension(implementation = _extension_sources_impl)
