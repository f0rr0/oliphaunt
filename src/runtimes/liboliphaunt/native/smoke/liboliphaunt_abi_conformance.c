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

#define CHECK_ONE_BIT(value) \
    _Static_assert(((value) != 0) && (((value) & ((value) - 1ull)) == 0), #value " must be a single capability bit")

CHECK_ONE_BIT(OLIPHAUNT_CAP_PROTOCOL_RAW);
CHECK_ONE_BIT(OLIPHAUNT_CAP_PROTOCOL_STREAM);
CHECK_ONE_BIT(OLIPHAUNT_CAP_MULTI_INSTANCE);
CHECK_ONE_BIT(OLIPHAUNT_CAP_SERVER_MODE);
CHECK_ONE_BIT(OLIPHAUNT_CAP_EXTENSIONS);
CHECK_ONE_BIT(OLIPHAUNT_CAP_QUERY_CANCEL);
CHECK_ONE_BIT(OLIPHAUNT_CAP_BACKUP_RESTORE);
CHECK_ONE_BIT(OLIPHAUNT_CAP_SIMPLE_QUERY);
CHECK_ONE_BIT(OLIPHAUNT_CAP_STATIC_EXTENSIONS);
CHECK_ONE_BIT(OLIPHAUNT_CAP_LOGICAL_REOPEN);

_Static_assert(OLIPHAUNT_ABI_VERSION == 6u, "unexpected liboliphaunt ABI version");
_Static_assert(OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION == 1u, "unexpected static extension ABI version");
_Static_assert(OLIPHAUNT_BACKUP_FORMAT_SQL == 1u, "unexpected SQL backup format tag");
_Static_assert(OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE == 2u, "unexpected physical archive backup format tag");
_Static_assert(OLIPHAUNT_BACKUP_FORMAT_OLIPHAUNT_ARCHIVE == 3u, "unexpected oliphaunt archive backup format tag");
_Static_assert(offsetof(OliphauntConfig, abi_version) == 0, "OliphauntConfig must start with abi_version");
_Static_assert(offsetof(OliphauntBackupOptions, abi_version) == 0, "OliphauntBackupOptions must start with abi_version");
_Static_assert(offsetof(OliphauntRestoreOptions, abi_version) == 0, "OliphauntRestoreOptions must start with abi_version");
_Static_assert(sizeof(((OliphauntConfig *)0)->reserved_flags) == sizeof(uint64_t), "config flags must be 64-bit");
_Static_assert(sizeof(((OliphauntArchiveFile *)0)->len) == sizeof(size_t), "archive file length must be size_t");
_Static_assert(sizeof(((OliphauntArchiveFile *)0)->reserved_flags) == sizeof(uint64_t), "archive file flags must be 64-bit");
_Static_assert(sizeof(((OliphauntBackupOptions *)0)->generated_file_count) == sizeof(size_t), "generated file count must be size_t");
_Static_assert(sizeof(((OliphauntBackupOptions *)0)->reserved_flags) == sizeof(uint64_t), "backup flags must be 64-bit");
_Static_assert(sizeof(((OliphauntRestoreOptions *)0)->flags) == sizeof(uint64_t), "restore flags must be 64-bit");
_Static_assert(sizeof(((OliphauntResponse *)0)->len) == sizeof(size_t), "response length must be size_t");
_Static_assert(sizeof(((OliphauntStaticExtension *)0)->symbol_count) == sizeof(size_t), "symbol count must be size_t");

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
    int32_t (*backup_fn)(OliphauntHandle *, uint32_t, OliphauntResponse *) = oliphaunt_backup;
    int32_t (*backup_ex_fn)(OliphauntHandle *, const OliphauntBackupOptions *, OliphauntResponse *) =
        oliphaunt_backup_ex;
    int32_t (*restore_fn)(const OliphauntRestoreOptions *) = oliphaunt_restore;
    int32_t (*cancel_fn)(OliphauntHandle *) = oliphaunt_cancel;
    int32_t (*detach_fn)(OliphauntHandle *) = oliphaunt_detach;
    int32_t (*close_fn)(OliphauntHandle *) = oliphaunt_close;
    int32_t (*register_static_extensions_fn)(const OliphauntStaticExtension *, size_t) =
        oliphaunt_register_static_extensions;
    const char *(*last_error_fn)(OliphauntHandle *) = oliphaunt_last_error;
    const char *(*version_fn)(void) = oliphaunt_version;
    uint64_t (*capabilities_fn)(void) = oliphaunt_capabilities;
    void (*free_response_fn)(OliphauntResponse *) = oliphaunt_free_response;
    OliphauntStreamCallback stream_callback_fn = stream_callback;

    CHECK(init_fn != NULL, "oliphaunt_init must link");
    CHECK(exec_protocol_fn != NULL, "oliphaunt_exec_protocol must link");
    CHECK(exec_simple_query_fn != NULL, "oliphaunt_exec_simple_query must link");
    CHECK(exec_protocol_stream_fn != NULL, "oliphaunt_exec_protocol_stream must link");
    CHECK(backup_fn != NULL, "oliphaunt_backup must link");
    CHECK(backup_ex_fn != NULL, "oliphaunt_backup_ex must link");
    CHECK(restore_fn != NULL, "oliphaunt_restore must link");
    CHECK(cancel_fn != NULL, "oliphaunt_cancel must link");
    CHECK(detach_fn != NULL, "oliphaunt_detach must link");
    CHECK(close_fn != NULL, "oliphaunt_close must link");
    CHECK(register_static_extensions_fn != NULL, "oliphaunt_register_static_extensions must link");
    CHECK(last_error_fn != NULL, "oliphaunt_last_error must link");
    CHECK(version_fn != NULL, "oliphaunt_version must link");
    CHECK(capabilities_fn != NULL, "oliphaunt_capabilities must link");
    CHECK(free_response_fn != NULL, "oliphaunt_free_response must link");
    CHECK(stream_callback_fn != NULL, "OliphauntStreamCallback must accept stream callbacks");

    OliphauntConfig config = {0};
    config.abi_version = OLIPHAUNT_ABI_VERSION;
    config.pgdata = "/tmp/oliphaunt-abi-conformance-pgdata";
    config.runtime_dir = "/tmp/oliphaunt-abi-conformance-runtime";
    config.username = "liboliphaunt";
    config.database = "postgres";
    config.reserved_flags = OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK;
    config.startup_args = NULL;
    config.startup_arg_count = 0;

    OliphauntResponse response = {0};
    response.data = NULL;
    response.len = 0;
    free_response_fn(&response);
    CHECK(response.data == NULL && response.len == 0, "oliphaunt_free_response must clear empty responses");
    free_response_fn(NULL);

    const uint8_t manifest_bytes[] = "layout=abi\n";
    OliphauntArchiveFile generated_file = {
        .path = "manifest.properties",
        .data = manifest_bytes,
        .len = sizeof(manifest_bytes) - 1,
        .mode = 0600,
        .reserved_flags = 0,
    };
    OliphauntBackupOptions backup_options = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .format = OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE,
        .generated_files = &generated_file,
        .generated_file_count = 1,
        .reserved_flags = 0,
    };
    CHECK(backup_options.generated_files[0].len == sizeof(manifest_bytes) - 1, "backup options layout mismatch");

    OliphauntRestoreOptions restore = {0};
    restore.abi_version = OLIPHAUNT_ABI_VERSION;
    restore.root = "/tmp/oliphaunt-abi-conformance-restore";
    restore.format = OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE;
    restore.data = (const uint8_t *)"x";
    restore.len = 1;
    restore.flags = OLIPHAUNT_RESTORE_REPLACE_EXISTING;

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

    uint64_t capabilities = capabilities_fn();
    uint64_t required =
        OLIPHAUNT_CAP_PROTOCOL_RAW |
        OLIPHAUNT_CAP_PROTOCOL_STREAM |
        OLIPHAUNT_CAP_EXTENSIONS |
        OLIPHAUNT_CAP_QUERY_CANCEL |
        OLIPHAUNT_CAP_BACKUP_RESTORE |
        OLIPHAUNT_CAP_SIMPLE_QUERY |
        OLIPHAUNT_CAP_STATIC_EXTENSIONS |
        OLIPHAUNT_CAP_LOGICAL_REOPEN;
    CHECK((capabilities & required) == required, "missing required capability bits");
    CHECK((capabilities & OLIPHAUNT_CAP_MULTI_INSTANCE) == 0, "direct C ABI must not advertise multi-instance");
    CHECK((capabilities & OLIPHAUNT_CAP_SERVER_MODE) == 0, "direct C ABI must not advertise server mode");

    CHECK(close_fn(NULL) == 0, "oliphaunt_close(NULL) must be a no-op");
    CHECK(detach_fn(NULL) == 0, "oliphaunt_detach(NULL) must be a no-op");
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
