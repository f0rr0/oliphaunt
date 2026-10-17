"""Import the final packed WASIX runtime crates for construction-only compilation."""

load(":cargo.bzl", "RUNTIME_CARGO_HELPERS")
load(":npm.bzl", "RUNTIME_NPM_NOTICES")

_SOURCE_COMMIT_ENV = "OLIPHAUNT_WASIX_SOURCE_COMMIT"
_INPUTS_ENV = "OLIPHAUNT_WASIX_CARGO_INPUTS"

def _valid_sha(value, length):
    return len(value) == length and value.lower() == value and all([character in "0123456789abcdef" for character in value.elems()])

def _wasix_runtime_carriers_repository_impl(ctx):
    source_commit = ctx.os.environ.get(_SOURCE_COMMIT_ENV, "")
    inputs_root = ctx.os.environ.get(_INPUTS_ENV, "")
    if not source_commit and not inputs_root and ctx.os.name.lower() == "linux" and ctx.os.arch.lower() in ["amd64", "x86_64"]:
        for name, source in ctx.attr.source_packages.items():
            package_path = source.split("//", 1)[1].split(":", 1)[0]
            ctx.file("%s/BUILD.bazel" % package_path, 'package(default_visibility = ["//visibility:public"])\nalias(name = "lib", actual = %s)\n' % repr(source))
        ctx.file("BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nfilegroup(name = "host_smoke", srcs = %s)\n' % repr(ctx.attr.host_smoke_sources))
        return
    if not _valid_sha(source_commit, 40):
        fail(_SOURCE_COMMIT_ENV + " must contain the exact 40-character source commit SHA")
    if not inputs_root:
        fail(_INPUTS_ENV + " must name the captured WASIX Cargo receipt directory")

    for source in [ctx.attr.release_manifest, ctx.attr.toolchain_manifest, ctx.attr.cargo_lock, ctx.attr.version_manifest, ctx.attr.tools_version_manifest, ctx.attr.root_package_json, ctx.attr._helper] + ctx.attr._helpers + ctx.attr._notices:
        ctx.read(source)
        ctx.watch(ctx.path(source))
    bun = ctx.path(ctx.attr.bun)
    ctx.watch(bun)
    receipt = ctx.path(inputs_root).get_child("receipt.json")
    if not receipt.exists:
        fail(_INPUTS_ENV + " is missing receipt.json")
    ctx.watch(receipt)
    receipt_data = json.decode(ctx.read(receipt))
    expected_names = [
        "liboliphaunt-wasix-aot-aarch64-apple-darwin",
        "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
        "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
        "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
        "liboliphaunt-wasix-portable",
    ]
    rows = receipt_data.get("crates", [])
    if len(rows) != 5 or sorted([row.get("name", "") for row in rows]) != expected_names:
        fail(_INPUTS_ENV + " receipt must identify exactly the five canonical Cargo crates")
    for row in rows + receipt_data.get("hostSmokeCrates", []):
        filename = row.get("path", "")
        name = row.get("name", "")
        version = row.get("version", "")
        if filename != name + "-" + version + ".crate" or "/" in filename or "\\" in filename:
            fail(_INPUTS_ENV + " receipt contains a non-canonical crate path")
        crate = ctx.path(inputs_root).get_child(filename)
        if not crate.exists:
            fail(_INPUTS_ENV + " is missing " + filename)
        ctx.watch(crate)
    source_root = ctx.path(ctx.attr.root_package_json).dirname
    rust_defs = str(ctx.attr.rust_defs)
    crates_defs = str(ctx.attr.crates_defs)
    result = ctx.execute([
        str(bun),
        str(ctx.path(ctx.attr._helper)),
        "extract",
        str(receipt),
        str(receipt.dirname),
        source_commit,
        str(ctx.path(".")),
        str(ctx.path(ctx.attr.release_manifest)),
        str(ctx.path(ctx.attr.toolchain_manifest)),
        str(ctx.path(ctx.attr.cargo_lock)),
        str(ctx.path(ctx.attr.version_manifest)),
        rust_defs,
        crates_defs,
        str(source_root),
    ], quiet = True, timeout = 600)
    if result.return_code:
        fail("Cannot import exact packed WASIX Cargo inputs:\n" + result.stdout + result.stderr)
    return

wasix_runtime_carriers_repository = repository_rule(
    implementation = _wasix_runtime_carriers_repository_impl,
    environ = [_SOURCE_COMMIT_ENV, _INPUTS_ENV],
    configure = True,
    attrs = {
        "release_manifest": attr.label(default = Label("//src/wasix/runtime:release.toml"), allow_single_file = True),
        "toolchain_manifest": attr.label(default = Label("//src/wasix/runtime:toolchain.toml"), allow_single_file = True),
        "cargo_lock": attr.label(default = Label("//:Cargo.lock"), allow_single_file = True),
        "root_package_json": attr.label(default = Label("//:package.json"), allow_single_file = True),
        "version_manifest": attr.label(default = Label("//src/wasix/runtime/crates/assets:Cargo.toml"), allow_single_file = True),
        "tools_version_manifest": attr.label(default = Label("//src/wasix/postgres-tools:crates/tools/Cargo.toml"), allow_single_file = True),
        "rust_defs": attr.label(default = Label("//build_defs/languages:rust.bzl"), allow_single_file = True),
        "crates_defs": attr.label(default = Label("@cargo_crates//:defs.bzl"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "_helper": attr.label(default = Label("//build_defs/wasix:cargo-inputs.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = RUNTIME_CARGO_HELPERS + ["//build_defs/wasix:cargo.mts", "//build_defs/languages:cargo-metadata.mts", "//:tools/packaging/frozen-cargo.mts"], allow_files = True),
        "_notices": attr.label_list(default = RUNTIME_NPM_NOTICES.keys(), allow_files = True),
        "source_packages": attr.string_dict(default = {
            "liboliphaunt-wasix-portable": str(Label("//src/wasix/runtime/crates/assets:lib")),
            "liboliphaunt-wasix-aot-aarch64-apple-darwin": str(Label("//src/wasix/runtime/crates/aot/aarch64-apple-darwin:lib")),
            "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu": str(Label("//src/wasix/runtime/crates/aot/aarch64-unknown-linux-gnu:lib")),
            "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc": str(Label("//src/wasix/runtime/crates/aot/x86_64-pc-windows-msvc:lib")),
            "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu": str(Label("//src/wasix/runtime/crates/aot/x86_64-unknown-linux-gnu:lib")),
        }),
        "host_smoke_sources": attr.string_list(default = [
            str(Label("//src/wasix/runtime/crates/assets:crate")),
            str(Label("//build_defs/extensions/wasix:contrib")),
            str(Label("//src/wasix/postgres-tools:portable_cargo")),
            str(Label("//src/wasix/postgres-tools:linux_arm64_gnu_cargo")),
            str(Label("//src/wasix/postgres-tools:linux_x64_gnu_cargo")),
            str(Label("//src/wasix/postgres-tools:macos_arm64_cargo")),
            str(Label("//src/wasix/postgres-tools:windows_x64_msvc_cargo")),
        ]),
    },
)
