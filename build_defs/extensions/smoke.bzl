"""SQL proof from selected candidate payloads and canonical lifecycle fixtures."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSIONS", "EXTENSION_COMPATIBILITY", "EXTENSION_RECIPES", "PRODUCTS")
load("@rules_shell//shell:sh_test.bzl", "sh_test")
load("//build_defs/extensions:platforms.bzl", NATIVE_EXTENSION_COMPATIBLE = "NATIVE_EXTENSION_LINUX_COMPATIBLE", _desktop_compatible = "NATIVE_EXTENSION_COMPATIBLE")
load(":extensions.bzl", "ExtensionMemberInfo", "extension_default_version", "extension_native_dependency_modules")
load(":construction.bzl", "desktop_member_payloads")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action", "bun_script_test")

def _smoke_plan_impl(ctx):
    fixtures = {file.basename[:-4]: file for file in ctx.files.fixtures}
    members = []
    selected = {}
    for target in ctx.attr.members:
        member = target[ExtensionMemberInfo]
        name = member.sql_name
        if name in selected:
            fail("candidate smoke plan repeats %s" % name)
        selected[name] = True
        if name not in fixtures:
            fail("candidate smoke plan lacks an independent SQL fixture for %s" % name)
        matches = [row for row in EXTENSIONS.values() if row["sql-name"] == name]
        if len(matches) != 1:
            fail("candidate smoke plan lacks canonical descriptor for %s" % name)
        descriptor = matches[0]
        if ctx.attr.host_version:
            contrib = descriptor["source-kind"] == "postgres-contrib"
            requirement = PRODUCTS[member.owner]["version"] if contrib else EXTENSION_COMPATIBILITY[name]["native_runtime_version"]
            product = member.owner if contrib else EXTENSION_COMPATIBILITY[name]["native_runtime_product"]
            if product != ctx.attr.host_product:
                fail("%s declares native host product %s, not supplied immutable host %s" % (name, product, ctx.attr.host_product))
            if requirement != ctx.attr.host_version:
                fail("%s declares native host %s, not supplied immutable host %s" % (name, requirement, ctx.attr.host_version))
        members.append({
            "sql_name": name,
            "default_version": extension_default_version(name),
            "dependencies": descriptor.get("dependencies", []),
            "lifecycle": descriptor["lifecycle"],
            "fixture": fixtures[name].path,
            "runtime_environment": EXTENSION_RECIPES.get(name, {}).get("runtime_environment", []),
            "dependency_modules": ["lib/postgresql/" + basename for basename in extension_native_dependency_modules(EXTENSION_RECIPES.get(name, {}).get("artifacts", {}).get("native_dependency_modules", []), member.configuration)],
        })
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"schema": "oliphaunt-native-extension-smoke-plan-v1", "members": members}))
    install = ctx.actions.declare_file(ctx.label.name + ".install.sql")
    smoke = ctx.actions.declare_file(ctx.label.name + ".smoke.sql")
    startup = ctx.actions.declare_file(ctx.label.name + ".startup.txt")
    environment = ctx.actions.declare_file(ctx.label.name + ".environment.tsv")
    dependencies = ctx.actions.declare_file(ctx.label.name + ".dependencies.tsv")
    args = ctx.actions.args()
    args.add("--spec", spec)
    args.add("--install", install)
    args.add("--smoke", smoke)
    args.add("--startup", startup)
    args.add("--environment", environment)
    args.add("--dependencies", dependencies)
    bun_action(
        ctx, ctx.attr._generator,
        inputs = depset([spec] + [fixtures[row["sql_name"]] for row in members]),
        outputs = [install, smoke, startup, environment, dependencies],
        arguments = [args],
        mnemonic = "NativeExtensionSmokePlan",
    )
    return [DefaultInfo(files = depset([install, smoke, startup, environment, dependencies])), OutputGroupInfo(
        install = depset([install]), smoke = depset([smoke]), startup = depset([startup]),
        environment = depset([environment]),
        dependencies = depset([dependencies]),
    )]

extension_smoke_plan = rule(
    implementation = _smoke_plan_impl,
    attrs = {
        "members": attr.label_list(mandatory = True, providers = [ExtensionMemberInfo]),
        "fixtures": attr.label_list(mandatory = True, allow_files = [".sql"]),
        "host_version": attr.string(),
        "host_product": attr.string(),
        "_generator": attr.label(default = "//build_defs/extensions:smoke_plan", providers = [BunScriptInfo], cfg = "exec"),
    },
)

def native_extension_sql_test(name, members, runtime = "//src/native/runtime:runtime_payload", consumer = "//build_defs/extensions:native_extension_smoke", host_version = "", host_product = "", runtime_prefix = ".", library_prefix = "lib", target_compatible_with = NATIVE_EXTENSION_COMPATIBLE):
    """Exercise selected archives in the embedded and ordinary PG ABI profiles."""
    plan = name + "_plan"
    if bool(host_version) != bool(host_product):
        fail("immutable host tests require both the canonical product and version")
    for prefix in [runtime_prefix, library_prefix]:
        if prefix != "." and any([not part or part in [".", ".."] or "\\" in part for part in prefix.split("/")]):
            fail("native host layout must use a safe carrier-relative directory")
    extension_smoke_plan(name = plan, members = members, fixtures = ["//src/test-fixtures/extensions:sql"], host_version = host_version, host_product = host_product)
    plans = []
    for group in ["install", "smoke", "startup", "environment", "dependencies"]:
        label = name + "_" + group
        native.filegroup(name = label, srcs = [":" + plan], output_group = group)
        plans.append(":" + label)
    archives = []
    for index, member in enumerate(members):
        label = name + "_archive_" + str(index)
        native.filegroup(name = label, srcs = [member], output_group = "archive")
        archives.append(":" + label)
    data = [runtime, consumer] + plans + archives
    sh_test(
        name = name,
        srcs = ["//build_defs/extensions:native_extension_all_sql_test.sh"],
        args = ["$(location %s)" % label for label in [runtime, consumer] + plans] +
               [runtime_prefix, library_prefix] + ["$(location %s)" % label for label in archives],
        data = data,
        size = "medium",
        target_compatible_with = target_compatible_with,
    )

def desktop_members_sql_test(name, runtime = "//src/native/runtime:runtime_payload", consumer = "//build_defs/extensions:native_extension_smoke", host_version = "", host_product = "", runtime_prefix = ".", library_prefix = None, published_runtime = False, include_postgis = False, target_compatible_with = _desktop_compatible):
    """Use the maintained SQL plan and consumer on each native desktop host."""
    if bool(host_version) != bool(host_product) or published_runtime != bool(host_version):
        fail("published desktop host tests require the canonical host product and version")
    for prefix in [runtime_prefix] + ([library_prefix] if library_prefix != None else []):
        if prefix != "." and any([not part or part in [".", ".."] or "\\" in part or ":" in part for part in prefix.split("/")]):
            fail("desktop host layout must use a safe carrier-relative directory")
    library_args = select({"//build_defs/native:windows_x64": ["--library-prefix=bin"], "//conditions:default": ["--library-prefix=lib"]}) if library_prefix == None else ["--library-prefix=" + library_prefix]
    members = desktop_member_payloads(include_postgis)
    plan = name + "_plan"
    extension_smoke_plan(name = plan, members = members, fixtures = ["//src/test-fixtures/extensions:sql"], host_version = host_version, host_product = host_product)
    plans = []
    for group in ["install", "smoke", "startup", "environment", "dependencies"]:
        label = name + "_" + group
        native.filegroup(name = label, srcs = [":" + plan], output_group = group)
        plans.append(":" + label)
    archives = []
    for index, member in enumerate(members):
        label = name + "_archive_" + str(index)
        native.filegroup(name = label, srcs = [member], output_group = "archive")
        archives.append(":" + label)
    inventory = "//build_defs/extensions:desktop_all_members_construction_inventory" if include_postgis else "//build_defs/extensions:desktop_members_construction_inventory"
    inputs = [runtime, consumer] + plans + [inventory] + archives
    bun_script_test(
        name = name,
        entry_point = "//build_defs/extensions:desktop_sql.test.mts",
        args = ["--runtime-prefix=" + runtime_prefix] + library_args +
               (["--published-runtime"] if published_runtime else []) + ["$(location %s)" % label for label in inputs],
        data = inputs + [
            "//build_defs/extensions:construction.mts", "//build_defs/extensions:validate_member_payload.mts",
            "//build_defs/native:host-runtime-test-helpers.mts", "//:tools/packaging/portable-archive.mts",
            "//:tools/packaging/platform-binary-contract.mts", "//:tools/packaging/windows-vc-runtime-closure.mts",
            "//:tools/packaging/windows-vc-runtime-policy.json", "//tools/release:platform-compatibility-policy.mts",
            "//:src/extensions/artifacts/native/tools/stage-windows-binary-contract.mts",
        ],
        size = "medium",
        target_compatible_with = target_compatible_with,
    )
