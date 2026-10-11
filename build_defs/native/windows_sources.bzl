"""PostgreSQL 18.4 Windows/MSVC sources in addition to the shared inventories.

Membership follows src/port/meson.build, src/backend/port/meson.build,
src/backend/port/win32/meson.build and src/interfaces/libpq/meson.build.
"""

load(":postgres_sources.bzl", "POSTGRES_PORT_CRC_X86_RUNTIME_SOURCES", "POSTGRES_PORT_REPLACEMENT_SOURCES")

# These units are compiled independently for backend and frontend roles.
WINDOWS_PORT_SOURCES = [
    "src/port/dirmod.c",
    "src/port/kill.c",
    "src/port/open.c",
    "src/port/system.c",
    "src/port/win32common.c",
    "src/port/win32dlopen.c",
    "src/port/win32env.c",
    "src/port/win32error.c",
    "src/port/win32fdatasync.c",
    "src/port/win32fseek.c",
    "src/port/win32gai_strerror.c",
    "src/port/win32getrusage.c",
    "src/port/win32link.c",
    "src/port/win32ntdll.c",
    "src/port/win32pread.c",
    "src/port/win32pwrite.c",
    "src/port/win32security.c",
    "src/port/win32setlocale.c",
    "src/port/win32stat.c",
    # Upstream adds these two for MSVC, separately from the OS selection.
    "src/port/dirent.c",
    "src/port/win32gettimeofday.c",
]

WINDOWS_BACKEND_PORT_SOURCES = [
    "src/backend/port/win32_sema.c",
    "src/backend/port/win32_shmem.c",
    "src/backend/port/win32/crashdump.c",
    "src/backend/port/win32/signal.c",
    "src/backend/port/win32/socket.c",
    "src/backend/port/win32/timer.c",
]

WINDOWS_LIBPQ_SOURCES = [
    "src/interfaces/libpq/pthread-win32.c",
    "src/interfaces/libpq/win32.c",
]

# Upstream unconditionally selects SSE4.2 with a runtime CPU check for MSVC
# x86/x64. The fallback is part of this inventory, not a second CRC selection.
WINDOWS_PORT_CRC_SOURCES = POSTGRES_PORT_CRC_X86_RUNTIME_SOURCES

# Absence of a POSIX barrier on Windows does not select its pthread replacement:
# upstream explicitly omits that candidate on Windows. The two getopt functions
# are always replaced, even when a Windows environment supplies them.
WINDOWS_PORT_REPLACEMENT_SOURCES = {
    macro: source
    for macro, source in POSTGRES_PORT_REPLACEMENT_SOURCES.items()
    if macro != "HAVE_PTHREAD_BARRIER_WAIT"
}
WINDOWS_FORCED_PORT_REPLACEMENTS = ["HAVE_GETOPT", "HAVE_GETOPT_LONG"]

def windows_port_replacements(configuration):
    """Select replacements from established facts, retaining upstream policy."""
    return [
        source
        for macro, source in WINDOWS_PORT_REPLACEMENT_SOURCES.items()
        if macro in WINDOWS_FORCED_PORT_REPLACEMENTS or configuration.get(macro, "0") != "1"
    ]
