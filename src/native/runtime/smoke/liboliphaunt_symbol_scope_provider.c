#include "liboliphaunt_internal.h"

int oliphaunt_scope_test_global = 4242;

int32_t oliphaunt_close(OliphauntHandle *handle) {
    (void)handle;
    return 0;
}

int32_t oliphaunt_close_if_generation(uint64_t generation) {
    (void)generation;
    return 0;
}

int32_t oliphaunt_close_claimed_global_instance(OliphauntHandle *handle) {
    (void)handle;
    return 0;
}

void oliphaunt_set_error(OliphauntHandle *handle, const char *message) {
    (void)handle;
    (void)message;
}
