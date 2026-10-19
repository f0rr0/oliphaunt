"""Declared portable/AOT extension inputs and canonical final envelopes."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_script_test", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "file_shipping_supplier", "merge_shipping_suppliers")
load("//build_defs/wasix:cargo.bzl", "RUNTIME_CARGO_HELPERS")
load("//build_defs/wasix:aot.bzl", "WasixAotInfo", "wasix_aot")
load("//build_defs/wasix:platform.bzl", "WASIX_PORTABLE_TRANSITION")
load("//build_defs/wasix:wasm.bzl", "WasmModuleInfo")
load("//build_defs/wasix:napi.bzl", "WasixNapiCarrierInfo")
load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS", "PREPARED_NATIVE_INPUTS", "PREPARED_NATIVE_SELECTED_PRODUCTS", "PRODUCTS", "PUBLICATION_CARRIERS", "WASIX_ARTIFACTS", "WASIX_EXTENSIONS")
load(":extensions.bzl", "extension_identity")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":native_carriers.bzl", "native_extension_carrier_helpers", "native_extension_carrier_legal", "native_external_carrier_metadata")

def wasix_sql_carrier_helpers():
    # Both public canonical writers import the shared extension/runtime contracts.
    return {label: True for label in native_extension_carrier_helpers() + RUNTIME_CARGO_HELPERS + ["//build_defs/wasix:package.mts", "//src/wasix/runtime:toolchain.toml", "//tools/release:cargo-payload-part-contract.mts", "//tools/release:publication-catalog.mts"]}.keys()

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
    wasix_extension_declared_host(name = "wasix_declared_host", sql_name = sql_name)
    wasix_compiled_extension_installed_test(name = "wasix_installed_test", sql_name = sql_name, leaf = ":wasix_carriers", host = ":wasix_declared_host",
        target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"], size = "large", timeout = "long", tags = ["manual", "installed-consumer"])
    # This family's selected inputs do not advertise the complete external owner.
    shipping_export(name = "wasix_shipping_export", packages = packages,
        qualification = [":wasix_installed_test", ":wasix_carriers_test", ":upstream_sql_parity_test"], testonly = True)
    native.filegroup(name = "wasix_carrier_spec", srcs = [":wasix_carriers"], output_group = "spec")
    native.filegroup(name = "wasix_sql_input", srcs = [":wasix_carriers"], output_group = "sql")
    inputs = [":wasix_carrier_spec"] + [":wasix_" + group + "_shipping_files" for group in ["github", "npm", "cargo", "manifest", "frozen"]] + [":wasix_sql_input"]
    bun_script_test(name = "wasix_carriers_test", entry_point = "//build_defs/extensions:wasix_carriers.test.mts", args = ["$(location %s)" % label for label in inputs], data = inputs + ["//build_defs/extensions:wasix_carriers.mts"] + wasix_sql_carrier_helpers() + native_extension_carrier_legal(sql_name), target_compatible_with = ["@platforms//os:linux"], size = "small")

def _unit_inputs_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(_metadata("pgtap")))
    return [DefaultInfo(files = depset([output]))]

wasix_sql_carrier_unit_inputs = rule(implementation = _unit_inputs_impl)

WasixExtensionHostInfo = provider(fields = ["module", "manifest", "version", "candidate"])

def _compiled_metadata(sql_name):
    spec = native_external_carrier_metadata(sql_name, "wasix-portable")
    spec.pop("runtimeVersion")
    spec["descriptor"] = dict(spec["descriptor"], **WASIX_EXTENSIONS[sql_name])
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
    support = {row["runtime-path"]: row["name"] for row in spec["descriptor"]["native-support-modules"]}
    if sorted(support.keys()) != sorted(spec["recipe"].get("artifacts", {}).get("native_dependency_modules", [])):
        fail("compiled WASIX support closure differs from its canonical target definition")
    module_rows = [{"name": ctx.attr.sql_name if file == modules[0] else support["lib/postgresql/" + file.basename], "path": file.path, "runtime_path": "lib/postgresql/" + file.basename} for file in modules]
    link_spec = ctx.actions.declare_file(ctx.label.name + ".link-inputs.json")
    link = ctx.actions.declare_file(ctx.label.name + ".link.json")
    link_inputs = {"sql_name": ctx.attr.sql_name, "runtime": runtime.path, "runtime_manifest": host.manifest.path, "modules": module_rows}
    link_files = modules + portable + [runtime, link_spec]
    link_outputs = [link]
    selected_host = host
    if getattr(host, "candidate", None):
        selected_runtime = ctx.actions.declare_file(ctx.label.name + "/selected-host/postgres.wasm")
        selected_manifest = ctx.actions.declare_file(ctx.label.name + "/selected-host/manifest.json")
        candidate = host.candidate
        link_inputs["candidate"] = {"runtime": candidate.module.path, "runtime_manifest": candidate.manifest.path,
                                    "selected_runtime": selected_runtime.path, "selected_runtime_manifest": selected_manifest.path}
        link_files += [candidate.module, candidate.manifest]
        link_outputs += [selected_runtime, selected_manifest]
        selected_host = WasixExtensionHostInfo(module = selected_runtime, manifest = selected_manifest, version = host.version)
    ctx.actions.write(link_spec, json.encode(link_inputs))
    args = ctx.actions.args()
    args.add_all(["assets", "declared-extension-link", "--spec", link_spec, "--output", link])
    ctx.actions.run(executable = ctx.executable._analyzer, arguments = [args], inputs = link_files, outputs = link_outputs, mnemonic = "WasixExtensionLinkContract")
    resources = []
    resource_files = list(ctx.files.resources)
    for file in resource_files:
        if file.is_directory:
            resources.append({"source": file.path, "destination": "share/postgresql/extension", "tree": True})
        elif file.basename.endswith(".control") or file.basename.endswith(".sql"):
            resources.append({"source": file.path, "destination": "share/postgresql/extension/" + file.basename})
        else:
            fail("compiled WASIX SQL resource needs a canonical SQL/control destination")
    if ctx.file.main_sql:
        resources.append({"source": ctx.file.main_sql.path, "destination": "share/postgresql/extension/" + ctx.attr.sql_name + "--" + spec["source"]["extension-control"]["default-version"] + ".sql"})
        resource_files = resource_files + [ctx.file.main_sql]
    for target, destination in ctx.attr.data_resources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("compiled WASIX mapped data requires one declared file or directory")
        resources.append({"source": files[0].path, "destination": destination, "tree": files[0].is_directory})
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
    cargo_parts = {}
    carrier_groups = {}
    for index, row in enumerate(spec["carriers"]):
        suffix = ".tgz" if row["ecosystem"] == "npm" else ".crate"
        filename = row["name"].replace("@", "").replace("/", "-") + "-" + spec["version"] + suffix
        file = ctx.actions.declare_file(ctx.label.name + "/" + row["ecosystem"] + "/" + filename)
        outputs[row["ecosystem"]].append(file)
        group = [file]
        if row["ecosystem"] == "cargo":
            parts = ctx.actions.declare_directory(ctx.label.name + "/cargo-parts/" + row["name"])
            cargo_parts[row["name"]] = parts
            group.append(parts)
        carrier_groups["carrier_" + str(index)] = depset(group)
    outputs["github"] = [ctx.actions.declare_file(ctx.label.name + "/release-assets/" + spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst")]
    outputs["manifest"] = [ctx.actions.declare_file(ctx.label.name + "/" + spec["product"] + "-" + spec["version"] + "-manifest.json")]
    outputs["frozen"] = [ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")]
    output_files = [file for files in outputs.values() for file in files] + cargo_parts.values()
    spec.update({"operation": "compiled", "modules": module_rows, "resources": resources, "link": link.path, "aot": images, "toolchain": ctx.file.toolchain.path,
        "outputs": {name: files[0].dirname if name in ["github", "npm", "cargo"] else files[0].path for name, files in outputs.items()}})
    if cargo_parts:
        spec["outputs"]["cargoParts"] = {name: file.path for name, file in cargo_parts.items()}
    inputs = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(inputs, json.encode(spec))
    leaves = ctx.actions.args()
    leaves.add_all([file for file in resource_files if file.is_directory], expand_directories = True)
    leaves.use_param_file("--resource-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._tool, arguments = [inputs.path, leaves], inputs = modules + resource_files + image_files + [link, inputs, ctx.file.toolchain] + ctx.files.legal,
                    source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal, outputs = output_files, mnemonic = "WasixCompiledExtensionEnvelopes")
    supplier = ctx.attr.host[ShippingSupplierInfo] if ShippingSupplierInfo in ctx.attr.host else ShippingSupplierInfo(suppliers = None, files = depset([host.module, host.manifest]))
    return [DefaultInfo(files = depset(output_files)), supplier, selected_host, ExtensionFinalLeafInfo(product = spec["product"], owner = owner.id, version = owner.version, family = "wasix", target = "wasix-portable", metadata = spec,
        github = outputs["github"], npm = outputs["npm"], cargo = outputs["cargo"] + cargo_parts.values(), manifest = outputs["manifest"][0], frozen = outputs["frozen"][0], spec = inputs, validation = link, receipt = None, origin = None),
        OutputGroupInfo(**{name: depset(files + (cargo_parts.values() if name == "cargo" else [])) for name, files in outputs.items()} | carrier_groups | {"spec": depset([inputs]), "link": depset([link])})]

_wasix_compiled_carriers = rule(implementation = _compiled_carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"sql_name": attr.string(mandatory = True), "module": attr.label(mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "support_modules": attr.label_list(providers = [WasmModuleInfo], cfg = WASIX_PORTABLE_TRANSITION),
        "resources": attr.label_list(allow_files = True, cfg = WASIX_PORTABLE_TRANSITION), "main_sql": attr.label(allow_single_file = True, cfg = WASIX_PORTABLE_TRANSITION), "data_resources": attr.label_keyed_string_dict(allow_files = True, cfg = WASIX_PORTABLE_TRANSITION),
        "aot": attr.label_list(providers = [WasixAotInfo], mandatory = True), "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]), "legal": attr.label_list(allow_files = True),
        "host": attr.label(mandatory = True, providers = [WasixExtensionHostInfo]),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True), "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True),
        "_analyzer": attr.label(default = "//src/wasix/runtime/tools/xtask:xtask", executable = True, cfg = "exec"),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")})

def wasix_compiled_extension_carriers(name, sql_name, module, resources, host, support_modules = [], data_resources = {}, main_sql = None):
    """Reuse the admitted portable module graph and canonical serializer for one owner."""
    aot = []
    for target_id in WASIX_AOT_TARGETS:
        for index, source in enumerate([module] + support_modules):
            image = name + "_aot_" + target_id.replace("-", "_") + "_" + str(index)
            wasix_aot(name = image, module = source, target_id = target_id, output_name = sql_name + "_" + str(index) + "-llvm-opta.bin.zst",
                exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"])
            aot.append(":" + image)
    _wasix_compiled_carriers(name = name, sql_name = sql_name, module = module, resources = resources, main_sql = main_sql, host = host, support_modules = support_modules, data_resources = data_resources,
        aot = aot, owner = extension_identity(sql_name, family = "wasix"), legal = native_extension_carrier_legal(sql_name), exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])

def wasix_compiled_extension_shipping(name, sql_name, carriers, qualification):
    """Expose this member's canonical WASIX leaves through existing owner rules."""
    spec = _compiled_metadata(sql_name)
    owner = extension_identity(sql_name, family = "wasix")
    packages = []
    for index, row in enumerate(spec["carriers"]):
        package = name + "_" + row["ecosystem"] + "_shipping_" + str(index)
        native.filegroup(name = package + "_files", srcs = [carriers], output_group = "carrier_" + str(index))
        shipping_package(name = package, owner = owner, artifacts = [":" + package + "_files"], ecosystem = row["ecosystem"], package_name = row["name"], configuration = row["target"], role = row["role"], suppliers = carriers)
        packages.append(":" + package)
    for group in ["github", "manifest", "frozen", "link"]:
        package = name + "_" + group + "_shipping"
        native.filegroup(name = package + "_files", srcs = [carriers], output_group = group)
        package_name = spec["product"] + "-" + spec["version"] + "-wasix-portable.tar.zst" if group == "github" else sql_name + "-wasix-" + group
        if group == "link":
            package_name = sql_name + "-wasix-" + ("final" if PREPARED_NATIVE_INPUTS else "pre-version") + "-link"
        shipping_package(name = package, owner = owner, artifacts = [":" + package + "_files"], ecosystem = "github" if group == "github" else "internal", package_name = package_name,
            configuration = "wasix-portable", role = "github-release-asset" if group == "github" else "extension-release-" + group + "-input", suppliers = carriers)
        packages.append(":" + package)
    shipping_export(name = name + "_shipping_export", packages = packages, qualification = qualification, testonly = True)

