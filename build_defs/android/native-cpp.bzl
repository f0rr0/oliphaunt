"""Original Expo and RN application C++ sources over declared prefab CcInfo."""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library")

_ANDROID = ["@platforms//os:android"]
_FOLLY_DEFINES = [
    "FOLLY_NO_CONFIG=1",
    "FOLLY_HAVE_CLOCK_GETTIME=1",
    "FOLLY_USE_LIBCPP=1",
    "FOLLY_CFG_NO_COROUTINES=1",
    "FOLLY_MOBILE=1",
    "FOLLY_HAVE_RECVMMSG=1",
    "FOLLY_HAVE_PTHREAD=1",
    "FOLLY_HAVE_XSI_STRERROR_R=1",
]
_RN_COPTS = ["-Wall", "-Werror", "-fexceptions", "-frtti", "-std=c++20"]
_RN_DEFINES = _FOLLY_DEFINES + ["ANDROID", "NDEBUG=1", "LOG_TAG=\"ReactNative\"", "RN_SERIALIZABLE_STATE"]
REACT_NATIVE_RELEASE_DEFINES = _RN_DEFINES
_SHARED_LINKOPTS = ["-Wl,-z,max-page-size=16384", "-Wl,-z,common-page-size=16384", "-Wl,-z,defs"]

def _sources(patterns):
    files = native.glob(patterns, allow_empty = True)
    if not files:
        fail("Original native source selector has no translation units: " + str(patterns))
    return files

def expo_core_cpp(name, root, react_native_deps, fbjni, cxx_runtime, shared_runtime_features, react_native_jni_root, react_native_minor = 85, worklets = None, worklets_include_dirs = []):
    """CMake jsi/main/common selectors, normal release flags and semantic PCH."""
    if bool(worklets) != bool(worklets_include_dirs):
        fail("Expo Worklets integration requires its actual CcInfo and source include directories together")
    if "-static_link_cpp_runtimes" not in shared_runtime_features:
        fail("RN prefab consumers require the maintained NDK's static_link_cpp_runtimes feature disabled and its actual shared runtime CcInfo")
    common = root + "/common/cpp"
    android = root + "/android/src"
    main = android + "/main/cpp"
    pch = main + "/ExpoHeader.pch"
    headers = native.glob([common + "/**/*.h", main + "/**/*.h"]) + native.glob([common + "/**/*.hpp", main + "/**/*.hpp", android + "/fabric/**/*.h"], allow_empty = True)
    copts = ["-std=c++20", "-O2", "-frtti", "-fexceptions", "-Wall", "-fstack-protector-all", "-include", "$(location " + pch + ")"]
    defines = _FOLLY_DEFINES + [
        "ANDROID", "NDEBUG=1", "USE_HERMES=0", "UNIT_TEST=0", "IS_NEW_ARCHITECTURE_ENABLED=1",
        "RN_FABRIC_ENABLED=1", "RN_SERIALIZABLE_STATE=1",
        "REACT_NATIVE_TARGET_VERSION=" + str(react_native_minor),
        "REACT_NATIVE_MINOR_VERSION=" + str(react_native_minor),
    ]
    dependencies = react_native_deps + [fbjni, cxx_runtime]
    cc_library(
        name = name + "_jsi",
        srcs = native.glob([common + "/JSI/*.cpp", android + "/jsi/*.cpp"]),
        hdrs = native.glob([android + "/jsi/*.h"]) + headers,
        textual_hdrs = [pch],
        additional_compiler_inputs = [pch],
        includes = [common + "/JSI", android + "/jsi", common, common + "/fabric", android + "/fabric", react_native_jni_root],
        copts = copts,
        local_defines = defines,
        features = shared_runtime_features,
        deps = dependencies,
        target_compatible_with = _ANDROID,
    )
    cc_library(
        name = name + "_sources",
        srcs = _sources([common + "/*.cpp", common + "/fabric/*.cpp"] +
                           [main + "/" + folder + "*.cpp" for folder in ["", "types/", "javaclasses/", "decorators/", "installers/", "worklets/", "fabric/"]]),
        includes = [react_native_jni_root, android + "/fabric", common, common + "/fabric"] + worklets_include_dirs,
        hdrs = headers,
        textual_hdrs = [pch],
        additional_compiler_inputs = [pch],
        copts = copts,
        local_defines = defines + (["WORKLETS_ENABLED=1"] if worklets else []),
        features = shared_runtime_features,
        deps = dependencies + [":" + name + "_jsi"] + ([worklets] if worklets else []),
        alwayslink = True,
        target_compatible_with = _ANDROID,
    )
    cc_binary(name = "libexpo-modules-core.so", deps = [":" + name + "_sources"],
        features = shared_runtime_features, linkshared = True, linkstatic = True,
        linkopts = _SHARED_LINKOPTS + ["-Wl,-soname,libexpo-modules-core.so", "-llog", "-landroid"], target_compatible_with = _ANDROID)
    return ":libexpo-modules-core.so"

