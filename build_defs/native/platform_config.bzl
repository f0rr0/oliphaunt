"""Bounded native PG configuration selected by the target ABI and libc."""

load(":android_lp64_config.bzl", "ANDROID_LP64_CONFIG")
load(":linux_x86_64_config.bzl", "LINUX_X86_64_CONFIG")
load(":postgres_sources.bzl", "POSTGRES_BACKEND_LINUX_SOURCES", "POSTGRES_PORT_REPLACEMENT_SOURCES", "POSTGRES_PORT_CRC_GENERIC_SOURCES")
load(":windows_config.bzl", "WINDOWS_COPTS", "WINDOWS_DEFINES", "WINDOWS_BACKEND_DEFINES", "WINDOWS_WRAPPER_DEFINES", "WINDOWS_INCLUDE_DIRECTORIES", "WINDOWS_LINKOPTS")
load(":windows_sources.bzl", "WINDOWS_BACKEND_PORT_SOURCES", "WINDOWS_PORT_SOURCES", "WINDOWS_PORT_CRC_SOURCES", "WINDOWS_LIBPQ_SOURCES")

_X64 = "@oliphaunt//build_defs/native:linux_x86_64"
_X64_GNU_228 = "@oliphaunt//build_defs/native:linux_x86_64_gnu_2_28"
_ARM64_GNU_228 = "@oliphaunt//build_defs/native:linux_aarch64_gnu_2_28"
_ANDROID_ARM64 = "@oliphaunt//build_defs/native:android_arm64"
_ANDROID_X64 = "@oliphaunt//build_defs/native:android_x86_64"
_ANDROID = "@oliphaunt//build_defs/native:android"
_MACOS = "@oliphaunt//build_defs/native:macos_arm64"
_WINDOWS = "@oliphaunt//build_defs/native:windows_x64"
_IOS = "@oliphaunt//build_defs/native:ios"
_IOS_DEVICE = "@oliphaunt//build_defs/native:ios_arm64"
_IOS_SIMULATOR = "@oliphaunt//build_defs/native:ios_arm64_simulator"

# glibc introduced strlcpy/strlcat in 2.38; lower ABI profiles must compile PG's
# replacements. This is a toolchain-dependent fact, not a host configure probe.
_GNU_228 = {key: value for key, value in LINUX_X86_64_CONFIG.items() if key not in ["HAVE_STRLCPY", "HAVE_STRLCAT"]} | {
    "HAVE_DECL_STRLCPY": "0",
    "HAVE_DECL_STRLCAT": "0",
    "CONFIGURE_ARGS": '"Bazel Linux glibc 2.28 ICU profile"',
    # Clang implements the printf checker, but rejects GCC's gnu_printf spelling.
    "PG_C_PRINTF_ATTRIBUTE": "printf",
    "PG_CXX_PRINTF_ATTRIBUTE": "printf",
}

_ARM64_228 = {key: value for key, value in _GNU_228.items() if key not in ["HAVE_X86_64_POPCNTQ", "HAVE_XSAVE_INTRINSICS", "HAVE__GET_CPUID", "HAVE__GET_CPUID_COUNT"]}
_ANDROID_X64_CONFIG = ANDROID_LP64_CONFIG | {key: "1" for key in ["HAVE_X86_64_POPCNTQ", "HAVE_XSAVE_INTRINSICS", "HAVE__GET_CPUID", "HAVE__GET_CPUID_COUNT"]}

NATIVE_CONFIG = select({
    _X64_GNU_228: _GNU_228,
    _ARM64_GNU_228: _ARM64_228,
    _X64: LINUX_X86_64_CONFIG,
    _ANDROID_ARM64: ANDROID_LP64_CONFIG,
    _ANDROID_X64: _ANDROID_X64_CONFIG,
}, no_match_error = "No PostgreSQL native configuration for this target ABI/libc. Select a declared Linux or bounded Android native platform; Apple and MSVC profiles require their own qualification.")

NATIVE_PROFILE = select({
    _X64_GNU_228: "Linux x86_64 glibc 2.28 Bazel",
    _ARM64_GNU_228: "Linux aarch64 glibc 2.28 Bazel",
    _X64: "Linux x86_64 Bazel development slice",
    _ANDROID_ARM64: "Android aarch64 Bionic Bazel",
    _ANDROID_X64: "Android x86_64 Bionic Bazel",
})

NATIVE_COMPATIBLE = select({
    _X64: [],
    _ARM64_GNU_228: [],
    _MACOS: [],
    _WINDOWS: [],
    "//conditions:default": ["@platforms//:incompatible"],
})

