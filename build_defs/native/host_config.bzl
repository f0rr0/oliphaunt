"""PostgreSQL target facts established by the selected Apple/MSVC compiler.

Linux and Android retain their already qualified bounded profiles. These host
profiles use upstream PG18.4 capability tests through the maintained native
checker, with no execution of a target binary and no configure process.
"""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_library")
load("@rules_cc_autoconf//autoconf:autoconf.bzl", "autoconf")
load("@rules_cc_autoconf//autoconf:autoconf_hdr.bzl", "autoconf_hdr")
load("@rules_cc_autoconf//autoconf:autoconf_srcs.bzl", "autoconf_srcs")
load("@rules_cc_autoconf//autoconf:checks.bzl", "checks", "macros")
load(":config.bzl", "pg_config_layout")
load(":postgres_sources.bzl", "POSTGRES_PORT_REPLACEMENT_SOURCES")
load(":windows_config.bzl", "WINDOWS_CONFIG", "WINDOWS_COPTS", "WINDOWS_DEFINES")
load(":windows_sources.bzl", "WINDOWS_PORT_REPLACEMENT_SOURCES", "WINDOWS_FORCED_PORT_REPLACEMENTS")

_PROFILES = [
    ("macos", False, "@oliphaunt//build_defs/native:macos_arm64", None),
    ("windows", True, "@oliphaunt//build_defs/native:windows_x64", None),
    ("ios", False, "@oliphaunt//build_defs/native:ios_arm64", 0),
    ("ios_simulator", False, "@oliphaunt//build_defs/native:ios_arm64_simulator", 1),
]

_HEADERS = [
    "atomic.h", "copyfile.h", "crtdefs.h", "execinfo.h", "getopt.h",
    "ifaddrs.h", "inttypes.h", "mbarrier.h", "memory.h", "stdint.h",
    "stdlib.h", "strings.h", "string.h", "sys/epoll.h", "sys/event.h",
    "sys/personality.h", "sys/prctl.h", "sys/procctl.h", "sys/signalfd.h",
    "sys/stat.h", "sys/types.h", "sys/ucred.h", "termios.h", "ucred.h",
    "unistd.h", "xlocale.h",
]

_FUNCTIONS = [
    "backtrace_symbols", "copyfile", "copy_file_range", "elf_aux_info",
    "explicit_bzero", "fseeko", "getauxval", "getifaddrs", "getopt",
    "getopt_long", "getpeereid", "getpeerucred", "inet_aton", "inet_pton",
    "kqueue", "localeconv_l", "mbstowcs_l", "mkdtemp", "posix_fadvise",
    "posix_fallocate", "ppoll", "pthread_barrier_wait", "pthread_is_threaded_np",
    "setproctitle", "setproctitle_fast", "strerror_r", "strlcat", "strlcpy",
    "strnlen", "strsep", "strsignal", "sync_file_range", "syncfs", "syslog",
    "timingsafe_bcmp", "uselocale", "wcstombs_l",
]

_DECLARATIONS = {
    "fdatasync": "unistd.h",
    "F_FULLFSYNC": "fcntl.h",
    "memset_s": "string.h",
    "posix_fadvise": "fcntl.h",
    "preadv": "sys/uio.h",
    "pwritev": "sys/uio.h",
    "strchrnul": "string.h",
    "strlcat": "string.h",
    "strlcpy": "string.h",
    "strnlen": "string.h",
    "strsep": "string.h",
    "timingsafe_bcmp": "string.h",
}

