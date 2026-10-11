"""Declared portable/AOT extension inputs and canonical final envelopes."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_script_test", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/wasix:cargo.bzl", "RUNTIME_CARGO_HELPERS")
load("//build_defs/wasix:aot.bzl", "WasixAotInfo", "wasix_aot")
load("//build_defs/wasix:platform.bzl", "WASIX_PORTABLE_TRANSITION")
load("//build_defs/wasix:wasm.bzl", "WasmModuleInfo")
load("//build_defs/wasix:napi.bzl", "WasixNapiCarrierInfo")
load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load(":extensions.bzl", "extension_identity")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":native_carriers.bzl", "native_extension_carrier_helpers", "native_extension_carrier_legal", "native_external_carrier_metadata")

def wasix_sql_carrier_helpers():
    # Both public canonical writers import the shared extension/runtime contracts.
    return {label: True for label in native_extension_carrier_helpers() + RUNTIME_CARGO_HELPERS + ["//build_defs/wasix:package.mts", "//src/wasix/runtime:toolchain.toml"]}.keys()

def _metadata(sql_name):
    if sql_name != "pgtap":
        fail("only the qualified pgTAP SQL-only WASIX producer is admitted")
    metadata = native_external_carrier_metadata(sql_name, "wasix-portable")
    metadata.pop("runtimeVersion")
    metadata["carriers"] = [row for row in metadata["carriers"] if row["target"] == "wasix-portable"]
    return metadata

def _leaf(spec, ecosystem):
    rows = [row for row in spec["carriers"] if row["ecosystem"] == ecosystem and row["target"] == "wasix-portable" and row["role"] == "portable-leaf"]
    if len(rows) != 1:
        fail("SQL-only WASIX envelope requires exactly its canonical " + ecosystem + " portable leaf")
    return rows[0]

def _carriers_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    spec = _metadata(ctx.attr.sql_name)
    if owner.id != spec["product"] or owner.version != spec["version"]:
        fail("SQL-only WASIX member differs from its canonical release owner")
    sql = ctx.attr.sql[DefaultInfo].files.to_list()
    if len(sql) != 1 or not sql[0].is_directory:
        fail("SQL-only WASIX member requires exactly the production SQL TreeArtifact")
    github = ctx.actions.declare_file(spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst")
    npm = ctx.actions.declare_file(_leaf(spec, "npm")["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + ".tgz")
    cargo = ctx.actions.declare_file(_leaf(spec, "cargo")["name"] + "-" + spec["version"] + ".crate")
    manifest = ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")
    frozen = ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")
    spec.update({"sqlRoot": sql[0].path, "outputs": {"github": github.path, "npm": npm.path, "cargo": cargo.path, "manifest": manifest.path, "frozen": frozen.path}})
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    leaves = ctx.actions.args()
    leaves.add_all(sql, expand_directories = True)
    leaves.use_param_file("--sql-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path, leaves], inputs = sql + [inputs] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = [github, npm, cargo, manifest, frozen], mnemonic = "WasixSqlExtensionEnvelopes")
    return [DefaultInfo(files = depset([github, npm, cargo, manifest, frozen])),
            ExtensionFinalLeafInfo(product = spec["product"], owner = owner.id, version = owner.version, family = "wasix", target = "wasix-portable", metadata = spec, github = [github], npm = [npm], cargo = [cargo], manifest = manifest, frozen = frozen, spec = inputs, validation = None, receipt = None, origin = None),
            OutputGroupInfo(github = depset([github]), npm = depset([npm]), cargo = depset([cargo]), manifest = depset([manifest]), frozen = depset([frozen]), spec = depset([inputs]), sql = depset(sql))]

_wasix_sql_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"sql_name": attr.string(mandatory = True), "sql": attr.label(mandatory = True, cfg = "exec"),
             "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]), "legal": attr.label_list(allow_files = True),
             "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True)})

def wasix_sql_extension_carriers(sql_name, sql = ":sql"):
    spec = _metadata(sql_name)
    _wasix_sql_carriers(name = "wasix_carriers", sql_name = sql_name, sql = sql, owner = extension_identity(sql_name, family = "wasix"), legal = native_extension_carrier_legal(sql_name), exec_compatible_with = ["@platforms//os:linux"])
    packages = []
    for ecosystem in ["github", "npm", "cargo", "manifest", "frozen"]:
        name = "wasix_" + ecosystem + "_shipping"
        native.filegroup(name = name + "_files", srcs = [":wasix_carriers"], output_group = ecosystem)
        if ecosystem == "github":
            package_name, role = spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst", "github-release-asset"
        elif ecosystem in ["npm", "cargo"]:
            row = _leaf(spec, ecosystem)
            package_name, role = row["name"], row["role"]
        else:
            package_name, role = sql_name + "-wasix-" + ecosystem, "extension-release-" + ecosystem + "-input"
        shipping_package(name = name, owner = extension_identity(sql_name, family = "wasix"), artifacts = [":" + name + "_files"], ecosystem = ecosystem if ecosystem in ["github", "npm", "cargo"] else "internal", package_name = package_name, configuration = "wasix-portable", role = role)
        packages.append(":" + name)
    # This family's selected inputs do not advertise the complete external owner.
    shipping_export(name = "wasix_shipping_export", packages = packages)
    native.filegroup(name = "wasix_carrier_spec", srcs = [":wasix_carriers"], output_group = "spec")
    native.filegroup(name = "wasix_sql_input", srcs = [":wasix_carriers"], output_group = "sql")
    inputs = [":wasix_carrier_spec"] + [":wasix_" + group + "_shipping_files" for group in ["github", "npm", "cargo", "manifest", "frozen"]] + [":wasix_sql_input"]
    bun_script_test(name = "wasix_carriers_test", entry_point = "//build_defs/extensions:wasix_carriers.test.mts", args = ["$(location %s)" % label for label in inputs], data = inputs + ["//build_defs/extensions:wasix_carriers.mts"] + wasix_sql_carrier_helpers() + native_extension_carrier_legal(sql_name), target_compatible_with = ["@platforms//os:linux"], size = "small")

def _unit_inputs_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(_metadata("pgtap")))
    return [DefaultInfo(files = depset([output]))]

wasix_sql_carrier_unit_inputs = rule(implementation = _unit_inputs_impl)

WasixExtensionHostInfo = provider(fields = ["module", "manifest", "version"])

def _compiled_metadata(sql_name):
    spec = native_external_carrier_metadata(sql_name, "wasix-portable")
    spec.pop("runtimeVersion")
    spec["carriers"] = [row for row in spec["carriers"] if row["target"] == "wasix-portable" or (row["ecosystem"] == "cargo" and row["role"] == "aot-leaf") or (row["ecosystem"] == "npm" and "-wasix-" in row["name"])]
    return spec

def _compiled_carriers_impl(ctx):
    spec = _compiled_metadata(ctx.attr.sql_name)
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    if owner.id != spec["product"] or owner.version != spec["version"]:
        fail("compiled WASIX extension differs from its canonical release owner")
    modules = [ctx.attr.module[0][WasmModuleInfo].module] + [target[WasmModuleInfo].module for target in ctx.attr.support_modules]
    expected = [spec["descriptor"]["native-module-file"]] + [path.split("/")[-1] for path in spec["recipe"].get("artifacts", {}).get("native_dependency_modules", [])]
    if sorted([file.basename for file in modules]) != sorted(expected):
        fail("compiled WASIX module closure differs from its canonical recipe")
    host = ctx.attr.host[WasixExtensionHostInfo]
    if host.version != spec["compatibility"]["wasix_runtime_version"]:
        fail("compiled WASIX extension host differs from its conventional compatibility requirement")
    runtime = host.module
    portable = [host.manifest]
    module_rows = [{"name": ctx.attr.sql_name if file == modules[0] else file.basename[:-3], "path": file.path, "runtime_path": "lib/postgresql/" + file.basename} for file in modules]
    link_spec = ctx.actions.declare_file(ctx.label.name + ".link-inputs.json")
    link = ctx.actions.declare_file(ctx.label.name + ".link.json")
    ctx.actions.write(link_spec, json.encode({"sql_name": ctx.attr.sql_name, "runtime": runtime.path, "runtime_manifest": host.manifest.path, "modules": module_rows}))
    args = ctx.actions.args()
    args.add_all(["assets", "declared-extension-link", "--spec", link_spec, "--output", link])
    ctx.actions.run(executable = ctx.executable._analyzer, arguments = [args], inputs = modules + portable + [runtime, link_spec], outputs = [link], mnemonic = "WasixExtensionLinkContract")
    resources = []
    resource_files = ctx.files.resources
    for file in resource_files:
        if file.is_directory:
            resources.append({"source": file.path, "destination": "share/postgresql/extension", "tree": True})
        elif file.basename.endswith(".control") or file.basename.endswith(".sql"):
            resources.append({"source": file.path, "destination": "share/postgresql/extension/" + file.basename})
        else:
            fail("compiled WASIX SQL resource needs a canonical SQL/control destination")
    for target, destination in ctx.attr.data_resources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("compiled WASIX mapped data requires one declared file")
        resources.append({"source": files[0].path, "destination": destination})
        resource_files += files
    images = []
    image_files = []
    for target in ctx.attr.aot:
        image = target[WasixAotInfo]
        image_files += [image.image, image.module]
        matches = [row for row in module_rows if row["path"] == image.module.path]
        if len(matches) != 1:
            fail("WASIX AOT image is outside its member's exact portable closure")
        row = matches[0]
        images.append({"target": image.target, "image": image.image.path, "module": image.module.path, "name": "extension:" + ctx.attr.sql_name + (":" + row["name"] if row["name"] != ctx.attr.sql_name else "")})
    outputs = {"npm": [], "cargo": []}
    carrier_groups = {}
    for index, row in enumerate(spec["carriers"]):
        suffix = ".tgz" if row["ecosystem"] == "npm" else ".crate"
        filename = row["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + suffix
        file = ctx.actions.declare_file(ctx.label.name + "/" + row["ecosystem"] + "/" + filename)
        outputs[row["ecosystem"]].append(file)
        carrier_groups["carrier_" + str(index)] = depset([file])
    outputs["github"] = [ctx.actions.declare_file(ctx.label.name + "/release-assets/" + spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst")]
    outputs["manifest"] = [ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")]
    outputs["frozen"] = [ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")]
    output_files = [file for files in outputs.values() for file in files]
    spec.update({"operation": "compiled", "modules": module_rows, "resources": resources, "link": link.path, "aot": images, "toolchain": ctx.file.toolchain.path,
        "outputs": {name: files[0].dirname if name in ["github", "npm", "cargo"] else files[0].path for name, files in outputs.items()}})
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    leaves = ctx.actions.args()
    leaves.add_all([file for file in resource_files if file.is_directory], expand_directories = True)
    leaves.use_param_file("--resource-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path, leaves], inputs = modules + resource_files + image_files + [link, inputs, ctx.file.toolchain] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal, outputs = output_files, mnemonic = "WasixCompiledExtensionEnvelopes")
    return [DefaultInfo(files = depset(output_files)), ExtensionFinalLeafInfo(product = spec["product"], owner = owner.id, version = owner.version, family = "wasix", target = "wasix-portable", metadata = spec,
        github = outputs["github"], npm = outputs["npm"], cargo = outputs["cargo"], manifest = outputs["manifest"][0], frozen = outputs["frozen"][0], spec = inputs, validation = link, receipt = None, origin = None),
        OutputGroupInfo(**{name: depset(files) for name, files in outputs.items()} | carrier_groups | {"spec": depset([inputs]), "link": depset([link])})]

_wasix_compiled_carriers = rule(implementation = _compiled_carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"sql_name": attr.string(mandatory = True), "module": attr.label(mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "support_modules": attr.label_list(providers = [WasmModuleInfo], cfg = WASIX_PORTABLE_TRANSITION),
        "resources": attr.label_list(allow_files = True, cfg = WASIX_PORTABLE_TRANSITION), "data_resources": attr.label_keyed_string_dict(allow_files = True),
        "aot": attr.label_list(providers = [WasixAotInfo], mandatory = True), "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]), "legal": attr.label_list(allow_files = True),
        "host": attr.label(mandatory = True, providers = [WasixExtensionHostInfo]),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True), "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True),
        "_analyzer": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")})

def wasix_compiled_extension_carriers(name, sql_name, module, resources, host, support_modules = [], data_resources = {}):
    """Reuse the admitted portable module graph and canonical serializer for one owner."""
    aot = []
    for target_id in WASIX_AOT_TARGETS:
        for index, source in enumerate([module] + support_modules):
            image = name + "_aot_" + target_id.replace("-", "_") + "_" + str(index)
            wasix_aot(name = image, module = source, target_id = target_id, output_name = sql_name + "_" + str(index) + "-llvm-opta.bin.zst",
                exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"])
            aot.append(":" + image)
    _wasix_compiled_carriers(name = name, sql_name = sql_name, module = module, resources = resources, host = host, support_modules = support_modules, data_resources = data_resources,
        aot = aot, owner = extension_identity(sql_name, family = "wasix"), legal = native_extension_carrier_legal(sql_name), exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])

def wasix_compiled_extension_shipping(name, sql_name, carriers, qualification):
    """Expose this member's canonical WASIX leaves through existing owner rules."""
    spec = _compiled_metadata(sql_name)
    owner = extension_identity(sql_name, family = "wasix")
    packages = []
    for index, row in enumerate(spec["carriers"]):
        package = name + "_" + row["ecosystem"] + "_shipping_" + str(index)
        native.filegroup(name = package + "_files", srcs = [carriers], output_group = "carrier_" + str(index))
        shipping_package(name = package, owner = owner, artifacts = [":" + package + "_files"], ecosystem = row["ecosystem"], package_name = row["name"], configuration = row["target"], role = row["role"])
        packages.append(":" + package)
    for group in ["github", "manifest", "frozen"]:
        package = name + "_" + group + "_shipping"
        native.filegroup(name = package + "_files", srcs = [carriers], output_group = group)
        package_name = spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst" if group == "github" else sql_name + "-wasix-" + group
        shipping_package(name = package, owner = owner, artifacts = [":" + package + "_files"], ecosystem = "github" if group == "github" else "internal", package_name = package_name,
            configuration = "wasix-portable", role = "github-release-asset" if group == "github" else "extension-release-" + group + "-input")
        packages.append(":" + package)
    shipping_export(name = name + "_shipping_export", packages = packages, qualification = qualification, testonly = True)