def safe_area_cpp(name, root, generated_sources, generated_headers, generated_include_dirs, react_native_deps, fbjni, cxx_runtime, shared_runtime_features, react_native_copts = [], react_native_defines = []):
    """Upstream Fabric custom sources plus the actual generated codegen Files."""
    common = root + "/common/cpp"
    jni = root + "/android/src/main/jni"
    library = "libreact_codegen_safeareacontext.so"
    cc_library(
        name = name + "_sources",
        srcs = _sources([jni + "/*.cpp", common + "/react/renderer/components/safeareacontext/*.cpp"]) + generated_sources,
        hdrs = native.glob([jni + "/*.h", common + "/**/*.h"]) + generated_headers,
        includes = [jni, common] + generated_include_dirs,
        copts = _RN_COPTS + ["-Wpedantic", "-Wno-gnu-zero-variadic-macro-arguments", "-Wno-dollar-in-identifier-extension"] + react_native_copts,
        local_defines = _RN_DEFINES + react_native_defines,
        features = shared_runtime_features,
        deps = react_native_deps + [fbjni, cxx_runtime],
        alwayslink = True,
        target_compatible_with = _ANDROID,
    )
    cc_binary(name = library, deps = [":" + name + "_sources"], features = shared_runtime_features,
        linkshared = True, linkstatic = True, linkopts = _SHARED_LINKOPTS + ["-Wl,-soname," + library], target_compatible_with = _ANDROID)
    cc_import(name = name + "_shared", shared_library = ":" + library, target_compatible_with = _ANDROID)
    # Its actual headers and shared binary are consumed by application autolinking.
    cc_library(
        name = name,
        hdrs = native.glob([jni + "/*.h", common + "/**/*.h"]) + generated_headers,
        includes = [jni, common] + generated_include_dirs,
        deps = react_native_deps + [fbjni, cxx_runtime, ":" + name + "_shared"],
        target_compatible_with = _ANDROID,
    )
    return ":" + library

def react_native_app_cpp(name, react_native_root, autolinking_sources, autolinking_headers, autolinking_include_dirs, generated_sources, generated_headers, generated_include_dirs, react_native_deps, fbjni, cxx_runtime, shared_runtime_features, native_module_deps, react_native_copts = [], react_native_defines = []):
    """Original RN OnLoad, original generated autolinking and app codegen graph."""
    cc_library(
        name = name + "_sources",
        srcs = native.glob([react_native_root + "/ReactAndroid/cmake-utils/default-app-setup/*.cpp"]) + autolinking_sources + generated_sources,
        hdrs = autolinking_headers + generated_headers,
        includes = autolinking_include_dirs + generated_include_dirs,
        copts = _RN_COPTS + react_native_copts,
        local_defines = _RN_DEFINES + react_native_defines,
        features = shared_runtime_features,
        deps = react_native_deps + [fbjni, cxx_runtime] + native_module_deps,
        alwayslink = True,
        target_compatible_with = _ANDROID,
    )
    cc_binary(name = "libappmodules.so", deps = [":" + name + "_sources"], features = shared_runtime_features,
        linkshared = True, linkstatic = True, linkopts = _SHARED_LINKOPTS + ["-Wl,-soname,libappmodules.so"], target_compatible_with = _ANDROID)
    return ":libappmodules.so"
