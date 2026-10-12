"""Declared Expo/RN generation edges; maintained Android/Kotlin/C++ rules compile."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@rules_android//providers:providers.bzl", "AndroidSdkInfo", "ApkInfo")
load("@rules_cc//cc:defs.bzl", "cc_import", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@rules_java//java/common:java_common.bzl", "java_common")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/extensions:mobile.bzl", "MobileExtensionInfo")

_NODE = "@rules_nodejs//nodejs:toolchain_type"
_TAR = "@tar.bzl//tar/toolchain:type"
_HELPERS = [
    Label("//:tools/packaging/archive-directory.mts"),
    Label("//:tools/packaging/portable-archive.mts"),
]

def _sources(ctx):
    inputs, sources, names = [], [], {}
    for target, destination in ctx.attr.sources.items():
        for file in target[DefaultInfo].files.to_list():
            relative = destination
            if not destination or destination.endswith("/"):
                prefix = target.label.package + "/"
                if not file.short_path.startswith(prefix):
                    fail("App source group must retain its declared package path: " + file.short_path)
                relative += file.short_path[len(prefix):]
            if relative in names:
                fail("Duplicate app source destination " + relative)
            names[relative] = True
            inputs.append(file)
            sources.append({"source": file.path, "destination": relative})
    return sources, inputs

def _node_inputs(ctx):
    if sorted(ctx.attr.package_inputs.values()) != sorted(ctx.attr.package_identities.keys()):
        fail("App packages must cover their exact conventional lock closure")
    packages, inputs = {}, []
    for target, identity in ctx.attr.package_inputs.items():
        package = target[NpmPackageInfo]
        row = json.decode(ctx.attr.package_identities[identity])
        if row["package"] != package.package or row["version"] != package.version:
            fail("App package identity differs from the canonical acquisition " + identity)
        packages[identity] = row | {"source": package.src.path}
        inputs.append(package.src)
    roots = dict(ctx.attr.package_roots)
    for target, identity in ctx.attr.workspace_inputs.items():
        package = target[NpmPackageInfo]
        row = json.decode(ctx.attr.workspace_identities[identity])
        if row["package"] != package.package or row["version"] != package.version:
            fail("App workspace package differs from its source artifact " + identity)
        if identity in packages:
            fail("App workspace package collides with an acquired package " + identity)
        packages[identity] = row | {"source": package.src.path, "local": True, "integrity": ""}
        roots[package.package] = identity
        inputs.append(package.src)
    sources, source_files = _sources(ctx)
    node = ctx.toolchains[_NODE].nodeinfo
    tar = ctx.toolchains[_TAR]
    return {"sources": sources, "packages": packages, "roots": roots, "node": node.node.path,
            "tar": tar.tarinfo.binary.path, "tarEnvironment": tar.tarinfo.default_env}, inputs + source_files + [node.node] + tar.default.files.to_list()

app_node_inputs = _node_inputs

def _action(ctx, operation, specification, inputs, outputs, mnemonic, tools = []):
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(specification) + "\n")
    bun_file_action(ctx, entry_point = ctx.file._runner,
                    arguments = [operation, spec.path],
                    inputs = inputs + [spec, ctx.file._runner] + ctx.files._helpers,
                    source_files = [ctx.file._runner] + ctx.files._helpers,
                    outputs = outputs, tools = tools,
                    execution_requirements = {"block-network": "1"}, mnemonic = mnemonic)

_RUNNER = {
    "_runner": attr.label(default = Label("//build_defs/android:app.mts"), allow_single_file = True),
    "_helpers": attr.label_list(default = _HELPERS, allow_files = True),
}
_NODE_INPUTS = dict(_RUNNER, **{
    "sources": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
    "package_inputs": attr.label_keyed_string_dict(providers = [NpmPackageInfo], mandatory = True),
    "package_identities": attr.string_dict(mandatory = True),
    "package_roots": attr.string_dict(mandatory = True),
    "workspace_inputs": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
    "workspace_identities": attr.string_dict(),
})

APP_NODE_INPUT_ATTRS = _NODE_INPUTS

def _codegen_impl(ctx):
    specification, inputs = _node_inputs(ctx)
    schema = ctx.actions.declare_file(ctx.label.name + "/schema.json")
    java = ctx.actions.declare_file(ctx.label.name + "/generated.srcjar")
    native = ctx.actions.declare_directory(ctx.label.name + "/cpp")
    headers = ctx.actions.declare_directory(ctx.label.name + "/include")
    _action(ctx, "codegen", specification | {
        "libraryName": ctx.attr.library_name,
        "javaPackageName": ctx.attr.java_package_name,
        "specs": ctx.attr.specs,
        "schema": schema.path, "javaSources": java.path,
        "nativeSources": native.path, "nativeHeaders": headers.path,
    }, inputs, [schema, java, native, headers], "ReactNativeAndroidCodegen")
    return [DefaultInfo(files = depset([java])), OutputGroupInfo(
        schema = depset([schema]), java = depset([java]), cpp = depset([native]), headers = depset([headers]))]

react_native_android_codegen = rule(
    implementation = _codegen_impl, toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE, _TAR],
    attrs = dict(_NODE_INPUTS, **{
        "library_name": attr.string(mandatory = True),
        "java_package_name": attr.string(mandatory = True),
        "specs": attr.string_list(mandatory = True),
    }),
)

def _project_impl(ctx):
    specification, inputs = _node_inputs(ctx)
    manifest = ctx.actions.declare_file(ctx.label.name + "/AndroidManifest.xml")
    java = ctx.actions.declare_file(ctx.label.name + "/app.srcjar")
    resources = ctx.actions.declare_directory(ctx.label.name + "/res")
    project = ctx.actions.declare_file(ctx.label.name + "/project.json")
    registry = ctx.actions.declare_file(ctx.label.name + "/expo-registry.srcjar")
    cpp = ctx.actions.declare_directory(ctx.label.name + "/native-cpp")
    headers = ctx.actions.declare_directory(ctx.label.name + "/native-headers")
    assets = ctx.actions.declare_directory(ctx.label.name + "/expo-assets")
    autolinking = ctx.actions.declare_file(ctx.label.name + "/autolinking.json")
    keystore = ctx.actions.declare_file(ctx.label.name + "/debug.keystore")
    _action(ctx, "project", specification | {
        "manifest": manifest.path, "javaSources": java.path, "resources": resources.path,
        "project": project.path,
        "expoRegistry": registry.path, "nativeSources": cpp.path, "nativeHeaders": headers.path,
        "expoAssets": assets.path, "autolinking": autolinking.path, "keystore": keystore.path,
    }, inputs, [manifest, java, resources, project, registry, cpp, headers, assets, autolinking, keystore], "ExpoAndroidProjectSources")
    return [DefaultInfo(files = depset([java])), OutputGroupInfo(
        manifest = depset([manifest]), java = depset([java]), resources = depset([resources]), project = depset([project]),
        expo_registry = depset([registry]), native_cpp = depset([cpp]), native_headers = depset([headers]),
        expo_assets = depset([assets]), autolinking = depset([autolinking]), keystore = depset([keystore]))]

expo_android_project = rule(implementation = _project_impl, attrs = _NODE_INPUTS,
                            toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE, _TAR])

def _bundle_impl(ctx):
    specification, inputs = _node_inputs(ctx)
    bundle = ctx.actions.declare_file(ctx.label.name + "/index.android.bundle")
    source_map = ctx.actions.declare_file(ctx.label.name + "/index.android.bundle.map")
    resources = ctx.actions.declare_directory(ctx.label.name + "/res")
    assets = ctx.actions.declare_directory(ctx.label.name + "/assets")
    _action(ctx, "bundle", specification | {
        "entry": ctx.attr.entry, "environment": ctx.attr.environment,
        "selectedExtensions": ctx.attr.selected_extensions, "catalogProfile": ctx.attr.catalog_profile,
        "profileProbe": ctx.file.catalog_profile_probe.path,
        "bundle": bundle.path, "sourceMap": source_map.path,
        "resources": resources.path, "assets": assets.path,
    }, inputs + [ctx.file.catalog_profile_probe], [bundle, source_map, resources, assets], "ExpoAndroidHermesBundle")
    return [DefaultInfo(files = depset([bundle])), OutputGroupInfo(
        bundle = depset([bundle]), source_map = depset([source_map]), resources = depset([resources]), assets = depset([assets]))]

expo_android_bundle = rule(
    implementation = _bundle_impl, toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE, _TAR],
    attrs = dict(_NODE_INPUTS, **{
        "entry": attr.string(default = "index.ts"), "environment": attr.string_dict(),
        "selected_extensions": attr.string_list(mandatory = True),
        "catalog_profile": attr.string(mandatory = True, values = ["standard", "icu"]),
        "catalog_profile_probe": attr.label(mandatory = True, allow_single_file = [".json"]),
    }),
)

def _prefab_impl(ctx):
    headers = ctx.actions.declare_directory(ctx.label.name + "/include")
    library = ctx.actions.declare_file(ctx.label.name + "/lib" + ctx.attr.module + ".so")
    _action(ctx, "prefab", {"aar": ctx.file.aar.path, "abi": ctx.attr.abi, "module": ctx.attr.module,
                           "headers": headers.path, "library": library.path},
            [ctx.file.aar], [headers, library], "AndroidPrefabAbi")
    return [DefaultInfo(files = depset([library])), OutputGroupInfo(headers = depset([headers]), library = depset([library]))]

_prefab = rule(implementation = _prefab_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
               attrs = dict(_RUNNER, **{"aar": attr.label(allow_single_file = [".aar"], mandatory = True),
                                        "abi": attr.string(mandatory = True, values = ["arm64-v8a", "x86_64"]),
                                        "module": attr.string(mandatory = True)}))

def android_prefab_import(name, aar, abi, module, **kwargs):
    """Expose the exact Maven prefab ABI through maintained C++ imports."""
    _prefab(name = name + "_files", aar = aar, abi = abi, module = module, **kwargs)
    native.filegroup(name = name + "_headers", srcs = [":" + name + "_files"], output_group = "headers")
    native.filegroup(name = name + "_library", srcs = [":" + name + "_files"], output_group = "library")
    cc_import(name = name + "_import", shared_library = ":" + name + "_library", hdrs = [":" + name + "_headers"], **kwargs)
    android_header_tree(name = name + "_includes", headers = ":" + name + "_headers", quote_includes = False, **kwargs)
    cc_library(name = name, deps = [":" + name + "_import", ":" + name + "_includes"], **kwargs)

def _header_tree_impl(ctx):
    headers = ctx.files.headers
    if len(headers) != 1 or not headers[0].is_directory:
        fail("Generated Android headers need one declared header tree")
    paths = [headers[0].path + ("/" + suffix if suffix else "") for suffix in ctx.attr.include_suffixes]
    context = cc_common.create_compilation_context(headers = depset(headers),
        system_includes = depset(paths), quote_includes = depset(paths) if ctx.attr.quote_includes else depset())
    return [DefaultInfo(files = depset(headers)), CcInfo(compilation_context = context)]

android_header_tree = rule(implementation = _header_tree_impl, attrs = {
    "headers": attr.label(mandatory = True, allow_files = True),
    "include_suffixes": attr.string_list(default = [""]),
    "quote_includes": attr.bool(default = True),
})

def _source_headers_impl(ctx):
    prefix = ctx.label.workspace_root + ("/" if ctx.label.workspace_root else "") + ctx.label.package
    paths = [(prefix + "/" if prefix else "") + directory for directory in ctx.attr.include_dirs]
    return [CcInfo(compilation_context = cc_common.create_compilation_context(
        headers = depset(ctx.files.headers), includes = depset(paths)))]

android_source_headers = rule(implementation = _source_headers_impl, attrs = {
    "headers": attr.label_list(mandatory = True, allow_files = True),
    "include_dirs": attr.string_list(mandatory = True),
})

def _aar_native_impl(ctx):
    library = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.library)
    runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    _action(ctx, "aar-native", {"aar": ctx.file.aar.path, "abi": ctx.attr.abi,
                               "library": ctx.attr.library, "output": library.path, "jar": runtime.java_home + "/bin/jar"},
            [ctx.file.aar] + runtime.files.to_list(), [library], "AndroidAarNativeAbi")
    return [DefaultInfo(files = depset([library]))]

android_aar_native = rule(implementation = _aar_native_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER, **{"aar": attr.label(mandatory = True, allow_single_file = [".aar"]),
                            "abi": attr.string(mandatory = True, values = ["arm64-v8a", "x86_64"]),
                            "library": attr.string(mandatory = True),
                            "_java_runtime": attr.label(default = Label("@bazel_tools//tools/jdk:current_java_runtime"), cfg = "exec", providers = [java_common.JavaRuntimeInfo])}))

def _final_aar_impl(ctx):
    if len(ctx.files.source) != 1:
        fail("A final Android carrier must expose one File or Maven tree")
    source = ctx.files.source[0]
    output = ctx.actions.declare_file(ctx.label.name + ".aar")
    if source.is_directory or ctx.attr.kind != "aar":
        _action(ctx, "final-aar", {"source": source.path, "output": output.path,
            "kind": ctx.attr.kind, "package": ctx.attr.package, "abi": ctx.attr.abi}, [source], [output], "AndroidFinalMavenAar")
    else:
        if source.extension != "aar":
            fail("Installed Android classes must come from the actual final AAR")
        ctx.actions.symlink(output = output, target_file = source)
    return [DefaultInfo(files = depset([output]))]

android_final_aar = rule(implementation = _final_aar_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER, **{"source": attr.label(mandatory = True, allow_files = True, cfg = "exec"),
        "kind": attr.string(default = "aar", values = ["aar", "runtime", "seed"]),
        "package": attr.string(), "abi": attr.string(default = "", values = ["", "arm64-v8a", "x86_64"])}))

def _exec_npm_impl(ctx):
    return [DefaultInfo(files = depset([ctx.file.archive])),
            NpmPackageInfo(package = ctx.attr.package_name, version = ctx.attr.version,
                           src = ctx.file.archive, npm_package_store_infos = depset())]

android_workspace_npm = rule(implementation = _exec_npm_impl, attrs = {
    "archive": attr.label(mandatory = True, allow_single_file = [".tgz"], cfg = "exec"),
    "package_name": attr.string(mandatory = True), "version": attr.string(mandatory = True),
})

def _link_receipt_impl(ctx):
    members, inputs = [], [ctx.file.library, ctx.file.registry]
    for target in ctx.attr.members:
        member = target[MobileExtensionInfo]
        members.append({"archive": member.archive.path, "registration": member.registration.path})
        inputs += [member.archive, member.registration]
    nm = [file for file in ctx.files._nm if file.basename == "llvm-nm"]
    if len(nm) != 1:
        fail("Static extension proof needs the actual pinned NDK nm tool")
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    _action(ctx, "extension-receipt", {"library": ctx.file.library.path, "registry": ctx.file.registry.path,
        "members": members, "selectedExtensions": ctx.attr.selected_extensions, "abi": ctx.attr.abi, "nm": nm[0].path, "output": output.path},
        inputs + ctx.files._nm, [output], "AndroidSelectedStaticExtensionLink")
    return [DefaultInfo(files = depset([output]))]

android_extension_receipt = rule(implementation = _link_receipt_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER, **{
        "library": attr.label(mandatory = True, allow_single_file = True),
        "registry": attr.label(mandatory = True, allow_single_file = [".c"]),
        "members": attr.label_list(mandatory = True, providers = [MobileExtensionInfo]),
        "selected_extensions": attr.string_list(mandatory = True),
        "abi": attr.string(mandatory = True, values = ["arm64-v8a", "x86_64"]),
        "_nm": attr.label(default = Label("@android_ndk//:nm"), cfg = "exec", allow_files = True),
    }))

def _runtime_assets_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name + "/assets")
    if len(ctx.files.payload) != 1 or not ctx.files.payload[0].is_directory:
        fail("App runtime assets need the actual declared native payload tree")
    _action(ctx, "runtime-assets", {"payload": ctx.files.payload[0].path, "formatter": ctx.executable._formatter.path,
        "version": ctx.attr.version, "selectedExtensions": ctx.attr.selected_extensions, "mobileStaticModules": ctx.attr.mobile_static_modules,
        "receipt": ctx.file.receipt.path, "output": output.path},
        ctx.files.payload + [ctx.file.receipt], [output], "ExpoSelectedRuntimeAssets", tools = [ctx.attr._formatter[DefaultInfo].files_to_run])
    return [DefaultInfo(files = depset([output]))]

android_app_runtime_assets = rule(implementation = _runtime_assets_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER, **{
        "payload": attr.label(default = Label("//src/native/runtime:public_payload"), cfg = "exec", allow_files = True),
        "version": attr.string(mandatory = True), "selected_extensions": attr.string_list(mandatory = True),
        "mobile_static_modules": attr.string_list(mandatory = True), "receipt": attr.label(mandatory = True, allow_single_file = [".json"]),
        "_formatter": attr.label(default = Label("//src/native/runtime/packaging:resources"), cfg = "exec", executable = True),
    }))

def _jni_aar_impl(ctx):
    libraries, inputs = [], []
    for target, destination in ctx.attr.libraries.items():
        physical = target[DefaultInfo].files.to_list()
        if len(physical) != 1:
            fail("JNI package needs one declared linked library " + str(target.label))
        libraries.append({"source": physical[0].path, "destination": destination})
        inputs += physical
    output = ctx.actions.declare_file(ctx.label.name + ".aar")
    _action(ctx, "jni-aar", {"libraries": libraries, "output": output.path, "package": ctx.attr.package},
            inputs, [output], "AndroidDeclaredJniEnvelope")
    return [DefaultInfo(files = depset([output]))]

android_jni_aar = rule(implementation = _jni_aar_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
                       attrs = dict(_RUNNER, **{"libraries": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
                                                "package": attr.string(mandatory = True)}))

def _apk_abi_impl(settings, attr):
    platform = "//build_defs/android:android_" + ("arm64" if attr.abi == "arm64-v8a" else "x86_64")
    return {"//command_line_option:android_platforms": [platform], "//command_line_option:compilation_mode": "opt"}

_apk_abi = transition(implementation = _apk_abi_impl, inputs = [],
    outputs = ["//command_line_option:android_platforms", "//command_line_option:compilation_mode"])

def _verify_impl(ctx):
    sdk = ctx.attr._sdk[AndroidSdkInfo]
    compiled = ctx.attr.apk[0][ApkInfo]
    apk = ctx.actions.declare_file(ctx.label.name + ".apk")
    runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    proof = ctx.actions.declare_file(ctx.label.name + ".json")
    objdump = [file for file in ctx.files._elf_tools if file.basename == "llvm-objdump"]
    if len(objdump) != 1:
        fail("APK link proof needs the actual pinned NDK objdump tool")
    _action(ctx, "verify", {"apk": apk.path, "unsignedApk": compiled.unsigned_apk.path, "keystore": ctx.file.keystore.path, "abi": ctx.attr.abi,
                           "zipalign": sdk.zip_align.executable.path, "apksigner": sdk.apk_signer.executable.path,
                           "aapt": sdk.aapt.executable.path,
                           "objdump": objdump[0].path,
                           "output": proof.path, "selectedExtensions": ctx.attr.selected_extensions,
                           "catalogProfile": ctx.attr.catalog_profile, "profileProbe": ctx.file.catalog_profile_probe.path,
                           "expectedClasses": ctx.attr.expected_classes,
                           "environment": {"JAVA_HOME": runtime.java_home}},
            [compiled.unsigned_apk, ctx.file.keystore, ctx.file.catalog_profile_probe] + runtime.files.to_list() + ctx.files._elf_tools, [apk, proof], "ExpoAndroidApkProof",
            tools = [sdk.zip_align, sdk.apk_signer, sdk.aapt])
    return [DefaultInfo(files = depset([apk, proof])), OutputGroupInfo(apk = depset([apk]), proof = depset([proof]))]

android_apk_proof = rule(
    implementation = _verify_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER, **{
        "apk": attr.label(providers = [ApkInfo], mandatory = True, cfg = _apk_abi),
        "abi": attr.string(mandatory = True, values = ["arm64-v8a", "x86_64"]),
        "selected_extensions": attr.string_list(mandatory = True),
        "catalog_profile": attr.string(mandatory = True, values = ["standard", "icu"]),
        "catalog_profile_probe": attr.label(mandatory = True, allow_single_file = [".json"]),
        "expected_classes": attr.string_list(mandatory = True),
        "keystore": attr.label(mandatory = True, allow_single_file = True, cfg = "exec"),
        "_sdk": attr.label(default = Label("@oliphaunt_android_sdk//:sdk"), providers = [AndroidSdkInfo]),
        "_java_runtime": attr.label(default = Label("@bazel_tools//tools/jdk:current_java_runtime"), cfg = "exec", providers = [java_common.JavaRuntimeInfo]),
        "_elf_tools": attr.label(default = Label("@android_ndk//:tools"), cfg = "exec", allow_files = True),
        "_allowlist_function_transition": attr.label(default = Label("@bazel_tools//tools/allowlists/function_transition_allowlist")),
    }),
)
