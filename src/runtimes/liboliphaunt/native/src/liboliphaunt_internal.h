#ifndef OLIPHAUNT_INTERNAL_H
#define OLIPHAUNT_INTERNAL_H

#include "../include/oliphaunt.h"
#include "liboliphaunt_platform.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define OLIPHAUNT_ICU_DATA_DIR_ENV "OLIPHAUNT_ICU_DATA_DIR"
#define OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV "OLIPHAUNT_EMBEDDED_MODULE_DIR"
#define OLIPHAUNT_ERROR_CAPACITY 1024

/*
 * Every fallible public C operation installs one of these stack-owned scopes.
 * set_error records into the innermost scope as well as the shared handle (or
 * global) slot. A failed nested operation is propagated to its parent when it
 * returns; a successful nested operation cannot erase an outer error.
 */
typedef struct OliphauntErrorScope {
    struct OliphauntErrorScope *parent;
    OliphauntHandle *fallback_handle;
    const char *operation;
    char error[OLIPHAUNT_ERROR_CAPACITY];
    bool has_error;
} OliphauntErrorScope;

void oliphaunt_error_scope_begin(
    OliphauntErrorScope *scope,
    OliphauntHandle *fallback_handle,
    const char *operation);
/* Promote a backend-thread error into the current thread's operation scope.
 * The caller must keep fallback_handle alive and serialize the shared error
 * producer through the operation's owning mutex while this snapshot is made. */
void oliphaunt_error_scope_capture_shared(OliphauntHandle *fallback_handle);
void oliphaunt_error_scope_end(OliphauntErrorScope *scope, bool failed);
/* Shared runners pass NULL only for synchronous non-capture entry points; every public
 * `_with_error` wrapper rejects a NULL capture before dispatching work. */
void oliphaunt_error_capture_current(
    OliphauntErrorCapture *capture,
    OliphauntHandle *fallback_handle,
    bool failed);

typedef struct OliphauntEmbeddedIO {
    void *context;
    ssize_t (*read)(void *context, void *ptr, size_t len);
    ssize_t (*write)(void *context, const void *ptr, size_t len);
} OliphauntEmbeddedIO;

typedef struct OliphauntOutputChunk {
    unsigned char *data;
    size_t len;
    struct OliphauntOutputChunk *next;
} OliphauntOutputChunk;

typedef struct OliphauntProtocolScanner {
    unsigned char header[5];
    size_t header_len;
    unsigned char tag;
    size_t payload_remaining;
    unsigned char ready_status;
    bool ready_status_set;
} OliphauntProtocolScanner;

typedef enum OliphauntBackupModeState {
    OLIPHAUNT_BACKUP_NOT_ENTERED = 0,
    OLIPHAUNT_BACKUP_EXIT_REQUIRED = 1,
    OLIPHAUNT_BACKUP_EXIT_CONFIRMED = 2,
    OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED = 3,
} OliphauntBackupModeState;

bool oliphaunt_backup_cleanup_required(OliphauntBackupModeState state);

typedef enum OliphauntBackupCleanupOutcome {
    OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED = 0,
    OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED_WITH_VALIDATION_FAILURE = 1,
    OLIPHAUNT_BACKUP_CLEANUP_UNCONFIRMED = 2,
} OliphauntBackupCleanupOutcome;

OliphauntBackupCleanupOutcome oliphaunt_backup_cleanup_outcome(
    int stop_rc,
    OliphauntBackupModeState stop_state);

typedef int (*OliphauntBackupStopAttempt)(
    void *context,
    OliphauntBackupModeState *state,
    char *error,
    size_t error_capacity);

typedef struct OliphauntBackupCleanupResult {
    OliphauntBackupModeState state;
    bool poison;
    char error[OLIPHAUNT_ERROR_CAPACITY];
} OliphauntBackupCleanupResult;

