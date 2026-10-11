/* Reject absent/incorrect target ABI probes before admitting PostgreSQL. */
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include "pg_config.h"

#define ALIGNOF(type) offsetof(struct { char byte; type value; }, value)
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