def _host_impl(ctx):
    expected = native_external_carrier_metadata(ctx.attr.sql_name, "wasix-portable")["compatibility"]["wasix_runtime_version"]
    archive = ctx.file.archive
    if not archive or not ctx.attr.origin:
        fail("WASIX host qualification requires its retained completed portable Cargo archive input")
    runtime = ctx.actions.declare_file(ctx.label.name + "/postgres.wasm")
    manifest = ctx.actions.declare_file(ctx.label.name + "/manifest.json")
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"operation": "host", "version": expected, "archive": archive.path, "module": runtime.path, "manifest": manifest.path}))
    bun_file_action(ctx, ctx.file._tool, arguments = [spec.path], inputs = [archive, spec], source_files = [ctx.file._tool] + ctx.files._helpers, outputs = [runtime, manifest], mnemonic = "DeclaredWasixExtensionHost")
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == "liboliphaunt-wasix" and row["ecosystem"] == "cargo" and row["name"] == "liboliphaunt-wasix-portable"]
    if len(carriers) != 1:
        fail("declared WASIX host requires its unique canonical portable Cargo carrier")
    carrier = carriers[0]
    origin = json.decode(ctx.attr.origin)
    publication = origin["publication"]
    if origin["kind"] != "completed-publication" or origin["artifact"] != "cargo:" + carrier["name"] or publication["product"] != carrier["product"] or publication["version"] != expected:
        fail("declared WASIX ABI supplier differs from its conventional host requirement")
    # The extractor validates the core from this original completed archive;
    # its derived Files never become a substitute supplier origin.
    supplier = ShippingSupplierInfo(suppliers = [{"product": carrier["product"], "version": expected, "configuration": carrier["target"] or "portable", "binding": "abi-contract",
                      "origin": origin, "files": [{"path": archive.path}]}], files = depset([archive]))
    candidate = None
    if ctx.attr.candidate:
        candidate = ctx.attr.candidate[WasixExtensionHostInfo]
        if candidate.version != expected:
            fail("source WASIX candidate differs from its declared host version")
        supplier = merge_shipping_suppliers([supplier, ctx.attr.candidate[ShippingSupplierInfo]])
    return [DefaultInfo(files = depset([runtime, manifest])), supplier, WasixExtensionHostInfo(module = runtime, manifest = manifest, version = expected, candidate = candidate)]

