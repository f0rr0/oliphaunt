"""Npm envelope for the declared portable runtime, using the shared formatter."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")

RUNTIME_NPM_HELPERS = [
    "//src/wasix/runtime:tools/wasix-runtime-npm-payload.mts",
    "//src/wasix/runtime:tools/wasix-runtime-npm-contract.mts",
    "//src/wasix/runtime:tools/wasix-runtime-npm-descriptor.mts",
    "//:tools/packaging/package-archive.mts",
    "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/portable-archive.mts",
    "//:tools/packaging/release-notices.mts",
    "//:tools/packaging/release-directory-safety.mts",
    "//:tools/packaging/npm-trusted-publishing.mts",
]

RUNTIME_NPM_NOTICES = {
    "//:LICENSE": "LICENSE",
    "//:THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
    "//src/wasix/sdks/rust:THIRD_PARTY_NOTICES.md": "src/wasix/sdks/rust/THIRD_PARTY_NOTICES.md",
    "//src/third-party/postgres:COPYRIGHT": "src/third-party/postgres/COPYRIGHT",
    "//src/third-party/postgres:source.toml": "src/third-party/postgres/source.toml",
    "//src/third-party/icu:LICENSE": "src/third-party/icu/LICENSE",
    "//src/third-party/icu:source.toml": "src/third-party/icu/source.toml",
}

def _runtime_npm_impl(ctx):
    payloads = ctx.attr.payload[DefaultInfo].files.to_list()
    if len(payloads) != 1 or not payloads[0].is_directory:
        fail("WASIX runtime npm carrier requires the actual portable payload tree")
    identity = ctx.attr.product[ReleaseIdentityInfo]
    if identity.id != "liboliphaunt-wasix":
        fail("WASIX runtime npm carrier requires its canonical product owner")
    inputs = payloads[:]
    notices = {}
    for target, destination in ctx.attr.notices.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or destination in notices:
            fail("WASIX runtime npm notice must be one unique declared file")
        notices[destination] = files[0].path
        inputs += files
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"version": identity.version, "packageName": ctx.attr.package_name, "portableAssets": payloads[0].path, "notices": notices}))
    output = ctx.actions.declare_file(ctx.label.name + ".tgz")
    args = ctx.actions.args()
    args.add_all(["--spec", spec, "--output", output])
    bun_file_action(
        ctx,
        ctx.file._packager,
        arguments = [args],
        inputs = depset(inputs + [spec]),
        source_files = ctx.files._helpers,
        outputs = [output],
        mnemonic = "WasixRuntimeNpmEnvelope",
    )
    return [DefaultInfo(files = depset([output]))]

_runtime_npm = rule(
    implementation = _runtime_npm_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "payload": attr.label(mandatory = True),
        "product": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]),
        "package_name": attr.string(mandatory = True),
        "notices": attr.label_keyed_string_dict(default = RUNTIME_NPM_NOTICES, allow_files = True),
        "_packager": attr.label(default = "//build_defs/wasix:npm.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = RUNTIME_NPM_HELPERS, allow_files = True),
    },
)

def wasix_runtime_npm():
    product = "liboliphaunt-wasix"
    names = [name[len("npm:"):] for name in PRODUCTS[product]["registry_packages"] if name.startswith("npm:")]
    if len(names) != 1:
        fail("WASIX portable runtime product must own exactly one npm carrier")
    owner = "@oliphaunt_metadata//:product_" + product
    _runtime_npm(name = "npm", payload = ":portable_payload", product = owner, package_name = names[0])
    shipping_package(name = "npm_shipping_package", owner = owner, artifacts = [":npm"], ecosystem = "npm", package_name = names[0], configuration = "portable", role = "portable-leaf")
    shipping_export(name = "npm_shipping_export", packages = [":npm_shipping_package"])
