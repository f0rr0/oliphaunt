"""Pinned PostgreSQL source and explicit local generator tools for the native port.

The local tools repository is a development capability, not a hermetic release
toolchain. Its binaries and data files are declared action inputs; the host
loader/sysroot still needs the separately qualified production toolchain.
"""

def source_string_values(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        key, separator, value = line.partition("=")
        value = value.strip()
        if not separator or not value.startswith("\"") or not value.endswith("\""):
            fail("source metadata must contain quoted string values: " + line)
        values[key.strip()] = value[1:-1]
    return values

def postgres_overlay_paths(overlays):
    """Validate declared regular-text overlays before acquiring PG sources."""
    destinations = {}
    for label, relative in overlays.items():
        components = relative.split("/")
        if not relative.startswith("src/") or any([part in ["", ".", ".."] for part in components]) or any([character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/" for character in relative.elems()]):
            fail("invalid PostgreSQL overlay destination: " + relative)
        if relative in destinations:
            fail("duplicate PostgreSQL overlay destination: " + relative)
        destinations[relative] = label
    return {relative: destinations[relative] for relative in sorted(destinations)}

def _postgres_repository_impl(ctx):
    overlays = postgres_overlay_paths(ctx.attr.overlays)
    source = source_string_values(ctx.read(ctx.attr.source_manifest))
    for name in ["version", "url", "sha256"]:
        if name not in source:
            fail("PostgreSQL source manifest is missing " + name)
    # The explicit unit inventory and LP64 configuration have only been proven
    # against this source. A pin update needs a reviewed inventory/profile port.
    if source["version"] != "18.4" or source["sha256"] != "81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094":
        fail("native PostgreSQL inventory/configuration is proven only for the canonical 18.4 source; review the source inventory, configuration and runtime parity before updating this profile")
    ctx.download_and_extract(
        url = source["url"],
        sha256 = source["sha256"],
        stripPrefix = "postgresql-" + source["version"],
    )
    # The authored postmaster recipe installs its six Git-100644 source blobs
    # before the ordered series. Empty defaults preserve existing source trees.
    for relative, label in overlays.items():
        ctx.file(relative, ctx.read(label), executable = False)
    if overlays:
        ctx.read(ctx.attr.overlay_modes_tool)
        ctx.watch(ctx.path(ctx.attr.overlay_bun))
        result = ctx.execute([ctx.path(ctx.attr.overlay_bun), "--no-install", "--no-env-file", ctx.path(ctx.attr.overlay_modes_tool), "overlay", ctx.path("."), json.encode(overlays.keys())], quiet = True)
        if result.return_code:
            fail("Cannot apply declared PostgreSQL overlay modes: " + result.stderr)
    patches = []
    for line in ctx.read(ctx.attr.patch_series).splitlines():
        patch = line.strip()
        if not patch or patch.startswith("#"):
            continue
        if not patch.startswith("src/") or ".." in patch.split("/"):
            fail("invalid repository-relative PostgreSQL patch: " + patch)
        if patch.startswith("src/native/runtime/"):
            label = Label("//src/native/runtime:" + patch[len("src/native/runtime/"):])
        elif patch.startswith("src/wasix/runtime/"):
            label = Label("//src/wasix/runtime:" + patch[len("src/wasix/runtime/"):])
        elif patch.startswith("src/wasix/postmaster/"):
            label = Label("//src/wasix/postmaster:" + patch[len("src/wasix/postmaster/"):])
        elif patch.startswith("src/third-party/postgres/"):
            label = Label("//src/third-party/postgres:" + patch[len("src/third-party/postgres/"):])
        else:
            fail("unknown PostgreSQL patch owner: " + patch)
        ctx.patch(ctx.path(label), strip = 1)
        patches.append(patch)
    ctx.file("SOURCE_VERSION", source["version"] + "\n")
    ctx.file("version.bzl", "POSTGRES_VERSION = " + repr(source["version"]) + "\n")
    ctx.file("patches.bzl", "POSTGRES_PATCHES = " + repr(patches) + "\n")
    ctx.symlink(ctx.attr.build_file, "BUILD.bazel")

postgres_repository = repository_rule(
    implementation = _postgres_repository_impl,
    attrs = {
        "source_manifest": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
        "patch_series": attr.label(default = "//src/native/runtime:postgres/series", allow_single_file = True),
        "build_file": attr.label(default = "//build_defs/native:postgres.BUILD.bazel", allow_single_file = True),
        "overlays": attr.label_keyed_string_dict(allow_files = True),
        "overlay_modes_tool": attr.label(default = Label("//build_defs/wasix/postmaster:source-modes.mts"), allow_single_file = True),
        "overlay_bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)

def _icu_repository_impl(ctx):
    source = source_string_values(ctx.read(ctx.attr.source_manifest))
    if source.get("url") != "https://github.com/unicode-org/icu.git":
        fail("ICU canonical origin changed; review archive acquisition before updating this import")
    commit = source.get("commit")
    if commit != "8eca245c7484ac6cc179e3e5f7c1ea7680810f39":
        fail("ICU source pin changed; update the verified archive checksum and native inventory together")
    ctx.download_and_extract(
        url = "https://codeload.github.com/unicode-org/icu/tar.gz/" + commit,
        type = "tar.gz",
        # SHA-256 of the immutable commit archive, verified during this port.
        sha256 = "6fb1db5c6eaeece80b1edc91696823de873bb79ab31360102bf9d6978441b1af",
        stripPrefix = "icu-" + commit + "/icu4c/source",
    )
    # Upstream's partial Bazel packages use the original archive-root paths.
    for directory in ["common", "i18n", "stubdata"]:
        ctx.delete(directory + "/BUILD.bazel")
    ctx.symlink(ctx.attr.build_file, "BUILD.bazel")
    ctx.symlink(ctx.attr.inventory, "icu_sources.bzl")

icu_repository = repository_rule(
    implementation = _icu_repository_impl,
    attrs = {
        "source_manifest": attr.label(default = "//src/third-party/icu:source.toml", allow_single_file = True),
        "build_file": attr.label(default = "//build_defs/native:icu.BUILD.bazel", allow_single_file = True),
        "inventory": attr.label(default = "//build_defs/native:icu_sources.bzl", allow_single_file = True),
    },
)

def _native_exec_tools_impl(ctx):
    versions = []
    for name in ["perl", "bison", "flex", "m4", "patch"]:
        binary = ctx.which(name)
        if not binary:
            fail("native generator tool is unavailable: " + name)
        ctx.symlink(binary, name)
        result = ctx.execute([binary, "--version"])
        if result.return_code:
            fail("cannot identify generator tool: " + name)
        versions.append(name + "=" + result.stdout.strip())
    bison_data = ctx.execute([ctx.path("bison"), "--print-datadir"])
    if bison_data.return_code:
        fail("cannot locate bison skeletons")
    ctx.symlink(bison_data.stdout.strip(), "bison_data")
    perl_libs = ctx.execute([ctx.path("perl"), "-e", "print join(qq(\\n), grep { -d $_ && $_ ne q(.) } @INC)"])
    if perl_libs.return_code:
        fail("cannot locate Perl standard library")
    count = 0
    for directory in perl_libs.stdout.splitlines():
        ctx.symlink(directory, "perl_lib_" + str(count))
        count += 1
    ctx.file("VERSIONS", "\n".join(versions) + "\n")
    ctx.file("BUILD.bazel", """package(default_visibility = [\"//visibility:public\"])
exports_files([\"perl\", \"bison\", \"flex\", \"m4\", \"patch\", \"VERSIONS\"])
filegroup(name = \"data\", srcs = glob([\"bison_data/**\", \"perl_lib_*/**\"], allow_empty = False))
filegroup(name = \"perl_data\", srcs = glob([\"perl_lib_*/**\"], allow_empty = False))
""")

native_exec_tools_repository = repository_rule(
    implementation = _native_exec_tools_impl,
    local = True,
    configure = True,
)