_wasix_extension_host = rule(implementation = _host_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "sql_name": attr.string(mandatory = True), "archive": attr.label(allow_single_file = True), "origin": attr.string(),
    "candidate": attr.label(providers = [WasixExtensionHostInfo, ShippingSupplierInfo]),
    "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True), "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True)})

def wasix_extension_uses_current_host(required_version, current_version, selected_products):
    return "liboliphaunt-wasix" in selected_products and required_version == current_version

def wasix_extension_source_candidate(required_version, current_version, prepared):
    return not prepared and required_version == current_version

def wasix_extension_declared_host(name, sql_name):
    version = native_external_carrier_metadata(sql_name, "wasix-portable")["compatibility"]["wasix_runtime_version"]
    current_version = PRODUCTS["liboliphaunt-wasix"]["version"]
    if PREPARED_NATIVE_INPUTS and wasix_extension_uses_current_host(version, current_version, PREPARED_NATIVE_SELECTED_PRODUCTS):
        wasix_extension_current_host(name = name)
    else:
        candidate = None
        if wasix_extension_source_candidate(version, current_version, PREPARED_NATIVE_INPUTS):
            wasix_extension_current_host(name = name + "_current_candidate")
            candidate = ":" + name + "_current_candidate"
        original = COMPLETED_SUPPLIER_ARTIFACTS.get("liboliphaunt-wasix/" + version + "/cargo:liboliphaunt-wasix-portable")
        _wasix_extension_host(name = name, sql_name = sql_name, archive = original["file"]["path"] if original else None,
            origin = json.encode({"kind": "completed-publication", "publication": original["publication"], "artifact": original["artifact"]}) if original else "", candidate = candidate)

