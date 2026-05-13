#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "../include/libpglite.h"

#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define DEFAULT_WAIT_TIMEOUT_MS 60000
#define DEFAULT_BACKEND_STACK_BYTES (8 * 1024 * 1024)

typedef struct PGLiteEmbeddedIO {
    void *context;
    ssize_t (*read)(void *context, void *ptr, size_t len);
    ssize_t (*write)(void *context, const void *ptr, size_t len);
} PGLiteEmbeddedIO;

extern int pglite_embedded_main(
    int argc,
    char **argv,
    const char *dbname,
    const char *username,
    PGLiteEmbeddedIO *io);

struct PGliteHandle {
    char *pgdata;
    char *runtime_dir;
    char *username;
    char *database;
    char *postgres_path;
    char **startup_args;
    size_t startup_arg_count;

    pthread_t backend_thread;
    bool thread_started;
    bool backend_exited;
    int backend_status;

    pthread_mutex_t mutex;
    pthread_cond_t input_cond;
    pthread_cond_t output_cond;
    bool sync_initialized;
    bool closing;

    unsigned char *input;
    size_t input_len;
    size_t input_off;

    unsigned char *output;
    size_t output_len;
    size_t output_cap;
    size_t output_scan_off;
    bool output_ready;

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

    PGLiteEmbeddedIO io;
    bool owns_global_guard;
    char last_error[1024];
};

static char global_last_error[1024];
static pthread_mutex_t global_instance_mutex = PTHREAD_MUTEX_INITIALIZER;
static enum {
    PGLITE_GLOBAL_UNUSED = 0,
    PGLITE_GLOBAL_ACTIVE,
    PGLITE_GLOBAL_SPENT,
} global_instance_state = PGLITE_GLOBAL_UNUSED;

static pthread_once_t trace_once = PTHREAD_ONCE_INIT;
static bool trace_protocol_enabled = false;

static void init_trace_protocol_flag(void) {
    const char *value = getenv("LIBPGLITE_TRACE_PROTOCOL");
    if (value == NULL || value[0] == '\0') {
        value = getenv("LIBPGLITE_TRACE");
    }
    if (value == NULL || value[0] == '\0') {
        value = getenv("PGLITE_OXIDE_NATIVE_TRACE_PROTOCOL");
    }
    if (value == NULL || value[0] == '\0') {
        value = getenv("PGLITE_OXIDE_NATIVE_TRACE");
    }
    trace_protocol_enabled =
        value != NULL &&
        value[0] != '\0' &&
        strcmp(value, "0") != 0 &&
        strcmp(value, "false") != 0 &&
        strcmp(value, "FALSE") != 0;
}

static bool trace_enabled(void) {
    pthread_once(&trace_once, init_trace_protocol_flag);
    return trace_protocol_enabled;
}

static uint64_t monotonic_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static uint64_t elapsed_ns(uint64_t started_ns) {
    return monotonic_ns() - started_ns;
}

static uint64_t ns_to_us(uint64_t value) {
    return value / 1000ULL;
}

static void reset_trace_locked(PGliteHandle *handle, size_t request_len) {
    handle->trace_request_bytes = request_len;
    handle->trace_response_bytes = 0;
    handle->trace_lock_ns = 0;
    handle->trace_input_copy_ns = 0;
    handle->trace_wait_ns = 0;
    handle->trace_response_copy_ns = 0;
    handle->trace_read_calls = 0;
    handle->trace_read_bytes = 0;
    handle->trace_read_copy_ns = 0;
    handle->trace_write_calls = 0;
    handle->trace_write_bytes = 0;
    handle->trace_write_append_ns = 0;
    handle->trace_ready_scan_calls = 0;
    handle->trace_ready_scan_ns = 0;
    handle->trace_output_grows = 0;
}

