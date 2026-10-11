"""PostGIS dependency facts from the selected Apple or MSVC compiler.

The qualified Linux templates do not depend on these targets. The maintained
checker compiles and links against the target SDK without running target code.
Unavailable features remain undefined, as required by upstream #ifdef checks.
"""

load("@bazel_skylib//rules:write_file.bzl", "write_file")
load("@rules_cc_autoconf//autoconf:autoconf.bzl", "autoconf")
load("@rules_cc_autoconf//autoconf:autoconf_hdr.bzl", "autoconf_hdr")
load("@rules_cc_autoconf//autoconf:checks.bzl", "checks", "macros", "utils")

POSTGIS_COMPILER_FACTS = select({
    "//build_defs/native:macos_arm64": ":macos_compiler_facts_header",
    "//build_defs/native:windows_x64": ":windows_compiler_facts_header",
    "//conditions:default": None,
})

_HEADERS = [
    "dlfcn.h", "endian.h", "fcntl.h", "inttypes.h", "limits.h", "locale.h",
    "memory.h", "poll.h", "pthread.h", "stdarg.h", "stddef.h", "stdint.h",
    "stdio.h", "stdlib.h", "strings.h", "string.h", "syslog.h", "sys/cdefs.h",
    "sys/param.h", "sys/random.h", "sys/resource.h", "sys/stat.h", "sys/types.h",
    "unistd.h", "wchar.h", "xlocale.h", "bsd/stdlib.h",
]

_FUNCTIONS = [
    "arc4random", "fseeko", "getc_unlocked", "getrandom", "getrusage",
    "localeconv", "mbrtowc", "open", "realloc", "setlocale", "snprintf",
    "strcasecmp", "strdup", "strerror", "strncasecmp", "strtoll", "strtoull",
    "uselocale", "vasprintf", "vprintf", "vsnprintf", "vsyslog", "wcrtomb",
    "_strtoi64", "_strtoui64",
]

_COMPILE_FEATURES = {
    # Expressions used by the pinned json-c and libxml2 configurations.
    "HAVE_ATOMIC_BUILTINS": "int main(void) { int x = 0; return __sync_add_and_fetch(&x, 1); }",
    "HAVE_FUNC_ATTRIBUTE_DESTRUCTOR": "void __attribute__((destructor)) f(void) {} int main(void) { return 0; }",
    "HAVE_VISIBILITY": "__attribute__((visibility(\"hidden\"))) int f(void) { return 0; }",
    "HAVE___THREAD": "__thread int v; int main(void) { return v; }",
    "HAVE_DECLSPEC_THREAD": "__declspec(thread) int v; int main(void) { return v; }",
    "HAVE_C_THREAD_LOCAL": "_Thread_local int v; int main(void) { return v; }",
    "HAVE_INLINE": "static inline int f(void) { return 0; } int main(void) { return f(); }",
    "HAVE___INLINE": "static __inline int f(void) { return 0; } int main(void) { return f(); }",
    "STDC_HEADERS": "#include <stdlib.h>\n#include <stdarg.h>\n#include <string.h>\n#include <float.h>\nint main(void) { return 0; }",
    "WORDS_LITTLEENDIAN": "#if !defined(_WIN32) && (!defined(__BYTE_ORDER__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__)\n#error not little endian\n#endif\nint main(void) { return 0; }",
}