# These are PG's compiler features, not guesses based on a compiler name. The
# probes keep the exact expressions which the corresponding PG code requires.
_COMPILE_FEATURES = {
    "HAVE_COMPUTED_GOTO": "int main(void) { void *p = &&label; goto *p; label: return 0; }",
    "HAVE_TYPEOF": "int main(void) { int x; typeof(x) y = 0; return y; }",
    "HAVE__STATIC_ASSERT": "int main(void) { return ({ _Static_assert(1, \"ok\"); 0; }); }",
    "HAVE__BUILTIN_CONSTANT_P": "int main(void) { return __builtin_constant_p(1); }",
    "HAVE__BUILTIN_TYPES_COMPATIBLE_P": "int main(void) { return __builtin_types_compatible_p(int, int); }",
    "HAVE_VISIBILITY_ATTRIBUTE": "__attribute__((visibility(\"hidden\"))) int f(void) { return 0; }",
    "HAVE_INT_OPTERR": "#include <unistd.h>\nextern int opterr; int main(void) { return opterr; }",
    "HAVE_INT_OPTRESET": "#include <unistd.h>\nextern int optreset; int main(void) { return optreset; }",
    "HAVE_INT_TIMEZONE": "#include <time.h>\nint main(void) { int *p = &timezone; return *p; }",
    "HAVE_PTHREAD_PRIO_INHERIT": "#include <pthread.h>\nint main(void) { return PTHREAD_PRIO_INHERIT; }",
    "STRERROR_R_INT": "#include <string.h>\nint main(void) { char b[64]; int (*p)(int, char *, size_t) = strerror_r; return p(0, b, sizeof(b)); }",
    "HAVE_UNION_SEMUN": "#include <sys/types.h>\n#include <sys/ipc.h>\n#include <sys/sem.h>\nint main(void) { union semun u; return sizeof(u); }",
    "HAVE__CPUID": "#include <intrin.h>\nint main(void) { int x[4]; __cpuid(x, 0); return x[0]; }",
    "HAVE__CPUIDEX": "#include <intrin.h>\nint main(void) { int x[4]; __cpuidex(x, 0, 0); return x[0]; }",
}

_LINK_FEATURES = {
    "HAVE__BUILTIN_BSWAP16": "int main(void) { return __builtin_bswap16(1); }",
    "HAVE__BUILTIN_BSWAP32": "int main(void) { return __builtin_bswap32(1); }",
    "HAVE__BUILTIN_BSWAP64": "int main(void) { return __builtin_bswap64(1); }",
    "HAVE__BUILTIN_CLZ": "int main(void) { return __builtin_clz(1); }",
    "HAVE__BUILTIN_CTZ": "int main(void) { return __builtin_ctz(1); }",
    "HAVE__BUILTIN_FRAME_ADDRESS": "int main(void) { return __builtin_frame_address(0) == 0; }",
    "HAVE__BUILTIN_OP_OVERFLOW": "int main(void) { int x; return __builtin_add_overflow(1, 1, &x); }",
    "HAVE__BUILTIN_POPCOUNT": "int main(void) { return __builtin_popcount(1); }",
    "HAVE__BUILTIN_UNREACHABLE": "int main(void) { __builtin_unreachable(); }",
    "HAVE_GCC__SYNC_CHAR_TAS": "int main(void) { char x = 0; return __sync_lock_test_and_set(&x, 1); }",
    "HAVE_GCC__SYNC_INT32_TAS": "#include <stdint.h>\nint main(void) { int32_t x = 0; return __sync_lock_test_and_set(&x, 1); }",
    "HAVE_GCC__SYNC_INT32_CAS": "#include <stdint.h>\nint main(void) { int32_t x = 0; return __sync_val_compare_and_swap(&x, 0, 1); }",
    "HAVE_GCC__SYNC_INT64_CAS": "#include <stdint.h>\nint main(void) { int64_t x = 0; return __sync_val_compare_and_swap(&x, 0, 1); }",
    "HAVE_GCC__ATOMIC_INT32_CAS": "#include <stdint.h>\nint main(void) { int32_t x = 0, y = 0; return __atomic_compare_exchange_n(&x, &y, 1, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); }",
    "HAVE_GCC__ATOMIC_INT64_CAS": "#include <stdint.h>\nint main(void) { int64_t x = 0, y = 0; return __atomic_compare_exchange_n(&x, &y, 1, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); }",
    "HAVE_PG_INT128": "int main(void) { __int128 x = 1; return (x * x / x) != 1; }",
    "HAVE_PTHREAD": "#include <pthread.h>\nstatic void *f(void *p) { return p; } int main(void) { pthread_t t; return pthread_create(&t, 0, f, 0); }",
}

