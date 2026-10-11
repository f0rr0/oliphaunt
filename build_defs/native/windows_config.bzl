"""Declared PostgreSQL product policy for the MSVC x64 Windows profile.

No HAVE_* capability is asserted here. The selected compiler/SDK must establish
those facts. ABI expectations are separate from generated configuration values.
"""

WINDOWS_CONFIG = {
    "BLCKSZ": "8192",
    "CONFIGURE_ARGS": '"Bazel Windows x64 MSVC ICU profile"',
    "DEF_PGPORT": "5432",
    "DEF_PGPORT_STR": '"5432"',
    "DLSUFFIX": '".dll"',
    "MEMSET_LOOP_LIMIT": "1024",
    "PACKAGE_BUGREPORT": '"pgsql-bugs@lists.postgresql.org"',
    "PACKAGE_NAME": '"PostgreSQL"',
    "PACKAGE_TARNAME": '"postgresql"',
    "PACKAGE_URL": '"https://www.postgresql.org/"',
    "PG_KRB_SRVNAM": '"postgres"',
    "RELSEG_SIZE": "131072",
    "USE_ICU": "1",
    # Upstream meson.build selects these by Windows/MSVC x64 domain.
    "USE_SSE42_CRC32C_WITH_RUNTIME_CHECK": "1",
    "USE_WIN32_SEMAPHORES": "1",
    "USE_WIN32_SHARED_MEMORY": "1",
    "WIN32_STACK_RLIMIT": "4194304",
    "XLOG_BLCKSZ": "8192",
    # PG uses a separate spelling to avoid colliding with __declspec(restrict).
    "pg_restrict": "__restrict",
}

# Contract expectations, not a substitute for target compiler sizeof/alignof
# checks. UCRT off_t is 32-bit; PG's win32_port.h supplies a 64-bit pgoff_t and
# fseeko/ftello wrappers rather than pretending that off_t is 64-bit.
WINDOWS_X64_ABI = {
    "ALIGNOF_DOUBLE": "8",
    "ALIGNOF_INT": "4",
    "ALIGNOF_INT64_T": "8",
    "ALIGNOF_LONG": "4",
    "ALIGNOF_SHORT": "2",
    "MAXIMUM_ALIGNOF": "8",
    "SIZEOF_LONG": "4",
    "SIZEOF_LONG_LONG": "8",
    "SIZEOF_OFF_T": "4",
    "SIZEOF_SIZE_T": "8",
    "SIZEOF_VOID_P": "8",
}

WINDOWS_OS_HEADER = "src/include/port/win32.h"
WINDOWS_INCLUDE_DIRECTORIES = [
    "src/include/port/win32",
    "src/include/port/win32_msvc",
    # libpq-int.h includes pthread-win32.h from src/port.
    "src/port",
]

WINDOWS_DEFINES = [
    "WIN32",
    "WINDOWS",
    "__WINDOWS__",
    "__WIN32__",
    "_CRT_SECURE_NO_DEPRECATE",
    "_CRT_NONSTDC_NO_DEPRECATE",
]

# Apply to producing backend/common/port/main objects, never exported header
# dependencies: extension modules must compile with PGDLLIMPORT = dllimport.
WINDOWS_BACKEND_DEFINES = ["BUILDING_DLL"]
WINDOWS_WRAPPER_DEFINES = ["OLIPHAUNT_BUILDING_DLL", "_CRT_SECURE_NO_WARNINGS"]

WINDOWS_COPTS = [
    "/std:c11",
    "/wd4018",
    "/wd4244",
    "/wd4273",
    "/wd4101",
    "/wd4102",
    "/wd4090",
    "/wd4267",
]

# /MD is owned by the standard MSVC toolchain's dynamic_link_msvcrt feature.
# These are the explicit SDK import libraries used by the canonical embedded
# Windows construction recipe, including its wrapper and PostgreSQL closure.
WINDOWS_LINKOPTS = [
    "/INCREMENTAL:NO",
    "/STACK:4194304",
    "ws2_32.lib",
    "secur32.lib",
    "advapi32.lib",
    "shell32.lib",
    "user32.lib",
    "bcrypt.lib",
]
