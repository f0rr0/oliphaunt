#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "liboliphaunt_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char test_error[1024];
static int long_symbol_target = 4242;

void oliphaunt_set_error(OliphauntHandle *handle, const char *message) {
    (void)handle;
    snprintf(test_error, sizeof(test_error), "%s", message != NULL ? message : "");
}

const OliphauntStaticExtension *liboliphaunt_builtin_static_extensions(size_t *count) {
    if (count != NULL) {
        *count = 0;
    }
    return NULL;
}

static const void *test_magic(void) {
    return &long_symbol_target;
}

static void fail(const char *message) {
    fprintf(stderr, "%s%s%s\n", message, test_error[0] != '\0' ? ": " : "", test_error);
    exit(1);
}

int main(void) {
    static const char long_linker_symbol[] =
        "_ZNSt3__112__hash_tableINS_17__hash_value_typeIyyEENS_22__unordered_map_hasherIyNS_4pairIKyyEENS_4hashIyEENS_8equal_toIyEELb1EEENS_21__unordered_map_equalIyS6_SA_S8_Lb1EEENS_9allocatorIS6_EEE25__emplace_unique_key_argsIyJNS4_IyyEEEEENS4_INS_15__hash_iteratorIPNS_11__hash_nodeIS2_PvEEEEbEERKT_DpOT0_";
    static const char overlong_module_name[] =
        "module_name_that_is_deliberately_longer_than_the_128_byte_package_and_filesystem_identity_limit_"
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    static const OliphauntStaticExtensionSymbol symbols[] = {
        {
            .name = long_linker_symbol,
            .address = &long_symbol_target,
        },
    };
    static const OliphauntStaticExtension valid_extension[] = {
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
            .name = "long_symbol_fixture",
            .magic = test_magic,
            .symbols = symbols,
            .symbol_count = sizeof(symbols) / sizeof(symbols[0]),
            .reserved_flags = 0,
        },
    };
    static const OliphauntStaticExtension invalid_extension[] = {
        {
            .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
            .name = overlong_module_name,
            .magic = test_magic,
            .reserved_flags = 0,
        },
    };

    if (strlen(long_linker_symbol) <= 128 || strlen(overlong_module_name) <= 128) {
        fail("static-extension registry test fixtures do not cross the module-name boundary");
    }
    if (oliphaunt_register_static_extensions(invalid_extension, 1) == 0 ||
        strstr(test_error, "invalid static extension registration entry") == NULL) {
        fail("static-extension registry accepted an overlong module identity");
    }

    test_error[0] = '\0';
    if (oliphaunt_register_static_extensions(valid_extension, 1) != 0) {
        fail("static-extension registry rejected a valid long linker symbol");
    }
    const OliphauntStaticExtension *registered =
        oliphaunt_static_extension_lookup("long_symbol_fixture.dylib");
    if (registered == NULL ||
        oliphaunt_static_extension_symbol(registered, long_linker_symbol) != &long_symbol_target) {
        fail("static-extension registry did not preserve the valid long linker symbol");
    }

    puts("liboliphaunt static-extension registry long-symbol contract passed");
    return 0;
}
