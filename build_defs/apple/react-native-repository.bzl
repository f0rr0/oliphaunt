"""Immutable official RN/Hermes release inputs, matched to original npm recipes."""

def _release_impl(ctx):
    source = json.decode(ctx.read(ctx.attr.native_metadata))
    locked = json.decode(ctx.read(ctx.attr.integrities))
    for key in ["reactNativeVersion", "hermesVersion"]:
        if locked[key] != source[key]:
            fail("Refresh immutable Apple release archive integrity for changed original npm " + key)
    version, hermes = source["reactNativeVersion"], source["hermesVersion"]
    for classifier in ["reactnative-core-release", "reactnative-dependencies-release"]:
        url = "https://repo.maven.apache.org/maven2/com/facebook/react/react-native-artifacts/" + version + "/react-native-artifacts-" + version + "-" + classifier + ".tar.gz"
        ctx.download_and_extract(url = url, sha256 = locked["archives"][classifier], output = ".")
    url = "https://repo.maven.apache.org/maven2/com/facebook/hermes/hermes-ios/" + hermes + "/hermes-ios-" + hermes + "-hermes-ios-release.tar.gz"
    ctx.download_and_extract(url = url, sha256 = locked["archives"]["hermes-ios-release"], output = ".")
    ctx.file("BUILD.bazel", """
load("@rules_apple//apple:apple.bzl", "apple_dynamic_xcframework_import")
package(default_visibility = ["//visibility:public"])
exports_files(glob(["React.xcframework/Headers/**", "React.xcframework/*.yaml", "destroot/include/**", "packages/react-native/third-party/ReactNativeDependencies.xcframework/Headers/**"]))
filegroup(name = "react_headers", srcs = glob(["React.xcframework/Headers/**"]))
filegroup(name = "jsi_headers", srcs = ["React.xcframework/Headers/React_jsi/jsi/jsi.h"])
filegroup(name = "hermes_headers", srcs = glob(["destroot/include/**"]))
filegroup(name = "dependency_headers", srcs = glob(["packages/react-native/third-party/ReactNativeDependencies.xcframework/Headers/**"]))
apple_dynamic_xcframework_import(name = "hermes", xcframework_imports = glob(["destroot/Library/Frameworks/universal/hermesvm.xcframework/**"]))
apple_dynamic_xcframework_import(name = "dependencies", xcframework_imports = glob(["packages/react-native/third-party/ReactNativeDependencies.xcframework/**"]))
apple_dynamic_xcframework_import(name = "React", xcframework_imports = glob(["React.xcframework/**"]), deps = [":hermes", ":dependencies"])
""")
    return ctx.repo_metadata(reproducible = True)

react_native_apple_release_repository = repository_rule(implementation = _release_impl, attrs = {
    "native_metadata": attr.label(mandatory = True, allow_single_file = [".json"]),
    "integrities": attr.label(default = Label("//build_defs/apple:react-native-artifacts.json"), allow_single_file = [".json"]),
})
