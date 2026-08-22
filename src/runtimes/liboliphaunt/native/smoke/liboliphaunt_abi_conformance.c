#include "oliphaunt.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition, message) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "liboliphaunt C ABI conformance failed: %s\n", message); \
            return 1; \
        } \
    } while (0)

_Static_assert(OLIPHAUNT_ABI_VERSION == 8u, "unexpected liboliphaunt ABI version");
_Static_assert(OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION == 1u, "unexpected static extension ABI version");
_Static_assert(OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK == 1ull, "unexpected external root lock flag");
_Static_assert(offsetof(OliphauntConfig, abi_version) == 0, "OliphauntConfig must start with abi_version");
_Static_assert(offsetof(OliphauntRestoreOptions, abi_version) == 0, "OliphauntRestoreOptions must start with abi_version");
_Static_assert(sizeof(((OliphauntConfig *)0)->reserved_flags) == sizeof(uint64_t), "config flags must be 64-bit");
_Static_assert(sizeof(((OliphauntRestoreOptions *)0)->len) == sizeof(size_t), "restore length must be size_t");
_Static_assert(sizeof(((OliphauntResponse *)0)->len) == sizeof(size_t), "response length must be size_t");
_Static_assert(sizeof(((OliphauntStaticExtension *)0)->symbol_count) == sizeof(size_t), "symbol count must be size_t");

#if UINTPTR_MAX == UINT64_MAX
_Static_assert(sizeof(OliphauntConfig) == 72, "unexpected 64-bit OliphauntConfig size");
_Static_assert(offsetof(OliphauntConfig, module_dir) == 24, "unexpected 64-bit module_dir offset");
_Static_assert(offsetof(OliphauntConfig, startup_arg_count) == 64, "unexpected 64-bit startup_arg_count offset");
_Static_assert(sizeof(OliphauntRestoreOptions) == 32, "unexpected 64-bit OliphauntRestoreOptions size");
_Static_assert(offsetof(OliphauntRestoreOptions, destination) == 8, "unexpected 64-bit restore destination offset");
_Static_assert(offsetof(OliphauntRestoreOptions, data) == 16, "unexpected 64-bit restore data offset");
_Static_assert(offsetof(OliphauntRestoreOptions, len) == 24, "unexpected 64-bit restore length offset");
#endif

static int32_t stream_callback(void *context, const uint8_t *data, size_t len) {
    size_t *total = (size_t *)context;
    if (total != NULL) {
        *total += len;
    }
    return data != NULL || len == 0 ? 0 : -1;
}

static uint8_t static_extension_symbol_storage;