static void print_trace_locked(PGliteHandle *handle, uint64_t total_ns) {
    uint64_t seq = ++handle->trace_seq;
    fprintf(
        stderr,
        "pglite_native_trace seq=%llu request_bytes=%llu response_bytes=%llu "
        "total_us=%llu lock_us=%llu input_copy_us=%llu wait_us=%llu "
        "ready_scan_calls=%llu ready_scan_us=%llu read_calls=%llu read_bytes=%llu "
        "read_copy_us=%llu write_calls=%llu write_bytes=%llu write_append_us=%llu "
        "output_grows=%llu output_cap=%llu response_copy_us=%llu\n",
        (unsigned long long)seq,
        (unsigned long long)handle->trace_request_bytes,
        (unsigned long long)handle->trace_response_bytes,
        (unsigned long long)ns_to_us(total_ns),
        (unsigned long long)ns_to_us(handle->trace_lock_ns),
        (unsigned long long)ns_to_us(handle->trace_input_copy_ns),
        (unsigned long long)ns_to_us(handle->trace_wait_ns),
        (unsigned long long)handle->trace_ready_scan_calls,
        (unsigned long long)ns_to_us(handle->trace_ready_scan_ns),
        (unsigned long long)handle->trace_read_calls,
        (unsigned long long)handle->trace_read_bytes,
        (unsigned long long)ns_to_us(handle->trace_read_copy_ns),
        (unsigned long long)handle->trace_write_calls,
        (unsigned long long)handle->trace_write_bytes,
        (unsigned long long)ns_to_us(handle->trace_write_append_ns),
        (unsigned long long)handle->trace_output_grows,
        (unsigned long long)handle->output_cap,
        (unsigned long long)ns_to_us(handle->trace_response_copy_ns));
}

static void set_error(PGliteHandle *handle, const char *message) {
    char *target = handle ? handle->last_error : global_last_error;
    snprintf(target, 1024, "%s", message ? message : "unknown native libpglite error");
}

static int path_exists(const char *path) {
    struct stat st;
    return path != NULL && stat(path, &st) == 0;
}

static int ensure_dir(const char *path) {
    if (path_exists(path)) {
        return 0;
    }
    if (mkdir(path, 0700) == 0 || errno == EEXIST) {
        return 0;
    }
    return -1;
}

static char *dup_string(const char *value, const char *fallback) {
    const char *source = value && value[0] ? value : fallback;
    return strdup(source);
}

static char *sibling_postgres_path(const char *initdb_path) {
    if (initdb_path == NULL || initdb_path[0] == '\0') {
        return NULL;
    }
    const char *slash = strrchr(initdb_path, '/');
    if (slash == NULL) {
        return NULL;
    }
    size_t dir_len = (size_t)(slash - initdb_path);
    const char *leaf = "/postgres";
    size_t leaf_len = strlen(leaf);
    char *path = (char *)malloc(dir_len + leaf_len + 1);
    if (path == NULL) {
        return NULL;
    }
    memcpy(path, initdb_path, dir_len);
    memcpy(path + dir_len, leaf, leaf_len + 1);
    return path;
}

static char *runtime_tool_path(const char *runtime_dir, const char *tool_name) {
    if (runtime_dir == NULL || runtime_dir[0] == '\0' ||
        tool_name == NULL || tool_name[0] == '\0') {
        return NULL;
    }
    const char *bin_sep = "/bin/";
    size_t dir_len = strlen(runtime_dir);
    size_t sep_len = strlen(bin_sep);
    size_t tool_len = strlen(tool_name);
    char *path = (char *)malloc(dir_len + sep_len + tool_len + 1);
    if (path == NULL) {
        return NULL;
    }
    memcpy(path, runtime_dir, dir_len);
    memcpy(path + dir_len, bin_sep, sep_len);
    memcpy(path + dir_len + sep_len, tool_name, tool_len + 1);
    if (access(path, X_OK) == 0 || path_exists(path)) {
        return path;
    }
    free(path);
    return NULL;
}

static char *resolve_postgres_argv0(const char *runtime_dir) {
    char *from_runtime = runtime_tool_path(runtime_dir, "postgres");
    if (from_runtime != NULL) {
        return from_runtime;
    }

    const char *postgres = getenv("LIBPGLITE_POSTGRES");
    if (postgres == NULL || postgres[0] == '\0') {
        postgres = getenv("LIBPGLITE_OXIDE_POSTGRES");
    }
    if (postgres == NULL || postgres[0] == '\0') {
        postgres = getenv("PGLITE_OXIDE_NATIVE_POSTGRES");
    }
    if (postgres != NULL && postgres[0] != '\0') {
        return strdup(postgres);
    }

    const char *initdb = getenv("LIBPGLITE_INITDB");
    if (initdb == NULL || initdb[0] == '\0') {
        initdb = getenv("LIBPGLITE_OXIDE_INITDB");
    }
    if (initdb == NULL || initdb[0] == '\0') {
        initdb = getenv("PGLITE_OXIDE_NATIVE_INITDB");
    }
    char *from_initdb = sibling_postgres_path(initdb);
    if (from_initdb != NULL) {
        return from_initdb;
    }

    return strdup("postgres");
}

