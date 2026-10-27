"""Import the canonical immutable WASIX compiler, sysroots and Binaryen pins."""

def _asset_rows(text):
    rows = []
    names = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 5:
            fail("WASIX asset manifest must contain five tab-separated fields")
        kind, name, size, sha256, url = fields
        if kind not in ["driver", "sysroot", "llvm", "binaryen"] or name in names:
            fail("WASIX asset manifest has an unknown kind or duplicate asset: " + name)
        if not size.isdigit() or int(size) <= 0 or int(size) > 500000000:
            fail("WASIX asset manifest has an invalid size: " + name)
        if len(sha256) != 64 or any([character not in "0123456789abcdef" for character in sha256.elems()]):
            fail("WASIX asset manifest has an invalid SHA-256: " + name)
        if not url.startswith("https://github.com/") or url.rsplit("/", 1)[-1] != name:
            fail("WASIX asset manifest has an invalid immutable asset URL: " + name)
        names[name] = True
        rows.append(struct(kind = kind, name = name, size = int(size), sha256 = sha256, url = url))
    required = [
        "wasixcc-x86_64-unknown-linux-gnu.tar.gz",
        "LLVM-Linux-x86_64.tar.gz",
        "binaryen-version_130-x86_64-linux.tar.gz",
        "sysroot.tar.gz",
        "sysroot-eh.tar.gz",
        "sysroot-ehpic.tar.gz",
        "sysroot-exnref-eh.tar.gz",
        "sysroot-exnref-ehpic.tar.gz",
    ]
    if sorted(names) != sorted(required):
        fail("WASIX Linux-x64 toolchain requires the canonical closed eight-asset inventory")
    return rows

def _wasix_toolchain_repository_impl(ctx):
    rows = _asset_rows(ctx.read(ctx.attr.asset_manifest))
    for row in rows:
        # This native profile always enables exnref exceptions and PIC. Keep
        # validating the complete canonical pin inventory, while acquiring only
        # the sysroot selected by actual compiler/linker actions.
        if row.kind == "sysroot" and row.name != "sysroot-exnref-ehpic.tar.gz":
            continue
        if row.kind == "sysroot":
            name = row.name[:-len(".tar.gz")]
            output = "sysroot/" + name
            prefix = "wasix-" + name + "/sysroot"
        elif row.kind == "binaryen":
            output = "binaryen"
            prefix = "binaryen-version_130"
        else:
            output = row.kind
            prefix = ""
        # The exact digest also commits to the canonical byte count/layout.
        ctx.download_and_extract(url = row.url, sha256 = row.sha256, output = output, stripPrefix = prefix)
    for command in ["wasixcc", "wasix++", "wasixcc++", "wasixar", "wasixnm", "wasixranlib", "wasixld"]:
        ctx.symlink("driver/wasixccenv", "bin/" + command)
    ctx.symlink(ctx.attr.asset_manifest, "ASSETS.tsv")
    ctx.symlink(ctx.attr.build_file, "BUILD.bazel")

wasix_toolchain_repository = repository_rule(
    implementation = _wasix_toolchain_repository_impl,
    attrs = {
        "asset_manifest": attr.label(default = "//src/wasix/runtime:assets/build/docker/pinned-wasixcc-assets.tsv", allow_single_file = True),
        "build_file": attr.label(default = "//build_defs/wasix:toolchain.BUILD.bazel", allow_single_file = True),
    },
)

def _wasix_tool_metadata_impl(ctx):
    root = ctx.path(ctx.attr.root_marker).dirname
    converter = ctx.path(ctx.attr.converter)
    ctx.read(converter)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([str(ctx.path(ctx.attr.bun)), str(converter), "--root", str(root), "--output-dir", str(ctx.path("."))], timeout = 120)
    if result.return_code:
        fail("WASIX tool metadata import failed:\n" + result.stdout + result.stderr)
    observed = json.decode(ctx.read(".metadata-inputs.json"))
    for relative, content in observed.items():
        source = root.get_child(relative)
        ctx.watch(source)
        if ctx.read(source) != content:
            fail("WASIX tool metadata changed during import: " + relative)
    ctx.file("BUILD.bazel", "package(default_visibility = [\"//visibility:public\"])\nexports_files([\"llvm.json\", \"targets.bzl\"])\n")

wasix_tool_metadata = repository_rule(
    implementation = _wasix_tool_metadata_impl,
    attrs = {
        "root_marker": attr.label(default = "//:package.json", allow_single_file = True),
        "converter": attr.label(default = "//build_defs/wasix:tool-metadata.mts", allow_single_file = True),
        "bun": attr.label(mandatory = True, allow_single_file = True),
    },
)

def _wasmer_llvm_repository_impl(ctx):
    metadata = json.decode(ctx.read(ctx.attr.metadata))
    if ctx.attr.host not in metadata["hosts"]:
        fail("no canonical Wasmer LLVM acquisition pin for " + ctx.attr.host)
    pin = metadata["hosts"][ctx.attr.host]
    ctx.download_and_extract(url = pin["url"], sha256 = pin["sha256"], type = "tar.xz")
    ctx.file("TOOLCHAIN.json", json.encode({"version": metadata["version"], "host": ctx.attr.host, "triple": pin["triple"], "sha256": pin["sha256"]}) + "\n")
    # The standard Cargo build-script runner expands ${pwd} to its execroot.
    # Derive both the ABI key and canonical repository path; do not discover an
    # LLVM installation through the host environment or copy a repository name.
    ctx.file("llvm.env", "LLVM_SYS_" + str(metadata["llvm_sys_abi"]) + "_PREFIX=${pwd}/external/" + ctx.name + "\n")
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["TOOLCHAIN.json", "llvm.env"] + glob(["bin/*"]))
filegroup(name = "files", srcs = glob(["bin/**", "lib/**", "usr/include/**", "include/**", "share/**"], allow_empty = True) + ["TOOLCHAIN.json"])
""")

wasmer_llvm_repository = repository_rule(
    implementation = _wasmer_llvm_repository_impl,
    attrs = {
        "metadata": attr.label(default = "@wasix_tool_metadata//:llvm.json", allow_single_file = True),
        "host": attr.string(mandatory = True),
    },
)
