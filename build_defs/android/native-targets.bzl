"""Real new-architecture RN/Expo native link graph over locked prefab ABIs."""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library")
load(":app.bzl", "android_aar_native", "android_header_tree", "android_prefab_import", "android_source_headers")
load(":native-cpp.bzl", "REACT_NATIVE_RELEASE_DEFINES", "expo_core_cpp", "react_native_app_cpp", "safe_area_cpp")

_APP = "@oliphaunt//src/examples/native/react-native-expo:"

def _select(arm64, x64):
    return select({"@platforms//cpu:aarch64": arm64, "@platforms//cpu:x86_64": x64})

def _raw(coordinate):
    # The maintained Maven pin exposes each exact downloaded artifact File.
    return "@expo_android_maven//:" + coordinate.replace(".", "_").replace("-", "_").replace(":", "_") + "_extension"

def expo_android_native(metadata):
    rn = _raw("com.facebook.react:react-android:aar:release:" + metadata["reactNative"])
    fbjni = _raw("com.facebook.fbjni:fbjni:aar:" + metadata["fbjni"])
    for platform, abi in [("arm64", "arm64-v8a"), ("x86_64", "x86_64")]:
        for name, aar in [("jsi", rn), ("reactnative", rn), ("fbjni", fbjni)]:
            android_prefab_import(name = name + "_" + platform, aar = aar, abi = abi, module = name)
        android_aar_native(name = "cxx_runtime_" + platform, aar = rn, abi = abi, library = "libc++_shared.so")
        cc_import(name = "cxx_runtime_" + platform + "_import", shared_library = ":cxx_runtime_" + platform)
        android_header_tree(name = "reactnative_includes_" + platform, headers = ":reactnative_" + platform + "_headers", include_suffixes = ["react", "react/fabric"])
    cc_library(name = "react_native_prefab", deps = _select([":jsi_arm64", ":reactnative_arm64", ":reactnative_includes_arm64"], [":jsi_x86_64", ":reactnative_x86_64", ":reactnative_includes_x86_64"]))
    cc_library(name = "fbjni", deps = _select([":fbjni_arm64"], [":fbjni_x86_64"]))
    cc_library(name = "shared_cxx_runtime", deps = _select([":cxx_runtime_arm64_import"], [":cxx_runtime_x86_64_import"]))
    cc_library(name = "react_native_jni_headers", hdrs = native.glob(["packages/react-native/ReactAndroid/src/main/jni/**/*.h"]), includes = ["packages/react-native/ReactAndroid/src/main/jni"])
    dependencies = [":react_native_prefab", ":react_native_jni_headers"]
    shared = ["-static_link_cpp_runtimes"]
    expo_core_cpp(name = "expo_core", root = "packages/expo-modules-core", react_native_deps = dependencies,
                  fbjni = ":fbjni", cxx_runtime = ":shared_cxx_runtime", shared_runtime_features = shared,
                  react_native_jni_root = "packages/react-native/ReactAndroid/src/main/jni",
                  react_native_minor = int(metadata["reactNative"].split(".")[1]))
    cc_library(name = "oliphaunt_codegen", srcs = [_APP + "android_codegen_cpp"],
               hdrs = [_APP + "android_codegen_headers"], deps = dependencies + [":fbjni", ":shared_cxx_runtime", _APP + "android_codegen_includes"],
               features = shared, copts = ["-std=c++20", "-fexceptions", "-frtti"], local_defines = REACT_NATIVE_RELEASE_DEFINES)
    android_source_headers(name = "safe_area_source_includes",
        headers = native.glob(["packages/react-native-safe-area-context/android/src/main/jni/*.h", "packages/react-native-safe-area-context/common/cpp/**/*.h"]),
        include_dirs = ["packages/react-native-safe-area-context/android/src/main/jni", "packages/react-native-safe-area-context/common/cpp"])
    safe_area_cpp(name = "safe_area", root = "packages/react-native-safe-area-context",
                  generated_sources = [_APP + "safe_area_codegen_cpp"], generated_headers = [_APP + "safe_area_codegen_headers"], generated_include_dirs = [],
                  react_native_deps = dependencies + [":safe_area_source_includes", _APP + "safe_area_codegen_includes"], fbjni = ":fbjni", cxx_runtime = ":shared_cxx_runtime", shared_runtime_features = shared)
    react_native_app_cpp(name = "appmodules", react_native_root = "packages/react-native",
                         autolinking_sources = [_APP + "android_autolinking_cpp"], autolinking_headers = [_APP + "android_autolinking_headers"], autolinking_include_dirs = [],
                         generated_sources = [], generated_headers = [], generated_include_dirs = [],
                         react_native_deps = dependencies + [_APP + "android_autolinking_includes"], fbjni = ":fbjni", cxx_runtime = ":shared_cxx_runtime", shared_runtime_features = shared,
                         native_module_deps = [":oliphaunt_codegen", ":safe_area"])