static int dup_startup_args(PGliteHandle *handle, const PGliteConfig *config) {
    if (config->startup_arg_count == 0) {
        return 0;
    }
    if (config->startup_args == NULL) {
        set_error(handle, "startup_arg_count is non-zero but startup_args is null");
        return -1;
    }
    handle->startup_args = (char **)calloc(config->startup_arg_count, sizeof(char *));
    if (handle->startup_args == NULL) {
        set_error(handle, "out of memory allocating startup arguments");
        return -1;
    }
    handle->startup_arg_count = config->startup_arg_count;
    for (size_t i = 0; i < config->startup_arg_count; i++) {
        if (config->startup_args[i] == NULL) {
            set_error(handle, "startup argument must not be null");
            return -1;
        }
        handle->startup_args[i] = strdup(config->startup_args[i]);
        if (handle->startup_args[i] == NULL) {
            set_error(handle, "out of memory copying startup argument");
            return -1;
        }
    }
    return 0;
}

static int acquire_global_instance(void) {
    pthread_mutex_lock(&global_instance_mutex);
    if (global_instance_state == PGLITE_GLOBAL_ACTIVE) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "native libpglite already has an active process-wide instance");
        return -1;
    }
    if (global_instance_state == PGLITE_GLOBAL_SPENT) {
        pthread_mutex_unlock(&global_instance_mutex);
        set_error(NULL, "native libpglite process lifetime has already been used");
        return -1;
    }
    global_instance_state = PGLITE_GLOBAL_ACTIVE;
    pthread_mutex_unlock(&global_instance_mutex);
    return 0;
}

static void release_global_instance(bool spent) {
    pthread_mutex_lock(&global_instance_mutex);
    global_instance_state = spent ? PGLITE_GLOBAL_SPENT : PGLITE_GLOBAL_UNUSED;
    pthread_mutex_unlock(&global_instance_mutex);
}

static int run_initdb_if_needed(PGliteHandle *handle) {
    char version_path[4096];
    snprintf(version_path, sizeof(version_path), "%s/PG_VERSION", handle->pgdata);
    if (path_exists(version_path)) {
        return 0;
    }

    const char *initdb = getenv("LIBPGLITE_INITDB");
    if (initdb == NULL || initdb[0] == '\0') {
        initdb = getenv("LIBPGLITE_OXIDE_INITDB");
    }
    if (initdb == NULL || initdb[0] == '\0') {
        initdb = getenv("PGLITE_OXIDE_NATIVE_INITDB");
    }
    char *runtime_initdb = NULL;
    if (initdb == NULL || initdb[0] == '\0') {
        runtime_initdb = runtime_tool_path(handle->runtime_dir, "initdb");
        initdb = runtime_initdb;
        if (initdb == NULL) {
            initdb = "initdb";
        }
    }

    char command[8192];
    snprintf(
        command,
        sizeof(command),
        "\"%s\" -D \"%s\" -U \"%s\" --auth=trust --no-sync >/dev/null",
        initdb,
        handle->pgdata,
        handle->username);
    int rc = system(command);
    free(runtime_initdb);
    if (rc != 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "initdb command failed: %s", command);
        return -1;
    }
    return 0;
}

static int append_output_locked(PGliteHandle *handle, const void *buf, size_t len) {
    if (len == 0) {
        return 0;
    }
    size_t required = handle->output_len + len;
    if (required > handle->output_cap) {
        size_t next = handle->output_cap ? handle->output_cap : 8192;
        while (next < required) {
            next *= 2;
        }
        unsigned char *grown = (unsigned char *)realloc(handle->output, next);
        if (grown == NULL) {
            errno = ENOMEM;
            return -1;
        }
        handle->output = grown;
        handle->output_cap = next;
        if (handle->trace_protocol) {
            handle->trace_output_grows++;
        }
    }
    memcpy(handle->output + handle->output_len, buf, len);
    handle->output_len += len;
    return 0;
}