/*
 * Private backup cleanup wiring shared by the implementation and its
 * fault-injected lifecycle test. The stop callback is invoked exactly once
 * only when PostgreSQL may still be in backup mode.
 */
void oliphaunt_run_failed_backup_cleanup(
    OliphauntBackupModeState state,
    const char *primary_error,
    OliphauntBackupStopAttempt stop,
    void *stop_context,
    OliphauntBackupCleanupResult *out);

typedef enum OliphauntDataRowValidation {
    OLIPHAUNT_DATA_ROW_VALID = 0,
    OLIPHAUNT_DATA_ROW_TRUNCATED_COUNT = 1,
    OLIPHAUNT_DATA_ROW_UNEXPECTED_COUNT = 2,
    OLIPHAUNT_DATA_ROW_TRUNCATED_LENGTH = 3,
    OLIPHAUNT_DATA_ROW_TRUNCATED_VALUE = 4,
    OLIPHAUNT_DATA_ROW_TRAILING_BYTES = 5,
} OliphauntDataRowValidation;

OliphauntDataRowValidation oliphaunt_validate_data_row(
    const uint8_t *body,
    size_t body_len,
    uint16_t expected_columns);

bool oliphaunt_response_confirms_command(
    const uint8_t *response,
    size_t response_len,
    const char *expected_tag,
    bool *tag_matches);

struct OliphauntHandle {
    char *pgdata;
    char *runtime_dir;
    char *module_dir;
    char *username;
    char *database;
    char *postgres_path;
    char *previous_pgdata_env;
    char *previous_proj_data_env;
    char *previous_icu_data_env;
    char *previous_skip_system_collation_discovery_env;
    char *previous_skip_icu_collation_discovery_env;
    char *previous_internal_icu_ready_env;
    char *previous_module_dir_env;
    char **startup_args;
    size_t startup_arg_count;
    bool had_previous_pgdata_env;
    bool pgdata_env_overridden;
    bool had_previous_proj_data_env;
    bool proj_data_env_overridden;
    bool had_previous_icu_data_env;
    bool icu_data_env_overridden;
    bool had_previous_skip_system_collation_discovery_env;
    bool skip_system_collation_discovery_env_overridden;
    bool had_previous_skip_icu_collation_discovery_env;
    bool skip_icu_collation_discovery_env_overridden;
    bool had_previous_internal_icu_ready_env;
    bool internal_icu_ready_env_overridden;
    bool had_previous_module_dir_env;
    bool module_dir_env_overridden;

    pthread_t backend_thread;
    bool thread_started;
    bool backend_exited;
    int backend_status;

    pthread_mutex_t mutex;
    pthread_mutex_t error_mutex;
    pthread_cond_t input_cond;
    pthread_cond_t output_cond;
    bool sync_initialized;
    bool error_mutex_initialized;
    bool closing;
    bool logical_active;
    bool external_root_lock;
    uint64_t logical_generation;
    unsigned char *input;
    size_t input_len;
    size_t input_off;
    size_t input_cap;

    unsigned char *output;
    size_t output_len;
    size_t output_cap;
    size_t output_scan_off;
    bool output_ready;
    unsigned char transaction_status;
    bool backup_mode_exit_unconfirmed;

    bool streaming;
    bool stream_failed;
    OliphauntOutputChunk *stream_head;
    OliphauntOutputChunk *stream_tail;
    size_t stream_bytes_queued;
    size_t stream_queue_max_bytes;
    OliphauntProtocolScanner stream_scanner;

    uint64_t trace_seq;
    uint64_t trace_request_bytes;
    uint64_t trace_response_bytes;
    uint64_t trace_lock_ns;
    uint64_t trace_input_copy_ns;
    uint64_t trace_wait_ns;
    uint64_t trace_response_copy_ns;
    uint64_t trace_read_calls;
    uint64_t trace_read_bytes;
    uint64_t trace_read_copy_ns;
    uint64_t trace_write_calls;
    uint64_t trace_write_bytes;
    uint64_t trace_write_append_ns;
    uint64_t trace_ready_scan_calls;
    uint64_t trace_ready_scan_ns;
    uint64_t trace_output_grows;
    bool trace_protocol;

