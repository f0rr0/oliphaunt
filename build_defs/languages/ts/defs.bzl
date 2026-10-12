"""Native SDK manifest projection and consumers of actual npm envelopes."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@aspect_rules_js//npm:defs.bzl", "npm_link_package")
load("//build_defs/release:shipping.bzl", "ShippingInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")

_NODE_TOOLCHAIN = "@rules_nodejs//nodejs:toolchain_type"

def _publish_files_impl(ctx):
    outputs = [ctx.actions.declare_file(ctx.label.name + "/" + name) for name in ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]]
    bun_file_action(
        ctx,
        entry_point = ctx.file._writer,
        arguments = [ctx.attr.profile, ctx.file.manifest.path, outputs[0].dirname],
        inputs = [ctx.file.manifest, ctx.file._writer, ctx.file.profile_helper] + ctx.files._helpers,
        source_files = [ctx.file._writer, ctx.file.profile_helper] + ctx.files._helpers,
        outputs = outputs,
        mnemonic = "SourceSdkManifest",
    )
    return [DefaultInfo(files = depset(outputs)), OutputGroupInfo(manifest = depset([outputs[0]]), license = depset([outputs[1]]), notices = depset([outputs[2]]))]

_source_sdk_publish_files = rule(
    implementation = _publish_files_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
        "profile": attr.string(default = "js", values = ["js", "wasix-ts", "wasix-tools"]),
        "_writer": attr.label(default = "//build_defs/languages/ts:publish-manifest.mts", allow_single_file = True),
        "profile_helper": attr.label(mandatory = True, allow_single_file = True),
        "_helpers": attr.label_list(default = [
            "//:LICENSE",
            "//:THIRD_PARTY_NOTICES.md",
            "//:tools/packaging/release-notices.mts",
            "//:tools/packaging/release-directory-safety.mts",
            "//:tools/packaging/portable-archive.mts",
        ], allow_files = True),
    },
)

def source_sdk_publish_files(name, manifest, profile = "js", **kwargs):
    _source_sdk_publish_files(
        name = name,
        manifest = manifest,
        profile = profile,
        profile_helper = {
            "js": "//:tools/packaging/source-only-sdk-package.mts",
            "wasix-ts": "//src/wasix/sdks/ts:tools/package.mts",
            "wasix-tools": "//src/wasix/postgres-tools/ts:tools/package.mts",
        }[profile],
        **kwargs
    )

def _archive_package_impl(ctx):
    return [
        DefaultInfo(files = depset([ctx.file.archive])),
        NpmPackageInfo(package = ctx.attr.package_name, version = ctx.attr.version, src = ctx.file.archive, npm_package_store_infos = depset()),
    ]

npm_archive_package = rule(
    implementation = _archive_package_impl,
    attrs = {
        "archive": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "package_name": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
    },
)

def _dependency_package_impl(ctx):
    if ctx.attr.source == "unverified":
        fail("Final npm dependency %s is unresolved: %s" % (ctx.attr.package_name, ctx.attr.reason))
    if ctx.attr.current:
        identity = ctx.attr.current[ShippingInfo]
        if identity.ecosystem != "npm" or identity.name != ctx.attr.package_name or identity.version != ctx.attr.version or (ctx.attr.owner and identity.product != ctx.attr.owner):
            fail("Current npm dependency differs from its declared source owner/name/version")
        files = identity.files.to_list()
        if len(files) != 1 or files[0].is_directory or not files[0].basename.endswith(".tgz"):
            fail("Current npm dependency needs one actual shipping archive File")
        archive = files[0]
    elif ctx.attr.registry:
        identity = ctx.attr.registry[NpmPackageInfo]
        if identity.package != ctx.attr.package_name or identity.version != ctx.attr.version:
            fail("Registry npm dependency name/version differs")
        archive = identity.src
    else:
        archive = ctx.file.archive
    if not archive:
        fail("Final npm dependency needs its actual captured archive File")
    output = ctx.actions.declare_file(ctx.label.name + "/dependency.tgz")
    arguments = ["--verify-dependency", archive.path, output.path, ctx.attr.package_name, ctx.attr.version, str(ctx.attr.size), ctx.attr.sha256]
    sources = [ctx.file._validator, ctx.file._archive_reader]
    bun_file_action(ctx, entry_point = ctx.file._validator, arguments = arguments, inputs = [archive] + sources, source_files = sources, outputs = [output], mnemonic = "VerifyNpmDependency")
    return [DefaultInfo(files = depset([output])), NpmPackageInfo(package = ctx.attr.package_name, version = ctx.attr.version, src = output, npm_package_store_infos = depset())]

_dependency_package = rule(
    implementation = _dependency_package_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "source": attr.string(mandatory = True),
        "package_name": attr.string(mandatory = True),
        "version": attr.string(default = ""),
        "owner": attr.string(default = ""),
        "reason": attr.string(default = ""),
        "size": attr.int(default = -1),
        "sha256": attr.string(default = ""),
        "archive": attr.label(allow_single_file = [".tgz"]),
        "registry": attr.label(providers = [NpmPackageInfo]),
        "current": attr.label(providers = [ShippingInfo]),
        "_validator": attr.label(default = "//build_defs/languages/ts:metadata.mts", allow_single_file = True),
        "_archive_reader": attr.label(default = "//:tools/packaging/portable-archive.mts", allow_single_file = True),
    },
)

def workspace_dependency_package(name, workspace, dependency, current, **kwargs):
    """Use the declared completed/selected source choice for compiler and installed consumers."""
    choice = workspace["dependencyInputs"][dependency]
    _dependency_package(
        name = name,
        source = choice["source"],
        package_name = dependency,
        version = choice.get("version", ""),
        owner = choice.get("owner", ""),
        reason = choice.get("reason", ""),
        size = choice.get("size", -1),
        sha256 = choice.get("sha256", ""),
        archive = choice.get("archive"),
        registry = "@javascript_packages//:" + choice["package"] if choice["source"] == "registry" else None,
        current = current if choice["source"] == "workspace" else None,
        **kwargs
    )

def workspace_dependency_link(name, package, workspace, dependency, **kwargs):
    choice = workspace["dependencyInputs"][dependency]
    npm_link_package(name = name, src = package, deps = {":_javascript_" + key: child for child, key in choice.get("packages", {}).items()}, **kwargs)

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _consumer_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("SDK consumers require the pinned Node toolchain")
    type_files = []
    packages = {}
    for key, target in ctx.attr.type_packages.items():
        source = key[NpmPackageInfo].src
        type_files.append(source)
        packages[target] = _runfile(ctx, source)
    specification = ctx.actions.declare_file(ctx.label.name + ".types.json")
    ctx.actions.write(specification, json.encode({"packages": packages, "types": ctx.attr.types}))
    files = [ctx.file.archive, ctx.file.query, ctx.file.consumer, ctx.file._runner, ctx.file.acquisition, ctx.file.typescript, specification, node] + type_files
    arguments = [ctx.file.archive, ctx.file.query, ctx.file.consumer, node, ctx.file.typescript, ctx.file.acquisition, specification]
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files, source_files = [ctx.file._runner], runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_source_sdk_consumer_test = rule(
    implementation = _consumer_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "query": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "consumer": attr.label(mandatory = True, allow_single_file = True),
        "typescript": attr.label(default = "@npm_typescript//:node_modules/typescript/dir", allow_single_file = True),
        "acquisition": attr.label(default = "@javascript_packages//:acquisition.json", allow_single_file = True),
        "type_packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "types": attr.string_dict(mandatory = True),
        "_runner": attr.label(default = "//build_defs/languages/ts:consumer-test.mts", allow_single_file = True),
    }),
)

def source_sdk_consumer_test(name, args = [], **kwargs):
    _source_sdk_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def _installed_npm_consumer_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("Installed npm consumers require the pinned Node toolchain")
    packages = {}
    package_files = []
    for target, identity in ctx.attr.packages.items():
        source = target[NpmPackageInfo].src
        packages[identity] = _runfile(ctx, source)
        package_files.append(source)
    archives = {}
    for target, name in ctx.attr.archives.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("Installed npm archive must have exactly one producer file: " + str(target.label))
        archives[name] = _runfile(ctx, files[0])
        package_files += files
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"packages": packages, "archives": archives, "roots": ctx.attr.roots, "consumer": _runfile(ctx, ctx.file.consumer), "helpers": [_runfile(ctx, file) for file in ctx.files.helpers], "acquisitions": [_runfile(ctx, file) for file in ctx.files.acquisitions]}))
    files = package_files + [specification, node, ctx.file.typescript, ctx.file.runner, ctx.file.consumer] + ctx.files.helpers + ctx.files.acquisitions
    return bun_test_entrypoint(ctx, ctx.file.runner, [specification, node, ctx.file.typescript], files, source_files = [ctx.file.runner, ctx.file.consumer] + ctx.files.helpers, runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_installed_npm_consumer_test = rule(
    implementation = _installed_npm_consumer_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "archives": attr.label_keyed_string_dict(allow_files = True),
        "roots": attr.string_dict(mandatory = True),
        "acquisitions": attr.label_list(allow_files = [".json"], mandatory = True),
        "runner": attr.label(allow_single_file = True, mandatory = True),
        "consumer": attr.label(allow_single_file = True, mandatory = True),
        "helpers": attr.label_list(allow_files = True),
        "typescript": attr.label(default = "@npm_typescript//:node_modules/typescript/dir", allow_single_file = True),
    }),
)

def installed_npm_consumer_test(name, args = [], **kwargs):
    _installed_npm_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def npm_dependency_closure(packages, roots):
    selected = {identity: True for identity in roots}
    for _ in range(len(packages) + 1):
        previous = len(selected)
        for identity in selected.keys():
            for dependency in packages[identity]["dependencies"].values():
                selected[dependency] = True
        if len(selected) == previous:
            return selected.keys()
    fail("npm dependency closure exceeds its declared packages")
