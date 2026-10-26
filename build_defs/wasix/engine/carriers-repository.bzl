"""Reuse the exact current Windows engine Cargo carriers supplied by the controller."""

load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_CURRENT_ARTIFACTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/wasix:cargo.bzl", "RUNTIME_CARGO_HELPERS")
load(":packages.bzl", "ENGINE_PACKAGE_HELPERS")

_SOURCE_ENV = "OLIPHAUNT_GIT_SOURCE_JSON"
ENGINE_CARRIER_HELPERS = {label: True for label in ENGINE_PACKAGE_HELPERS + RUNTIME_CARGO_HELPERS + [
    "//build_defs/wasix/engine:carriers.mts",
    "//src/wasix/runtime/engine:package.mts",
    "//:tools/packaging/frozen-cargo.mts",
    "//tools/release:publication-catalog.mts",
]}.keys()

def _packages_impl(ctx):
    groups = {}
    for target, group in ctx.attr.groups.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("Imported engine groups require their exact regular original/member File")
        groups.setdefault(group, []).extend(files)
    return [DefaultInfo(files = depset(ctx.files.archives)), OutputGroupInfo(**{group: depset(files) for group, files in groups.items()})]

engine_imported_packages = rule(implementation = _packages_impl, attrs = {
    "archives": attr.label_list(allow_files = True),
    "groups": attr.label_keyed_string_dict(allow_files = True),
})

def _empty(ctx):
    ctx.file("available.bzl", "AVAILABLE = False\nORIGINALS = {}\nARCHIVES = {}\n")
    ctx.file("BUILD.bazel", 'exports_files(["available.bzl"], visibility = ["//visibility:public"])\n')

def _impl(ctx):
    if not ctx.attr.records:
        _empty(ctx)
        return
    names = json.decode(ctx.read(ctx.attr.acquisition))["patch"].keys()
    originals = {}
    for encoded in ctx.attr.records:
        row = json.decode(encoded)
        if row["artifact"].startswith("cargo:") and row["artifact"][6:] in names:
            if row["artifact"] in originals:
                fail("Windows engine original Cargo carrier repeats")
            originals[row["artifact"]] = row
    if not originals:
        _empty(ctx)
        return
    if len(originals) != len(names):
        fail("Windows engine requires all seven original Cargo carriers")
    snapshot = json.decode(ctx.os.environ.get(_SOURCE_ENV, "{}"))
    source = {name: snapshot.get(name) for name in ["commit", "tree"]}
    archives = {}
    for artifact, row in originals.items():
        file = ctx.path(Label(row["file"]["path"]))
        ctx.watch(file)
        ctx.watch(file.realpath)
        archives[artifact[6:]] = str(file)
    for helper in ctx.attr.helpers:
        ctx.read(helper)
    ctx.watch(ctx.path(ctx.attr.bun))
    ctx.file("inputs.json", json.encode({
        "version": ctx.attr.version, "source": source, "records": originals.values(),
        "catalog": [json.decode(row) for row in ctx.attr.catalog],
        "archives": archives, "outputDirectory": str(ctx.path(".")),
    }))
    result = ctx.execute([ctx.path(ctx.attr.bun), "--no-env-file", "--no-install", ctx.path(ctx.attr.helper), ctx.path("inputs.json")], quiet = True, timeout = 120)
    if result.return_code:
        fail("Cannot import original Windows engine carriers: " + result.stdout + result.stderr)
    ctx.delete("inputs.json")
    selected = json.decode(result.stdout)
    groups = {}
    aliases = {}
    for artifact, row in originals.items():
        name = artifact[6:]
        alias = "cargo_" + name
        relative = "archives/" + name + "-" + row["version"] + ".crate"
        ctx.symlink(ctx.path(Label(row["file"]["path"])), relative)
        aliases[artifact] = alias
        groups[":" + alias] = selected["archiveGroups"][name]
    for group, files in selected["files"].items():
        for file in files:
            groups[":" + file.replace("\\", "/")] = group
    definitions = "load(%r, \"engine_imported_packages\")\npackage(default_visibility = [\"//visibility:public\"])\nexports_files([\"available.bzl\"])\n" % str(ctx.attr.definition)
    for artifact, alias in aliases.items():
        row = originals[artifact]
        definitions += "alias(name = %r, actual = %r)\n" % (alias, ":archives/" + artifact[6:] + "-" + row["version"] + ".crate")
    definitions += "engine_imported_packages(name = \"packages\", archives = %r, groups = %r)\n" % ([":" + alias for alias in aliases.values()], groups)
    for group in sorted({name: True for name in groups.values()}):
        definitions += "filegroup(name = %r, srcs = [\":packages\"], output_group = %r)\n" % ("embedded_bindings" if group == "bindings" else group, group)
    ctx.file("BUILD.bazel", definitions)
    ctx.file("available.bzl", "AVAILABLE = True\nORIGINALS = %r\nARCHIVES = {%s}\n" % (originals, ", ".join(["%r: Label(%r)" % (artifact, ":" + alias) for artifact, alias in aliases.items()])))

windows_engine_carriers_repository = repository_rule(
    implementation = _impl,
    configure = True,
    environ = [_SOURCE_ENV],
    attrs = {
        "records": attr.string_list(default = [json.encode(row) for row in (NATIVE_CURRENT_ARTIFACTS or {}).values()]),
        "catalog": attr.string_list(default = [json.encode(row) for row in PUBLICATION_CARRIERS]),
        "version": attr.string(default = PRODUCTS["oliphaunt-wasix-rust"]["version"]),
        "acquisition": attr.label(default = Label("@wasix_engine_acquisition//:acquisition.json"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "helper": attr.label(default = Label(":carriers.mts"), allow_single_file = True),
        "helpers": attr.label_list(default = ENGINE_CARRIER_HELPERS, allow_files = True),
        "definition": attr.label(default = Label(":carriers-repository.bzl"), allow_single_file = True),
    },
)
