"""Canonical public WASIX tools carriers from their independent command graph."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "PUBLICATION_CARRIERS", "WASIX_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/native/carriers:defs.bzl", "native_checksum_manifest")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load(":cargo.bzl", "RUNTIME_CARGO_HELPERS")
load(":npm.bzl", "RUNTIME_NPM_NOTICES")

TOOLS_CARRIER_HELPERS = RUNTIME_CARGO_HELPERS + [
    "//build_defs/wasix:cargo.mts",
    "//build_defs/wasix:package.mts",
    "//src/wasix/postgres-tools:tools/package-assets.mts",
    "//src/wasix/postgres-tools:tools/wasix-tools-aot-npm.mts",
    "//src/wasix/postgres-tools:tools/wasix-tools-npm-carrier.mts",
    "//src/wasix/runtime:tools/package-release-assets.mts",
    "//:tools/packaging/npm-trusted-publishing.mts",
]

def _source_map(entries, inputs):
    result = {}
    for target, destination in entries.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or destination in result:
            fail("WASIX tools source must be one unique declared file")
        result[destination] = files[0].path
        inputs += files
    return result

def _tools_carriers_impl(ctx):
    product = ctx.attr.product[ReleaseIdentityInfo]
    runtime = ctx.attr.runtime_product[ReleaseIdentityInfo]
    if product.id != "postgres-tools-wasix" or runtime.id != "liboliphaunt-wasix":
        fail("WASIX tools envelopes require their canonical product and runtime owners")
    payload = ctx.attr.payload[DefaultInfo].files.to_list()
    if len(payload) != 1 or not payload[0].is_directory:
        fail("WASIX tools envelopes require their actual declared payload tree")
    artifact = json.decode(ctx.attr.artifact)
    prefix = ctx.label.name + "/"
    github = ctx.actions.declare_file(prefix + artifact["asset"].replace("{version}", product.version))
    npm = ctx.actions.declare_file(prefix + ctx.attr.npm_package.replace("@", "").replace("/", "-") + "-" + product.version + ".tgz")
    cargo = ctx.actions.declare_file(prefix + ctx.attr.cargo_package + "-" + product.version + ".crate")
    inputs = payload + [ctx.file.toolchain, ctx.file.postgres_source, ctx.file.postgres_series, ctx.file.icu_source] + ctx.files.patches
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "version": product.version,
        "runtimeVersion": runtime.version,
        "artifact": artifact,
        "cargoPackage": ctx.attr.cargo_package,
        "npmPackage": ctx.attr.npm_package,
        "payload": payload[0].path,
        "sources": _source_map(ctx.attr.sources, inputs),
        "notices": _source_map(ctx.attr.notices, inputs),
        "toolchain": ctx.file.toolchain.path,
        "postgresSource": ctx.file.postgres_source.path,
        "postgresSeries": ctx.file.postgres_series.path,
        "patches": {file.short_path: file.path for file in ctx.files.patches},
        "icuSource": ctx.file.icu_source.path,
        "outputs": {"github": github.path, "npm": npm.path, "cargo": cargo.path},
    }))
    args = ctx.actions.args()
    args.add_all(["--spec", spec])
    leaves = ctx.actions.args()
    leaves.add_all(payload, expand_directories = True)
    leaves.use_param_file("--payload-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._packager, arguments = [args, leaves], inputs = depset(inputs + [spec]),
                    source_files = ctx.files._helpers, outputs = [github, npm, cargo], mnemonic = "WasixToolsFinalEnvelopes")
    return [DefaultInfo(files = depset([github, npm, cargo])),
            OutputGroupInfo(github = depset([github]), npm = depset([npm]), cargo = depset([cargo]))]

_tools_carriers = rule(
    implementation = _tools_carriers_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "payload": attr.label(mandatory = True),
        "product": attr.label(default = "@oliphaunt_metadata//:product_postgres-tools-wasix", providers = [ReleaseIdentityInfo]),
        "runtime_product": attr.label(default = "@oliphaunt_metadata//:product_liboliphaunt-wasix", providers = [ReleaseIdentityInfo]),
        "artifact": attr.string(mandatory = True),
        "cargo_package": attr.string(mandatory = True),
        "npm_package": attr.string(mandatory = True),
        "sources": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "notices": attr.label_keyed_string_dict(default = dict(RUNTIME_NPM_NOTICES, **{"//src/wasix/postgres-tools:npm/native.mts": "src/wasix/postgres-tools/npm/native.mts"}), allow_files = True),
        "patches": attr.label_list(allow_files = [".patch"], mandatory = True),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "postgres_source": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
        "postgres_series": attr.label(default = "//src/wasix/runtime:postgres/series", allow_single_file = True),
        "icu_source": attr.label(default = "//src/third-party/icu:source.toml", allow_single_file = True),
        "_packager": attr.label(default = "//build_defs/wasix:tools-carriers.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = TOOLS_CARRIER_HELPERS, allow_files = True),
    },
)

def wasix_tools_carriers(patches, qualification = []):
    owner = "@oliphaunt_metadata//:product_postgres-tools-wasix"
    rows = [row for row in WASIX_ARTIFACTS if row["product"] == "postgres-tools-wasix" and row["kind"] != "checksums"]
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == "postgres-tools-wasix"]
    packages, archives, github_groups = ["//src/wasix/postgres-tools/ts:shipping_package"], [], []
    for row in rows:
        portable = row["target"] == "portable"
        name = row["target"].replace("-", "_")
        cargo_rows = [carrier for carrier in carriers if carrier["ecosystem"] == "cargo" and carrier["target"] == row.get("triple")]
        npm_name = "@oliphaunt/liboliphaunt-wasix-tools" if portable else row["npm_package"]
        npm_rows = [carrier for carrier in carriers if carrier["ecosystem"] == "npm" and carrier["name"] == npm_name]
        if len(cargo_rows) != 1 or len(npm_rows) != 1:
            fail("WASIX tools envelope has no unique canonical carrier identities")
        template = "crates/" + ("tools" if portable else "aot/" + row["triple"]) + "/"
        sources = native.glob([template + pattern for pattern in ["Cargo.toml", "README.md", "build.rs", "build-support.rs", "src/**"]])
        native.filegroup(name = name + "_package_sources", srcs = sources)
        payload = ":portable_payload" if portable else ":aot_" + name + "_payload"
        _tools_carriers(name = "carriers_" + name, payload = payload, artifact = json.encode(row),
                        cargo_package = cargo_rows[0]["name"], npm_package = npm_name, patches = patches,
                        sources = {source: source[len(template):] for source in sources})
        for ecosystem in ["github", "npm", "cargo"]:
            group = name + "_" + ecosystem
            if ecosystem == "github":
                private = group + "_input"
                native.filegroup(name = private, srcs = [":carriers_" + name], output_group = ecosystem)
                archives.append(":" + private)
                github_groups.append((group, row["asset"].replace("{version}", PRODUCTS["postgres-tools-wasix"]["version"])))
            else:
                native.filegroup(name = group, srcs = [":carriers_" + name], output_group = ecosystem)
            carrier = cargo_rows[0] if ecosystem == "cargo" else npm_rows[0]
            shipping_package(name = group + "_shipping", owner = owner, artifacts = [":" + group], ecosystem = ecosystem,
                             package_name = row["asset"].replace("{version}", PRODUCTS["postgres-tools-wasix"]["version"]) if ecosystem == "github" else carrier["name"],
                             configuration = row["target"] if ecosystem == "github" else (carrier["target"] or row["target"]), role = "github-release-asset" if ecosystem == "github" else carrier["role"])
            packages.append(":" + group + "_shipping")
    native_checksum_manifest(name = "assembled_release_assets", product = "postgres-tools-wasix", archives = archives, artifact_rows = WASIX_ARTIFACTS, assemble = True)
    for group, asset in github_groups:
        native.filegroup(name = group, srcs = [":assembled_release_assets"], output_group = asset)
    native.filegroup(name = "checksums", srcs = [":assembled_release_assets"], output_group = "checksums")
    checksum = [row for row in WASIX_ARTIFACTS if row["product"] == "postgres-tools-wasix" and row["kind"] == "checksums"]
    shipping_package(name = "checksums_shipping", owner = owner, artifacts = [":checksums"], ecosystem = "github",
                     package_name = checksum[0]["asset"].replace("{version}", PRODUCTS["postgres-tools-wasix"]["version"]),
                     configuration = "portable", role = "github-release-asset")
    packages.append(":checksums_shipping")
    native.filegroup(name = "release_assets", srcs = [":assembled_release_assets"])
    native.filegroup(name = "carriers", srcs = [":carriers_" + row["target"].replace("-", "_") for row in rows] + ["//src/wasix/postgres-tools/ts:npm"])
    shipping_export(name = "shipping_export", packages = packages, qualification = qualification, testonly = True)
