"""Native member construction; publication ownership stays in imported metadata."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "CONTRIB_OWNERS", "EXTENSIONS", "EXTENSION_PROFILES", "EXTENSION_RECIPES", "EXTENSION_SOURCES", "POSTGRES_SOURCE")
load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "bun_script_test")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", _native_configuration = "NATIVE_EXTENSION_CONFIGURATION")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")

ExtensionMemberInfo = provider(fields = ["sql_name", "configuration", "owner", "inventory", "archive"])
NATIVE_EXTENSION_CONFIGURATION = _native_configuration

def _descriptor(sql_name):
    for descriptor in EXTENSIONS.values():
        if descriptor["sql-name"] == sql_name:
            return descriptor
    fail("SQL member %s is absent from the canonical extension catalog" % sql_name)

def _extension_product(sql_name, family = "native"):
    descriptor = _descriptor(sql_name)
    if descriptor["source-kind"] == "postgres-contrib":
        product = CONTRIB_OWNERS[family]
    else:
        product = EXTENSION_SOURCES[sql_name]["product"]
    return product

def extension_identity(sql_name, family = "native"):
    return "@oliphaunt_metadata//:product_" + _extension_product(sql_name, family)

def extension_default_version(sql_name):
    descriptor = _descriptor(sql_name)
    if descriptor["source-kind"] == "postgres-contrib":
        members = [member for member in CONTRIB_MEMBERS if member["sql-name"] == sql_name]
        if len(members) != 1:
            fail("contrib member must occur exactly once in its canonical distribution")
        return members[0].get("default-version")
    return EXTENSION_SOURCES[sql_name]["extension-control"]["default-version"]

def _require_native_profile(ctx):
    if not ctx.target_platform_has_constraint(ctx.attr._linux[platform_common.ConstraintValueInfo]):
        fail("this native construction slice requires a qualified Linux platform")
    if ctx.target_platform_has_constraint(ctx.attr._x86_64[platform_common.ConstraintValueInfo]):
        configuration = "linux-x64-gnu"
    elif ctx.target_platform_has_constraint(ctx.attr._aarch64[platform_common.ConstraintValueInfo]):
        configuration = "linux-arm64-gnu"
    else:
        fail("this native construction slice has no qualified configuration for this CPU")
    if POSTGRES_SOURCE["postgresql"]["version"].split(".")[0] != "18":
        fail("this native extension construction slice supports PostgreSQL 18 only")
    declared = [target for profile in EXTENSION_PROFILES["profiles"] for target in profile["targets"]
                if target["target"] == configuration and target["family"] == "native" and target["kind"] == "native-dynamic"]
    if len(declared) != 1:
        fail("%s native support is absent or duplicated in the canonical target profiles" % configuration)
    return configuration

_PLATFORM_ATTRS = {
    "_linux": attr.label(default = "@platforms//os:linux"),
    "_x86_64": attr.label(default = "@platforms//cpu:x86_64"),
    "_aarch64": attr.label(default = "@platforms//cpu:aarch64"),
}

def _pgtap_sql_impl(ctx):
    configuration = _require_native_profile(ctx)
    directory = ctx.actions.declare_directory(ctx.label.name + ".sql")
    args = ctx.actions.args()
    args.add("--source", ctx.file.control.dirname)
    args.add("--output", directory.path)
    args.add("--os", "linux")
    args.add("--version", extension_default_version("pgtap"))
    perl = ctx.toolchains["@rules_perl//perl:exec_toolchain_type"].perl_runtime
    args.add("--perl", perl.interpreter)
    for option in perl.perlopt:
        args.add("--perl-option=" + option)
    ctx.actions.run(
        executable = ctx.attr._generator[DefaultInfo].files_to_run,
        inputs = depset(ctx.files.inputs + [ctx.file.control], transitive = [perl.runtime]),
        outputs = [directory],
        arguments = [args],
        mnemonic = "PgtapSql",
        progress_message = "Generate pinned pgTAP SQL for %s" % configuration,
    )
    return [DefaultInfo(files = depset([directory]))]

_pgtap_sql = rule(
    implementation = _pgtap_sql_impl,
    attrs = dict(_PLATFORM_ATTRS, **{
        "inputs": attr.label_list(allow_files = True, mandatory = True),
        "control": attr.label(allow_single_file = True, mandatory = True),
        "_generator": attr.label(default = "//build_defs/extensions:pgtap_sql", executable = True, cfg = "exec"),
    }),
    toolchains = ["@rules_perl//perl:exec_toolchain_type"],
)

def pgtap_sql(name, **kwargs):
    _pgtap_sql(name = name, target_compatible_with = NATIVE_EXTENSION_COMPATIBLE, **kwargs)

def _perl_runtime_impl(ctx):
    perl = ctx.toolchains["@rules_perl//perl:exec_toolchain_type"].perl_runtime
    options = ctx.actions.declare_file(ctx.label.name + ".options.json")
    ctx.actions.write(options, json.encode(perl.perlopt))
    return [DefaultInfo(files = depset([options], transitive = [perl.runtime])),
            OutputGroupInfo(interpreter = depset([perl.interpreter]), options = depset([options]))]

extension_perl_runtime = rule(
    implementation = _perl_runtime_impl,
    toolchains = ["@rules_perl//perl:exec_toolchain_type"],
)

def _payload_impl(ctx):
    configuration = _require_native_profile(ctx)
    descriptor = _descriptor(ctx.attr.sql_name)
    identity = ctx.attr.owner[ReleaseIdentityInfo]
    if str(ctx.attr.owner.label) != str(Label(extension_identity(ctx.attr.sql_name))):
        fail("member owner differs from canonical %s carrier ownership" % ctx.attr.sql_name)
    source_kind = descriptor["source-kind"]
    data_files = []
    recipe_artifacts = EXTENSION_RECIPES.get(ctx.attr.sql_name, {}).get("artifacts", {})
    if source_kind == "postgres-contrib":
        members = [member for member in CONTRIB_MEMBERS if member["sql-name"] == ctx.attr.sql_name]
        if len(members) != 1:
            fail("contrib member must occur exactly once in its canonical distribution")
        data_files = members[0].get("data-files", [])
    else:
        data_files = recipe_artifacts.get("data_files", [])
    profiles = []
    mappings = []
    for file in ctx.files.resources:
        if file.is_directory:
            mappings.append({"source": file.path, "destination": "share/postgresql/extension", "tree": True})
        elif file.basename.endswith(".sql") or file.basename.endswith(".control"):
            mappings.append({"source": file.path, "destination": "share/postgresql/extension/" + file.basename})
        else:
            destinations = [destination for destination in data_files if destination.split("/")[-1] == file.basename]
            if len(destinations) != 1:
                fail("resource %s has no unique canonical member destination" % file.basename)
            mappings.append({"source": file.path, "destination": destinations[0]})
    data_inputs = []
    construction_licenses = []
    for target, destination in ctx.attr.construction_licenses.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or not destination.startswith("share/licenses/"):
            fail("construction licenses require one declared file beneath share/licenses")
        mappings.append({"source": files[0].path, "destination": destination})
        data_inputs.append(files[0])
        construction_licenses.append(destination)
    for target, destination in ctx.attr.data_resources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("mapped member data must provide exactly one file or directory")
        file = files[0]
        if file.is_directory:
            if not any([path.startswith(destination + "/") for path in data_files]):
                fail("mapped member data directory is absent from the canonical recipe")
            mappings.append({"source": file.path, "destination": destination, "tree": True})
        else:
            if destination not in data_files:
                fail("mapped member data file is absent from the canonical recipe")
            mappings.append({"source": file.path, "destination": destination})
        data_inputs.append(file)
    module_file = descriptor.get("native-module-file", "")
    module_stem = module_file[:-3] if module_file.endswith(".so") else ""
    if ctx.files.server_module and ctx.files.server_module == ctx.files.embedded_module:
        fail("server and embedded ABI profiles require independently produced module files")
    if ctx.file.main_sql:
        mappings.append({
            "source": ctx.file.main_sql.path,
            "destination": "share/postgresql/extension/%s--%s.sql" % (ctx.attr.sql_name, extension_default_version(ctx.attr.sql_name)),
        })
    for profile, files in [("postgresql", ctx.files.server_module), ("modules", ctx.files.embedded_module)]:
        if files:
            if len(files) != 1 or not module_stem:
                fail("native module must provide exactly one file for a compiled catalog member")
            profiles.append(profile)
            mappings.append({"source": files[0].path, "destination": "lib/%s/%s.so" % (profile, module_stem)})
    if module_stem and profiles != ["postgresql", "modules"]:
        fail("compiled member payload requires independently built server and embedded modules")
    dependency_paths = recipe_artifacts.get("native_dependency_modules", [])
    if sorted([file.basename for file in ctx.files.dependency_modules]) != sorted([path.split("/")[-1] for path in dependency_paths]):
        fail("native dependency modules differ from the canonical extension recipe")
    for file in ctx.files.dependency_modules:
        for profile in profiles:
            mappings.append({"source": file.path, "destination": "lib/%s/%s" % (profile, file.basename)})
    facts = {
        "schema": "oliphaunt-extension-member-payload-v1",
        "sql_name": ctx.attr.sql_name,
        "owner": identity.id,
        "version": identity.version,
        "family": "native",
        "configuration": configuration,
        "source_kind": source_kind,
        "postgres_major": 18,
        "postgres_source": POSTGRES_SOURCE,
        "default_version": extension_default_version(ctx.attr.sql_name),
        "creates_extension": descriptor["lifecycle"]["create-extension"],
        "dependencies": descriptor.get("dependencies", []),
        "module_profiles": profiles,
        "module_file": module_file,
        "dependency_modules": [path.split("/")[-1] for path in dependency_paths],
        "data_files": data_files,
        "sql_prefixes": recipe_artifacts.get("extension_sql_file_prefixes", []),
        "sql_files": recipe_artifacts.get("extension_sql_file_names", []),
    }
    if source_kind != "postgres-contrib":
        facts["source"] = EXTENSION_SOURCES[ctx.attr.sql_name]
    if construction_licenses:
        facts["construction_licenses"] = sorted(construction_licenses)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    archive = ctx.actions.declare_file(ctx.label.name + ".tar.gz")
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    ctx.actions.write(spec, json.encode({"descriptor": facts, "inputs": mappings}))
    args = ctx.actions.args()
    args.add("--spec", spec)
    args.add("--output", archive)
    args.add("--inventory", inventory)
    ctx.actions.run(
        executable = ctx.attr._assembler[DefaultInfo].files_to_run,
        inputs = depset([spec] + ctx.files.resources + ctx.files.main_sql + ctx.files.server_module + ctx.files.embedded_module + ctx.files.dependency_modules + data_inputs),
        outputs = [archive, inventory],
        arguments = [args],
        mnemonic = "ExtensionMemberPayload",
        progress_message = "Assemble %s native member payload" % ctx.attr.sql_name,
    )
    return [DefaultInfo(files = depset([archive, inventory])),
            OutputGroupInfo(archive = depset([archive]), inventory = depset([inventory])),
            ExtensionMemberInfo(sql_name = ctx.attr.sql_name, owner = identity.id,
                                configuration = configuration, inventory = inventory, archive = archive)]

_extension_member_payload = rule(
    implementation = _payload_impl,
    attrs = dict(_PLATFORM_ATTRS, **{
        "sql_name": attr.string(mandatory = True),
        "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]),
        "resources": attr.label_list(allow_files = True, mandatory = True),
        "main_sql": attr.label(allow_single_file = True),
        "server_module": attr.label(allow_files = True),
        "embedded_module": attr.label(allow_files = True),
        "dependency_modules": attr.label_list(allow_files = True),
        "data_resources": attr.label_keyed_string_dict(allow_files = True),
        "construction_licenses": attr.label_keyed_string_dict(allow_files = True),
        "_assembler": attr.label(default = "//build_defs/extensions:member_payload", executable = True, cfg = "exec"),
    }),
)

def extension_member_payload(name, **kwargs):
    _extension_member_payload(name = name, target_compatible_with = NATIVE_EXTENSION_COMPATIBLE, **kwargs)

def extension_member_validation_test(name, payload, sql_name):
    """Validate the actual archive with a reader independent of its assembler."""
    archive = name + "_archive"
    native.filegroup(name = archive, srcs = [payload], output_group = "archive")
    bun_script_test(
        name = name,
        entry_point = "//build_defs/extensions:validate_member_payload.mts",
        args = ["$(location :%s)" % archive, "--sql-name", sql_name,
                "--owner", _extension_product(sql_name)],
        data = [":" + archive, "//:tools/packaging/portable-archive.mts"],
        size = "small",
    )

def _source_headers_impl(ctx):
    return [CcInfo(compilation_context = cc_common.create_compilation_context(
        headers = depset(ctx.files.hdrs),
        includes = depset([ctx.file.include_root.dirname]),
    ))]

extension_source_headers = rule(
    implementation = _source_headers_impl,
    attrs = {
        "hdrs": attr.label_list(allow_files = True, mandatory = True),
        "include_root": attr.label(allow_single_file = True, mandatory = True),
    },
)

def native_extension_modules(name, srcs, hdrs = [], copts = [], deps = [], includes = [], defines = [], linkopts = [], dynamic_deps = []):
    """Compile separate PostgreSQL-server and embedded ABI variants directly."""
    for variant, headers, runtime_deps in [
        ("server", "//src/native/runtime:postgres_server_headers", []),
        ("embedded", "//src/native/runtime:postgres_embedded_headers", ["//src/native/runtime:liboliphaunt"]),
    ]:
        cc_library(
            name = name + "_" + variant + "_objects",
            srcs = srcs,
            hdrs = hdrs,
            deps = [headers] + deps,
            copts = copts,
            includes = includes,
            defines = defines,
            alwayslink = True,
            target_compatible_with = NATIVE_EXTENSION_COMPATIBLE,
        )
        cc_binary(
            name = name + "_" + variant + ".so",
            deps = [":" + name + "_" + variant + "_objects"] + runtime_deps,
            linkshared = True,
            linkstatic = True,
            dynamic_deps = dynamic_deps,
            linkopts = linkopts + (["-Wl,-z,defs"] if variant == "embedded" else []),
            target_compatible_with = NATIVE_EXTENSION_COMPATIBLE,
        )
