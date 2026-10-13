#define _GNU_SOURCE 1
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/ioctl.h>
#include "pg_config.h"

#define ABI_SIZE(type, macro) _Static_assert(sizeof(type) == macro, #macro)
#define ABI_ALIGN(type, macro) _Static_assert(_Alignof(type) == macro, #macro)
ABI_SIZE(long, SIZEOF_LONG);
ABI_SIZE(long long, SIZEOF_LONG_LONG);
ABI_SIZE(off_t, SIZEOF_OFF_T);
ABI_SIZE(size_t, SIZEOF_SIZE_T);
ABI_SIZE(void *, SIZEOF_VOID_P);
ABI_ALIGN(double, ALIGNOF_DOUBLE);
ABI_ALIGN(int, ALIGNOF_INT);
ABI_ALIGN(int64_t, ALIGNOF_INT64_T);
ABI_ALIGN(long, ALIGNOF_LONG);
ABI_ALIGN(short, ALIGNOF_SHORT);

/* Availability and port sources share actual autoconf compile/link facts.
 * This contract retains explicit wasm32 ABI and atomic checks. Interface
 * enumeration uses PostgreSQL's supported ioctl or generic loopback fallback.
 * The final declared link requires libm; a dead linker cannot mean that all
 * optional capabilities are absent. */
#ifndef HAVE_LIBM
#error "WASIX configuration must link the declared libm dependency"
#endif
#if !defined(HAVE_GETIFADDRS) && defined(SIOCGIFCONF)
_Static_assert(SIOCGIFCONF != 0, "PostgreSQL interface enumeration fallback");
#endif

_Static_assert(__atomic_always_lock_free(4, 0), "32-bit WASIX atomics");
_Static_assert(__atomic_always_lock_free(8, 0), "64-bit WASIX atomics");