def _host_impl(ctx):
    expected = native_external_carrier_metadata(ctx.attr.sql_name, "wasix-portable")["compatibility"]["wasix_runtime_version"]
    files = ctx.files.package
    rows = {}
    for name in ["Cargo.toml", "payload/manifest.json", "payload/oliphaunt.wasix.tar.zst"]:
        matches = [file for file in files if file.path.endswith("/" + name)]
        if len(matches) != 1:
            fail("declared WASIX host package requires exactly " + name)
        rows[name] = matches[0].path
    runtime = ctx.actions.declare_file(ctx.label.name + "/postgres.wasm")
    manifest = ctx.actions.declare_file(ctx.label.name + "/manifest.json")
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"operation": "host", "version": expected, "files": rows, "module": runtime.path, "manifest": manifest.path}))
    bun_file_action(ctx, ctx.file._tool, arguments = [spec.path], inputs = files + [spec], source_files = [ctx.file._tool] + ctx.files._helpers, outputs = [runtime, manifest], mnemonic = "DeclaredWasixExtensionHost")
    return [DefaultInfo(files = depset([runtime, manifest])), WasixExtensionHostInfo(module = runtime, manifest = manifest, version = expected)]

_wasix_extension_host = rule(implementation = _host_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "sql_name": attr.string(mandatory = True), "package": attr.label(mandatory = True),
    "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True), "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True)})

