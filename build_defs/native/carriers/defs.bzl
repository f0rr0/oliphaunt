"""Desktop runtime/tools envelopes from typed native construction mappings."""

load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_RUNTIME_ARTIFACTS", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_pkg//pkg:providers.bzl", "PackageFilesInfo", "PackageFilegroupInfo")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")
load("//build_defs/host:desktop-profile.bzl", "desktop_profile")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")

_CONFIGURATIONS = {
    "linux-x64-gnu": "//build_defs/native:linux_x86_64",
    "linux-arm64-gnu": "//build_defs/native:linux_aarch64_gnu_2_28",
    "macos-arm64": "//build_defs/native:macos_arm64",
    "windows-x64-msvc": "//build_defs/native:windows_x64",
}

def native_carrier_legal_inputs(profile = "native-runtime"):
    # Keep this declared source map aligned with releaseNoticeRows(profile),
    # including the source.toml pins validated by that existing renderer.
    if profile not in ["native-runtime", "native-tools"]:
        fail("unsupported native carrier legal profile: " + profile)
    result = {"//:" + name: name for name in [
        "LICENSE", "THIRD_PARTY_NOTICES.md",
    ]}
    result["//src/native/runtime:THIRD_PARTY_NOTICES.md"] = "src/native/runtime/THIRD_PARTY_NOTICES.md"
    components = [("postgres", ["COPYRIGHT", "source.toml"])]
    if profile == "native-runtime":
        components.append(("icu", ["LICENSE", "source.toml"]))
    for package, names in components:
        for name in names:
            result["//src/third-party/" + package + ":" + name] = "src/third-party/" + package + "/" + name
    return result

def native_carrier_helpers():
    return [
        "//:tools/packaging/archive-directory.mts", "//:tools/packaging/cargo-source-package.mts", "//:tools/packaging/cargo-manifest.mts",
        "//:tools/packaging/native-cargo-payload.mts", "//:tools/packaging/npm-package.mts",
        "//:tools/packaging/npm-trusted-publishing.mts", "//:tools/packaging/package-archive.mts",
        "//:tools/packaging/platform-binary-contract.mts", "//:tools/packaging/portable-archive.mts",
        "//:tools/packaging/release-carrier.mts", "//:tools/packaging/release-directory-safety.mts",
        "//:tools/packaging/sdk-runtime-payload.mts",
        "//:tools/packaging/release-notices.mts", "//:tools/packaging/rust-native-targets.mts",
        "//:tools/packaging/rust-dependency-license-contract.mts",
        "//:tools/packaging/windows-vc-runtime-closure.mts", "//:tools/packaging/windows-vc-runtime-policy.json",
        "//tools/release:release-artifact-targets.mts", "//tools/release:release-graph.mts",
        "//tools/release:release-history.mts", "//tools/release:compatibility-version-parser.mts",
        "//tools/release:extension-release-metadata.mts", "//tools/release:platform-compatibility-policy.mts",
        "//:src/extensions/artifacts/packages/tools/contrib-carriers.mts",
        "//:src/extensions/artifacts/packages/tools/extension-registry-packages.mts",
        "//src/extensions/contracts:extension-target-profiles.mts",
        "//src/database-resources:seeds/carrier-identities.mts",
        "//src/native/mobile-bindings:tools/dependency-license-contract.mts",
        "//src/wasix/runtime:tools/wasix-cargo-artifact-contract.mts",
        "//src/wasix/runtime:tools/wasix-runtime-npm-contract.mts",
        "//src/native/runtime:tools/native-runtime-payload.mts",
        "//src/native/runtime:tools/native-runtime-payload-policy.json",
    ]

def native_payload_helpers():
    """The payload renderer's module closure and eagerly read policy files.

    Envelope/registry rendering is a later action with its own inputs. Keep
    those modules out of the payload tool so they cannot invalidate its output.
    Legal source bytes are supplied separately by the payload rule.
    """
    return [
        "//src/native/runtime:tools/native-runtime-payload.mts",
        "//src/native/runtime:tools/native-runtime-payload-policy.json",
        "//:tools/packaging/platform-binary-contract.mts",
        "//tools/release:platform-compatibility-policy.mts",
        "//:tools/packaging/release-notices.mts",
        "//:tools/packaging/portable-archive.mts",
        "//:tools/packaging/release-directory-safety.mts",
        "//:tools/packaging/windows-vc-runtime-closure.mts",
        "//:tools/packaging/windows-vc-runtime-policy.json",
    ]

