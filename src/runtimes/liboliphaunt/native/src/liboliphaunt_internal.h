#ifndef OLIPHAUNT_INTERNAL_H
#define OLIPHAUNT_INTERNAL_H

#include "../include/oliphaunt.h"
#include "liboliphaunt_platform.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define OLIPHAUNT_ICU_DATA_DIR_ENV "OLIPHAUNT_ICU_DATA_DIR"
#define OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV "OLIPHAUNT_EMBEDDED_MODULE_DIR"

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

struct OliphauntHandle {
    char *pgdata;
    char *runtime_dir;
    char *username;
    char *database;
    char *postgres_path;
    char *previous_pgdata_env;
    char *previous_proj_data_env;
    char *previous_icu_data_env;
    char *previous_module_dir_env;
    char **startup_args;
    size_t startup_arg_count;
    bool had_previous_pgdata_env;
    bool pgdata_env_overridden;
    bool had_previous_proj_data_env;
    bool proj_data_env_overridden;
    bool had_previous_icu_data_env;
    bool icu_data_env_overridden;
    bool had_previous_module_dir_env;
    bool module_dir_env_overridden;

    pthread_t backend_thread;
    bool thread_started;
    bool backend_exited;
    int backend_status;

    pthread_mutex_t mutex;
    pthread_cond_t input_cond;
    pthread_cond_t output_cond;
    bool sync_initialized;
    bool closing;
    bool logical_active;
    bool external_root_lock;

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
    bool owns_global_guard;
    int stable_root_lock_fd;
    int root_marker_lock_fd;
    char *stable_root_lock_path;
    char *root_marker_lock_path;
    char last_error[1024];
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
int oliphaunt_run_initdb_if_needed(OliphauntHandle *handle);
char *oliphaunt_resolve_postgres_argv0(const char *runtime_dir);

int oliphaunt_build_backend_argv(OliphauntHandle *handle, OliphauntBackendArgv *out);
void oliphaunt_free_backend_argv(OliphauntBackendArgv *argv);
size_t oliphaunt_backend_stack_size_bytes(void);

int oliphaunt_acquire_global_instance(OliphauntHandle **existing);
void oliphaunt_publish_global_instance(OliphauntHandle *handle);
void oliphaunt_release_global_instance(bool spent);
void oliphaunt_clear_global_instance(OliphauntHandle *handle, bool spent);
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

int oliphaunt_path_exists(const char *path);
char *oliphaunt_join_path(const char *left, const char *right);
char *oliphaunt_runtime_icu_data_dir(const char *runtime_dir);
char *oliphaunt_resolve_embedded_module_dir(const char *runtime_dir);
char *oliphaunt_path_parent_dup(const char *path);
char *oliphaunt_path_file_name_dup(const char *path);
int oliphaunt_mkdir_p(const char *path, mode_t mode);
int oliphaunt_remove_tree(const char *path);
int oliphaunt_directory_is_empty(const char *path);
int oliphaunt_acquire_stable_root_lock(OliphauntHandle *handle, const char *root, int *out_fd, char **out_path);
void oliphaunt_release_file_lock(int *fd, char **path);
int oliphaunt_acquire_root_marker_lock(OliphauntHandle *handle, const char *pgdata);
void oliphaunt_release_root_marker_lock(OliphauntHandle *handle);

int oliphaunt_archive_append_pgdata_tree(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata);
int oliphaunt_archive_append_pg_wal_tree(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *pgdata);
int oliphaunt_archive_append_generated_file(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *archive_path, const char *contents);
int oliphaunt_archive_append_generated_bytes(OliphauntByteBuffer *archive, OliphauntHandle *handle, const char *archive_path, const uint8_t *contents, size_t len, uint32_t mode);
int oliphaunt_archive_finish(OliphauntByteBuffer *archive, OliphauntHandle *handle);
int oliphaunt_unpack_physical_archive(OliphauntHandle *handle, const uint8_t *data, size_t len, const char *staging_root);

#define set_error oliphaunt_set_error

#endif
