#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "liboliphaunt_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* Standalone link stubs for liboliphaunt_fs.c paths this resolver test does not call. */
void oliphaunt_set_error(OliphauntHandle *handle, const char *message) {
    (void)handle;
    (void)message;
}

void pg_sha256_init(void *ctx) {
    (void)ctx;
}

void pg_sha256_update(void *ctx, const uint8_t *data, size_t len) {
    (void)ctx;
    (void)data;
    (void)len;
}

void pg_sha256_final(void *ctx, uint8_t *dest) {
    (void)ctx;
    (void)dest;
}

static int make_dir(const char *path) {
    if (mkdir(path, 0700) == 0) {
        return 0;
    }
    perror(path);
    return -1;
}

static int join(char *out, size_t capacity, const char *left, const char *right) {
    int written = snprintf(out, capacity, "%s/%s", left, right);
    if (written < 0 || (size_t)written >= capacity) {
        fprintf(stderr, "module-dir resolver fixture path is too long\n");
        return -1;
    }
    return 0;
}

static int expect_path(const char *context, char *actual, const char *expected) {
    if (actual == NULL || strcmp(actual, expected) != 0) {
        fprintf(
            stderr,
            "%s resolved %s, expected %s\n",
            context,
            actual != NULL ? actual : "(null)",
            expected);
        free(actual);
        return -1;
    }
    free(actual);
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <empty-fixture-root>\n", argv[0]);
        return 2;
    }

    char explicit_dir[4096];
    char env_dir[4096];
    char work_dir[4096];
    char runtime_dir[4096];
    char runtime_lib_dir[4096];
    char runtime_postgresql_dir[4096];
    char out_dir[4096];
    char fallback_dir[4096];
    char missing_dir[4096];
    if (join(explicit_dir, sizeof(explicit_dir), argv[1], "explicit") != 0 ||
        join(env_dir, sizeof(env_dir), argv[1], "environment") != 0 ||
        join(work_dir, sizeof(work_dir), argv[1], "work") != 0 ||
        join(runtime_dir, sizeof(runtime_dir), work_dir, "runtime") != 0 ||
        join(runtime_lib_dir, sizeof(runtime_lib_dir), runtime_dir, "lib") != 0 ||
        join(runtime_postgresql_dir, sizeof(runtime_postgresql_dir), runtime_lib_dir, "postgresql") != 0 ||
        join(out_dir, sizeof(out_dir), work_dir, "out") != 0 ||
        join(fallback_dir, sizeof(fallback_dir), out_dir, "modules") != 0 ||
        join(missing_dir, sizeof(missing_dir), argv[1], "missing") != 0) {
        return 1;
    }

    if (make_dir(explicit_dir) != 0 ||
        make_dir(env_dir) != 0 ||
        make_dir(work_dir) != 0 ||
        make_dir(runtime_dir) != 0 ||
        make_dir(runtime_lib_dir) != 0 ||
        make_dir(runtime_postgresql_dir) != 0 ||
        make_dir(out_dir) != 0 ||
        make_dir(fallback_dir) != 0) {
        return 1;
    }

    if (setenv(OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV, env_dir, 1) != 0) {
        perror("set OLIPHAUNT_EMBEDDED_MODULE_DIR");
        return 1;
    }
    if (expect_path(
            "per-handle module directory",
            oliphaunt_resolve_embedded_module_dir(explicit_dir, runtime_dir),
            explicit_dir) != 0) {
        return 1;
    }
    if (oliphaunt_resolve_embedded_module_dir(missing_dir, runtime_dir) != NULL) {
        fprintf(stderr, "missing per-handle module directory incorrectly fell through\n");
        return 1;
    }
    if (expect_path(
            "host environment override",
            oliphaunt_resolve_embedded_module_dir(NULL, runtime_dir),
            env_dir) != 0) {
        return 1;
    }

    if (unsetenv(OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV) != 0) {
        perror("unset OLIPHAUNT_EMBEDDED_MODULE_DIR");
        return 1;
    }
    if (expect_path(
            "legacy work-tree fallback",
            oliphaunt_resolve_embedded_module_dir(NULL, runtime_dir),
            fallback_dir) != 0) {
        return 1;
    }

    puts("liboliphaunt module-dir resolver precedence passed");
    return 0;
}