def _sources(entries, inputs):
    result = {}
    for target, destination in entries.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("carrier source must be exactly one declared File: " + str(target.label))
        if destination in result:
            fail("duplicate carrier source destination " + destination)
        result[destination] = files[0].path
        inputs.append(files[0])
    return result

def _mapping_rows(targets, prefix, inputs):
    rows = []
    for target in targets:
        if PackageFilesInfo in target:
            mappings = [target[PackageFilesInfo]]
        elif PackageFilegroupInfo in target:
            group = target[PackageFilegroupInfo]
            if group.pkg_dirs or group.pkg_symlinks:
                fail("native public payload does not support authored directories or symlinks")
            mappings = [provider for provider, _origin in group.pkg_files]
        else:
            fail("native payload requires typed rules_pkg mappings: " + str(target.label))
        for mapping in mappings:
            for destination, source in mapping.dest_src_map.items():
                # These two upstream build recipes are not installed timezone data.
                if destination.endswith("timezonesets/Makefile") or destination.endswith("timezonesets/meson.build"):
                    continue
                rows.append({"source": source.path, "destination": prefix + destination, "tree": source.is_directory, "mode": mapping.attributes.get("mode", "0644")})
                inputs.append(source)
    return rows

def _stripped_impl(ctx):
    original = ctx.attr.mapping[PackageFilesInfo]
    result = {}
    if ctx.attr.enabled:
        cc = find_cc_toolchain(ctx)
        configuration = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
        strip = cc_common.get_tool_for_action(feature_configuration = configuration, action_name = ACTION_NAMES.strip)
    for index, (destination, source) in enumerate(original.dest_src_map.items()):
        if ctx.attr.enabled:
            if source.is_directory:
                fail("native binary stripping requires scalar Files")
            output = ctx.actions.declare_file(ctx.label.name + "/" + str(index) + "/" + source.basename)
            ctx.actions.run(executable = strip, arguments = ctx.attr.strip_flags + ["-o", output.path, source.path], inputs = [source], tools = cc.all_files, outputs = [output], mnemonic = "NativeCarrierStrip")
            result[destination] = output
        else:
            result[destination] = source
    return [DefaultInfo(files = depset(result.values())), PackageFilesInfo(dest_src_map = result, attributes = original.attributes)]

_stripped_mapping = rule(
    implementation = _stripped_impl,
    attrs = {"mapping": attr.label(providers = [PackageFilesInfo], mandatory = True), "enabled": attr.bool(default = True), "strip_flags": attr.string_list(default = ["--strip-debug"])},
    fragments = ["cpp"], toolchains = use_cc_toolchain(),
)

def _payload_impl(ctx):
    inputs = []
    rows = _mapping_rows(ctx.attr.root_mappings, "", inputs) + _mapping_rows(ctx.attr.runtime_mappings, "runtime/", inputs)
    output = ctx.actions.declare_directory(ctx.label.name)
    spec = json.decode(ctx.attr.metadata)
    spec.update({"mappings": rows, "legal": _sources(ctx.attr.legal, inputs), "windowsRuntime": {file.basename: file.path for file in ctx.files.windows_runtime}, "output": output.path})
    inputs += ctx.files.windows_runtime
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(manifest, json.encode(spec))
    bun_action(ctx, ctx.attr.tool, arguments = [manifest.path], inputs = inputs + [manifest], outputs = [output], mnemonic = "NativePublicPayload")
    return [DefaultInfo(files = depset([output]))]

