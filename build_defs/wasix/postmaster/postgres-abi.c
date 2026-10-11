#include "postgres.h"
#include <sys/types.h>

#if !defined(__wasi__) || !defined(EXEC_BACKEND)
#error The postmaster requires the actual WASI EXEC_BACKEND port
#endif
#if !defined(PG_WASIX_ATOMIC_LATCH_STATE) || PG_WASIX_ATOMIC_LATCH_STATE != 1
#error The postmaster requires the canonical packed atomic latch state
#endif
#if defined(OLIPHAUNT_WASM_SINGLE_USER) || defined(OLIPHAUNT_WASM_SINGLE_BACKEND_ATOMICS)
#error The postmaster cannot consume the embedded single-backend profile
#endif
#if !defined(HAVE_SYNC_FILE_RANGE) || HAVE_SYNC_FILE_RANGE != 1
#error The constructed libc must supply sync_file_range
#endif
#if !defined(USE_UNNAMED_POSIX_SEMAPHORES) || defined(USE_ICU) || defined(USE_OPENSSL) || defined(HAVE_LIBZ)
#error The postmaster must preserve the canonical wasix-core capabilities
#endif

_Static_assert(sizeof(long) == 4 && SIZEOF_LONG == 4, "Actual long must be LP32");
_Static_assert(sizeof(void *) == 4 && SIZEOF_VOID_P == 4, "Actual pointers must be LP32");
_Static_assert(sizeof(size_t) == 4 && SIZEOF_SIZE_T == 4, "Actual size_t must be LP32");
_Static_assert(sizeof(off_t) == 8 && SIZEOF_OFF_T == 8, "Actual off_t must be 64 bits");
_Static_assert(sizeof(Datum) == 4, "Actual PostgreSQL Datum must be LP32");
_Static_assert(!FLOAT8PASSBYVAL, "LP32 PostgreSQL float8 must pass by reference");
_Static_assert(MAXIMUM_ALIGNOF == 8 && BLCKSZ == 8192 && XLOG_BLCKSZ == 8192,
               "Actual PostgreSQL storage ABI must retain the canonical profile");