# C construction capability is broader than the desktop module/server carrier.
# Android and iOS embed process-local IPC and builtin modules; they cannot claim the
# desktop postmaster or installed dynamic-extension SQL consumer semantics.
NATIVE_C_COMPATIBLE = select({
    _X64: [],
    _ARM64_GNU_228: [],
    _ANDROID: [],
    _IOS_DEVICE: [],
    _IOS_SIMULATOR: [],
    _MACOS: [],
    _WINDOWS: [],
    "//conditions:default": ["@platforms//:incompatible"],
})

NATIVE_ELF_C_COMPATIBLE = select({_X64: [], _ARM64_GNU_228: [], _ANDROID: [], "//conditions:default": ["@platforms//:incompatible"]})
NATIVE_UNIX_COMPATIBLE = select({_X64: [], _ARM64_GNU_228: [], _MACOS: [], "//conditions:default": ["@platforms//:incompatible"]})
NATIVE_MACOS_COMPATIBLE = select({_MACOS: [], "//conditions:default": ["@platforms//:incompatible"]})
NATIVE_WINDOWS_COMPATIBLE = select({_WINDOWS: [], "//conditions:default": ["@platforms//:incompatible"]})
NATIVE_HOST_COMPATIBLE = select({_MACOS: [], _WINDOWS: [], "//conditions:default": ["@platforms//:incompatible"]})
NATIVE_LINUX_COMPATIBLE = select({_X64: [], _ARM64_GNU_228: [], "//conditions:default": ["@platforms//:incompatible"]})

def _port_replacements(configuration):
    return [source for macro, source in POSTGRES_PORT_REPLACEMENT_SOURCES.items() if macro not in configuration]

NATIVE_PORT_REPLACEMENTS = select({
    _X64_GNU_228: _port_replacements(_GNU_228),
    _ARM64_GNU_228: _port_replacements(_ARM64_228),
    _X64: _port_replacements(LINUX_X86_64_CONFIG),
    _ANDROID: _port_replacements(ANDROID_LP64_CONFIG),
    _MACOS: [":host_macos_replacements"],
    _WINDOWS: [":host_windows_replacements"],
    _IOS_DEVICE: [":host_ios_replacements"],
    _IOS_SIMULATOR: [":host_ios_simulator_replacements"],
})

# The fixed profiles remain selected only on their qualified configurations.
# Host profiles establish HAVE_* facts with the actual target compiler/SDK.
NATIVE_CONFIGURATION = select({
    _MACOS: [":host_macos_configuration"],
    _WINDOWS: [":host_windows_configuration"],
    _IOS_DEVICE: [":host_ios_configuration"],
    _IOS_SIMULATOR: [":host_ios_simulator_configuration"],
    "//conditions:default": [":static_configuration"],
})
NATIVE_CONFIGURATION_ADMISSION = select({
    _MACOS: [":host_macos_admission"],
    _WINDOWS: [":host_windows_admission"],
    _IOS_DEVICE: [":host_ios_admission"],
    _IOS_SIMULATOR: [":host_ios_simulator_admission"],
    "//conditions:default": [],
})
NATIVE_INCLUDE_DIRECTORIES = select({
    _MACOS: ["host_macos/src/include"],
    _WINDOWS: ["host_windows/src/include"] + WINDOWS_INCLUDE_DIRECTORIES,
    _IOS_DEVICE: ["host_ios/src/include"],
    _IOS_SIMULATOR: ["host_ios_simulator/src/include"],
    "//conditions:default": [],
})
NATIVE_HEADER_DEFINES = select({
    _MACOS: ["_DARWIN_C_SOURCE"],
    _WINDOWS: WINDOWS_DEFINES,
    _IOS: ["_DARWIN_C_SOURCE"],
    "//conditions:default": ["_GNU_SOURCE"],
})
NATIVE_COPTS = select({
    _WINDOWS: WINDOWS_COPTS,
    "//conditions:default": ["-std=gnu11", "-fno-strict-aliasing", "-fwrapv", "-fexcess-precision=standard"],
})
NATIVE_BACKEND_DEFINES = select({_WINDOWS: WINDOWS_BACKEND_DEFINES, "//conditions:default": []})
NATIVE_WRAPPER_DEFINES = select({_WINDOWS: WINDOWS_WRAPPER_DEFINES, "//conditions:default": []})
NATIVE_WRAPPER_COPTS = select({_WINDOWS: WINDOWS_COPTS, "//conditions:default": ["-std=gnu11", "-fno-strict-aliasing", "-fwrapv"]})
NATIVE_BUILTIN_PLPGSQL_DEPS = select({_WINDOWS: ["@postgres//:plpgsql_builtin_windows"], "//conditions:default": ["@postgres//:plpgsql_embedded"]})
NATIVE_PORT_ADDITIONAL_SOURCES = select({_WINDOWS: WINDOWS_PORT_SOURCES, "//conditions:default": []})
NATIVE_PORT_CRC_SOURCES = select({_WINDOWS: WINDOWS_PORT_CRC_SOURCES, "//conditions:default": POSTGRES_PORT_CRC_GENERIC_SOURCES})
NATIVE_LIBPQ_ADDITIONAL_SOURCES = select({_WINDOWS: WINDOWS_LIBPQ_SOURCES, "//conditions:default": []})

