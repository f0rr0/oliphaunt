#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_BACKEND_STACK_BYTES (8 * 1024 * 1024)

static const char *const DEFAULT_BACKEND_ARGS[] = {
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

static int append_backend_arg(OliphauntHandle *handle, OliphauntBackendArgv *out, size_t capacity, const char *arg) {
    if (out->argc < 0 || (size_t)out->argc + 1 >= capacity) {
        set_error(handle, "embedded backend argv capacity exceeded");
        return -1;
    }
    out->argv[out->argc] = strdup(arg != NULL ? arg : "");
    if (out->argv[out->argc] == NULL) {
        set_error(handle, "out of memory copying embedded backend argv");
        return -1;
    }
    out->argc++;
    out->argv[out->argc] = NULL;
    return 0;
}

int oliphaunt_build_backend_argv(OliphauntHandle *handle, OliphauntBackendArgv *out) {
    if (handle == NULL || out == NULL) {
        set_error(handle, "invalid embedded backend argv builder arguments");
        return -1;
    }
    if (handle->postgres_path == NULL || handle->postgres_path[0] == '\0' ||
        handle->pgdata == NULL || handle->pgdata[0] == '\0') {
        set_error(handle, "embedded backend argv requires postgres path and PGDATA");
        return -1;
    }

    memset(out, 0, sizeof(*out));
    size_t default_arg_count = sizeof(DEFAULT_BACKEND_ARGS) / sizeof(DEFAULT_BACKEND_ARGS[0]);
    size_t capacity = 1 + default_arg_count + handle->startup_arg_count + 2 + 1;
    if (capacity > (size_t)INT_MAX) {
        set_error(handle, "embedded backend argv is too large");
        return -1;
    }

    out->argv = (char **)calloc(capacity, sizeof(char *));
    if (out->argv == NULL) {
        set_error(handle, "out of memory allocating embedded backend argv");
        return -1;
    }

    if (append_backend_arg(handle, out, capacity, handle->postgres_path) != 0) {
        goto fail;
    }
    for (size_t i = 0; i < default_arg_count; i++) {
        if (append_backend_arg(handle, out, capacity, DEFAULT_BACKEND_ARGS[i]) != 0) {
            goto fail;
        }
    }
    for (size_t i = 0; i < handle->startup_arg_count; i++) {
        if (append_backend_arg(handle, out, capacity, handle->startup_args[i]) != 0) {
            goto fail;
        }
    }
    if (append_backend_arg(handle, out, capacity, "-D") != 0 ||
        append_backend_arg(handle, out, capacity, handle->pgdata) != 0) {
        goto fail;
    }

    return 0;

fail:
    oliphaunt_free_backend_argv(out);
    return -1;
}

void oliphaunt_free_backend_argv(OliphauntBackendArgv *argv) {
    if (argv == NULL) {
        return;
    }
    if (argv->argv != NULL) {
        for (int i = 0; i < argv->argc; i++) {
            free(argv->argv[i]);
        }
        free(argv->argv);
    }
    argv->argc = 0;
    argv->argv = NULL;
}

size_t oliphaunt_backend_stack_size_bytes(void) {
    const char *value = getenv("OLIPHAUNT_STACK_BYTES");
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
