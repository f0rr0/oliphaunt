"""Actual target static archives; desktop producers retain their existing graph."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "EXTENSION_COMPATIBILITY", "EXTENSION_SOURCES", "NATIVE_COMPONENTS", "NATIVE_MOBILE_MEMBER_ALIASES", "POSTGRES_SOURCE")
load("@rules_cc//cc:cc_static_library.bzl", "cc_static_library")
load("@rules_cc//cc:defs.bzl", "cc_import", "cc_library")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/native:platform_config.bzl", "NATIVE_COPTS")
load(":extensions.bzl", "extension_identity")
load(":native_carriers.bzl", "native_extension_carrier_helpers")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")

# macOS is the real third slice of the public extension XCFramework. It does
# not widen the ordinary desktop extension member/profile guard.
_STATIC_PROFILES = {
    "//build_defs/native:android_arm64": "android-arm64-v8a",
    "//build_defs/native:android_x86_64": "android-x86_64",
    "//build_defs/native:ios_arm64": "ios-device",
    "//build_defs/native:ios_arm64_simulator": "ios-simulator",
    "//build_defs/native:macos_arm64": "macos-arm64",
}
MOBILE_EXTENSION_CONFIGURATION = select(_STATIC_PROFILES, no_match_error = "Static extension construction requires a declared Android or Apple slice.")
MOBILE_EXTENSION_COMPATIBLE = select({condition: [] for condition in _STATIC_PROFILES} | {"//conditions:default": ["@platforms//:incompatible"]})
_APPLE = ["//build_defs/native:ios_arm64", "//build_defs/native:ios_arm64_simulator", "//build_defs/native:macos_arm64"]

MobileExtensionInfo = provider(fields = ["sql_name", "stem", "owner", "version", "runtime_version", "configuration", "source", "archive", "registration", "nm", "tools", "apple", "aliases"])
MobileComponentInfo = provider(fields = ["identity", "configuration", "source", "archive"])

def _descriptor(sql_name):
    rows = [row for row in EXTENSIONS.values() if row["sql-name"] == sql_name]
    if len(rows) != 1:
        fail("static member requires exactly one canonical SQL descriptor")
    return rows[0]

def _own_objects_impl(ctx):
    infos = []
    inputs = []
    for root in ctx.attr.roots:
        infos.append(root[CcInfo])
        owned = [item for item in root[CcInfo].linking_context.linker_inputs.to_list() if item.owner == root.label]
        if not owned or not any([library.objects or library.pic_objects for item in owned for library in item.libraries]):
            fail("static archive requires actual objects owned by its explicit root " + str(root.label))
        inputs += owned
    return [CcInfo(
        compilation_context = cc_common.merge_cc_infos(cc_infos = infos).compilation_context,
        linking_context = cc_common.create_linking_context(linker_inputs = depset(inputs, order = "topological")),
    )]

_own_objects = rule(implementation = _own_objects_impl, attrs = {"roots": attr.label_list(mandatory = True, providers = [CcInfo])})

def mobile_static_archive(name, roots, **kwargs):
    """Keep separately declared component/runtime objects out of this archive."""
    _own_objects(name = name + "_own_objects", roots = roots, **kwargs)
    cc_static_library(name = name, deps = [":" + name + "_own_objects"], **kwargs)

def _member_impl(ctx):
    descriptor = _descriptor(ctx.attr.sql_name)
    stem = descriptor.get("native-module-file", "")
    if not stem.endswith(".so") or stem[:-3] != ctx.attr.stem:
        fail("static member stem differs from the canonical compiled member")
    identity = ctx.attr.owner[ReleaseIdentityInfo]
    if str(ctx.attr.owner.label) != str(Label(extension_identity(ctx.attr.sql_name))):
        fail("static member owner differs from its canonical release product")
    if ctx.file.archive.basename != "liboliphaunt_extension_" + ctx.attr.stem + ".a":
        fail("static member archive differs from its canonical basename")
    source = POSTGRES_SOURCE if descriptor["source-kind"] == "postgres-contrib" else EXTENSION_SOURCES[ctx.attr.sql_name]
    symbols = ctx.actions.declare_file(ctx.label.name + ".symbols.txt")
    toolchain = find_cc_toolchain(ctx)
    registration = ctx.actions.declare_file(ctx.label.name + ".registration.json")
    unit = ctx.actions.declare_file(ctx.label.name + ".registry.c")
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"sqlName": ctx.attr.sql_name, "stem": ctx.attr.stem, "apple": ctx.attr.apple, "aliases": [{"name": name, "address": address} for name, address in ctx.attr.aliases.items()],
                                       "nm": ctx.file.nm.path, "archive": ctx.file.archive.path, "symbols": symbols.path, "registration": registration.path, "source": unit.path}))
    bun_file_action(ctx, ctx.file._registration, source_files = [ctx.file._registration] + ctx.files._helpers,
                    arguments = [spec.path], inputs = depset([spec, ctx.file.archive, ctx.file.nm] + ctx.files.nm_runtime, transitive = [toolchain.all_files]), outputs = [symbols, registration, unit], execution_requirements = {"no-remote": "1"} if ctx.attr.apple else {}, mnemonic = "MobileExtensionRegistration")
    return [DefaultInfo(files = depset([ctx.file.archive, registration])),
            OutputGroupInfo(archive = depset([ctx.file.archive]), registration = depset([registration]), registry_source = depset([unit])),
            MobileExtensionInfo(sql_name = ctx.attr.sql_name, stem = ctx.attr.stem, owner = identity.id, version = identity.version,
                                runtime_version = identity.version if descriptor["source-kind"] == "postgres-contrib" else EXTENSION_COMPATIBILITY[ctx.attr.sql_name]["native_runtime_version"], configuration = ctx.attr.configuration, source = source, archive = ctx.file.archive, registration = registration,
                                nm = ctx.file.nm, tools = depset([ctx.file.nm] + ctx.files.nm_runtime, transitive = [toolchain.all_files]), apple = ctx.attr.apple, aliases = ctx.attr.aliases)]

def _component_impl(ctx):
    units = [unit for component in NATIVE_COMPONENTS["components"] for unit in component["link-units"] if unit["id"] == ctx.attr.identity]
    if len(units) != 1 or ctx.file.archive.basename not in [path.split("/")[-1] for path in units[0]["archive-candidates"]]:
        fail("static component archive differs from its canonical link unit")
    return [DefaultInfo(files = depset([ctx.file.archive])), MobileComponentInfo(identity = ctx.attr.identity, configuration = ctx.attr.configuration, source = json.decode(ctx.attr.source), archive = ctx.file.archive)]

_component = rule(implementation = _component_impl, attrs = {"identity": attr.string(mandatory = True), "configuration": attr.string(mandatory = True), "source": attr.string(mandatory = True), "archive": attr.label(mandatory = True, allow_single_file = [".a"])})

def mobile_static_component(name, identity, archive, source):
    _component(name = name, identity = identity, archive = archive, source = json.encode(source), configuration = MOBILE_EXTENSION_CONFIGURATION, target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)

_REGISTRATION_HELPERS = native_extension_carrier_helpers() + ["//:src/extensions/artifacts/native/tools/ios-extension-registration.mts"]

_member = rule(implementation = _member_impl, toolchains = use_cc_toolchain() + BUN_SOURCE_TOOLCHAINS,
    attrs = {"sql_name": attr.string(mandatory = True), "stem": attr.string(mandatory = True),
             "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]),
             "configuration": attr.string(mandatory = True), "archive": attr.label(mandatory = True, allow_single_file = [".a"]),
             "apple": attr.bool(), "aliases": attr.string_dict(), "nm": attr.label(mandatory = True, allow_single_file = True, cfg = "exec"),
             "nm_runtime": attr.label_list(allow_files = True, cfg = "exec"),
             "_registration": attr.label(default = "//build_defs/extensions:mobile_registration.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = _REGISTRATION_HELPERS, allow_files = True)}, fragments = ["cpp"])

def native_mobile_extension(name, sql_name, srcs, hdrs = [], deps = [], copts = [], includes = [], defines = [], linkopts = [], object_roots = [], consumer_deps = None):
    """Compile the existing units with the static hook namespace and target SDK."""
    descriptor = _descriptor(sql_name)
    stem = descriptor.get("native-module-file", "")
    if not stem.endswith(".so"):
        fail("SQL-only members do not have a static compiler target")
    stem = stem[:-3]
    aliases = NATIVE_MOBILE_MEMBER_ALIASES[sql_name]
    prefix = "oliphaunt_static_" + stem.replace("-", "_")
    local_defines = ["Pg_magic_func=" + prefix + "_Pg_magic_func", "_PG_init=" + prefix + "__PG_init"]
    local_defines += [key + "=" + value for key, value in aliases.items()]
    cc_library(name = name + "_objects", srcs = srcs, hdrs = hdrs,
               deps = ["//src/native/runtime:postgres_embedded_headers"] + deps, includes = includes, defines = defines,
               local_defines = local_defines, copts = copts + NATIVE_COPTS + ["-g0"], alwayslink = True,
               target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    archive = "oliphaunt_extension_" + stem
    mobile_static_archive(name = archive, roots = [":" + name + "_objects"] + object_roots, target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    _member(name = name, sql_name = sql_name, stem = stem, owner = extension_identity(sql_name), configuration = MOBILE_EXTENSION_CONFIGURATION,
            archive = ":" + archive, aliases = aliases,
            apple = select({condition: True for condition in _APPLE} | {"//conditions:default": False}),
            nm = select({condition: "@native_apple_sdk//:tools/nm_files" for condition in _APPLE} | {"//conditions:default": "@android_ndk//:nm"}),
            nm_runtime = select({condition: ["@native_apple_sdk//:toolchain_files"] for condition in _APPLE} | {"//conditions:default": []}),
            target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_import(name = name + "_import", static_library = ":" + archive, alwayslink = True, target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_library", deps = [":" + name + "_import"] + (deps if consumer_deps == None else consumer_deps), linkopts = linkopts, target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)

def _registry_impl(ctx):
    members = [target[MobileExtensionInfo] for target in ctx.attr.members]
    names = sorted([member.sql_name for member in members])
    if names != sorted(ctx.attr.sql_names) or len(names) != len({name: True for name in names}):
        fail("static registry must include every selected actual member once")
    if len({member.configuration: True for member in members}) != 1:
        fail("static registry cannot mix target configurations")
    output = ctx.actions.declare_file(ctx.label.name + ".c")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"registrations": [member.registration.path for member in members], "source": output.path}))
    bun_file_action(ctx, ctx.file._registration, arguments = [specification.path],
                    source_files = [ctx.file._registration] + ctx.files._helpers,
                    inputs = [specification] + [member.registration for member in members], outputs = [output], mnemonic = "MobileExtensionCombinedRegistry")
    return [DefaultInfo(files = depset([output]))]

mobile_extension_registry = rule(implementation = _registry_impl, toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {"members": attr.label_list(mandatory = True, providers = [MobileExtensionInfo]), "sql_names": attr.string_list(mandatory = True),
             "_registration": attr.label(default = "//build_defs/extensions:mobile_registration.mts", allow_single_file = True),
             "_helpers": attr.label_list(default = _REGISTRATION_HELPERS, allow_files = True)})
