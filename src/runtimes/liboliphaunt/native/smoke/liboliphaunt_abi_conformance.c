#include "oliphaunt.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#ifndef _WIN32
#include <pthread.h>
#endif

#define CHECK(condition, message) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "liboliphaunt C ABI conformance failed: %s\n", message); \
            return 1; \
        } \
    } while (0)

#define CHECK_NULL_CAPTURE(call, operation) \
    do { \
        CHECK((call) != 0, operation " must reject a null error capture"); \
        copied_error[0] = '\0'; \
        (void)copy_last_error_fn(NULL, copied_error, sizeof(copied_error)); \
        CHECK( \
            strcmp(copied_error, operation " error capture is null") == 0, \
            operation " must publish its null-capture validation error"); \
    } while (0)

_Static_assert(OLIPHAUNT_ABI_VERSION == 10u, "unexpected liboliphaunt ABI version");
_Static_assert(OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION == 1u, "unexpected static extension ABI version");
_Static_assert(OLIPHAUNT_ERROR_CAPTURE_CAPACITY == 1024u, "unexpected error capture capacity");
_Static_assert(OLIPHAUNT_STREAM_CALLBACK_ABORTED == 1, "unexpected callback-aborted status");
_Static_assert(OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK == 1ull, "unexpected external root lock flag");
_Static_assert(offsetof(OliphauntConfig, abi_version) == 0, "OliphauntConfig must start with abi_version");
_Static_assert(offsetof(OliphauntRestoreOptions, abi_version) == 0, "OliphauntRestoreOptions must start with abi_version");
_Static_assert(sizeof(((OliphauntConfig *)0)->flags) == sizeof(uint64_t), "config flags must be 64-bit");
_Static_assert(sizeof(((OliphauntRestoreOptions *)0)->len) == sizeof(size_t), "restore length must be size_t");
_Static_assert(sizeof(((OliphauntResponse *)0)->len) == sizeof(size_t), "response length must be size_t");
_Static_assert(sizeof(((OliphauntStaticExtension *)0)->symbol_count) == sizeof(size_t), "symbol count must be size_t");
_Static_assert(offsetof(OliphauntErrorCapture, length) == 0, "error capture must start with length");
_Static_assert(offsetof(OliphauntErrorCapture, message) == 4, "unexpected error capture message offset");
_Static_assert(sizeof(OliphauntErrorCapture) == 1028, "unexpected error capture size");

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

#ifndef _WIN32
typedef struct ErrorRaceGate {
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    unsigned int arrived;
    int released;
} ErrorRaceGate;

typedef struct ErrorRaceWorker {
    ErrorRaceGate *gate;
    int operation;
    int operation_failed;
    size_t required;
    size_t copied_length;
    size_t truncated_length;
    OliphauntErrorCapture captured;
    char copied[128];
    char truncated[4];
} ErrorRaceWorker;

static void *run_error_race_worker(void *opaque) {
    ErrorRaceWorker *worker = (ErrorRaceWorker *)opaque;
    int32_t rc = worker->operation == 0
        ? oliphaunt_exec_protocol_with_error(
            NULL, NULL, 0, NULL, &worker->captured)
        : oliphaunt_restore_with_error(NULL, &worker->captured);
    worker->operation_failed = rc != 0;
    worker->required = oliphaunt_copy_last_error(NULL, NULL, 0);

    pthread_mutex_lock(&worker->gate->mutex);
    worker->gate->arrived++;
    pthread_cond_broadcast(&worker->gate->condition);
    while (!worker->gate->released) {
        pthread_cond_wait(&worker->gate->condition, &worker->gate->mutex);
    }
    pthread_mutex_unlock(&worker->gate->mutex);

    worker->copied_length = oliphaunt_copy_last_error(
        NULL,
        worker->copied,
        sizeof(worker->copied));
    worker->truncated_length = oliphaunt_copy_last_error(
        NULL,
        worker->truncated,
        sizeof(worker->truncated));
    return NULL;
}
#endif