static uint32_t read_be32(const unsigned char *ptr) {
    return ((uint32_t)ptr[0] << 24) |
           ((uint32_t)ptr[1] << 16) |
           ((uint32_t)ptr[2] << 8) |
           (uint32_t)ptr[3];
}

static bool scan_ready_for_query_locked(PGliteHandle *handle) {
    bool trace = handle->trace_protocol;
    uint64_t scan_started = trace ? monotonic_ns() : 0;
    size_t off = handle->output_scan_off;
    while (off + 5 <= handle->output_len) {
        unsigned char tag = handle->output[off];
        uint32_t msg_len = read_be32(handle->output + off + 1);
        if (msg_len < 4) {
            if (trace) {
                handle->trace_ready_scan_calls++;
                handle->trace_ready_scan_ns += elapsed_ns(scan_started);
            }
            return false;
        }
        size_t frame_len = 1 + (size_t)msg_len;
        if (frame_len > handle->output_len - off) {
            if (trace) {
                handle->trace_ready_scan_calls++;
                handle->trace_ready_scan_ns += elapsed_ns(scan_started);
            }
            return false;
        }
        off += frame_len;
        if (tag == 'Z') {
            handle->output_ready = true;
            handle->output_scan_off = off;
            if (trace) {
                handle->trace_ready_scan_calls++;
                handle->trace_ready_scan_ns += elapsed_ns(scan_started);
            }
            return true;
        }
    }
    handle->output_scan_off = off;
    if (trace) {
        handle->trace_ready_scan_calls++;
        handle->trace_ready_scan_ns += elapsed_ns(scan_started);
    }
    return handle->output_ready;
}

static int wait_timeout_ms(void) {
    const char *value = getenv("LIBPGLITE_TIMEOUT_MS");
    if (value == NULL || value[0] == '\0') {
        value = getenv("PGLITE_OXIDE_NATIVE_TIMEOUT_MS");
    }
    if (value == NULL || value[0] == '\0') {
        return DEFAULT_WAIT_TIMEOUT_MS;
    }
    int parsed = atoi(value);
    return parsed > 0 ? parsed : DEFAULT_WAIT_TIMEOUT_MS;
}

static size_t backend_stack_size_bytes(void) {
    const char *value = getenv("LIBPGLITE_STACK_BYTES");
    if (value == NULL || value[0] == '\0') {
        value = getenv("PGLITE_OXIDE_NATIVE_STACK_BYTES");
    }
    if (value == NULL || value[0] == '\0') {
        return DEFAULT_BACKEND_STACK_BYTES;
    }
    char *end = NULL;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (end == value || parsed < (unsigned long long)PTHREAD_STACK_MIN) {
        return DEFAULT_BACKEND_STACK_BYTES;
    }
    return (size_t)parsed;
}

static void add_ms_to_timespec(struct timespec *ts, int ms) {
    ts->tv_sec += ms / 1000;
    ts->tv_nsec += (long)(ms % 1000) * 1000000L;
    if (ts->tv_nsec >= 1000000000L) {
        ts->tv_sec++;
        ts->tv_nsec -= 1000000000L;
    }
}

static int wait_for_ready_locked(PGliteHandle *handle) {
    int timeout_ms = wait_timeout_ms();
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    add_ms_to_timespec(&deadline, timeout_ms);

    while (true) {
        bool ready = scan_ready_for_query_locked(handle);
        if (ready) {
            break;
        }
        if (handle->backend_exited) {
            snprintf(
                handle->last_error,
                sizeof(handle->last_error),
                "embedded backend exited with status %d before ReadyForQuery",
                handle->backend_status);
            return -1;
        }
        int rc = pthread_cond_timedwait(&handle->output_cond, &handle->mutex, &deadline);
        if (rc == ETIMEDOUT) {
            snprintf(
                handle->last_error,
                sizeof(handle->last_error),
                "timed out after %dms waiting for embedded backend ReadyForQuery",
                timeout_ms);
            return -1;
        }
        if (rc != 0) {
            snprintf(handle->last_error, sizeof(handle->last_error), "pthread wait failed: %d", rc);
            return -1;
        }
    }
    return 0;
}