def _compiler_checks(windows):
    probes = macros.AC_CHECK_HEADERS(_HEADERS) + macros.AC_CHECK_FUNCS(_FUNCTIONS)
    probes += [
        checks.AC_CHECK_DECL(symbol, includes = ["#include <math.h>"], define = "HAVE_DECL_" + symbol.upper())
        for symbol in ["INFINITY", "isinf", "isnan", "nan", "_finite", "_isnan"]
    ]
    probes += [
        # Use libxml2's exact header requirements, including the headers that
        # dict.c includes whenever HAVE_DECL_GETENTROPY is enabled.
        checks.AC_CHECK_DECL("getentropy", includes = ["#include <sys/random.h>", "#include <unistd.h>"], define = "HAVE_DECL_GETENTROPY"),
        checks.AC_CHECK_DECL("glob", includes = ["#include <glob.h>"], define = "HAVE_DECL_GLOB"),
        checks.AC_CHECK_DECL("mmap", includes = ["#include <sys/mman.h>"], define = "HAVE_DECL_MMAP"),
        checks.AC_CHECK_TYPE("mbstate_t", includes = ["#include <wchar.h>"], define = "HAVE_MBSTATE_T"),
        checks.AC_CHECK_TYPE("mode_t", includes = ["#include <sys/types.h>"], define = "HAVE_MODE_T"),
        checks.AC_CHECK_TYPE("ssize_t", includes = ["#include <sys/types.h>"], define = "HAVE_SSIZE_T"),
        checks.AC_COMPUTE_INT("EILSEQ", "EILSEQ", includes = ["#include <errno.h>"]),
        checks.AC_TRY_LINK(
            code = utils.AC_LANG_PROGRAM(["#include <langinfo.h>"], "return nl_langinfo(CODESET) == 0;"),
            define = "HAVE_LANGINFO_CODESET",
            if_false = None,
        ),
        checks.AC_TRY_LINK(
            code = utils.AC_LANG_PROGRAM(["#include <dlfcn.h>"], "return dlopen(0, RTLD_NOW) == 0;"),
            define = "HAVE_DLOPEN",
            if_false = None,
        ),
        checks.AC_CHECK_LIB("dl", "dlopen", define = "HAVE_LIBDL", if_false = None),
        checks.AC_DEFINE("JSON_C_HAVE_INTTYPES_H", condition = "ac_cv_header_inttypes_h", if_true = 1, if_false = None),
        checks.AC_DEFINE("JSON_C_HAVE_STDINT_H", condition = "ac_cv_header_stdint_h", if_true = 1, if_false = None),
    ]
    probes += [
        checks.AC_CHECK_SIZEOF(t, includes = ["#include <stddef.h>", "#include <stdint.h>"], define = d)
        for t, d in [
            ("int", "SIZEOF_INT"), ("int64_t", "SIZEOF_INT64_T"),
            ("long", "SIZEOF_LONG"), ("long long", "SIZEOF_LONG_LONG"),
            ("size_t", "SIZEOF_SIZE_T"), ("void *", "SIZEOF_VOID_P"),
        ]
    ]
    # json-c's upstream MSVC configuration measures SSIZE_T from BaseTsd.h.
    probes.append(checks.AC_CHECK_SIZEOF(
        "SSIZE_T" if windows else "ssize_t",
        includes = ["#include <BaseTsd.h>" if windows else "#include <sys/types.h>"],
        define = "SIZEOF_SSIZE_T",
    ))
    probes += [checks.AC_TRY_COMPILE(code = code, define = define) for define, code in _COMPILE_FEATURES.items()]
    target_guard = "!defined(_WIN32) || !defined(_M_X64) || !defined(_MSC_VER)" if windows else "!defined(__APPLE__) || !defined(__MACH__) || !defined(__aarch64__)"
    probes.append(checks.AC_TRY_LINK(
        code = "#if " + target_guard + "\n#error incorrect PostGIS compiler target\n#endif\n#include <stdio.h>\n#include <stdlib.h>\nint main(void) { void *p = malloc(8); printf(\"%p\\n\", p); free(p); return 0; }",
        define = "HAVE_POSTGIS_COMPILER_SANITY",
        if_false = None,
    ))
    # Match production's MSVC C mode and feature visibility. Values are integers
    # so the checker's generated preamble never defines a C string literal.
    definitions = ["_CRT_SECURE_NO_WARNINGS", "_CRT_NONSTDC_NO_WARNINGS", "_USE_MATH_DEFINES"] if windows else ["_GNU_SOURCE"]
    configured = []
    for probe in probes:
        check = json.decode(probe) | {"copts": ["/std:c11"] if windows else [], "compile_defines": definitions}
        # AC_CHECK_DECL defaults to a defined zero on failure. Our fact header
        # uses the same undefined convention as all other optional probes.
        if check["type"] == "decl":
            check["define_value_fail"] = None
        configured.append(json.encode(check))
    return [checks.AC_DEFINE(define, 1) for define in definitions] + configured

def postgis_compiler_facts():
    """Declare only foreign-profile probes and their required result headers."""
    for prefix, windows, setting in [
        ("macos", False, "//build_defs/native:macos_arm64"),
        ("windows", True, "//build_defs/native:windows_x64"),
    ]:
        name = prefix + "_compiler_facts"
        compatible = select({setting: [], "//conditions:default": ["@platforms//:incompatible"]})
        probes = _compiler_checks(windows)
        autoconf(name = name, checks = probes, target_compatible_with = compatible)
        write_file(
            name = name + "_template",
            out = name + ".h.in",
            content = ["#undef " + json.decode(probe)["define"] for probe in probes],
            target_compatible_with = compatible,
        )
        autoconf_hdr(
            name = name + "_header",
            out = name + ".h",
            template = ":" + name + "_template",
            deps = [":" + name],
            defaults = False,
            target_compatible_with = compatible,
        )