int main(void) {
    int32_t (*init_fn)(const OliphauntConfig *, OliphauntHandle **) = oliphaunt_init;
    int32_t (*exec_protocol_fn)(OliphauntHandle *, const uint8_t *, size_t, OliphauntResponse *) =
        oliphaunt_exec_protocol;
    int32_t (*exec_simple_query_fn)(OliphauntHandle *, const char *, size_t, OliphauntResponse *) =
        oliphaunt_exec_simple_query;
    int32_t (*exec_protocol_raw_stream_fn)(
        OliphauntHandle *,
        const uint8_t *,
        size_t,
        OliphauntStreamCallback,
        void *) = oliphaunt_exec_protocol_raw_stream;
    int32_t (*backup_fn)(OliphauntHandle *, OliphauntResponse *) =
        oliphaunt_backup;
    int32_t (*restore_fn)(const OliphauntRestoreOptions *) = oliphaunt_restore;
    int32_t (*init_with_error_fn)(const OliphauntConfig *, OliphauntHandle **, OliphauntErrorCapture *) =
        oliphaunt_init_with_error;
    int32_t (*exec_protocol_with_error_fn)(
        OliphauntHandle *,
        const uint8_t *,
        size_t,
        OliphauntResponse *,
        OliphauntErrorCapture *) = oliphaunt_exec_protocol_with_error;
    int32_t (*exec_simple_query_with_error_fn)(
        OliphauntHandle *,
        const char *,
        size_t,
        OliphauntResponse *,
        OliphauntErrorCapture *) = oliphaunt_exec_simple_query_with_error;
    int32_t (*exec_protocol_raw_stream_with_error_fn)(
        OliphauntHandle *,
        const uint8_t *,
        size_t,
        OliphauntStreamCallback,
        void *,
        OliphauntErrorCapture *) = oliphaunt_exec_protocol_raw_stream_with_error;
    int32_t (*backup_with_error_fn)(OliphauntHandle *, OliphauntResponse *, OliphauntErrorCapture *) =
        oliphaunt_backup_with_error;
    int32_t (*restore_with_error_fn)(const OliphauntRestoreOptions *, OliphauntErrorCapture *) =
        oliphaunt_restore_with_error;
    int32_t (*detach_with_error_fn)(OliphauntHandle *, OliphauntErrorCapture *) =
        oliphaunt_detach_with_error;
    int32_t (*cancel_fn)(OliphauntHandle *) = oliphaunt_cancel;
    int32_t (*detach_fn)(OliphauntHandle *) = oliphaunt_detach;
    uint64_t (*logical_generation_fn)(OliphauntHandle *) = oliphaunt_logical_generation;
    int32_t (*close_if_generation_fn)(uint64_t) =
        oliphaunt_close_if_generation;
    int32_t (*close_fn)(OliphauntHandle *) = oliphaunt_close;
    int32_t (*register_static_extensions_fn)(const OliphauntStaticExtension *, size_t) =
        oliphaunt_register_static_extensions;
    size_t (*copy_last_error_fn)(OliphauntHandle *, char *, size_t) =
        oliphaunt_copy_last_error;
    const char *(*version_fn)(void) = oliphaunt_version;
    void (*free_response_fn)(OliphauntResponse *) = oliphaunt_free_response;
    OliphauntStreamCallback stream_callback_fn = stream_callback;

    CHECK(init_fn != NULL, "oliphaunt_init must link");
    CHECK(exec_protocol_fn != NULL, "oliphaunt_exec_protocol must link");
    CHECK(exec_simple_query_fn != NULL, "oliphaunt_exec_simple_query must link");
    CHECK(exec_protocol_raw_stream_fn != NULL, "oliphaunt_exec_protocol_raw_stream must link");
    CHECK(backup_fn != NULL, "oliphaunt_backup must link");
    CHECK(restore_fn != NULL, "oliphaunt_restore must link");
    CHECK(init_with_error_fn != NULL, "oliphaunt_init_with_error must link");
    CHECK(exec_protocol_with_error_fn != NULL, "oliphaunt_exec_protocol_with_error must link");
    CHECK(exec_simple_query_with_error_fn != NULL, "oliphaunt_exec_simple_query_with_error must link");
    CHECK(exec_protocol_raw_stream_with_error_fn != NULL,
          "oliphaunt_exec_protocol_raw_stream_with_error must link");
    CHECK(backup_with_error_fn != NULL, "oliphaunt_backup_with_error must link");
    CHECK(restore_with_error_fn != NULL, "oliphaunt_restore_with_error must link");
    CHECK(detach_with_error_fn != NULL, "oliphaunt_detach_with_error must link");
    CHECK(cancel_fn != NULL, "oliphaunt_cancel must link");
    CHECK(detach_fn != NULL, "oliphaunt_detach must link");
    CHECK(logical_generation_fn != NULL, "oliphaunt_logical_generation must link");
    CHECK(close_if_generation_fn != NULL, "oliphaunt_close_if_generation must link");
    CHECK(close_fn != NULL, "oliphaunt_close must link");
    CHECK(register_static_extensions_fn != NULL, "oliphaunt_register_static_extensions must link");
    CHECK(copy_last_error_fn != NULL, "oliphaunt_copy_last_error must link");
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
    config.flags = 0;
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
    char copied_error[256] = {0};
    size_t copied_error_len = copy_last_error_fn(NULL, copied_error, sizeof(copied_error));
    CHECK(copied_error_len == strlen(copied_error),
          "oliphaunt_copy_last_error must return the full error length");
    CHECK(strstr(copied_error, "invalid oliphaunt_cancel arguments") != NULL,
          "oliphaunt_copy_last_error must copy the global error");
    char truncated_error[4] = {'x', 'x', 'x', 'x'};
    CHECK(copy_last_error_fn(NULL, truncated_error, sizeof(truncated_error)) == copied_error_len,
          "oliphaunt_copy_last_error must report the untruncated length");
    CHECK(truncated_error[sizeof(truncated_error) - 1] == '\0',
          "oliphaunt_copy_last_error must terminate truncated output");
    OliphauntErrorCapture captured;
    memset(&captured, 0xa5, sizeof(captured));
    CHECK(detach_with_error_fn(NULL, &captured) == 0,
          "oliphaunt_detach_with_error(NULL) must retain detach semantics");
    CHECK(captured.length == 0 && captured.message[0] == '\0',
          "successful captured operations must clear the complete visible result");
    for (size_t i = 0; i < sizeof(captured); i++) {
        CHECK(((const unsigned char *)&captured)[i] == 0,
              "successful captured operations must deterministically zero the capture");
    }
    CHECK_NULL_CAPTURE(init_with_error_fn(NULL, NULL, NULL), "oliphaunt_init");
    CHECK_NULL_CAPTURE(
        exec_protocol_with_error_fn(NULL, NULL, 0, NULL, NULL),
        "oliphaunt_exec_protocol");
    CHECK_NULL_CAPTURE(
        exec_simple_query_with_error_fn(NULL, NULL, 0, NULL, NULL),
        "oliphaunt_exec_simple_query");
    CHECK_NULL_CAPTURE(
        exec_protocol_raw_stream_with_error_fn(
            NULL, NULL, 0, stream_callback_fn, NULL, NULL),
        "oliphaunt_exec_protocol_raw_stream");
    CHECK_NULL_CAPTURE(backup_with_error_fn(NULL, NULL, NULL), "oliphaunt_backup");
    CHECK_NULL_CAPTURE(restore_with_error_fn(NULL, NULL), "oliphaunt_restore");
    CHECK_NULL_CAPTURE(detach_with_error_fn(NULL, NULL), "oliphaunt_detach");
    CHECK(restore_with_error_fn(NULL, &captured) != 0,
          "oliphaunt_restore_with_error(NULL) must fail");
    CHECK(captured.length == strlen(captured.message),
          "captured operation errors must report their exact length");
    CHECK(strstr(captured.message, "invalid oliphaunt_restore options") != NULL,
          "captured operation errors must belong to the same native invocation");

#ifndef _WIN32
    ErrorRaceGate error_gate;
    CHECK(pthread_mutex_init(&error_gate.mutex, NULL) == 0,
          "error-attribution race mutex must initialize");
    CHECK(pthread_cond_init(&error_gate.condition, NULL) == 0,
          "error-attribution race condition must initialize");
    error_gate.arrived = 0;
    error_gate.released = 0;
    ErrorRaceWorker error_workers[2] = {
        {.gate = &error_gate, .operation = 0},
        {.gate = &error_gate, .operation = 1},
    };
    pthread_t error_threads[2];
    CHECK(pthread_create(&error_threads[0], NULL, run_error_race_worker, &error_workers[0]) == 0,
          "first error-attribution worker must start");
    CHECK(pthread_create(&error_threads[1], NULL, run_error_race_worker, &error_workers[1]) == 0,
          "second error-attribution worker must start");

    pthread_mutex_lock(&error_gate.mutex);
    while (error_gate.arrived != 2) {
        pthread_cond_wait(&error_gate.condition, &error_gate.mutex);
    }
    pthread_mutex_unlock(&error_gate.mutex);

    /* Deterministically replace the shared global error after both worker
     * operations failed and completed their size probes. Their later copies
     * must still observe their own operation-local snapshots. */
    CHECK(close_if_generation_fn(0) == -1,
          "global error overwrite must reject generation zero");

    pthread_mutex_lock(&error_gate.mutex);
    error_gate.released = 1;
    pthread_cond_broadcast(&error_gate.condition);
    pthread_mutex_unlock(&error_gate.mutex);
    CHECK(pthread_join(error_threads[0], NULL) == 0,
          "first error-attribution worker must join");
    CHECK(pthread_join(error_threads[1], NULL) == 0,
          "second error-attribution worker must join");
    pthread_cond_destroy(&error_gate.condition);
    pthread_mutex_destroy(&error_gate.mutex);

    static const char *expected_worker_errors[2] = {
        "invalid oliphaunt_exec_protocol arguments",
        "invalid oliphaunt_restore options",
    };
    for (size_t i = 0; i < 2; i++) {
        CHECK(error_workers[i].operation_failed,
              "concurrent error-attribution operation must fail");
        CHECK(error_workers[i].captured.length == strlen(expected_worker_errors[i]),
              "same-call capture must report its operation-local error length");
        CHECK(strcmp(error_workers[i].captured.message, expected_worker_errors[i]) == 0,
              "same-call capture must retain the worker operation's error");
        CHECK(error_workers[i].required == strlen(expected_worker_errors[i]),
              "size probe must report the operation-local error length");
        CHECK(error_workers[i].copied_length == error_workers[i].required,
              "copy after a global overwrite must preserve the probed length");
        CHECK(strcmp(error_workers[i].copied, expected_worker_errors[i]) == 0,
              "copy after a global overwrite must preserve the operation-local error");
        CHECK(error_workers[i].truncated_length == error_workers[i].required,
              "repeated truncated copy must preserve the operation-local length");
        CHECK(error_workers[i].truncated[sizeof(error_workers[i].truncated) - 1] == '\0',
              "repeated truncated copy must remain NUL-terminated");
    }
#endif

    (void)init_fn;
    (void)exec_protocol_fn;
    (void)exec_simple_query_fn;
    (void)exec_protocol_raw_stream_fn;
    (void)backup_fn;
    (void)restore_fn;
    (void)register_static_extensions_fn;
    (void)config;
    (void)restore;

    return 0;
}
