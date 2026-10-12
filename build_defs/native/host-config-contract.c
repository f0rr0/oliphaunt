/* Reject absent/incorrect target ABI probes before admitting PostgreSQL. */
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include "pg_config.h"

#if !defined(SIZEOF_LONG) || !defined(SIZEOF_LONG_LONG) || \
    !defined(SIZEOF_OFF_T) || !defined(SIZEOF_SIZE_T) || \
    !defined(SIZEOF_VOID_P) || !defined(ALIGNOF_DOUBLE) || \
    !defined(ALIGNOF_INT) || !defined(ALIGNOF_INT64_T) || \
    !defined(ALIGNOF_LONG) || !defined(ALIGNOF_SHORT)
#error "Host ABI facts are missing: inspect the native compiler probe diagnostics"
#else

struct oliphaunt_double_alignment { char byte; double value; };
struct oliphaunt_int_alignment { char byte; int value; };
struct oliphaunt_int64_t_alignment { char byte; int64_t value; };
struct oliphaunt_long_alignment { char byte; long value; };
struct oliphaunt_short_alignment { char byte; short value; };
#define ALIGNOF(type) offsetof(struct oliphaunt_##type##_alignment, value)
#define ASSERT(name, condition) typedef char name[(condition) ? 1 : -1]
ASSERT(long_size, SIZEOF_LONG == sizeof(long));
ASSERT(long_long_size, SIZEOF_LONG_LONG == sizeof(long long));
ASSERT(off_t_size, SIZEOF_OFF_T == sizeof(off_t));
ASSERT(size_t_size, SIZEOF_SIZE_T == sizeof(size_t));
ASSERT(pointer_size, SIZEOF_VOID_P == sizeof(void *));
ASSERT(double_align, ALIGNOF_DOUBLE == ALIGNOF(double));
ASSERT(int_align, ALIGNOF_INT == ALIGNOF(int));
ASSERT(int64_align, ALIGNOF_INT64_T == ALIGNOF(int64_t));
ASSERT(long_align, ALIGNOF_LONG == ALIGNOF(long));
ASSERT(short_align, ALIGNOF_SHORT == ALIGNOF(short));
ASSERT(pg_alignment, MAXIMUM_ALIGNOF >= ALIGNOF(int64_t));
ASSERT(profile_pointer_size, SIZEOF_VOID_P == 8);
#ifdef _WIN32
ASSERT(windows_llp64, SIZEOF_LONG == 4 && SIZEOF_OFF_T == 4);
#else
ASSERT(apple_lp64, SIZEOF_LONG == 8 && SIZEOF_OFF_T == 8);
#endif
#endif