NATIVE_OS_HEADER = "src/include/port/linux.h"
NATIVE_BACKEND_PORT_SOURCES = select({
    _ANDROID: ["src/backend/port/oliphaunt_embedded_sema.c", "src/backend/port/oliphaunt_embedded_shmem.c"],
    _IOS: ["src/backend/port/oliphaunt_embedded_sema.c", "src/backend/port/oliphaunt_embedded_shmem.c"],
    _MACOS: ["src/backend/port/sysv_sema.c", "src/backend/port/sysv_shmem.c"],
    _WINDOWS: WINDOWS_BACKEND_PORT_SOURCES,
    "//conditions:default": POSTGRES_BACKEND_LINUX_SOURCES,
})
NATIVE_LINKOPTS = select({
    _ANDROID: ["-lm", "-ldl"],
    _MACOS: [],
    _IOS: [],
    _WINDOWS: WINDOWS_LINKOPTS,
    "//conditions:default": ["-lm", "-ldl", "-lpthread"],
})
# The pinned Zig toolchain intentionally has no post-link strip tool. Its
# declared linker supports debug stripping without removing dynamic exports.
# Keep development/debug outputs intact; apply only at final native links.
NATIVE_RELEASE_LINKOPTS = select({"@oliphaunt//build_defs/native:linux_opt": ["-Wl,-S"], "//conditions:default": []})
NATIVE_FRONTEND_LINKOPTS = select({_MACOS: ["-Wl,-rpath,@loader_path/../lib"], _WINDOWS: [], "//conditions:default": ["-Wl,-rpath,$ORIGIN/../lib"]})
NATIVE_SERVER_LINKOPTS = select({_MACOS: [], _WINDOWS: [], "//conditions:default": ["-Wl,--export-dynamic"]})
NATIVE_MODULE_LINKOPTS = select({_MACOS: ["-Wl,-undefined,dynamic_lookup"], _WINDOWS: [], "//conditions:default": []})
NATIVE_EMBEDDED_MODULE_LINKOPTS = select({_MACOS: ["-Wl,-rpath,@loader_path/.."], _WINDOWS: [], "//conditions:default": ["-Wl,-z,defs"]})
NATIVE_LIBPQ_LINKOPTS = select({_MACOS: ["-Wl,-install_name,@rpath/libpq.5.dylib"], _WINDOWS: [], "//conditions:default": ["-Wl,-soname,libpq.so.5", "-Wl,-z,defs"]})
NATIVE_RUNTIME_LINKOPTS = select({_MACOS: ["-Wl,-install_name,@rpath/liboliphaunt.dylib"], _WINDOWS: [], "//conditions:default": ["-Wl,-soname,liboliphaunt.so", "-Wl,-z,defs"]})
NATIVE_EMBEDDED_DEFINES = select({
    _ANDROID: ["OLIPHAUNT_EMBEDDED_MOBILE_SHMEM"],
    _IOS: ["OLIPHAUNT_EMBEDDED_MOBILE_SHMEM"],
    "//conditions:default": [],
})
NATIVE_BUILTIN_SNOWBALL = select({
    _ANDROID: ["OLIPHAUNT_BUILTIN_DICT_SNOWBALL"],
    _IOS: ["OLIPHAUNT_BUILTIN_DICT_SNOWBALL"],
    "//conditions:default": [],
})
NATIVE_BUILTIN_SNOWBALL_DEPS = select({
    _ANDROID: ["@postgres//:snowball_builtin"],
    _IOS: ["@postgres//:snowball_builtin"],
    "//conditions:default": [],
})
