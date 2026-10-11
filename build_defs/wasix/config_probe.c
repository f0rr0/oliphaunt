#define _GNU_SOURCE 1
#include <fcntl.h>
#include <getopt.h>
#include <ifaddrs.h>
#include <locale.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>
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

/* Compile against actual declared libc headers, rather than inheriting host
 * configure results. Final runtime linkage also proves these symbols exist. */
#define FUNCTION(name) __typeof__(&name) const oliphaunt_probe_##name = &name
FUNCTION(explicit_bzero);
FUNCTION(fdatasync);
FUNCTION(fseeko);
/* Header declarations alone are not a libc capability: this pinned sysroot
 * has ifaddrs.h but no getifaddrs/freeifaddrs definitions. */
#ifdef HAVE_GETIFADDRS
FUNCTION(getifaddrs);
FUNCTION(freeifaddrs);
#else
FUNCTION(ioctl);
_Static_assert(SIOCGIFCONF != 0, "PostgreSQL interface enumeration fallback");
#endif
FUNCTION(getopt_long);
FUNCTION(mkdtemp);
FUNCTION(posix_fadvise);
FUNCTION(posix_fallocate);
FUNCTION(ppoll);
FUNCTION(preadv);
FUNCTION(pthread_barrier_wait);
FUNCTION(pwritev);
FUNCTION(strchrnul);
FUNCTION(strlcat);
FUNCTION(strlcpy);
FUNCTION(strnlen);
FUNCTION(strsep);
FUNCTION(uselocale);

int oliphaunt_wasix_config_probe(void)
{
    struct tm value = {0};
    socklen_t length = 0;
    int buffer[2] = {0};
    _Static_assert(__atomic_always_lock_free(4, 0), "32-bit WASIX atomics");
    _Static_assert(__atomic_always_lock_free(8, 0), "64-bit WASIX atomics");
    return (value.tm_zone != NULL) + length + __sync_bool_compare_and_swap(buffer, 0, 1);
}
