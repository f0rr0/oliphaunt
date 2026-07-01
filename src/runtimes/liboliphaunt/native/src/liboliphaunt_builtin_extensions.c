#include "liboliphaunt_internal.h"

#ifdef OLIPHAUNT_BUILTIN_PLPGSQL
extern const void *Pg_magic_func(void);
extern void _PG_init(void);
extern void plpgsql_call_handler(void);
extern void pg_finfo_plpgsql_call_handler(void);
extern void plpgsql_inline_handler(void);
extern void pg_finfo_plpgsql_inline_handler(void);
extern void plpgsql_validator(void);
extern void pg_finfo_plpgsql_validator(void);

static const OliphauntStaticExtensionSymbol plpgsql_symbols[] = {
    {.name = "plpgsql_call_handler", .address = (void *)plpgsql_call_handler},
    {.name = "pg_finfo_plpgsql_call_handler", .address = (void *)pg_finfo_plpgsql_call_handler},
    {.name = "plpgsql_inline_handler", .address = (void *)plpgsql_inline_handler},
    {.name = "pg_finfo_plpgsql_inline_handler", .address = (void *)pg_finfo_plpgsql_inline_handler},
    {.name = "plpgsql_validator", .address = (void *)plpgsql_validator},
    {.name = "pg_finfo_plpgsql_validator", .address = (void *)pg_finfo_plpgsql_validator},
};

static const OliphauntStaticExtension builtin_static_extensions[] = {
    {
        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
        .name = "plpgsql",
        .magic = Pg_magic_func,
        .init = _PG_init,
        .symbols = plpgsql_symbols,
        .symbol_count = sizeof(plpgsql_symbols) / sizeof(plpgsql_symbols[0]),
        .reserved_flags = 0,
    },
};
#endif

const OliphauntStaticExtension *liboliphaunt_builtin_static_extensions(size_t *count) {
#ifdef OLIPHAUNT_BUILTIN_PLPGSQL
    if (count != NULL) {
        *count = sizeof(builtin_static_extensions) / sizeof(builtin_static_extensions[0]);
    }
    return builtin_static_extensions;
#else
    if (count != NULL) {
        *count = 0;
    }
    return NULL;
#endif
}