def _policy(version, windows, ios = False):
    major, minor = [int(part) for part in version.split(".")]
    policy = WINDOWS_CONFIG if windows else {
        "BLCKSZ": "8192", "CONFIGURE_ARGS": '"Bazel macOS arm64 ICU profile"',
        "DEF_PGPORT": "5432", "DEF_PGPORT_STR": '"5432"', "DLSUFFIX": '".dylib"',
        "MEMSET_LOOP_LIMIT": "1024", "PACKAGE_BUGREPORT": '"pgsql-bugs@lists.postgresql.org"',
        "PACKAGE_NAME": '"PostgreSQL"', "PACKAGE_TARNAME": '"postgresql"',
        "PACKAGE_URL": '"https://www.postgresql.org/"', "PG_KRB_SRVNAM": '"postgres"',
        "RELSEG_SIZE": "131072", "USE_ICU": "1", "USE_SYSV_SEMAPHORES": "1",
        "USE_SYSV_SHARED_MEMORY": "1", "USE_SLICING_BY_8_CRC32C": "1",
        "XLOG_BLCKSZ": "8192", "pg_restrict": "__restrict",
        "PG_C_PRINTF_ATTRIBUTE": "printf", "PG_CXX_PRINTF_ATTRIBUTE": "printf",
    }
    if ios:
        policy = policy | {"CONFIGURE_ARGS": '"Bazel iOS arm64 ICU profile"'}
    return policy | {
        "PACKAGE_STRING": '"PostgreSQL ' + version + '"',
        "PACKAGE_VERSION": '"' + version + '"',
        "PG_MAJORVERSION": '"' + str(major) + '"',
        "PG_MAJORVERSION_NUM": str(major), "PG_MINORVERSION_NUM": str(minor),
        "PG_VERSION": '"' + version + '"', "PG_VERSION_NUM": str(major * 10000 + minor),
        "PG_VERSION_STR": '"PostgreSQL ' + version + ' Bazel ' + ("MSVC" if windows else "Apple Clang") + ', 64-bit"',
        # Upstream derives this from double's compiler-established alignment.
        "MAXIMUM_ALIGNOF": "ALIGNOF_DOUBLE",
        "STDC_HEADERS": "1",
    }

