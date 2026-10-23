#include <stddef.h>
#include <stdint.h>

#define OLIPHAUNT_STRINGIFY_INNER(value) #value
#define OLIPHAUNT_STRINGIFY(value) OLIPHAUNT_STRINGIFY_INNER(value)
#include OLIPHAUNT_STRINGIFY(OLIPHAUNT_COMPILER_PROBE_HEADER)

#if !defined(HAVE_STDIO_H) || !defined(HAVE_STDINT_H) || !defined(HAVE_STDLIB_H)
#error "native compiler probe failed mandatory standard headers"
#endif
#if defined(HAVE_OLIPHAUNT_NATIVE_PROBE_MISSING_HEADER_H) || defined(HAVE_OLIPHAUNT_MISSING_TYPE)
#error "native compiler probe falsely accepts a missing header or type"
#endif

/* Compile-time expressions work with MSVC and cross compilers too. No target
 * execution or copied host LP64 assumption establishes these ABI facts. */
#define SAME_SIZE(macro, type) typedef char verify_##macro[(macro) == sizeof(type) ? 1 : -1]
#define SAME_ALIGNMENT(macro, type) \
    struct align_##macro { char lead; type value; }; \
    typedef char verify_##macro[(macro) == offsetof(struct align_##macro, value) ? 1 : -1]

SAME_SIZE(SIZEOF_LONG, long);
SAME_SIZE(SIZEOF_LONG_LONG, long long);
SAME_SIZE(SIZEOF_SIZE_T, size_t);
SAME_SIZE(SIZEOF_VOID_P, void *);
SAME_ALIGNMENT(ALIGNOF_DOUBLE, double);
SAME_ALIGNMENT(ALIGNOF_INT, int);
SAME_ALIGNMENT(ALIGNOF_INT64_T, int64_t);
SAME_ALIGNMENT(ALIGNOF_LONG, long);
SAME_ALIGNMENT(ALIGNOF_SHORT, short);

int main(void) { return 0; }