def _current_host_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    if owner.id != "liboliphaunt-wasix":
        fail("current WASIX extension host requires its canonical runtime owner")
    archive = ctx.file.archive
    if archive.is_source or archive.is_directory or archive.owner != ctx.attr.archive.label:
        fail("current WASIX extension host requires the original source-built runtime archive File")
    runtime = ctx.actions.declare_file(ctx.label.name + "/postgres.wasm")
    manifest = ctx.actions.declare_file(ctx.label.name + "/manifest.json")
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"operation": "current-host", "archive": archive.path, "module": runtime.path, "manifest": manifest.path}))
    bun_file_action(ctx, ctx.file._tool, arguments = [spec.path], inputs = [archive, spec], source_files = [ctx.file._tool] + ctx.files._helpers, outputs = [runtime, manifest], mnemonic = "CurrentWasixExtensionHost")
    supplier = ShippingSupplierInfo(suppliers = [{"product": owner.id, "version": owner.version, "configuration": "wasix-portable", "binding": "abi-contract",
        "origin": {"kind": "current-source"}, "files": [{"path": archive.path}]}], files = depset([archive]))
    return [DefaultInfo(files = depset([runtime, manifest])), supplier, WasixExtensionHostInfo(module = runtime, manifest = manifest, version = owner.version)]

