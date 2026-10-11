"""Canonical mobile final leaves from actual host modules and static SDK slices."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "EXTENSION_GITHUB_ARTIFACTS", "EXTENSION_RELEASE_METADATA", "NATIVE_COMPONENT_SOURCES", "NATIVE_MOBILE_COMPONENT_CLOSURES", "PUBLICATION_CARRIERS")
load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("@rules_apple//apple:apple.bzl", "apple_static_xcframework")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load(":construction.bzl", "desktop_member_inventory")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_identity")
load(":final_leaf.bzl", "ExtensionFinalLeafInfo")
load(":mobile.bzl", "MobileComponentInfo", "MobileExtensionInfo")
load(":mobile_members.bzl", "MOBILE_COMPONENT_ARCHIVE_OBJECTS", "MOBILE_COMPONENT_TARGETS", "MOBILE_MEMBER_ARCHIVE_OBJECTS", "MOBILE_MEMBER_TARGETS")
load(":owner_carriers.bzl", "native_extension_final_contract_test", "native_final_leaf_files", "native_final_leaf_input", "native_owner_carrier_helpers", "native_owner_carrier_legal", "native_owner_carrier_metadata")

_TARGET_PLATFORMS = {"android-arm64-v8a": "//build_defs/android:android_arm64", "android-x86_64": "//build_defs/android:android_x86_64", "macos-arm64": "//build_defs/host:apple_package_macos_arm64", "ios-device": "//build_defs/host:ios_device_arm64", "ios-simulator": "//build_defs/host:ios_simulator_arm64"}
_TARGETS = ["android-arm64-v8a", "android-x86_64", "ios-xcframework"]
_MAC = ["@platforms//os:macos", "@platforms//cpu:aarch64"]
_LINUX = ["@platforms//os:linux", "@platforms//cpu:x86_64"]

def _slices_impl(settings, attr):
    targets = ["macos-arm64", "ios-device", "ios-simulator"] if attr.target == "ios-xcframework" else [attr.target]
    return {target: {"//command_line_option:platforms": [str(Label(_TARGET_PLATFORMS[target]))]} for target in targets}

_slices = transition(implementation = _slices_impl, inputs = [], outputs = ["//command_line_option:platforms"])

def _host_impl(settings, attr):
    target = "//build_defs/host:apple_package_macos_arm64" if attr.target == "ios-xcframework" else "//build_defs/native:linux_x86_64_glibc_2_28"
    return {"//command_line_option:platforms": [str(Label(target))]}

_host = transition(implementation = _host_impl, inputs = [], outputs = ["//command_line_option:platforms"])

_MACOS_PROFILE = "@apple_support//platforms:macos_arm64_platform"
def _apple_package_impl(settings, attr):
    return {_MACOS_PROFILE: str(Label("//build_defs/host:apple_package_macos_arm64"))}

_apple_package = transition(implementation = _apple_package_impl, inputs = [], outputs = [_MACOS_PROFILE])

def _framework_impl(ctx):
    return [ctx.attr.archive[0][DefaultInfo]]

_framework = rule(implementation = _framework_impl, attrs = {"archive": attr.label(mandatory = True, cfg = _apple_package), "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")})

def mobile_carrier_helpers():
    return native_owner_carrier_helpers() + ["//build_defs/extensions:mobile_registration.mts", "//src/native/sdks/swift:tools/swift-xcframework-contract.mts"]

def _static_row(member):
    return {"sqlName": member.sql_name, "owner": member.owner, "version": member.version, "runtimeVersion": member.runtime_version, "source": member.source,
            "target": member.configuration, "archive": member.archive.path, "registration": member.registration.path, "nm": {"path": member.nm.path, "apple": member.apple}, "aliases": member.aliases}

def _carriers_impl(ctx):
    metadata = native_owner_carrier_metadata(ctx.attr.product)
    expected = sorted([member["sqlName"] for member in metadata["members"]])
    host_members = ctx.split_attr.host.values()[0]
    host = {target[ExtensionMemberInfo].sql_name: target[ExtensionMemberInfo] for target in host_members}
    if sorted(host.keys()) != expected or len(host) != len(host_members):
        fail("mobile final leaf must consume every canonical host member exactly once")
    compiled = sorted([member["sqlName"] for member in metadata["members"] if member["descriptor"].get("native-module-file")])
    statics = {target: {member[MobileExtensionInfo].sql_name: member[MobileExtensionInfo] for member in members} for target, members in ctx.split_attr.members.items()}
    dependencies = {target: {item[MobileComponentInfo].identity: item[MobileComponentInfo] for item in rows} for target, rows in ctx.split_attr.dependencies.items()}
    inputs = [ctx.file._components] + ctx.files.legal
    tools = []
    for target, rows in statics.items():
        if sorted(rows.keys()) != compiled or len(rows) != len(ctx.split_attr.members[target]):
            fail("mobile static slice differs from canonical compiled member cohort")
        for member in rows.values():
            inputs += [member.archive, member.registration]
            tools.append(member.tools)
    dependency_ids = sorted({identity: True for name in expected for identity in NATIVE_MOBILE_COMPONENT_CLOSURES[name][ctx.attr.target]["linkUnits"]}.keys())
    for target, rows in dependencies.items():
        if sorted(rows.keys()) != dependency_ids or len(rows) != len(ctx.split_attr.dependencies[target]):
            fail("mobile component slice differs from canonical member closure")
        for component in rows.values():
            inputs.append(component.archive)
    frameworks = {}
    for target, identity in ctx.attr.frameworks.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or not files[0].basename.endswith(".xcframework.zip") or identity in frameworks:
            fail("iOS envelope requires one actual maintained framework output per role")
        frameworks[identity] = files[0]
        inputs += files
    members = []
    for canonical in metadata["members"]:
        name = canonical["sqlName"]
        member = dict(canonical)
        producer = host[name]
        host_target = "macos-arm64" if ctx.attr.target == "ios-xcframework" else "linux-x64-gnu"
        if producer.owner != metadata["owner"] or producer.configuration != host_target:
            fail("mobile host member differs from its actual owner/configuration")
        inputs += [producer.archive, producer.inventory]
        member.update({"target": ctx.attr.target, "hostArchive": producer.archive.path, "components": ctx.file._components.path,
                       "catalogSqlNames": metadata["catalogSqlNames"], "allProfiles": metadata["allProfiles"], "dependencySources": NATIVE_COMPONENT_SOURCES,
                       "staticArchives": [_static_row(rows[name]) for rows in statics.values()] if name in compiled else [],
                       "dependencyArchives": [{"target": cohort, "identity": identity, "archive": rows[identity].archive.path, "source": rows[identity].source} for cohort, rows in dependencies.items() for identity in NATIVE_MOBILE_COMPONENT_CLOSURES[name][ctx.attr.target]["linkUnits"]], "frameworks": []})
        if ctx.attr.target == "ios-xcframework" and name in compiled:
            stem = canonical["descriptor"]["native-module-file"][:-3]
            member["frameworks"] = [{"kind": "ios-xcframework", "identity": stem, "file": frameworks["extension:" + name].path, "bundleName": "liboliphaunt_extension_" + stem}]
            member["frameworks"] += [{"kind": "ios-dependency-xcframework", "identity": identity, "file": frameworks["dependency:" + identity].path, "bundleName": "liboliphaunt_dependency_" + identity} for identity in NATIVE_MOBILE_COMPONENT_CLOSURES[name][ctx.attr.target]["linkUnits"]]
        members.append(member)
    github = ctx.actions.declare_directory(ctx.label.name + "/github")
    frozen = ctx.actions.declare_file(ctx.label.name + "/extension-artifacts.json")
    manifest = ctx.actions.declare_file(ctx.label.name + "/" + metadata["product"] + "-" + metadata["version"] + "-manifest.json")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    spec = dict(metadata)
    spec.update({"operation": "package", "target": ctx.attr.target, "expectedMembers": expected, "members": members, "outputs": {"github": github.path, "frozen": frozen.path, "manifest": manifest.path}})
    ctx.actions.write(specification, json.encode(spec))
    bun_file_action(ctx, ctx.file._tool, arguments = [specification.path], inputs = depset(inputs + [specification], transitive = tools), source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    outputs = [github, frozen, manifest], mnemonic = "MobileExtensionFinalEnvelopes")
    return [DefaultInfo(files = depset([github, frozen, manifest])), ExtensionFinalLeafInfo(product = metadata["product"], owner = metadata["owner"], version = metadata["version"], family = "native", target = ctx.attr.target, metadata = spec,
            github = [github], npm = [], cargo = [], manifest = manifest, frozen = frozen, spec = specification, validation = None, receipt = None, origin = None),
            OutputGroupInfo(github = depset([github]), manifest = depset([manifest]), frozen = depset([frozen]), spec = depset([specification]))]

_mobile_carriers = rule(implementation = _carriers_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "product": attr.string(mandatory = True), "target": attr.string(mandatory = True, values = _TARGETS), "host": attr.label_list(mandatory = True, providers = [ExtensionMemberInfo], cfg = _host),
    "members": attr.label_list(providers = [MobileExtensionInfo], cfg = _slices), "dependencies": attr.label_list(providers = [MobileComponentInfo], cfg = _slices), "frameworks": attr.label_keyed_string_dict(allow_files = True), "legal": attr.label_list(allow_files = True),
    "_tool": attr.label(default = "//build_defs/extensions:mobile_carriers.mts", allow_single_file = True), "_helpers": attr.label_list(default = mobile_carrier_helpers(), allow_files = True), "_components": attr.label(default = "//src/extensions/catalog:native-components.toml", allow_single_file = True), "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def mobile_native_carriers(name, product, target, frameworks = {}):
    metadata = native_owner_carrier_metadata(product)
    names = [member["sqlName"] for member in metadata["members"]]
    hosts = {row.name: row.label for row in desktop_member_inventory(include_postgis = True)}
    units = sorted({identity: True for sql_name in names for identity in NATIVE_MOBILE_COMPONENT_CLOSURES[sql_name][target]["linkUnits"]}.keys())
    compatible = _MAC if target == "ios-xcframework" else _LINUX
    _mobile_carriers(name = name, product = product, target = target, host = [hosts[sql_name] for sql_name in names], members = [MOBILE_MEMBER_TARGETS[sql_name] for sql_name in names if sql_name in MOBILE_MEMBER_TARGETS],
                     dependencies = [MOBILE_COMPONENT_TARGETS[identity] for identity in units], frameworks = frameworks, legal = native_owner_carrier_legal(product), target_compatible_with = compatible)
    owner = extension_identity(names[0])
    packages = []
    github_files = name + "_github_files"
    native.filegroup(name = github_files, srcs = [":" + name], output_group = "github", target_compatible_with = compatible)
    github_rows = [row for row in EXTENSION_GITHUB_ARTIFACTS if row["artifactProduct"] == product and row["product"] == metadata["owner"] and row["version"] == metadata["version"] and row["target"] == target and row["role"] == "github-release-asset"]
    if not github_rows or len({row["name"]: True for row in github_rows}) != len(github_rows):
        fail("mobile shipping requires exact unique canonical GitHub asset identities")
    for index, row in enumerate(github_rows):
        package = name + "_github_" + str(index) + "_shipping"
        shipping_package(name = package, owner = owner, artifacts = [":" + github_files], ecosystem = "github", package_name = row["name"],
                         configuration = row["target"], role = row["role"], target_compatible_with = compatible)
        packages.append(":" + package)
    for group in ["manifest", "frozen"]:
        files = name + "_" + group + "_files"
        native.filegroup(name = files, srcs = [":" + name], output_group = group, target_compatible_with = compatible)
        package = name + "_" + group + "_shipping"
        shipping_package(name = package, owner = owner, artifacts = [":" + files], ecosystem = "internal", package_name = product + "-" + target + "-" + group,
                         configuration = target, role = "extension-release-" + group + "-input", target_compatible_with = compatible)
        packages.append(":" + package)
    shipping_export(name = name + "_shipping_export", packages = packages, target_compatible_with = compatible)
    return packages

def _maven_rows(metadata):
    return [row for row in PUBLICATION_CARRIERS if row["product"] == metadata["owner"] and row["ecosystem"] == "maven" and row["name"].startswith("dev.oliphaunt.extensions:" + metadata["product"] + "-")]

def _maven_impl(ctx):
    metadata = native_owner_carrier_metadata(ctx.attr.product)
    leaves = [target[ExtensionFinalLeafInfo] for target in ctx.attr.leaves]
    if sorted([leaf.target for leaf in leaves]) != ["android-arm64-v8a", "android-x86_64"]:
        fail("Maven must consume both actual Android final cohorts once")
    if any([leaf.product != metadata["product"] or leaf.owner != metadata["owner"] or leaf.version != metadata["version"] or leaf.family != "native" for leaf in leaves]):
        fail("Maven final leaves differ from their canonical distribution")
    rows = _maven_rows(metadata)
    if len(rows) != 2 or len({row["name"]: True for row in rows}) != 2:
        fail("Maven requires both unique canonical publication identities")
    outputs = {row["name"]: ctx.actions.declare_directory(ctx.label.name + "/" + row["name"].replace(":", "/")) for row in rows}
    spec = dict(metadata)
    spec.update({"leaves": [native_final_leaf_input(leaf) for leaf in leaves], "components": ctx.file._components.path, "mavenCoordinates": sorted(outputs.keys()), "outputs": {name: file.path for name, file in outputs.items()}})
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode(spec))
    bun_file_action(ctx, ctx.file._tool, arguments = [specification.path], source_files = [ctx.file._tool] + ctx.files._helpers + ctx.files.legal,
                    inputs = [specification, ctx.file._components] + [file for leaf in leaves for file in native_final_leaf_files(leaf)] + ctx.files.legal,
                    outputs = outputs.values(), mnemonic = "MobileExtensionMavenEnvelopes")
    return [DefaultInfo(files = depset(outputs.values())), OutputGroupInfo(**{row["name"].split(":")[1].replace("-", "_"): depset([outputs[row["name"]]]) for row in rows})]

_mobile_maven = rule(implementation = _maven_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "product": attr.string(mandatory = True), "leaves": attr.label_list(mandatory = True, providers = [ExtensionFinalLeafInfo]), "legal": attr.label_list(allow_files = True),
    "_tool": attr.label(default = "//build_defs/extensions:mobile_maven.mts", allow_single_file = True), "_components": attr.label(default = "//src/extensions/catalog:native-components.toml", allow_single_file = True),
    "_helpers": attr.label_list(default = mobile_carrier_helpers() + ["//build_defs/extensions:owner_carriers.mts", "//:tools/packaging/build-maven-artifact-manifest.mts", "//:tools/packaging/maven-artifact-manifest.mts", "//:tools/packaging/maven-artifact-staging.mts", "//:tools/packaging/maven-central-contract.mts", "//:tools/packaging/atomic-directory.mts", "//tools/release:compatibility-version-policy.mts", "//tools/release:product-version.mts"], allow_files = True),
})

def mobile_maven_carriers(name, product, leaves):
    metadata = native_owner_carrier_metadata(product)
    _mobile_maven(name = name, product = product, leaves = leaves, legal = native_owner_carrier_legal(product), target_compatible_with = _LINUX)
    packages = []
    target_packages = {"android-arm64-v8a": [], "android-x86_64": []}
    for row in _maven_rows(metadata):
        group = row["name"].split(":")[1].replace("-", "_")
        files = name + "_" + group + "_files"
        native.filegroup(name = files, srcs = [":" + name], output_group = group, target_compatible_with = _LINUX)
        package = name + "_" + group + "_shipping"
        shipping_package(name = package, owner = extension_identity(metadata["members"][0]["sqlName"]), artifacts = [":" + files], ecosystem = "maven", package_name = row["name"], configuration = row["target"] or "android", role = row["role"], target_compatible_with = _LINUX)
        packages.append(":" + package)
        if row["target"] not in target_packages:
            fail("mobile Maven identity must declare its exact Android ABI")
        target_packages[row["target"]].append(":" + package)
    shipping_export(name = name + "_shipping_export", packages = packages, target_compatible_with = _LINUX)
    return target_packages

def mobile_final_carrier_targets():
    frameworks = {}
    descriptors = {row["sql-name"]: row for row in EXTENSIONS.values()}
    for identity, objects in MOBILE_MEMBER_ARCHIVE_OBJECTS.items():
        name = "framework_extension_" + identity.replace("-", "_")
        bundle = "liboliphaunt_extension_" + descriptors[identity]["native-module-file"][:-3]
        apple_static_xcframework(name = name + "_raw", bundle_name = bundle, deps = [objects], ios = {"device": ["arm64"], "simulator": ["arm64"]}, macos = ["arm64"], families_required = {"ios": ["iphone"]}, minimum_os_versions = {"macos": APPLE_DEPLOYMENT_TARGETS["package_macos"], "ios": APPLE_DEPLOYMENT_TARGETS["ios"]}, target_compatible_with = _MAC)
        _framework(name = name, archive = ":" + name + "_raw", target_compatible_with = _MAC)
        frameworks[":" + name] = "extension:" + identity
    for identity, objects in MOBILE_COMPONENT_ARCHIVE_OBJECTS.items():
        name = "framework_dependency_" + identity.replace("-", "_")
        apple_static_xcframework(name = name + "_raw", bundle_name = "liboliphaunt_dependency_" + identity, deps = [objects], ios = {"device": ["arm64"], "simulator": ["arm64"]}, macos = ["arm64"], families_required = {"ios": ["iphone"]}, minimum_os_versions = {"macos": APPLE_DEPLOYMENT_TARGETS["package_macos"], "ios": APPLE_DEPLOYMENT_TARGETS["ios"]}, target_compatible_with = _MAC)
        _framework(name = name, archive = ":" + name + "_raw", target_compatible_with = _MAC)
        frameworks[":" + name] = "dependency:" + identity
    products = sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA}.keys())
    packages = {target: [] for target in _TARGETS}
    for product in products:
        metadata = native_owner_carrier_metadata(product)
        names = [member["sqlName"] for member in metadata["members"]]
        units = {unit: True for name in names for unit in NATIVE_MOBILE_COMPONENT_CLOSURES[name]["ios-xcframework"]["linkUnits"]}
        selected_frameworks = {label: role for label, role in frameworks.items() if (role.startswith("extension:") and role[len("extension:"):] in names) or (role.startswith("dependency:") and role[len("dependency:"):] in units)}
        for target in _TARGETS:
            packages[target] += mobile_native_carriers(name = product.replace("-", "_") + "_" + target.replace("-", "_"), product = product, target = target, frameworks = selected_frameworks if target == "ios-xcframework" else {})
        maven = mobile_maven_carriers(name = product.replace("-", "_") + "_maven", product = product, leaves = [":" + product.replace("-", "_") + "_" + target.replace("-", "_") for target in _TARGETS if target.startswith("android-")])
        for target, rows in maven.items():
            packages[target] += rows
    for target in _TARGETS:
        suffix = target.replace("-", "_")
        compatible = _MAC if target == "ios-xcframework" else _LINUX
        shipping_export(name = suffix + "_shipping_export", packages = packages[target], target_compatible_with = compatible)
        native_extension_final_contract_test(name = suffix + "_final_contract_test", products = products,
            leaves = [":" + product.replace("-", "_") + "_" + suffix for product in products], target_compatible_with = compatible, size = "medium")
        selected = sorted({row["artifactProduct"]: True for row in EXTENSION_RELEASE_METADATA if row["sqlName"] in ["pg_uuidv7", "pgtap"]}.keys())
        native_extension_final_contract_test(name = suffix + "_small_final_contract_test", products = selected,
            leaves = [":" + product.replace("-", "_") + "_" + suffix for product in selected], target_compatible_with = compatible, size = "medium")
    shipping_export(name = "android_shipping_export", packages = {label: True for target in _TARGETS if target.startswith("android-") for label in packages[target]}.keys(), target_compatible_with = _LINUX)
    native.filegroup(name = "android_maven_carriers", srcs = [":" + product.replace("-", "_") + "_maven" for product in products], target_compatible_with = _LINUX)
