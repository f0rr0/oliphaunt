"""PostgreSQL WASIX product policy; compiler/libc availability is measured."""

WASIX_POLICY = {
    "ALIGNOF_DOUBLE": "8",
    "ALIGNOF_INT": "4",
    "ALIGNOF_INT64_T": "8",
    "ALIGNOF_LONG": "4",
    "ALIGNOF_SHORT": "2",
    "BLCKSZ": "8192",
    "CONFIGURE_ARGS": '"Bazel wasm32 WASIX exceptions/PIC static ICU"',
    "DEF_PGPORT": "5432",
    "DEF_PGPORT_STR": '"5432"',
    "DLSUFFIX": '".so"',
    "MAXIMUM_ALIGNOF": "8",
    "MEMSET_LOOP_LIMIT": "1024",
    "PACKAGE_BUGREPORT": '"pgsql-bugs@lists.postgresql.org"',
    "PACKAGE_NAME": '"PostgreSQL"',
    "PACKAGE_TARNAME": '"postgresql"',
    "PACKAGE_URL": '"https://www.postgresql.org/"',
    "PG_CXX_PRINTF_ATTRIBUTE": "printf",
    "PG_C_PRINTF_ATTRIBUTE": "printf",
    "PG_KRB_SRVNAM": '"postgres"',
    "RELSEG_SIZE": "131072",
    "SIZEOF_LONG": "4",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_OFF_T": "8",
    "SIZEOF_SIZE_T": "4",
    "SIZEOF_VOID_P": "4",
    "STDC_HEADERS": "1",
    "USE_ICU": "1",
    "USE_SLICING_BY_8_CRC32C": "1",
    "USE_SYSV_SHARED_MEMORY": "1",
    "USE_UNNAMED_POSIX_SEMAPHORES": "1",
    "XLOG_BLCKSZ": "8192",
    "pg_restrict": "__restrict",
    "restrict": "__restrict",
}

WASIX_COPTS = [
    "-ffile-prefix-map=" + Label("@postgres_wasix//:src/include/pg_config.h.in").workspace_root + "/=postgres/",
    "-std=gnu11",
    "-O2",
    "-g0",
    "-flto=thin",
    "-fno-strict-aliasing",
    "-fwrapv",
    "-Wno-declaration-after-statement",
    "-Wno-macro-redefined",
    "-Wno-unused-function",
    "-Wno-missing-prototypes",
    "-Wno-incompatible-pointer-types",
]

WASIX_DEFINES = ["_GNU_SOURCE", "OLIPHAUNT_WASM_SINGLE_USER"] + [
    name + "=oliphaunt_wasix_" + name
    for name in ["system", "popen", "pclose", "exit", "munmap", "fcntl", "atexit", "setsockopt", "getsockopt", "getsockname", "socket", "connect", "recv", "send", "poll", "longjmp", "siglongjmp"]
]
