"""Maven envelopes over real maintained Java/Kotlin/Android construction outputs."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "PUBLICATION_CARRIERS")
load("@oliphaunt_kotlin_manifest//:metadata.bzl", "KOTLIN")
load("@rules_java//java/common:java_info.bzl", "JavaInfo")
load("@rules_jvm_external//:providers.bzl", "MavenInfo")
load("@rules_jvm_external//private/rules:has_maven_deps.bzl", "has_maven_deps")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:mobile-compiled-inputs.bzl", "MOBILE_BINDINGS_COMPILE_OWNERS", "MOBILE_BINDINGS_COMPILE_QUALIFICATION", "MobileCompiledInputsInfo", "merge_mobile_compiled_inputs", "mobile_bindings_compile_group", "mobile_bindings_compiled_supplier", "mobile_compiled_inputs")
load("//build_defs/native/carriers:defs.bzl", "native_carrier_helpers")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "merge_shipping_suppliers")

_JAVA_RUNTIME = "@bazel_tools//tools/jdk:runtime_toolchain_type"
KOTLIN_BINDINGS_COMPILE_SLOTS = ["android-arm64-v8a", "android-x86_64", "host-generator"]

def _javadoc_impl(ctx):
    runtime = ctx.toolchains[_JAVA_RUNTIME].java_runtime
    classpath = depset(transitive = [dep[JavaInfo].transitive_compile_time_jars for dep in ctx.attr.deps])
    spec = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(spec, json.encode({"sources": [file.path for file in ctx.files.srcs], "classpath": [file.path for file in classpath.to_list()], "javaHome": runtime.java_home, "release": KOTLIN["jvmTarget"]}))
    output = ctx.actions.declare_file(ctx.label.name + ".zip")
    bun_file_action(
        ctx,
        entry_point = ctx.file._driver,
        source_files = [ctx.file._driver] + ctx.files._helpers,
        arguments = [output.path, spec.path],
        inputs = depset(ctx.files.srcs + [spec, ctx.file._driver] + ctx.files._helpers, transitive = [classpath, runtime.files]),
        outputs = [output],
        mnemonic = "OliphauntPluginJavadoc",
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([output]))]

java_javadoc = rule(
    implementation = _javadoc_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_JAVA_RUNTIME],
    attrs = {
        "srcs": attr.label_list(allow_files = [".java"], mandatory = True),
        "deps": attr.label_list(providers = [JavaInfo]),
        "_driver": attr.label(default = Label("//build_defs/languages/jvm:javadoc.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label("//:tools/packaging/archive-directory.mts"), Label("//:tools/packaging/portable-archive.mts")], allow_files = True),
    },
)

def _maven_package_impl(ctx):
    owner = PRODUCTS["oliphaunt-kotlin"]
    group, artifact = ctx.attr.coordinate.split(":")
    version = owner["version"]
    packaging = ctx.attr.packaging
    suffixes = [".pom"] if packaging == "pom" else ["." + packaging, ".pom", "-sources.jar", "-javadoc.jar"] + ([".module"] if packaging == "jar" else [])
    relative = group.replace(".", "/") + "/" + artifact + "/" + version + "/" + artifact + "-" + version
    files = [ctx.actions.declare_file(ctx.label.name + "/maven/" + relative + suffix) for suffix in suffixes]
    root = files[0].path.removesuffix(relative + suffixes[0])
    sources = {}
    for file in ctx.files.sources:
        member = file.short_path
        authored = False
        for prefix in [ctx.label.package + "/src/main/java/", ctx.label.package + "/oliphaunt/src/commonMain/kotlin/", ctx.label.package + "/oliphaunt/src/androidMain/kotlin/", ctx.label.package + "/oliphaunt/src/androidMain/aidl/"]:
            if member.startswith(prefix):
                member = member[len(prefix):]
                authored = True
                break
        if not authored:
            member = "generated/" + file.basename
        if member in sources:
            fail("Duplicate Maven source member " + member)
        sources[member] = file.path
    legal = {file.short_path: file.path for file in ctx.files.legal_sources}
    class_jars = depset(transitive = [depset(dep[JavaInfo].runtime_output_jars) for dep in ctx.attr.classes]).to_list()
    inputs = ctx.files.sources + ctx.files.legal_sources + class_jars + [ctx.file._packager] + ctx.files._helpers
    native = {}
    if ctx.file.android_aar:
        inputs.append(ctx.file.android_aar)
    for target, abi in ctx.attr.native_libraries.items():
        physical = target[DefaultInfo].files.to_list()
        if len(physical) != 1 or abi in native:
            fail("Each unique Android ABI must bind one declared mobile library")
        native[abi] = physical[0].path
        inputs.extend(physical)
    coroutines_jar = None
    coroutines_coordinates = None
    if ctx.attr.coroutines_jvm:
        coroutines = ctx.attr.coroutines_jvm
        library = KOTLIN["libraries"]["kotlinx-coroutines-core"]
        coroutines_coordinates = coroutines[MavenInfo].coordinates
        if coroutines_coordinates != library["module"] + "-jvm:" + library["version"]:
            fail("Declared JVM coroutine dependency differs from canonical Kotlin coordinates")
        jars = coroutines[JavaInfo].runtime_output_jars
        if len(jars) != 1:
            fail("Declared JVM coroutine dependency must provide exactly one runtime JAR")
        coroutines_jar = jars[0]
        inputs.append(coroutines_jar)
    if ctx.file.javadoc:
        inputs.append(ctx.file.javadoc)
    spec = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(spec, json.encode({
        "version": version, "registryPackages": owner["registry_packages"], "coordinate": ctx.attr.coordinate,
        "kotlin": KOTLIN, "sources": sources, "legalSources": legal,
        "classJars": [file.path for file in class_jars], "nativeLibraries": native,
        "androidAar": ctx.file.android_aar.path if ctx.file.android_aar else None,
        "coroutinesJvm": coroutines_jar.path if coroutines_jar else None,
        "coroutinesCoordinates": coroutines_coordinates,
        "javadocArchive": ctx.file.javadoc.path if ctx.file.javadoc else None,
    }))
    bun_file_action(
        ctx,
        entry_point = ctx.file._packager,
        source_files = [ctx.file._packager] + ctx.files._helpers,
        arguments = [root, spec.path],
        inputs = depset(inputs + [spec]),
        outputs = files,
        mnemonic = "OliphauntMavenEnvelope",
        use_default_shell_env = False,
    )
    observed = []
    for target in ctx.attr.sources:
        if MobileCompiledInputsInfo in target:
            observed.append(target[MobileCompiledInputsInfo])
        else:
            source_files = target[DefaultInfo].files.to_list()
            if len(source_files) != 1 or not source_files[0].is_source or source_files[0].owner != target.label:
                fail("Maven source rule lacks its original compiler input observation: " + str(target.label))
    compiled = merge_mobile_compiled_inputs(observed + [target[MobileCompiledInputsInfo] for target in ctx.attr.native_libraries])
    if packaging == "aar":
        expected = [mobile_bindings_compile_group(owner, slot) for owner in MOBILE_BINDINGS_COMPILE_OWNERS for slot in KOTLIN_BINDINGS_COMPILE_SLOTS]
        if sorted(compiled.files) != sorted(expected) or sorted(compiled.upstream) != sorted(expected):
            fail("Kotlin AAR must retain its complete original Rust compiler File inventory")
    suppliers = merge_shipping_suppliers([ctx.attr.suppliers[ShippingSupplierInfo], compiled.current, compiled.registry])
    return [DefaultInfo(files = depset(files)), compiled, suppliers,
            OutputGroupInfo(archive = depset([files[0]]) if packaging != "pom" else depset(), **{name: depset([file]) for name, file in compiled.files.items()})]

_maven_package = rule(
    implementation = _maven_package_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "coordinate": attr.string(mandatory = True),
        "packaging": attr.string(mandatory = True, values = ["aar", "jar", "pom"]),
        "sources": attr.label_list(allow_files = True, aspects = [mobile_compiled_inputs]),
        "legal_sources": attr.label_list(allow_files = True),
        "classes": attr.label_list(providers = [JavaInfo]),
        "android_aar": attr.label(allow_single_file = [".aar"]),
        "native_libraries": attr.label_keyed_string_dict(allow_files = True, aspects = [mobile_compiled_inputs]),
        "suppliers": attr.label(default = "//build_defs/release:no_suppliers", providers = [ShippingSupplierInfo]),
        "coroutines_jvm": attr.label(providers = [JavaInfo], aspects = [has_maven_deps]),
        "javadoc": attr.label(allow_single_file = True),
        "_packager": attr.label(default = Label("//build_defs/languages/jvm:maven-package.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [
            Label("//build_defs/languages/jvm:maven-pom.mts"), Label("//build_defs/languages:mobile-legal.mts"),
            Label("//src/native/sdks/kotlin:tools/kotlin-maven-staging.mts"), Label("//src/native/mobile-bindings:tools/dependency-license-contract.mts"),
            Label("//:tools/packaging/maven-central-contract.mts"), Label("//:tools/packaging/archive-directory.mts"), Label("//:tools/packaging/portable-archive.mts"),
            Label("//:tools/packaging/platform-binary-contract.mts"), Label("//:tools/packaging/windows-vc-runtime-closure.mts"), Label("//tools/release:platform-compatibility-policy.mts"),
            Label("//:tools/packaging/windows-vc-runtime-policy.json"),
            Label("//:tools/packaging/release-notices.mts"), Label("//:tools/packaging/release-directory-safety.mts"), Label("//:tools/packaging/rust-dependency-license-contract.mts"),
        ], allow_files = True),
    },
)

def kotlin_maven_package(name, coordinate, packaging, **kwargs):
    carriers = [row for row in PUBLICATION_CARRIERS if row["product"] == "oliphaunt-kotlin" and row["ecosystem"] == "maven" and row["name"] == coordinate and row["target"] == None]
    if len(carriers) != 1:
        fail("Canonical Maven package identity is not unique: " + coordinate)
    _maven_package(name = name, coordinate = coordinate, packaging = packaging, **kwargs)
    if packaging != "pom":
        native.filegroup(name = name + "_archive", srcs = [":" + name], output_group = "archive")
    shipping_package(
        name = name + "_shipping",
        owner = "@oliphaunt_metadata//:product_oliphaunt-kotlin",
        artifacts = [":" + name], ecosystem = "maven", package_name = coordinate, configuration = "portable", role = carriers[0]["role"],
        suppliers = ":" + name,
    )
    if packaging == "aar":
        exports = []
        for owner, product in MOBILE_BINDINGS_COMPILE_OWNERS.items():
            packages = []
            for slot in KOTLIN_BINDINGS_COMPILE_SLOTS:
                group = mobile_bindings_compile_group(owner, slot)
                native.filegroup(name = name + "_" + group, srcs = [":" + name], output_group = group)
                supplier = name + "_" + group + "_suppliers"
                mobile_bindings_compiled_supplier(name = supplier, inputs = ":" + name, owner = owner, configuration = slot)
                package = name + "_" + group + "_shipping"
                shipping_package(name = package, owner = "@oliphaunt_metadata//:product_" + product, artifacts = [":" + name + "_" + group],
                                 ecosystem = "internal", package_name = product + "-kotlin-bindings", configuration = slot, role = "compiled-source", suppliers = ":" + supplier)
                packages.append(":" + package)
            export = name + "_" + owner + "_compiled_shipping_export"
            shipping_export(name = export, packages = packages, qualification = MOBILE_BINDINGS_COMPILE_QUALIFICATION[owner], testonly = True)
            exports.append(":" + export)
        shipping_export(name = name + "_compiled_shipping_export", exports = exports, testonly = True)

def _installed_maven_test_impl(ctx):
    arguments = [PRODUCTS["oliphaunt-kotlin"]["version"]]
    artifacts = ctx.files.packages
    for file in artifacts:
        parts = file.short_path.split("/maven/", 1)
        if len(parts) != 2:
            fail("Installed Kotlin package must provide declared Maven repository files: " + file.short_path)
        arguments += ["maven", parts[1], file]
    consumer = ctx.attr.consumer[JavaInfo].runtime_output_jars
    if not consumer:
        fail("Installed Kotlin public API consumer must provide compiled JARs")
    for file in consumer:
        arguments += ["consumer", file]
    for file in ctx.files._legal:
        arguments += ["legal", file.short_path, file]
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, artifacts + consumer + ctx.files._helpers + ctx.files._legal,
                              source_files = [ctx.file._runner] + ctx.files._helpers)

_kotlin_installed_maven_test = rule(
    implementation = _installed_maven_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "packages": attr.label_list(mandatory = True),
        "consumer": attr.label(mandatory = True, providers = [JavaInfo]),
        "_runner": attr.label(default = "//build_defs/languages/jvm:installed-maven.test.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = native_carrier_helpers() + [
            "//build_defs/languages:mobile-legal.mts",
            "//src/native/sdks/kotlin:tools/check-package.mts", "//src/native/sdks/kotlin:tools/kotlin-maven-staging.mts",
            "//:tools/packaging/maven-central-contract.mts",
        ], allow_files = True),
        "_legal": attr.label_list(default = ["//:LICENSE", "//:THIRD_PARTY_NOTICES.md", "//:Cargo.lock", "//src/native/mobile-bindings:license_inputs"], allow_files = True),
    }),
)

def kotlin_installed_maven_test(name, **kwargs):
    """Final Maven contract plus compilation of the imported public Android AAR."""
    _kotlin_installed_maven_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