def wasix_extension_declared_host(name, sql_name):
    version = native_external_carrier_metadata(sql_name, "wasix-portable")["compatibility"]["wasix_runtime_version"]
    _wasix_extension_host(name = name, sql_name = sql_name, package = "@wasix_release_crates__liboliphaunt-wasix-portable-" + version + "//:payload_files")

def _compiled_installed_impl(ctx):
    leaf = ctx.attr.leaf[ExtensionFinalLeafInfo]
    module = ctx.attr.module[0][WasmModuleInfo].module
    addon = ctx.attr.addon[WasixNapiCarrierInfo].npm
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node
    files = leaf.github + leaf.npm + leaf.cargo + [leaf.manifest, leaf.frozen, leaf.spec, leaf.validation, module, addon, node, ctx.file._runner, ctx.file._consumer] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [leaf.spec, leaf.github[0], leaf.npm[0], leaf.cargo[0], leaf.frozen, module, addon, node, ctx.file._consumer, leaf.validation], files, source_files = [ctx.file._runner, ctx.file._consumer] + ctx.files._helpers)

_compiled_installed_test = rule(implementation = _compiled_installed_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS + ["@rules_nodejs//nodejs:toolchain_type"], attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
    "leaf": attr.label(mandatory = True, providers = [ExtensionFinalLeafInfo]), "module": attr.label(mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
    "addon": attr.label(default = "//src/wasix/node-addon:release_carriers", providers = [WasixNapiCarrierInfo]),
    "_runner": attr.label(default = "//build_defs/extensions/wasix:compiled_carriers.test.mts", allow_single_file = True),
    "_consumer": attr.label(default = "//build_defs/extensions/wasix:installed_consumer.mts", allow_single_file = True),
    "_helpers": attr.label_list(default = wasix_sql_carrier_helpers() + ["//src/wasix/sdks/ts:tools/pgwire-client.mts"], allow_files = True),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")}))

def wasix_compiled_extension_installed_test(name, **kwargs):
    _compiled_installed_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