    OliphauntEmbeddedIO io;
    int stable_root_lock_fd;
    char *stable_root_lock_path;
    char last_error[OLIPHAUNT_ERROR_CAPACITY];
};

typedef struct OliphauntByteBuffer {
    uint8_t *data;
    size_t len;
    size_t cap;
} OliphauntByteBuffer;

typedef struct OliphauntBackendArgv {
    int argc;
    char **argv;
} OliphauntBackendArgv;

const char *oliphaunt_handle_pgdata(OliphauntHandle *handle);
void oliphaunt_set_error(OliphauntHandle *handle, const char *message);
const OliphauntStaticExtension *oliphaunt_static_extension_lookup(const char *filename);
const void *oliphaunt_static_extension_magic(const OliphauntStaticExtension *extension);
void *oliphaunt_static_extension_symbol(const OliphauntStaticExtension *extension, const char *symbol);
void oliphaunt_static_extension_init(const OliphauntStaticExtension *extension);

char *oliphaunt_dup_config_string(const char *value, const char *fallback);
int oliphaunt_dup_startup_args(OliphauntHandle *handle, const OliphauntConfig *config);
int oliphaunt_validate_startup_args(OliphauntHandle *handle, const OliphauntConfig *config);
bool oliphaunt_config_matches_resident_runtime(
    const OliphauntHandle *handle,
    const OliphauntConfig *config);
char *oliphaunt_resolve_postgres_argv0(const char *runtime_dir);

int oliphaunt_build_backend_argv(OliphauntHandle *handle, OliphauntBackendArgv *out);
void oliphaunt_free_backend_argv(OliphauntBackendArgv *argv);
size_t oliphaunt_backend_stack_size_bytes(void);

/*
 * Returns 1 with existing->mutex held when a resident instance exists, 0 after
 * reserving the process-wide instance slot for initial startup, or -1 on
 * failure. A caller receiving 1 must unlock existing->mutex on every path.
 */
int oliphaunt_acquire_global_instance(OliphauntHandle **existing);
int oliphaunt_ensure_extension_symbol_scope(char *error, size_t error_capacity);
void oliphaunt_publish_global_instance(OliphauntHandle *handle);
void oliphaunt_release_global_instance(bool spent);
/*
 * Atomically claims a published resident instance for terminal close.
 *
 * When require_generation is true, handle is ignored and the current
 * registry-owned instance is selected by generation alone. Returns 0 and sets
 * claimed when the caller owns terminal close, 1 for a stale/non-owner handle
 * or generation, 2 when terminal close already completed, and -1 on internal
 * synchronization failure.
 */
int oliphaunt_claim_global_instance_for_close(
    OliphauntHandle *handle,
    uint64_t generation,
    bool require_generation,
    OliphauntHandle **claimed);
int oliphaunt_claim_current_global_instance_for_close(OliphauntHandle **claimed);
int32_t oliphaunt_close_claimed_global_instance(OliphauntHandle *handle);
/*
 * Pins the current published handle across one complete public C operation,
 * including its error-scope teardown. Terminal close may make the registry
 * reject new calls and interrupt the backend, but it cannot destroy the
 * handle until every acquired call has ended.
 */
int oliphaunt_begin_handle_call(OliphauntHandle *handle);
bool oliphaunt_try_begin_handle_call(OliphauntHandle *handle);
void oliphaunt_end_handle_call(void);
/*
 * Serializes logical detach against public handle calls without holding the
 * handle mutex across PostgreSQL reset work. A stream callback is rejected
 * before waiting, so reentrant detach remains a prompt busy error.
 */
int oliphaunt_begin_handle_retirement(OliphauntHandle *handle);
void oliphaunt_end_handle_retirement(void);
void oliphaunt_wait_for_active_handle_calls(void);
void oliphaunt_register_process_exit_shutdown(void);

