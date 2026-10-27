"""One SDK-owned construction of the Windows engine's seven Cargo envelopes."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

ENGINE_PACKAGE_HELPERS = [
    "//:tools/packaging/cargo-manifest.mts",
    "//:tools/packaging/cargo-source-package.mts",
    "//:tools/packaging/package-archive.mts",
    "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/portable-archive.mts",
    "//:tools/packaging/release-notices.mts",
    "//:tools/packaging/release-directory-safety.mts",
]

def _windows_engine_packages_impl(ctx):
    owner = PRODUCTS["oliphaunt-wasix-rust"]
    version = owner["version"]
    facades = [row["name"] for row in PUBLICATION_CARRIERS if row["product"] == owner["id"] and row["ecosystem"] == "cargo" and row["role"] == "platform-leaf" and row["target"] == "windows-x64-msvc"]
    if len(facades) != 1:
        fail("Windows engine needs one canonical SDK-owned platform carrier")
    facade = facades[0]
    sources = {}
    archives = {}
    groups = {}
    inputs = [ctx.file.sdk_manifest, ctx.file.dll, ctx.file.embedded_bindings, ctx.file.build_script, ctx.file.notices] + ctx.files.source_files
    prefix = ctx.label.name + "/"
    for target, original in ctx.attr.source_manifests.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or original in sources:
            fail("Engine upstream manifest must be one uniquely named regular File")
        name = "oliphaunt-" + original
        if "crates:" + name not in owner["registry_packages"]:
            fail("Engine source carrier is not declared by its SDK owner: " + name)
        sources[original] = files[0].dirname
        inputs += files
        archives[name] = ctx.actions.declare_file(prefix + name + "-" + version + ".crate")
        groups[original.replace("-", "_")] = depset([archives[name]])
    if len(sources) != 4:
        fail("Windows engine needs its four declared upstream source packages")
    parts = [facade + "-part-001", facade + "-part-002"]
    delivery = []
    for name in parts + [facade]:
        archives[name] = ctx.actions.declare_file(prefix + name + "-" + version + ".crate")
        stem = "facade" if name == facade else "part" + name[-3:]
        source = ctx.actions.declare_file(prefix + "delivery/" + name + "/src/lib.rs")
        delivery.append(source)
        groups[stem + "_rs"] = depset([source])
        if name != facade:
            payload = ctx.actions.declare_file(prefix + "delivery/" + name + "/payload/dll.gz.part")
            delivery.append(payload)
            groups[stem + "_payload"] = depset([payload])
    groups["facade"] = depset([archives[name] for name in parts + [facade]])
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "version": version,
        "sdkManifestFile": ctx.file.sdk_manifest.path,
        "sources": sources,
        "dllFile": ctx.file.dll.path,
        "embeddedBindingsFile": ctx.file.embedded_bindings.path,
        "buildScriptTemplate": ctx.file.build_script.path,
        "noticesFile": ctx.file.notices.path,
        "outputDirectory": archives[facade].dirname,
    }))
    args = ctx.actions.args()
    args.add(specification)
    bun_file_action(
        ctx,
        entry_point = ctx.file._packager,
        arguments = [args],
        inputs = depset(inputs + [specification]),
        source_files = ctx.files._helpers,
        outputs = archives.values() + delivery,
        mnemonic = "WindowsEngineCargoEnvelopes",
    )
    return [DefaultInfo(files = depset(archives.values())), OutputGroupInfo(**groups)]

windows_engine_packages = rule(
    implementation = _windows_engine_packages_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "sdk_manifest": attr.label(mandatory = True, allow_single_file = True),
        "source_manifests": attr.label_keyed_string_dict(mandatory = True, allow_files = True),
        "source_files": attr.label_list(mandatory = True, allow_files = True),
        "dll": attr.label(mandatory = True, allow_single_file = [".dll"]),
        "embedded_bindings": attr.label(mandatory = True, allow_single_file = [".rs"]),
        "build_script": attr.label(mandatory = True, allow_single_file = True),
        "notices": attr.label(mandatory = True, allow_single_file = True),
        "_packager": attr.label(default = "//src/wasix/runtime/engine:package.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ENGINE_PACKAGE_HELPERS, allow_files = True),
    },
)