static ssize_t embedded_read(void *context, void *ptr, size_t len) {
    PGliteHandle *handle = (PGliteHandle *)context;
    pthread_mutex_lock(&handle->mutex);
    while (handle->input_off >= handle->input_len && !handle->closing) {
        pthread_cond_wait(&handle->input_cond, &handle->mutex);
    }

    if (handle->input_off >= handle->input_len && handle->closing) {
        pthread_mutex_unlock(&handle->mutex);
        return 0;
    }

    size_t available = handle->input_len - handle->input_off;
    size_t take = available < len ? available : len;
    bool trace = handle->trace_protocol;
    uint64_t copy_started = trace ? monotonic_ns() : 0;
    memcpy(ptr, handle->input + handle->input_off, take);
    if (trace) {
        handle->trace_read_calls++;
        handle->trace_read_bytes += take;
        handle->trace_read_copy_ns += elapsed_ns(copy_started);
    }
    handle->input_off += take;

    if (handle->input_off >= handle->input_len) {
        free(handle->input);
        handle->input = NULL;
        handle->input_len = 0;
        handle->input_off = 0;
    }

    pthread_mutex_unlock(&handle->mutex);
    return (ssize_t)take;
}

static ssize_t embedded_write(void *context, const void *ptr, size_t len) {
    PGliteHandle *handle = (PGliteHandle *)context;
    pthread_mutex_lock(&handle->mutex);
    bool trace = handle->trace_protocol;
    uint64_t append_started = trace ? monotonic_ns() : 0;
    int rc = append_output_locked(handle, ptr, len);
    bool ready = false;
    if (trace && rc == 0) {
        handle->trace_write_calls++;
        handle->trace_write_bytes += len;
        handle->trace_write_append_ns += elapsed_ns(append_started);
    }
    if (rc == 0) {
        ready = scan_ready_for_query_locked(handle);
    }
    if (ready) {
        pthread_cond_broadcast(&handle->output_cond);
    }
    pthread_mutex_unlock(&handle->mutex);
    return rc == 0 ? (ssize_t)len : -1;
}

static void *backend_thread_main(void *arg) {
    PGliteHandle *handle = (PGliteHandle *)arg;
    static char *default_args[] = {
        "-F",
        "-c",
        "search_path=public",
        "-c",
        "exit_on_error=false",
        "-c",
        "max_worker_processes=0",
        "-c",
        "max_parallel_workers=0",
        "-c",
        "max_parallel_workers_per_gather=0",
        "-c",
        "autovacuum=off",
        "-c",
        "wal_buffers=4MB",
        "-c",
        "min_wal_size=80MB",
        "-c",
        "shared_buffers=128MB",
        "-c",
        "log_checkpoints=off",
        "-c",
        "log_timezone=UTC",
        "-c",
        "TimeZone=UTC",
    };
    size_t default_arg_count = sizeof(default_args) / sizeof(default_args[0]);
    size_t argc_capacity = 1 + default_arg_count + handle->startup_arg_count + 2 + 1;
    char **argv = (char **)calloc(argc_capacity, sizeof(char *));
    if (argv == NULL) {
        pthread_mutex_lock(&handle->mutex);
        set_error(handle, "out of memory allocating embedded backend argv");
        handle->backend_status = -1;
        handle->backend_exited = true;
        handle->closing = true;
        pthread_cond_broadcast(&handle->input_cond);
        pthread_cond_broadcast(&handle->output_cond);
        pthread_mutex_unlock(&handle->mutex);
        return NULL;
    }

    size_t argc = 0;
    argv[argc++] = handle->postgres_path;
    for (size_t i = 0; i < default_arg_count; i++) {
        argv[argc++] = default_args[i];
    }
    for (size_t i = 0; i < handle->startup_arg_count; i++) {
        argv[argc++] = handle->startup_args[i];
    }
    argv[argc++] = "-D";
    argv[argc++] = handle->pgdata;
    argv[argc] = NULL;

    int rc = pglite_embedded_main((int)argc, argv, handle->database, handle->username, &handle->io);
    free(argv);

    pthread_mutex_lock(&handle->mutex);
    handle->backend_status = rc;
    handle->backend_exited = true;
    handle->closing = true;
    pthread_cond_broadcast(&handle->input_cond);
    pthread_cond_broadcast(&handle->output_cond);
    pthread_mutex_unlock(&handle->mutex);
    return NULL;
}

