#include "COliphaunt.h"

void oliphaunt_swift_link_runtime(void) {
#ifdef OLIPHAUNT_LINK_RUNTIME
    /* Keep the packaged runtime linked when Rust resolves its ABI dynamically. */
    const char *(*volatile version)(void) = oliphaunt_version;
    (void)version;
#endif
}