wasix_extension_current_host = rule(implementation = _current_host_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "archive": attr.label(default = "//src/wasix/runtime:release_archive_portable", allow_single_file = True),
    "owner": attr.label(default = "@oliphaunt_metadata//:product_liboliphaunt-wasix", providers = [ReleaseIdentityInfo]),
    "_tool": attr.label(default = "//build_defs/extensions:wasix_carriers.mts", allow_single_file = True), "_helpers": attr.label_list(default = wasix_sql_carrier_helpers(), allow_files = True)})

def _compiled_installed_impl(ctx):
    leaf = ctx.attr.leaf[ExtensionFinalLeafInfo]
    module = ctx.attr.module[0][WasmModuleInfo].module if ctx.attr.module else None
    if module == None and leaf.metadata["descriptor"].get("native-module-file"):
        fail("compiled WASIX installed test requires its actual declared module")
    if module != None and leaf.validation == None:
        fail("compiled WASIX installed test requires its actual strict link contract")
    host_target = ctx.attr.leaf if WasixExtensionHostInfo in ctx.attr.leaf else ctx.attr.host
    if not host_target or WasixExtensionHostInfo not in host_target:
        fail("installed WASIX extension requires its exact selected host Files")
    host = host_target[WasixExtensionHostInfo]
    if ctx.attr.host and ctx.attr.host[WasixExtensionHostInfo].version != host.version:
        fail("explicit WASIX host differs from the leaf's selected host identity")
    if host.version != leaf.metadata["compatibility"]["wasix_runtime_version"]:
        fail("installed WASIX host differs from its owner's conventional requirement")
    if not ctx.attr.addon:
        fail("installed WASIX extension requires unambiguous original addon/facade Files for its declared host " + host.version)
    napi = json.decode(ctx.attr.napi_contract)
    if WasixNapiCarrierInfo in ctx.attr.addon:
        carrier = ctx.attr.addon[WasixNapiCarrierInfo]
        if carrier.target != napi["target"]["target"]:
            fail("installed WASIX addon target differs from its canonical carrier")
        addon = carrier.npm
        napi["constructionContract"] = carrier.construction_contract
    else:
        originals = ctx.attr.addon[DefaultInfo].files.to_list()
        if len(originals) != 1 or originals[0].is_directory:
            fail("installed held WASIX addon requires one original npm archive File")
        addon = originals[0]
    current_addon = None
    if ctx.attr.current_addon:
        current_carrier = ctx.attr.current_addon[WasixNapiCarrierInfo]
        if current_carrier.target != napi["target"]["target"]:
            fail("current WASIX addon target differs from its canonical carrier")
        current_addon = current_carrier.npm
        napi["currentConstructionContract"] = current_carrier.construction_contract
    napi_input = ctx.actions.declare_file(ctx.label.name + ".napi.json")
    ctx.actions.write(napi_input, json.encode(napi))
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node
    fixtures = [file for file in ctx.files._fixtures if file.basename == leaf.metadata["sqlName"] + ".sql"]
    if len(fixtures) != 1:
        fail("compiled WASIX installed test requires its canonical source-owned SQL fixture")
    files = leaf.github + leaf.npm + leaf.cargo + [leaf.manifest, leaf.frozen, leaf.spec, addon, node, ctx.file._runner, ctx.file._consumer, host.module, host.manifest, napi_input, ctx.file.addon_template] + ([current_addon] if current_addon else []) + ([ctx.file.addon_facade] if ctx.file.addon_facade else []) + ([module, leaf.validation] if module else []) + fixtures + ctx.files._helpers
    parts = [file for file in leaf.cargo if file.is_directory]
    return bun_test_entrypoint(ctx, ctx.file._runner, [leaf.spec, leaf.github[0], leaf.npm[0], leaf.cargo[0], leaf.frozen, module or "-", addon, node, ctx.file._consumer, leaf.validation or "-", fixtures[0], host.module, host.manifest, napi_input, ctx.file.addon_facade or "-", ctx.file.addon_template, current_addon or "-"] + parts, files, source_files = [ctx.file._runner, ctx.file._consumer] + ctx.files._helpers)