bool oliphaunt_trace_enabled(void);
uint64_t oliphaunt_monotonic_ns(void);
uint64_t oliphaunt_elapsed_ns(uint64_t started_ns);
void oliphaunt_reset_trace_locked(OliphauntHandle *handle, size_t request_len);
void oliphaunt_print_trace_locked(OliphauntHandle *handle, uint64_t total_ns);

ssize_t oliphaunt_embedded_read(void *context, void *ptr, size_t len);
ssize_t oliphaunt_embedded_write(void *context, const void *ptr, size_t len);
int oliphaunt_set_input_locked(OliphauntHandle *handle, const void *buf, size_t len);
int oliphaunt_startup_timeout_ms(void);
int oliphaunt_wait_for_ready_locked(OliphauntHandle *handle, int timeout_ms);
void oliphaunt_clear_stream_chunks_locked(OliphauntHandle *handle);
/* Returns -1 and sets the operation error when a raw stream owns the handle.
 * The caller must hold handle->mutex. */
static inline int oliphaunt_reject_if_streaming_locked(OliphauntHandle *handle) {
    if (handle == NULL || !handle->streaming) {
        return 0;
    }
    oliphaunt_set_error(
        handle,
        "native liboliphaunt handle is busy delivering a raw protocol stream");
    return -1;
}

int oliphaunt_path_exists(const char *path);
int oliphaunt_path_is_directory(const char *path);
char *oliphaunt_join_path(const char *left, const char *right);
char *oliphaunt_runtime_icu_data_dir(const char *runtime_dir);
char *oliphaunt_resolve_embedded_module_dir(const char *module_dir, const char *runtime_dir);
char *oliphaunt_path_parent_dup(const char *path);
char *oliphaunt_path_file_name_dup(const char *path);
int oliphaunt_mkdir_p(const char *path, mode_t mode);
int oliphaunt_remove_tree(const char *path);
int oliphaunt_directory_is_empty(const char *path);
int oliphaunt_acquire_stable_root_lock(OliphauntHandle *handle, const char *root, int *out_fd, char **out_path);
void oliphaunt_release_file_lock(int *fd, char **path);
int oliphaunt_acquire_root_lock(OliphauntHandle *handle, const char *pgdata);
int oliphaunt_validate_managed_root(OliphauntHandle *handle, const char *pgdata);
int oliphaunt_publish_native_root_descriptor(OliphauntHandle *handle, const char *pgdata);
void oliphaunt_release_root_lock(OliphauntHandle *handle);
int oliphaunt_path_is_reparse_point(const char *path);
int oliphaunt_path_is_filesystem_root(const char *path);

int oliphaunt_archive_append_pgdata_tree(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata);
int oliphaunt_archive_append_pg_control(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata);
typedef int (*OliphauntWalSegmentVisitor)(void *context, const char *wal_file);
int oliphaunt_visit_wal_range(
    OliphauntHandle *handle,
    const char *start_wal_file,
    const char *stop_wal_file,
    uint64_t wal_segment_size,
    OliphauntWalSegmentVisitor visitor,
    void *context);
int oliphaunt_archive_append_wal_range(
    OliphauntByteBuffer *archive,
    OliphauntHandle *handle,
    const char *pgdata,
    const char *start_wal_file,
    const char *stop_wal_file,
    uint64_t wal_segment_size);
int oliphaunt_archive_append_text(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *archive_path, const char *contents);
int oliphaunt_archive_append_bytes(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *archive_path, const uint8_t *contents, size_t len);
int oliphaunt_archive_finish(OliphauntByteBuffer *archive, OliphauntHandle *handle);
int oliphaunt_unpack_physical_archive(OliphauntHandle *handle, const uint8_t *data, size_t len, const char *staging_root);

#define set_error oliphaunt_set_error

#endif