static int set_input_locked(PGliteHandle *handle, const void *buf, size_t len) {
    if (handle->input != NULL || handle->input_len != 0) {
        set_error(handle, "native libpglite input queue is busy");
        return -1;
    }
    bool trace = handle->trace_protocol;
    uint64_t copy_started = trace ? monotonic_ns() : 0;
    unsigned char *copy = NULL;
    if (len > 0) {
        copy = (unsigned char *)malloc(len);
        if (copy == NULL) {
            set_error(handle, "out of memory while copying protocol input");
            return -1;
        }
        memcpy(copy, buf, len);
    }
    handle->input = copy;
    handle->input_len = len;
    handle->input_off = 0;
    if (trace) {
        handle->trace_input_copy_ns += elapsed_ns(copy_started);
    }
    pthread_cond_broadcast(&handle->input_cond);
    return 0;
}

static int start_backend(PGliteHandle *handle) {
    if (ensure_dir(handle->pgdata) != 0) {
        set_error(handle, "failed to create PGDATA directory");
        return -1;
    }
    if (run_initdb_if_needed(handle) != 0) {
        return -1;
    }

    handle->postgres_path = resolve_postgres_argv0(handle->runtime_dir);
    if (handle->postgres_path == NULL) {
        set_error(handle, "out of memory while resolving postgres path");
        return -1;
    }

    handle->io.context = handle;
    handle->io.read = embedded_read;
    handle->io.write = embedded_write;

    pthread_attr_t attr;
    int rc = pthread_attr_init(&attr);
    if (rc != 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "pthread_attr_init failed: %d", rc);
        return -1;
    }
    size_t stack_size = backend_stack_size_bytes();
    rc = pthread_attr_setstacksize(&attr, stack_size);
    if (rc != 0) {
        pthread_attr_destroy(&attr);
        snprintf(
            handle->last_error,
            sizeof(handle->last_error),
            "pthread_attr_setstacksize(%zu) failed: %d",
            stack_size,
            rc);
        return -1;
    }
    rc = pthread_create(&handle->backend_thread, &attr, backend_thread_main, handle);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
        snprintf(handle->last_error, sizeof(handle->last_error), "pthread_create failed: %d", rc);
        return -1;
    }
    handle->thread_started = true;

    pthread_mutex_lock(&handle->mutex);
    rc = wait_for_ready_locked(handle);
    if (rc == 0) {
        handle->output_len = 0;
        handle->output_scan_off = 0;
        handle->output_ready = false;
    }
    pthread_mutex_unlock(&handle->mutex);
    return rc;
}

int32_t pglite_init(const PGliteConfig *config, PGliteHandle **out) {
    if (out == NULL) {
        set_error(NULL, "pglite_init out parameter is null");
        return -1;
    }
    *out = NULL;
    if (config == NULL || config->abi_version != PGLITE_ABI_VERSION || config->pgdata == NULL) {
        set_error(NULL, "invalid pglite_init config");
        return -1;
    }
    if (acquire_global_instance() != 0) {
        return -1;
    }

    PGliteHandle *handle = (PGliteHandle *)calloc(1, sizeof(PGliteHandle));
    if (handle == NULL) {
        release_global_instance(false);
        set_error(NULL, "out of memory allocating PGliteHandle");
        return -1;
    }
    handle->owns_global_guard = true;
    handle->trace_protocol = trace_enabled();

    handle->pgdata = dup_string(config->pgdata, "");
    handle->runtime_dir = dup_string(config->runtime_dir, "");
    handle->username = dup_string(config->username, "postgres");
    handle->database = dup_string(config->database, "postgres");
    if (handle->pgdata == NULL || handle->runtime_dir == NULL ||
        handle->username == NULL || handle->database == NULL) {
        pglite_close(handle);
        set_error(NULL, "out of memory copying pglite config");
        return -1;
    }
    if (dup_startup_args(handle, config) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "%s", handle->last_error);
        pglite_close(handle);
        set_error(NULL, message);
        return -1;
    }

    if (pthread_mutex_init(&handle->mutex, NULL) != 0 ||
        pthread_cond_init(&handle->input_cond, NULL) != 0 ||
        pthread_cond_init(&handle->output_cond, NULL) != 0) {
        pglite_close(handle);
        set_error(NULL, "failed to initialize native libpglite synchronization");
        return -1;
    }
    handle->sync_initialized = true;

    if (start_backend(handle) != 0) {
        char message[1024];
        snprintf(message, sizeof(message), "%s", handle->last_error);
        pglite_close(handle);
        set_error(NULL, message);
        return -1;
    }

    *out = handle;
    return 0;
}