_compiled_installed_test = rule(implementation = _compiled_installed_impl, test = True, toolchains = BUN_SOURCE_TOOLCHAINS + ["@rules_nodejs//nodejs:toolchain_type"], attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
    "leaf": attr.label(mandatory = True, providers = [ExtensionFinalLeafInfo]), "module": attr.label(cfg = WASIX_PORTABLE_TRANSITION),
    "host": attr.label(providers = [WasixExtensionHostInfo]),
    "addon": attr.label(providers = [[WasixNapiCarrierInfo], [ShippingSupplierInfo]]),
    "addon_facade": attr.label(allow_single_file = True), "addon_template": attr.label(allow_single_file = True, mandatory = True),
    "current_addon": attr.label(providers = [WasixNapiCarrierInfo]),
    "napi_contract": attr.string(mandatory = True),
    "_runner": attr.label(default = "//build_defs/extensions/wasix:compiled_carriers.test.mts", allow_single_file = True),
    "_consumer": attr.label(default = "//build_defs/extensions/wasix:installed_consumer.mts", allow_single_file = True),
    "_fixtures": attr.label_list(default = ["//src/test-fixtures/extensions:sql"], allow_files = True),
    "_helpers": attr.label_list(default = wasix_sql_carrier_helpers() + ["//src/wasix/sdks/ts:tools/pgwire-client.mts", "//src/wasix/node-addon:tools/carrier-contract.mts", "//build_defs/extensions:wasix_carriers.mts"], allow_files = True),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")}))

def wasix_compiled_extension_installed_test(name, sql_name, **kwargs):
    target_rows = [row for row in WASIX_ARTIFACTS if row["product"] == "oliphaunt-wasix-napi" and row["kind"] == "wasix-napi-addon" and row["target"] == "linux-x64-gnu"]
    if len(target_rows) != 1:
        fail("installed WASIX extension requires its canonical GNU x64 addon target")
    target = target_rows[0]
    requirement = native_external_carrier_metadata(sql_name, "wasix-portable")["compatibility"]["wasix_runtime_version"]
    current = PREPARED_NATIVE_INPUTS and wasix_extension_uses_current_host(requirement, PRODUCTS["liboliphaunt-wasix"]["version"], PREPARED_NATIVE_SELECTED_PRODUCTS)
    candidate = kwargs.get("module") and wasix_extension_source_candidate(requirement, PRODUCTS["liboliphaunt-wasix"]["version"], PREPARED_NATIVE_INPUTS)
    napi = {"current": current, "version": PRODUCTS["oliphaunt-wasix-napi"]["version"], "target": target}
    if candidate:
        napi["currentVersion"] = PRODUCTS["oliphaunt-wasix-napi"]["version"]
    addon = "//src/wasix/node-addon:release_carriers" if current else None
    facade = None
    if not current:
        sdk_carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == "oliphaunt-wasix-ts" and row["ecosystem"] == "npm"]
        if len(sdk_carriers) != 1:
            fail("held WASIX addon requires its canonical TypeScript facade")
        originals = [row for row in COMPLETED_SUPPLIER_ARTIFACTS.values() if row["publication"]["product"] == "oliphaunt-wasix-napi" and row["artifact"] == "npm:" + target["npm_package"]]
        facades = [row for row in COMPLETED_SUPPLIER_ARTIFACTS.values() if row["publication"]["product"] == "oliphaunt-wasix-ts" and row["artifact"] == "npm:" + sdk_carriers[0]["name"]]
        if len(originals) == 1 and len(facades) == 1:
            original = originals[0]
            file_shipping_supplier(name = name + "_held_addon", inputs = {original["file"]["path"]: ""},
                owner = "@oliphaunt_metadata//:product_oliphaunt-wasix-napi", configuration = target["target"], binding = "abi-contract",
                origin = json.encode({"kind": "completed-publication", "publication": original["publication"], "artifact": original["artifact"]}))
            addon = ":" + name + "_held_addon"
            facade = facades[0]["file"]["path"]
            napi.update({"version": original["publication"]["version"], "original": original, "facade": facades[0]})
    directory = target["npm_os"] + "-" + target["npm_cpu"] + "-gnu"
    _compiled_installed_test(name = name, args = bun_test_entrypoint_args(name), addon = addon, addon_facade = facade,
        addon_template = "//src/wasix/node-addon:packages/" + directory + "/package.json", napi_contract = json.encode(napi),
        current_addon = "//src/wasix/node-addon:release_carriers" if candidate else None, **kwargs)

def wasix_compiled_extension_qualification(name, sql_name, module):
    wasix_compiled_extension_installed_test(name = name + "_installed_test", sql_name = sql_name, leaf = ":" + name, module = module,
        target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"], size = "large", timeout = "long", tags = ["manual", "installed-consumer"])
    wasix_compiled_extension_shipping(name = name, sql_name = sql_name, carriers = ":" + name, qualification = [
        ":" + name + "_installed_test", ":link_inputs_test", ":invalid_link_profile_test", ":unhandled_linkopts_test",
        ":resource_inputs_test", ":cargo_parts_test", "//src/wasix/runtime/tools/xtask:export_policy_test",
    ])