native_public_payload = rule(
    implementation = _payload_impl,
    cfg = desktop_profile,
    attrs = {
        "root_mappings": attr.label_list(mandatory = True), "runtime_mappings": attr.label_list(mandatory = True),
        "metadata": attr.string(mandatory = True), "legal": attr.label_keyed_string_dict(allow_files = True),
        "windows_runtime": attr.label_list(allow_files = True),
        "tool": attr.label(default = Label("//build_defs/native/carriers:payload_tool"), providers = [BunScriptInfo], cfg = "exec"),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _envelope_impl(ctx):
    inputs = [ctx.file.payload]
    output = ctx.actions.declare_directory(ctx.attr.out) if ctx.attr.phase == "cargo" else ctx.actions.declare_file(ctx.attr.out)
    spec = json.decode(ctx.attr.metadata)
    spec.update({"phase": ctx.attr.phase, "payload": ctx.file.payload.path, "sources": _sources(ctx.attr.sources, inputs), "legal": _sources(ctx.attr.legal, inputs), "output": output.path})
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(manifest, json.encode(spec))
    bun_action(ctx, ctx.attr.tool, arguments = [manifest.path], inputs = inputs + [manifest], outputs = [output], mnemonic = {"github": "NativeGithubEnvelope", "npm": "NativeNpmEnvelope", "cargo": "NativeCargoEnvelope"}[ctx.attr.phase])
    return [DefaultInfo(files = depset([output]))]

_native_envelope = rule(
    implementation = _envelope_impl,
    attrs = {"payload": attr.label(allow_single_file = True, mandatory = True), "phase": attr.string(values = ["github", "npm", "cargo"], mandatory = True), "out": attr.string(mandatory = True), "metadata": attr.string(mandatory = True), "sources": attr.label_keyed_string_dict(allow_files = True), "legal": attr.label_keyed_string_dict(allow_files = True), "tool": attr.label(default = Label("//build_defs/native/carriers:envelope_tool"), providers = [BunScriptInfo], cfg = "exec")},
)

def native_desktop_carriers(product, root_mappings, runtime_mappings, binary_mappings, qualification):
    descriptor = PRODUCTS[product]
    rows = [row for row in NATIVE_RUNTIME_ARTIFACTS if row["product"] == product and row["kind"] in ["native-runtime", "native-tools"] and row["target"] in _CONFIGURATIONS]
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == product]
    metadata, payload_metadata, payload_legal, github, npm, npm_names, npm_roles, cargo_names, cargo_roles, physical, compatible, sources = {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}
    for artifact in rows:
        target = artifact["target"]
        configuration = _CONFIGURATIONS[target]
        metadata[configuration] = json.encode({"artifact": artifact, "version": descriptor["version"], "carriers": carriers})
        # The public payload consumes only its binary/layout contract. Own
        # release versions and registry identities belong to later envelopes.
        # Compiler inputs (including the runtime's public version API) stay in
        # the actual typed mappings and their native construction closure.
        payload_metadata[configuration] = json.encode({"artifact": {"kind": artifact["kind"], "target": target}})
        payload_legal[configuration] = native_carrier_legal_inputs(artifact["kind"])
        github[configuration] = "release-assets/" + artifact["asset"].replace("{version}", descriptor["version"])
        leaf = [row for row in carriers if row["ecosystem"] == "npm" and row["name"] == artifact["npm_package"]]
        # Base runtime and contrib share a release owner. Select the exact
        # conventional native payload aggregator, not every owner/target row.
        package_base = "liboliphaunt-native" if product == "liboliphaunt-native" else "oliphaunt-tools"
        cargo = [row for row in carriers if row["ecosystem"] == "cargo" and row["target"] == target and row["name"] == package_base + "-" + target]
        if len(leaf) != 1 or len(cargo) != 1:
            fail("canonical native registry leaf must be unique for " + target)
        leaf, cargo = leaf[0], cargo[0]
        npm[configuration] = leaf["name"].replace("@", "").replace("/", "-") + "-" + leaf["version"] + ".tgz"
        npm_names[configuration], npm_roles[configuration] = leaf["name"], leaf["role"]
        cargo_names[configuration], cargo_roles[configuration] = cargo["name"], cargo["role"]
        physical[configuration], compatible[configuration] = target, []
        directory = ("packages/" if product == "liboliphaunt-native" else "npm-platforms/") + leaf["target"]
        sources[configuration] = {directory + "/package.json": "package.json", directory + "/README.md": "README.md"}
    compatibility = select(compatible | {"//conditions:default": ["@platforms//:incompatible"]})
    replacements = {}
    for index, mapping in enumerate(binary_mappings):
        name = "public_binary_mapping_" + str(index)
        _stripped_mapping(name = name, mapping = mapping, enabled = select({"//build_defs/native:macos_arm64": True, "//conditions:default": False}), strip_flags = ["-S"], target_compatible_with = compatibility)
        replacements[mapping] = ":" + name
    native_public_payload(name = "public_payload", root_mappings = [replacements.get(label, label) for label in root_mappings], runtime_mappings = [replacements.get(label, label) for label in runtime_mappings], metadata = select(payload_metadata), legal = select(payload_legal), windows_runtime = select({"//build_defs/native:windows_x64": ["@native_msvc_sdk//:runtime_dlls"], "//conditions:default": []}), target_compatible_with = compatibility)
    for phase, out in [("github", select(github)), ("npm", select(npm)), ("cargo", "cargo-packages")]:
        _native_envelope(name = "github_archive" if phase == "github" else "cargo_packages" if phase == "cargo" else "npm", phase = phase, payload = ":public_payload", metadata = select(metadata), sources = select(sources) if phase == "npm" else {}, legal = native_carrier_legal_inputs() if phase != "github" else {}, out = out, target_compatible_with = compatibility)
    shipping_package(name = "native_github_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":github_archive"], ecosystem = "github", package_name = select({key: value[len("release-assets/"):] for key, value in github.items()}), configuration = select(physical), role = "github-release-asset", suppliers = "//build_defs/release:no_suppliers")
    shipping_package(name = "native_npm_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":npm"], ecosystem = "npm", package_name = select(npm_names), configuration = select(physical), role = select(npm_roles), suppliers = "//build_defs/release:no_suppliers")
    shipping_package(name = "native_cargo_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":cargo_packages"], ecosystem = "cargo", package_name = select(cargo_names), configuration = select(physical), role = select(cargo_roles), suppliers = "//build_defs/release:no_suppliers")
    shipping_package(name = "native_payload_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":public_payload"], ecosystem = "internal", package_name = product + "-public-payload", configuration = select(physical), role = "construction", suppliers = "//build_defs/release:no_suppliers")
    shipping_export(name = "native_shipping_export", packages = [":native_github_shipping", ":native_npm_shipping", ":native_cargo_shipping", ":native_payload_shipping"], qualification = qualification, testonly = True)

def _facade_impl(ctx):
    inputs = []
    output = ctx.actions.declare_file(ctx.attr.out)
    spec = json.decode(ctx.attr.metadata)
    spec.update({"phase": ctx.attr.phase, "sources": _sources(ctx.attr.sources, inputs), "legal": _sources(ctx.attr.legal, inputs), "output": output.path})
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(manifest, json.encode(spec))
    bun_action(ctx, ctx.attr.tool, arguments = [manifest.path], inputs = inputs + [manifest], outputs = [output], mnemonic = "NativeToolsFacade")
    return [DefaultInfo(files = depset([output]))]

_native_facade = rule(implementation = _facade_impl, attrs = {"phase": attr.string(values = ["npm", "cargo"], mandatory = True), "out": attr.string(mandatory = True), "metadata": attr.string(mandatory = True), "sources": attr.label_keyed_string_dict(allow_files = True), "legal": attr.label_keyed_string_dict(allow_files = True), "tool": attr.label(default = Label("//build_defs/native/carriers:facade_tool"), providers = [BunScriptInfo], cfg = "exec")})

def native_tools_facades(qualification):
    product = "postgres-tools-native"
    descriptor = PRODUCTS[product]
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == product]
    metadata = json.encode({"version": descriptor["version"], "targets": [row for row in NATIVE_RUNTIME_ARTIFACTS if row["product"] == product and row["kind"] == "native-tools"], "carriers": carriers})
    for ecosystem in ["npm", "cargo"]:
        rows = [row for row in carriers if row["ecosystem"] == ecosystem and row["target"] == None]
        if len(rows) != 1:
            fail("tools source facade must have one canonical identity")
        row = rows[0]
        if ecosystem == "npm":
            sources = {"npm/" + file: file for file in ["package.json", "README.md", "index.mts", "index.d.ts"]}
            output = row["name"].replace("@", "").replace("/", "-") + "-" + row["version"] + ".tgz"
        else:
            sources = {file: file[len("crates/tools/"):] for file in native.glob(["crates/tools/**"], exclude = ["crates/tools/tests/**", "**/target/**"])}
            sources["//src/test-fixtures:postgres/logical-tools.json"] = "testdata/logical-tools.json"
            output = row["name"] + "-" + row["version"] + ".crate"
        name = ecosystem + "_facade"
        _native_facade(name = name, phase = ecosystem, out = output, metadata = metadata, sources = sources, legal = native_carrier_legal_inputs())
        shipping_package(name = name + "_shipping", owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":" + name], ecosystem = ecosystem, package_name = row["name"], configuration = "portable", role = row["role"], suppliers = "//build_defs/release:no_suppliers")
    shipping_export(name = "facade_shipping_export", packages = [":npm_facade_shipping", ":cargo_facade_shipping"], qualification = qualification, testonly = True)

def _unit_inputs_impl(ctx):
    inputs = []
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    metadata = json.decode(ctx.attr.metadata)
    metadata.update({"sources": _sources(ctx.attr.sources, inputs), "legal": _sources(ctx.attr.legal, inputs)})
    metadata["payloadModules"] = {file.short_path: file.path for file in ctx.files.payload_modules}
    metadata["payloadLegalInputs"] = {profile: native_carrier_legal_inputs(profile).values() for profile in ["native-tools", "native-runtime"]}
    inputs += ctx.files.payload_modules
    ctx.actions.write(output, json.encode(metadata))
    return [DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(files = inputs + [output]))]

_native_unit_inputs = rule(implementation = _unit_inputs_impl, attrs = {"metadata": attr.string(mandatory = True), "sources": attr.label_keyed_string_dict(allow_files = True), "legal": attr.label_keyed_string_dict(allow_files = True), "payload_modules": attr.label_list(allow_files = True)})

def native_carrier_unit_inputs(name):
    product = "postgres-tools-native"
    rows = [row for row in NATIVE_RUNTIME_ARTIFACTS if row["product"] == product and row["kind"] == "native-tools"]
    sources = {}
    for file in ["package.json", "README.md", "index.mts", "index.d.ts"]:
        sources["//src/native/postgres-tools:npm/" + file] = "npm/" + file
    for file in ["Cargo.toml", "README.md", "build.rs", "build_support.rs", "src/arguments.rs", "src/lib.rs"]:
        sources["//src/native/postgres-tools:crates/tools/" + file] = "cargo/" + file
    sources["//src/test-fixtures:postgres/logical-tools.json"] = "cargo/testdata/logical-tools.json"
    _native_unit_inputs(name = name, metadata = json.encode({"version": PRODUCTS[product]["version"], "targets": rows, "carriers": [row for row in PUBLICATION_CARRIERS if row["product"] == product]}), sources = sources, legal = native_carrier_legal_inputs(), payload_modules = [":payload.mts"] + native_payload_helpers())

def _checksums_impl(ctx):
    files = ctx.files.archives
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    output = ctx.actions.declare_file(ctx.attr.output_directory + "/" + ctx.attr.out)
    copies = [ctx.actions.declare_file(ctx.attr.output_directory + "/" + name) for name in ctx.attr.expected] if ctx.attr.assemble else []
    data = {"expected": ctx.attr.expected, "files": [file.path for file in files], "output": output.path}
    if ctx.attr.assemble:
        data["copies"] = [file.path for file in copies]
    ctx.actions.write(spec, json.encode(data))
    bun_action(ctx, ctx.attr.tool, arguments = [spec.path], inputs = files + [spec], outputs = [output] + copies, mnemonic = "NativeProductReleaseAssets" if ctx.attr.assemble else "NativeProductChecksums")
    groups = {file.basename: depset([file]) for file in copies}
    groups["checksums"] = depset([output])
    return [DefaultInfo(files = depset([output] + copies)), OutputGroupInfo(**groups)]

_native_checksums = rule(implementation = _checksums_impl, attrs = {"archives": attr.label_list(allow_files = True, mandatory = True), "expected": attr.string_list(mandatory = True), "out": attr.string(mandatory = True), "output_directory": attr.string(default = "release-assets"), "assemble": attr.bool(default = False), "tool": attr.label(default = Label("//build_defs/native/carriers:checksum_tool"), providers = [BunScriptInfo], cfg = "exec")})

def native_checksum_manifest(name, product, archives, artifact_rows = NATIVE_RUNTIME_ARTIFACTS, assemble = False, output_directory = "release-assets"):
    descriptor = PRODUCTS[product]
    rows = [row for row in artifact_rows if row["product"] == product and "github-release" in row["surfaces"]]
    checksums = [row for row in rows if row["kind"] == "checksums"]
    if len(checksums) != 1:
        fail("product checksum descriptor must be unique")
    _native_checksums(name = name, archives = archives, expected = [row["asset"].replace("{version}", descriptor["version"]) for row in rows if row["kind"] != "checksums"], out = checksums[0]["asset"].replace("{version}", descriptor["version"]), assemble = assemble, output_directory = output_directory)
