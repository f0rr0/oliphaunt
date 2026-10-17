"""Runtime-owned WASIX contrib envelopes from the existing portable module graph."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "EXTENSION_RELEASE_METADATA", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("@cargo_crates//:defs.bzl", _current_crate_deps = "crate_deps")
load("@native_cargo_metadata//:cargo.bzl", _CURRENT_CARGO = "CARGO")
load("//build_defs/extensions:contrib_carriers.bzl", "native_contrib_carrier_legal", "native_contrib_carrier_metadata")
load("//build_defs/extensions:extensions.bzl", "extension_identity")
load("//build_defs/extensions:final_leaf.bzl", "ExtensionFinalLeafInfo")
load("//build_defs/extensions:wasix_carriers.bzl", "WasixExtensionHostInfo", "wasix_sql_carrier_helpers")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/foundation:bun.bzl", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/wasix:aot.bzl", "WasixAotInfo", "wasix_aot")
load("//build_defs/wasix:platform.bzl", "WASIX_PORTABLE_TRANSITION")
load("//build_defs/wasix:wasm.bzl", "WasmModuleInfo")
load("//build_defs/wasix:npm.bzl", "RUNTIME_NPM_NOTICES")

def _metadata():
    spec = native_contrib_carrier_metadata("wasix-portable", family = "wasix")
    releases = {row["sqlName"]: row for row in EXTENSION_RELEASE_METADATA if row["class"] == "contrib"}
    spec["releaseMetadata"] = releases[spec["expectedMembers"][0]]
    spec["carriers"] = [row for row in spec["carriers"] if row["target"] == "wasix-portable" or (row["ecosystem"] == "cargo" and row["role"] == "aot-leaf") or (row["ecosystem"] == "npm" and row["name"] == spec["releaseMetadata"]["npmPackage"] + "-wasix")]
    for member in spec["members"]:
        member["releaseMetadata"] = releases[member["sqlName"]]
        member["source"] = dict(member["source"])
        member["source"]["extension-control"] = {"default-version": member["contrib"].get("default-version")}
        member["recipe"] = {"artifacts": {"data_files": member["contrib"].get("data-files", [])}}
        member["carriers"] = spec["carriers"]
    return spec

def _carriers_impl(ctx):
    spec = _metadata()
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    host = ctx.attr.host[WasixExtensionHostInfo]
    if owner.id != spec["owner"] or owner.version != spec["version"]:
        fail("WASIX contrib bundle differs from its canonical runtime owner")
    if host.version != spec["version"] or host.version != spec["compatibility"]["wasix_runtime_version"]:
        fail("WASIX contrib requires its current runtime owner's exact host")
    modules = {target[WasmModuleInfo].module.basename: target[WasmModuleInfo].module for target in ctx.attr.modules}
    expected = [member["contrib"]["module-file"] for member in spec["members"]]
    if len(modules) != len(ctx.attr.modules) or sorted(modules.keys()) != sorted(expected):
        fail("WASIX contrib must consume all canonical portable members exactly once")
    resource_names = [member["sqlName"] for member in spec["members"] if member["descriptor"]["lifecycle"]["create-extension"] or member["contrib"].get("data-files", [])]
    if sorted(ctx.attr.resources.values()) != sorted(resource_names):
        fail("WASIX contrib requires every canonical resource producer exactly once")
    resources = {name: [] for name in spec["expectedMembers"]}
    resources.update({sql_name: target[DefaultInfo].files.to_list() for target, sql_name in ctx.attr.resources.items()})
    images = [target[WasixAotInfo] for target in ctx.attr.aot]
    if len(images) != len(spec["members"]) * len(WASIX_AOT_TARGETS):
        fail("WASIX contrib requires only its complete canonical AOT cohort")
    image_files = [file for image in images for file in [image.image, image.module]]
    member_inputs = []
    links = []
    resource_files = []
    for member in spec["members"]:
        sql_name = member["sqlName"]
        module = modules[member["contrib"]["module-file"]]
        module_rows = [{"name": sql_name, "path": module.path, "runtime_path": "lib/postgresql/" + module.basename}]
        link_spec = ctx.actions.declare_file(ctx.label.name + "/links/" + sql_name + ".inputs.json")
        link = ctx.actions.declare_file(ctx.label.name + "/links/" + sql_name + ".json")
        ctx.actions.write(link_spec, json.encode({"sql_name": sql_name, "runtime": host.module.path, "runtime_manifest": host.manifest.path, "modules": module_rows}))
        args = ctx.actions.args()
        args.add_all(["assets", "declared-extension-link", "--spec", link_spec, "--output", link])
        ctx.actions.run(executable = ctx.executable._analyzer, arguments = [args], inputs = [module, host.module, host.manifest, link_spec], outputs = [link], mnemonic = "WasixContribLinkContract")
        links.append(link)
        member_resources = []
        data = {destination.split("/")[-1]: destination for destination in member["contrib"].get("data-files", [])}
        for file in resources[sql_name]:
            if file.is_directory:
                fail("WASIX contrib resources require exact upstream files")
            if file.basename.endswith(".control") or file.basename.endswith(".sql"):
                destination = "share/postgresql/extension/" + file.basename
            elif file.basename in data:
                destination = data[file.basename]
            else:
                fail("WASIX contrib resource has no canonical destination: " + file.basename)
            member_resources.append({"source": file.path, "destination": destination})
        resource_files += resources[sql_name]
        member_images = [image for image in images if image.module.path == module.path]
        if len(member_images) != len(WASIX_AOT_TARGETS) or sorted([image.target for image in member_images]) != sorted(WASIX_AOT_TARGETS.values()):
            fail("WASIX contrib member requires its exact four serialized AOT targets")
        member.update({"operation": "compiled", "modules": module_rows, "resources": member_resources, "link": link.path, "toolchain": ctx.file.toolchain.path,
                       "aot": [{"target": image.target, "image": image.image.path, "module": module.path, "name": "extension:" + sql_name} for image in member_images]})
        member_inputs += [module, link]
    outputs = {"npm": [], "cargo": []}
    carrier_groups = {}
    for index, row in enumerate(spec["carriers"]):
        suffix = ".tgz" if row["ecosystem"] == "npm" else ".crate"
        filename = row["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + suffix
        file = ctx.actions.declare_file(ctx.label.name + "/" + row["ecosystem"] + "/" + filename)
        outputs[row["ecosystem"]].append(file)
        carrier_groups["carrier_" + str(index)] = depset([file])
    if len(outputs["npm"]) != 1 or len(outputs["cargo"]) != len(WASIX_AOT_TARGETS) + 1:
        fail("WASIX contrib requires its canonical npm portable and Cargo portable/AOT carriers")
    outputs["github"] = [ctx.actions.declare_file(ctx.label.name + "/release-assets/" + spec["product"] + "-" + spec["version"] + "-wasix-wasix-portable-bundle.tar.gz")]
    outputs["manifest"] = [ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")]
    outputs["frozen"] = [ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")]
    output_files = [file for files in outputs.values() for file in files]
    spec.update({"operation": "contrib", "outputs": {name: files[0].dirname if name in ["npm", "cargo"] else files[0].path for name, files in outputs.items()}})
    for member in spec["members"]:
        member["outputs"] = spec["outputs"]
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path], inputs = member_inputs + resource_files + image_files + [inputs, ctx.file.toolchain] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal, outputs = output_files, mnemonic = "WasixContribEnvelopes")
    return [DefaultInfo(files = depset(output_files)),
            ExtensionFinalLeafInfo(product = spec["product"], owner = owner.id, version = owner.version, family = "wasix", target = "wasix-portable", metadata = spec,
                                   github = outputs["github"], npm = outputs["npm"], cargo = outputs["cargo"], manifest = outputs["manifest"][0], frozen = outputs["frozen"][0], spec = inputs, validation = None, receipt = None, origin = None),
            OutputGroupInfo(**{name: depset(files) for name, files in outputs.items()} | carrier_groups | {"spec": depset([inputs]), "link": depset(links)})]

_wasix_contrib_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "modules": attr.label_list(mandatory = True, providers = [WasmModuleInfo], cfg = WASIX_PORTABLE_TRANSITION),
    "resources": attr.label_keyed_string_dict(mandatory = True, allow_files = True), "aot": attr.label_list(mandatory = True, providers = [WasixAotInfo]),
    "host": attr.label(mandatory = True, providers = [WasixExtensionHostInfo]), "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]), "legal": attr.label_list(allow_files = True),
    "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
    "_tool": attr.label(default = "//build_defs/extensions/wasix:contrib_carriers.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = wasix_sql_carrier_helpers() + ["//build_defs/extensions:wasix_carriers.mts", "//:src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts", "//:src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts"], allow_files = True),
    "_analyzer": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def wasix_contrib_extension_carriers(name, host):
    """Package all 32 existing members together under the current WASIX runtime."""
    modules = []
    resources = {}
    aot = []
    for member in CONTRIB_MEMBERS:
        module = "//src/wasix/runtime:contrib_" + member["id"]
        modules.append(module)
        if member.get("default-version"):
            resources["@postgres_wasix//:contrib_" + member["contrib-dir"].replace("-", "_") + "_resources"] = member["sql-name"]
        for target_id in WASIX_AOT_TARGETS:
            image = name + "_aot_" + target_id.replace("-", "_") + "_" + member["id"]
            wasix_aot(name = image, module = module, target_id = target_id, output_name = member["sql-name"] + "-llvm-opta.bin.zst",
                      exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"])
            aot.append(":" + image)
    _wasix_contrib_carriers(name = name, modules = modules, resources = resources, aot = aot, host = host,
                           owner = extension_identity(CONTRIB_MEMBERS[0]["sql-name"], family = "wasix"), legal = native_contrib_carrier_legal(),
                           exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])

def _installed_impl(ctx):
    leaf = ctx.attr.leaf[ExtensionFinalLeafInfo]
    host = ctx.attr.host[WasixExtensionHostInfo]
    binary = ctx.attr.binary[DefaultInfo].files_to_run.executable
    if len(leaf.cargo) != len(WASIX_AOT_TARGETS) + 1 or any([file.is_directory for file in leaf.cargo]):
        fail("contrib installed test requires its exact five regular Cargo carriers")
    arguments = [leaf.spec, leaf.npm[0], leaf.cargo[0], leaf.frozen, host.module, host.manifest, binary]
    files = leaf.github + leaf.npm + leaf.cargo + [leaf.spec, leaf.frozen, host.module, host.manifest, binary] + ctx.files._helpers
    runfiles = ctx.attr.binary[DefaultInfo].default_runfiles
    incremental = ctx.attr.server_binary != None
    if incremental != (ctx.attr.tools_portable != None) or incremental != (ctx.attr.tools_aot != None):
        fail("contrib incremental proof requires both final tools carriers and its server binary")
    if incremental:
        target = WASIX_AOT_TARGETS["linux-x64-gnu"]
        rows = [row for row in PUBLICATION_CARRIERS if row["product"] == "postgres-tools-wasix" and row["ecosystem"] == "cargo"]
        portable = [row for row in rows if row["target"] == None]
        aot = [row for row in rows if row["target"] == target]
        if len(portable) != 1 or len(aot) != 1:
            fail("incremental contrib proof requires its unique canonical tools Cargo identities")
        tools = ctx.actions.declare_file(ctx.label.name + ".tools.json")
        ctx.actions.write(tools, json.encode({"version": PRODUCTS["postgres-tools-wasix"]["version"], "runtimeVersion": host.version,
                                             "portableName": portable[0]["name"], "aotName": aot[0]["name"], "target": target}))
        server = ctx.attr.server_binary[DefaultInfo].files_to_run.executable
        arguments += [tools, ctx.file.tools_portable, ctx.file.tools_aot, server]
        files += [tools, ctx.file.tools_portable, ctx.file.tools_aot, server] + ctx.files.additional_helpers
        runfiles = runfiles.merge(ctx.attr.server_binary[DefaultInfo].default_runfiles)
    elif ctx.files.additional_helpers:
        fail("ordinary contrib lifecycle proof must not carry unused incremental helpers")
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files,
        source_files = [ctx.file._runner] + ctx.files._helpers + ctx.files.additional_helpers, additional_runfiles = runfiles)

_wasix_contrib_installed_test = rule(implementation = _installed_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "leaf": attr.label(mandatory = True, providers = [ExtensionFinalLeafInfo]), "host": attr.label(mandatory = True, providers = [WasixExtensionHostInfo]),
        "binary": attr.label(default = "//src/wasix/sdks/rust:extension_carrier_unit_test", executable = True, cfg = "target"),
        "server_binary": attr.label(executable = True, cfg = "target"),
        "tools_portable": attr.label(allow_single_file = [".crate"]),
        "tools_aot": attr.label(allow_single_file = [".crate"]),
        "additional_helpers": attr.label_list(allow_files = True),
        "_runner": attr.label(default = "//build_defs/extensions/wasix:contrib_installed.test.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True),
    }))

def wasix_contrib_extension_installed_test(name, **kwargs):
    _wasix_contrib_installed_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)

def wasix_contrib_extension_incremental_installed_test(name, **kwargs):
    """Run logical restore and server cases from one shared extracted contrib packet."""
    wasix_contrib_extension_installed_test(name = name,
        binary = "//src/wasix/sdks/rust:extension_carrier_tools_unit_test",
        server_binary = "//src/wasix/pgwire-server:contrib_carrier_server_test",
        tools_portable = "//src/wasix/postgres-tools:portable_cargo",
        tools_aot = "//src/wasix/postgres-tools:linux_x64_gnu_cargo",
        additional_helpers = ["//src/wasix/postgres-tools:tools/package-assets.mts", "//src/wasix/runtime:tools/package-release-assets.mts"] + RUNTIME_NPM_NOTICES.keys(),
        **kwargs)

def wasix_contrib_server_crate_deps(names, package_name):
    """Bind the constructed server variant to one current Cargo dependency graph."""
    if package_name != "src/wasix/pgwire-server":
        fail("contrib server dependency override belongs only to its source test owner")
    dependencies = []
    for name in names:
        if name == "oliphaunt-wasix":
            dependencies.append("//src/wasix/sdks/rust:extension_carrier_lib")
        else:
            labels = {}
            for owner, facts in _CURRENT_CARGO.items():
                declaration = (facts["dependencies"] | facts["dev_dependencies"]).get(name)
                if declaration == None or (type(declaration) == "dict" and ("path" in declaration or declaration.get("optional", False))):
                    continue
                for label in _current_crate_deps([name], package_name = owner):
                    labels[str(label)] = label
            if len(labels) != 1:
                fail("contrib server requires one current Cargo identity for " + name + ": " + str(labels.keys()))
            dependencies += labels.values()
    return dependencies

def wasix_contrib_extension_shipping(name, carriers, qualification):
    """Expose canonical runtime-owned bundle Files through existing shipping rules."""
    spec = _metadata()
    owner = extension_identity(CONTRIB_MEMBERS[0]["sql-name"], family = "wasix")
    packages = []
    for index, row in enumerate(spec["carriers"]):
        package = name + "_" + row["ecosystem"] + "_shipping_" + str(index)
        native.filegroup(name = package + "_files", srcs = [carriers], output_group = "carrier_" + str(index))
        shipping_package(name = package, owner = owner, artifacts = [":" + package + "_files"], ecosystem = row["ecosystem"], package_name = row["name"], configuration = row["target"] or "portable", role = row["role"])
        packages.append(":" + package)
    for group in ["github", "manifest", "frozen"]:
        package = name + "_" + group + "_shipping"
        native.filegroup(name = package + "_files", srcs = [carriers], output_group = group)
        package_name = spec["product"] + "-" + spec["version"] + "-wasix-" + spec["target"] + "-bundle.tar.gz" if group == "github" else "contrib-wasix-" + group
        shipping_package(name = package, owner = owner, artifacts = [":" + package + "_files"], ecosystem = "github" if group == "github" else "internal", package_name = package_name,
                         configuration = spec["target"], role = "github-release-asset" if group == "github" else "extension-release-" + group + "-input")
        packages.append(":" + package)
    shipping_export(name = name + "_shipping_export", packages = packages, qualification = qualification, testonly = True)