int main(void) {
    int32_t (*init_fn)(const OliphauntConfig *, OliphauntHandle **) = oliphaunt_init;
    int32_t (*exec_protocol_fn)(OliphauntHandle *, const uint8_t *, size_t, OliphauntResponse *) =
        oliphaunt_exec_protocol;
    int32_t (*exec_simple_query_fn)(OliphauntHandle *, const char *, size_t, OliphauntResponse *) =
        oliphaunt_exec_simple_query;
    int32_t (*exec_protocol_stream_fn)(
        OliphauntHandle *,
        const uint8_t *,
        size_t,
        OliphauntStreamCallback,
        void *) = oliphaunt_exec_protocol_stream;
    int32_t (*backup_fn)(OliphauntHandle *, OliphauntResponse *) =
        oliphaunt_backup;
    int32_t (*restore_fn)(const OliphauntRestoreOptions *) = oliphaunt_restore;
    int32_t (*cancel_fn)(OliphauntHandle *) = oliphaunt_cancel;
    int32_t (*detach_fn)(OliphauntHandle *) = oliphaunt_detach;
    uint64_t (*logical_generation_fn)(OliphauntHandle *) = oliphaunt_logical_generation;
    int32_t (*close_if_generation_fn)(uint64_t) =
        oliphaunt_close_if_generation;
    int32_t (*close_fn)(OliphauntHandle *) = oliphaunt_close;
    int32_t (*register_static_extensions_fn)(const OliphauntStaticExtension *, size_t) =
        oliphaunt_register_static_extensions;
    const char *(*last_error_fn)(OliphauntHandle *) = oliphaunt_last_error;
    const char *(*version_fn)(void) = oliphaunt_version;
    void (*free_response_fn)(OliphauntResponse *) = oliphaunt_free_response;
    OliphauntStreamCallback stream_callback_fn = stream_callback;

    CHECK(init_fn != NULL, "oliphaunt_init must link");
    CHECK(exec_protocol_fn != NULL, "oliphaunt_exec_protocol must link");
    CHECK(exec_simple_query_fn != NULL, "oliphaunt_exec_simple_query must link");
    CHECK(exec_protocol_stream_fn != NULL, "oliphaunt_exec_protocol_stream must link");
    CHECK(backup_fn != NULL, "oliphaunt_backup must link");
    CHECK(restore_fn != NULL, "oliphaunt_restore must link");
    CHECK(cancel_fn != NULL, "oliphaunt_cancel must link");
    CHECK(detach_fn != NULL, "oliphaunt_detach must link");
    CHECK(logical_generation_fn != NULL, "oliphaunt_logical_generation must link");
    CHECK(close_if_generation_fn != NULL, "oliphaunt_close_if_generation must link");
    CHECK(close_fn != NULL, "oliphaunt_close must link");
    CHECK(register_static_extensions_fn != NULL, "oliphaunt_register_static_extensions must link");
    CHECK(last_error_fn != NULL, "oliphaunt_last_error must link");
    CHECK(version_fn != NULL, "oliphaunt_version must link");
    CHECK(free_response_fn != NULL, "oliphaunt_free_response must link");
    CHECK(stream_callback_fn != NULL, "OliphauntStreamCallback must accept stream callbacks");

    OliphauntConfig config = {0};
    config.abi_version = OLIPHAUNT_ABI_VERSION;
    config.pgdata = "/tmp/oliphaunt-abi-conformance-pgdata";
    config.runtime_dir = "/tmp/oliphaunt-abi-conformance-runtime";
    config.module_dir = NULL;
    config.username = "liboliphaunt";
    config.database = "postgres";
    config.reserved_flags = 0;
    config.startup_args = NULL;
    config.startup_arg_count = 0;

    OliphauntResponse response = {0};
    response.data = NULL;
    response.len = 0;
    free_response_fn(&response);
    CHECK(response.data == NULL && response.len == 0, "oliphaunt_free_response must clear empty responses");
    free_response_fn(NULL);

    OliphauntRestoreOptions restore = {0};
    restore.abi_version = OLIPHAUNT_ABI_VERSION;
    restore.destination = "/tmp/oliphaunt-abi-conformance-restore";
    restore.data = (const uint8_t *)"x";
    restore.len = 1;

    OliphauntStaticExtensionSymbol symbol = {
        .name = "liboliphaunt_abi_conformance_symbol",
        .address = &static_extension_symbol_storage,
    };
    OliphauntStaticExtension extension = {
        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
        .name = "liboliphaunt_abi_conformance",
        .magic = NULL,
        .init = NULL,
        .symbols = &symbol,
        .symbol_count = 1,
        .reserved_flags = 0,
    };
    CHECK(extension.symbols[0].address == &static_extension_symbol_storage, "static extension symbol layout mismatch");

    const char *version = version_fn();
    unsigned int major = 0;
    unsigned int minor = 0;
    unsigned int patch = 0;
    char trailing = '\0';
    CHECK(version != NULL && sscanf(version, "%u.%u.%u%c", &major, &minor, &patch, &trailing) == 3,
          "unexpected version string");

    CHECK(close_fn(NULL) == 0, "oliphaunt_close(NULL) must be a no-op");
    CHECK(detach_fn(NULL) == 0, "oliphaunt_detach(NULL) must be a no-op");
    CHECK(logical_generation_fn(NULL) == 0, "oliphaunt_logical_generation(NULL) must return zero");
    CHECK(close_if_generation_fn(0) == -1,
          "oliphaunt_close_if_generation(0) must reject generation zero");
    CHECK(cancel_fn(NULL) != 0, "oliphaunt_cancel(NULL) must fail");
    const char *error = last_error_fn(NULL);
    CHECK(error != NULL && strstr(error, "invalid oliphaunt_cancel arguments") != NULL,
          "oliphaunt_cancel(NULL) must set a global error");

    (void)init_fn;
    (void)exec_protocol_fn;
    (void)exec_simple_query_fn;
    (void)exec_protocol_stream_fn;
    (void)backup_fn;
    (void)restore_fn;
    (void)register_static_extensions_fn;
    (void)config;
    (void)restore;

    return 0;
}