def postgres_host_configuration_targets(version):
    """Declare facts, header, positive admission and conditional port units."""
    for suffix, windows, setting, simulator in _PROFILES:
        name = "host_" + suffix
        compatible = select({setting: [], "//conditions:default": ["@platforms//:incompatible"]})
        opts = WINDOWS_COPTS + ["/WX"] if windows else ["-std=gnu11", "-Werror=unguarded-availability-new", "-Werror=incompatible-pointer-types", "-Werror=implicit-function-declaration"]
        definitions = WINDOWS_DEFINES if windows else ["_DARWIN_C_SOURCE"]
        policy = _policy(version, windows, ios = simulator != None)
        tests = macros.AC_CHECK_HEADERS(_HEADERS) + macros.AC_CHECK_FUNCS(_FUNCTIONS)
        tests += [checks.AC_CHECK_DECL(symbol, includes = ["#include <" + header + ">"], define = "HAVE_DECL_" + symbol.upper(), if_false = "0") for symbol, header in _DECLARATIONS.items()]
        tests += [checks.AC_CHECK_SIZEOF(t, includes = ["#include <stdint.h>", "#include <sys/types.h>"], define = d) for t, d in [
            ("long", "SIZEOF_LONG"), ("long long", "SIZEOF_LONG_LONG"), ("off_t", "SIZEOF_OFF_T"), ("size_t", "SIZEOF_SIZE_T"), ("void *", "SIZEOF_VOID_P"),
        ]]
        tests += [checks.AC_CHECK_ALIGNOF(t, includes = ["#include <stdint.h>"], define = d) for t, d in [
            ("double", "ALIGNOF_DOUBLE"), ("int", "ALIGNOF_INT"), ("int64_t", "ALIGNOF_INT64_T"), ("long", "ALIGNOF_LONG"), ("short", "ALIGNOF_SHORT"),
        ]]
        tests += [checks.AC_CHECK_TYPE("struct option", includes = ["#include <getopt.h>"], define = "HAVE_STRUCT_OPTION"),
                  checks.AC_CHECK_TYPE("socklen_t", includes = ["#include <sys/types.h>", "#include <sys/socket.h>"], define = "HAVE_SOCKLEN_T"),
                  checks.AC_CHECK_MEMBER("struct sockaddr.sa_len", includes = ["#include <sys/types.h>", "#include <sys/socket.h>"], define = "HAVE_STRUCT_SOCKADDR_SA_LEN"),
                  checks.AC_CHECK_MEMBER("struct tm.tm_zone", includes = ["#include <time.h>"], define = "HAVE_STRUCT_TM_TM_ZONE")]
        tests += [checks.AC_TRY_COMPILE(code = code, define = define) for define, code in _COMPILE_FEATURES.items()]
        tests += [checks.AC_TRY_LINK(code = code, define = define, if_false = None) for define, code in _LINK_FEATURES.items()]
        tests += [checks.AC_DEFINE("PG_INT128_TYPE", condition = "HAVE_PG_INT128", if_true = "__int128", if_false = None),
                  checks.AC_CHECK_ALIGNOF("__int128", define = "ALIGNOF_PG_INT128_TYPE", requires = ["HAVE_PG_INT128"])]
        # Compilation flags and SDK feature visibility must match production.
        tests = [json.encode(json.decode(test) | {"copts": opts, "compile_defines": definitions + ["__STDC_WANT_LIB_EXT1__"]}) for test in tests]
        # AC_DEFINE preserves the value's JSON type in probe preambles. Feature
        # switches must be integers: "1" would emit a C string literal, which
        # conflicts with MSVC's /D_CRT_SECURE_NO_DEPRECATE=1 under /WX.
        autoconf(name = name + "_facts", checks = [checks.AC_DEFINE(d, 1) for d in definitions + ["__STDC_WANT_LIB_EXT1__"]] + tests + [checks.AC_DEFINE(key, value) for key, value in policy.items()], target_compatible_with = compatible)
        autoconf_hdr(name = name + "_config", out = name + "/src/include/pg_config.h", template = "src/include/pg_config.h.in", deps = [":" + name + "_facts"], defaults = False, target_compatible_with = compatible)
        pg_config_layout(name = name + "_layout", os_header = "src/include/port/" + ("win32.h" if windows else "darwin.h"), output_directory = name + "/src/include", target_compatible_with = compatible)
        cc_binary(name = name + "_sanity", srcs = ["@oliphaunt//build_defs/native:probe-sanity.c"], copts = opts, target_compatible_with = compatible)
        abi_sources = ["@oliphaunt//build_defs/native:host-config-contract.c"]
        abi_defines = []
        if simulator != None:
            abi_sources.append("@oliphaunt//build_defs/native:ios-config-contract.c")
            abi_defines.append("OLIPHAUNT_EXPECT_IOS_SIMULATOR=" + str(simulator))
        cc_library(name = name + "_abi", srcs = abi_sources, local_defines = abi_defines, hdrs = [":" + name + "_config"], includes = [name + "/src/include"], copts = opts, target_compatible_with = compatible)
        native.filegroup(name = name + "_configuration", srcs = [":" + name + "_config", ":" + name + "_layout"], target_compatible_with = compatible)
        # This dependency is built once for the profile; a dead compiler cannot
        # be interpreted as a platform where every optional feature is absent.
        cc_library(name = name + "_admission", deps = [":" + name + "_abi"], data = [":" + name + "_sanity"], target_compatible_with = compatible)
        replacements = WINDOWS_PORT_REPLACEMENT_SOURCES if windows else POSTGRES_PORT_REPLACEMENT_SOURCES
        autoconf_srcs(name = name + "_replacements", srcs = {source: ("1" if windows and macro in WINDOWS_FORCED_PORT_REPLACEMENTS else "!ac_cv_func_" + macro[len("HAVE_"):].lower()) for macro, source in replacements.items()}, deps = [":" + name + "_facts"], defaults = False, target_compatible_with = compatible)