int32_t pglite_exec_protocol(
    PGliteHandle *handle,
    const uint8_t *request,
    size_t request_len,
    PGliteResponse *out) {
    if (handle == NULL || out == NULL || (request_len > 0 && request == NULL)) {
        set_error(handle, "invalid pglite_exec_protocol arguments");
        return -1;
    }
    out->data = NULL;
    out->len = 0;

    bool trace = handle->trace_protocol;
    uint64_t total_started = trace ? monotonic_ns() : 0;
    uint64_t lock_started = trace ? monotonic_ns() : 0;
    pthread_mutex_lock(&handle->mutex);
    if (trace) {
        reset_trace_locked(handle, request_len);
        handle->trace_lock_ns = elapsed_ns(lock_started);
    }
    if (handle->backend_exited) {
        set_error(handle, "native backend is not running");
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    handle->output_len = 0;
    handle->output_scan_off = 0;
    handle->output_ready = false;
    if (set_input_locked(handle, request, request_len) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    uint64_t wait_started = trace ? monotonic_ns() : 0;
    if (wait_for_ready_locked(handle) != 0) {
        pthread_mutex_unlock(&handle->mutex);
        return -1;
    }
    if (trace) {
        handle->trace_wait_ns = elapsed_ns(wait_started);
    }

    if (handle->output_len > 0) {
        uint64_t response_copy_started = trace ? monotonic_ns() : 0;
        out->data = (uint8_t *)malloc(handle->output_len);
        if (out->data == NULL) {
            set_error(handle, "out of memory copying protocol response");
            pthread_mutex_unlock(&handle->mutex);
            return -1;
        }
        memcpy(out->data, handle->output, handle->output_len);
        out->len = handle->output_len;
        if (trace) {
            handle->trace_response_bytes = out->len;
            handle->trace_response_copy_ns = elapsed_ns(response_copy_started);
        }
        handle->output_len = 0;
    }
    if (trace) {
        print_trace_locked(handle, elapsed_ns(total_started));
    }
    pthread_mutex_unlock(&handle->mutex);
    return 0;
}

int32_t pglite_close(PGliteHandle *handle) {
    if (handle == NULL) {
        return 0;
    }

    if (handle->sync_initialized) {
        pthread_mutex_lock(&handle->mutex);
        if (handle->thread_started && !handle->backend_exited) {
            static const unsigned char terminate[] = {'X', 0, 0, 0, 4};
            handle->closing = true;
            if (handle->input == NULL && handle->input_len == 0) {
                (void)set_input_locked(handle, terminate, sizeof(terminate));
            } else {
                pthread_cond_broadcast(&handle->input_cond);
            }
        } else {
            handle->closing = true;
            pthread_cond_broadcast(&handle->input_cond);
        }
        pthread_mutex_unlock(&handle->mutex);
    }

    if (handle->thread_started) {
        pthread_join(handle->backend_thread, NULL);
    }

    if (handle->sync_initialized) {
        pthread_cond_destroy(&handle->input_cond);
        pthread_cond_destroy(&handle->output_cond);
        pthread_mutex_destroy(&handle->mutex);
    }

    free(handle->pgdata);
    free(handle->runtime_dir);
    free(handle->username);
    free(handle->database);
    free(handle->postgres_path);
    for (size_t i = 0; i < handle->startup_arg_count; i++) {
        free(handle->startup_args[i]);
    }
    free(handle->startup_args);
    free(handle->input);
    free(handle->output);
    if (handle->owns_global_guard) {
        release_global_instance(handle->thread_started);
    }
    free(handle);
    return 0;
}

const char *pglite_last_error(PGliteHandle *handle) {
    return handle ? handle->last_error : global_last_error;
}

const char *pglite_version(void) {
    return "native-libpglite-postgresql-18.3-spike-0";
}

uint64_t pglite_capabilities(void) {
    return PGLITE_CAP_PROTOCOL_RAW | PGLITE_CAP_EXTENSIONS;
}

void pglite_free_response(PGliteResponse *response) {
    if (response == NULL) {
        return;
    }
    free(response->data);
    response->data = NULL;
    response->len = 0;
}
