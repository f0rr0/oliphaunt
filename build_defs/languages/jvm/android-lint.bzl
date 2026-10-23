"""Android debug Lint over the actual native library and pinned official model."""

load("@oliphaunt_kotlin_manifest//:metadata.bzl", "KOTLIN", "KOTLIN_QUALITY")
load("@rules_android//providers:providers.bzl", "AndroidIdeInfo")
load("@rules_java//java/common:java_info.bzl", "JavaInfo")
load("@rules_jvm_external//:providers.bzl", "MavenInfo")
load("@rules_jvm_external//private/rules:has_maven_deps.bzl", "calculate_artifact_jars", "has_maven_deps")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

_JAVA_RUNTIME = "@bazel_tools//tools/jdk:runtime_toolchain_type"

def _android_lint_test_impl(ctx):
    runtime = ctx.toolchains[_JAVA_RUNTIME].java_runtime
    java = [file for file in runtime.files.to_list() if file.path == runtime.java_executable_exec_path]
    if len(java) != 1:
        fail("Android Lint requires the declared Java runtime executable")
    metadata = {
        "agpVersion": KOTLIN_QUALITY["lint"]["agpVersion"],
        "namespace": KOTLIN["namespace"],
        "jvmTarget": KOTLIN["jvmTarget"],
        "languageVersion": KOTLIN["languageVersion"],
        "compileSdk": KOTLIN["compileSdk"],
        "minSdk": ctx.attr.min_sdk if ctx.attr.min_sdk else KOTLIN["minSdk"],
        "expectIssue": ctx.attr.expect_issue,
    }
    arguments = [java[0], json.encode(metadata)]
    # The Kotlin compiler's implicit runtime must not contaminate Lint's
    # isolated upstream Kotlin/UAST dependencies. Only helper classes join it.
    tools = ctx.attr._model[JavaInfo].runtime_output_jars + ctx.attr._lint[JavaInfo].transitive_runtime_jars.to_list()
    for jar in tools:
        arguments += ["tool", jar]
    classes = depset(transitive = [depset(target[JavaInfo].runtime_output_jars) for target in [ctx.attr.library] + ctx.attr.additional_classes]).to_list()
    if not classes:
        fail("Android Lint requires the actual native compiled library")
    for jar in classes:
        arguments += ["class", jar]
    info = ctx.attr.library[MavenInfo]
    libraries = {}
    jars = []
    for dependency in info.all_infos.to_list():
        if dependency.coordinates == None:
            continue
        if dependency.coordinates == "STOPPED":
            fail("Android Lint cannot omit a declared Maven dependency")
        physical = calculate_artifact_jars(dependency)
        record = struct(jars = physical, dependencies = dependency.maven_deps.to_list())
        previous = libraries.get(dependency.coordinates)
        if previous != None and previous != record:
            fail("Android Lint has conflicting actual Maven facts for " + dependency.coordinates)
        libraries[dependency.coordinates] = record
    for coordinate in sorted(libraries):
        record = libraries[coordinate]
        if not record.jars:
            fail("Android Lint Maven dependency has no declared runtime JAR: " + coordinate)
        arguments += ["library", coordinate, json.encode(record.dependencies), str(len(record.jars))] + record.jars
        jars.extend(record.jars)
    for coordinate in info.maven_deps.to_list():
        arguments += ["dependency", coordinate]
    merged_manifest = ctx.attr.library[AndroidIdeInfo].generated_manifest or ctx.file.manifest
    arguments += ["manifest", ctx.file.manifest, "merged-manifest", merged_manifest]
    for file in ctx.files.proguard:
        arguments += ["proguard", file]
    files = []
    for kind, declared in [("source", ctx.files.srcs), ("generated", ctx.files.generated_srcs), ("conventional", ctx.files.conventional_files)]:
        for file in declared:
            if kind == "generated":
                member = file.short_path.replace("../", "external/")
            elif file.short_path.startswith(ctx.label.package + "/"):
                member = file.short_path[len(ctx.label.package) + 1:]
            else:
                fail("Android Lint authored sources must belong to their declared owner")
            arguments += [kind, member, file]
            files.append(file)
    for file in ctx.files._sdk:
        arguments += ["sdk", file.short_path.split("/", 2)[2], file]
        files.append(file)
    inputs = files + classes + jars + tools + runtime.files.to_list() + [ctx.file.manifest, merged_manifest] + ctx.files.proguard
    # A complete SDK platform exceeds operating-system argv limits. Keep the
    # same declared facts in a response file instead of expanding them in argv.
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode([
        {"file": argument.short_path[3:] if argument.short_path.startswith("../") else ctx.workspace_name + "/" + argument.short_path}
        if type(argument) == "File" else {"literal": argument}
        for argument in arguments
    ]) + "\n")
    return bun_test_entrypoint(ctx, ctx.file._runner, [specification], inputs + [specification],
                               runfiles_argument = True, source_files = [ctx.file._runner])

_android_lint_test = rule(
    implementation = _android_lint_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_JAVA_RUNTIME],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "library": attr.label(mandatory = True, providers = [JavaInfo, AndroidIdeInfo], aspects = [has_maven_deps]),
        "additional_classes": attr.label_list(providers = [JavaInfo]),
        "srcs": attr.label_list(allow_files = [".kt", ".java", ".aidl"], mandatory = True),
        "generated_srcs": attr.label_list(allow_files = [".kt", ".java"]),
        "conventional_files": attr.label_list(allow_files = True),
        "manifest": attr.label(mandatory = True, allow_single_file = [".xml"]),
        "proguard": attr.label_list(allow_files = True),
        "min_sdk": attr.int(),
        "expect_issue": attr.string(),
        "_sdk": attr.label(default = "@oliphaunt_android_sdk_archive//:lint_inputs"),
        "_lint": attr.label(default = "@oliphaunt_android_lint_maven//:com_android_tools_lint_lint_gradle", providers = [JavaInfo]),
        "_model": attr.label(default = "//build_defs/languages/jvm:lint_model", providers = [JavaInfo], cfg = "exec"),
        "_runner": attr.label(default = "//build_defs/languages/jvm:android-lint.mts", allow_single_file = True),
    }),
)

def kotlin_android_lint_test(name, **kwargs):
    _android_lint_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
