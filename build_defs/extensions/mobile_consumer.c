#include <stddef.h>
#include "oliphaunt.h"

extern const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count);

/* The target linker must resolve every actual registration address and public API. */
int main(void) {
    size_t count = 0;
    const OliphauntStaticExtension *members = liboliphaunt_selected_static_extensions(&count);
    if (members == NULL || count == 0) return 1;
    return oliphaunt_register_static_extensions(members, count) == 0 ? 0 : 1;
}
