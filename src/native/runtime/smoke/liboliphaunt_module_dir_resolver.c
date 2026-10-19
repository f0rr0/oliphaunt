#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include "liboliphaunt_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Standalone link stubs for liboliphaunt_fs.c paths this resolver test does not call. */
void oliphaunt_set_error(OliphauntHandle *handle, const char *message) {
    if (handle != NULL) {
        snprintf(handle->last_error, sizeof(handle->last_error), "%s", message != NULL ? message : "");
    }
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

static int write_text(const char *path, const char *text) {
    FILE *file = fopen(path, "wb");
    if (file == NULL) return -1;
    size_t length = strlen(text);
    size_t written = fwrite(text, 1, length, file);
    int close_rc = fclose(file);
    int rc = written == length && close_rc == 0 ? 0 : -1;
    return rc;
}

static int read_text(const char *path, char *out, size_t capacity) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) return -1;
    size_t length = fread(out, 1, capacity - 1, file);
    int rc = ferror(file) || !feof(file) || fclose(file) != 0 ? -1 : 0;
    out[length] = '\0';
    return rc;
}

static int prepare_complete_pgdata(const char *root, const char *descriptor) {
    char pgdata[4096];
    char global[4096];
    char path[4096];
    if (join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        join(global, sizeof(global), pgdata, "global") != 0 ||
        make_dir(root) != 0 || make_dir(pgdata) != 0 || make_dir(global) != 0 ||
        join(path, sizeof(path), pgdata, "pg_wal") != 0 || make_dir(path) != 0 ||
        join(path, sizeof(path), pgdata, "PG_VERSION") != 0 || write_text(path, "18\n") != 0 ||
        join(path, sizeof(path), global, "pg_control") != 0 || write_text(path, "control") != 0) {
        return -1;
    }
    if (descriptor != NULL) {
        if (join(path, sizeof(path), root, ".oliphaunt.json") != 0 ||
            write_text(path, descriptor) != 0) {
            return -1;
        }
    }
    return 0;
}

static int expect_descriptor_rejected_unchanged(
    const char *fixture_root,
    const char *name,
    const char *descriptor) {
    char root[4096];
    char pgdata[4096];
    char descriptor_path[4096];
    char after[1024];
    OliphauntHandle handle = {0};
    if (join(root, sizeof(root), fixture_root, name) != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        join(descriptor_path, sizeof(descriptor_path), root, ".oliphaunt.json") != 0 ||
        prepare_complete_pgdata(root, descriptor) != 0) {
        return -1;
    }
    if (oliphaunt_validate_managed_root(&handle, pgdata) == 0 ||
        read_text(descriptor_path, after, sizeof(after)) != 0 || strcmp(after, descriptor) != 0) {
        fprintf(stderr, "%s descriptor was accepted or modified\n", name);
        return -1;
    }
    return 0;
}

static int verify_managed_root_descriptor_contract(const char *fixture_root) {
    static const char canonical[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n";
    static const char pretty_wasix[] =
        "{\n  \"physicalFormat\": \"wasix-pg18-v1\",\n  \"postgresMajor\": 18,\n  \"pgdata\": \"pgdata\",\n  \"engineFamily\": \"wasix\",\n  \"schema\": \"oliphaunt-database-root-v1\"\n}\n";
    static const char unknown[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\",\"extra\":true}\n";
    static const char duplicate[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n";
    static const char wrong_major[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":17,\"physicalFormat\":\"native-pg18-v1\"}\n";
    static const char string_major[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":\"18\",\"physicalFormat\":\"native-pg18-v1\"}\n";
    static const char decimal_major[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18.0,\"physicalFormat\":\"native-pg18-v1\"}\n";
    static const char mismatched_family_format[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"wasix\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n";
    char root[4096];
    char pgdata[4096];
    char path[4096];
    char contents[1024];
    OliphauntHandle handle = {0};

    if (join(root, sizeof(root), fixture_root, "descriptor-empty") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 || make_dir(root) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0 ||
        join(path, sizeof(path), root, ".oliphaunt.json") != 0 || access(path, F_OK) == 0) {
        fprintf(stderr, "empty root was accepted or mutated by low-level validation\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-pretty") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, pretty_wasix) != 0 ||
        join(path, sizeof(path), root, ".oliphaunt.json") != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) != 0 ||
        read_text(path, contents, sizeof(contents)) != 0 || strcmp(contents, pretty_wasix) != 0) {
        fprintf(stderr, "semantic reordered WASIX descriptor was rejected or rewritten\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-native") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) != 0) {
        fprintf(stderr, "canonical native descriptor was rejected\n");
        return -1;
    }

    if (expect_descriptor_rejected_unchanged(fixture_root, "descriptor-unknown", unknown) != 0 ||
        expect_descriptor_rejected_unchanged(fixture_root, "descriptor-duplicate", duplicate) != 0 ||
        expect_descriptor_rejected_unchanged(fixture_root, "descriptor-wrong-major", wrong_major) != 0 ||
        expect_descriptor_rejected_unchanged(fixture_root, "descriptor-string-major", string_major) != 0 ||
        expect_descriptor_rejected_unchanged(fixture_root, "descriptor-decimal-major", decimal_major) != 0 ||
        expect_descriptor_rejected_unchanged(
            fixture_root, "descriptor-mismatched-family-format", mismatched_family_format) != 0) {
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptorless-pgdata") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, NULL) != 0 ||
        join(path, sizeof(path), pgdata, "PG_VERSION") != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0 ||
        read_text(path, contents, sizeof(contents)) != 0 || strcmp(contents, "18\n") != 0) {
        fprintf(stderr, "descriptorless PGDATA was adopted or modified\n");
        return -1;
    }
    if (join(path, sizeof(path), root, ".oliphaunt.json") != 0 || access(path, F_OK) == 0) {
        fprintf(stderr, "descriptorless PGDATA gained a descriptor\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-arbitrary") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 || make_dir(root) != 0 ||
        join(path, sizeof(path), root, "keep.txt") != 0 || write_text(path, "keep") != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0 ||
        read_text(path, contents, sizeof(contents)) != 0 || strcmp(contents, "keep") != 0) {
        fprintf(stderr, "arbitrary descriptorless root was adopted or modified\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-extra-entry") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        join(path, sizeof(path), root, "keep.txt") != 0 || write_text(path, "keep") != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0 ||
        read_text(path, contents, sizeof(contents)) != 0 || strcmp(contents, "keep") != 0) {
        fprintf(stderr, "managed root with an extra top-level entry was accepted or modified\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-missing-control") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        join(path, sizeof(path), pgdata, "global/pg_control") != 0 || unlink(path) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0) {
        fprintf(stderr, "managed root without pg_control was accepted\n");
        return -1;
    }
    if (join(root, sizeof(root), fixture_root, "descriptor-empty-control") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        join(path, sizeof(path), pgdata, "global/pg_control") != 0 || write_text(path, "") != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0) {
        fprintf(stderr, "managed root with empty pg_control was accepted\n");
        return -1;
    }
    if (join(root, sizeof(root), fixture_root, "descriptor-missing-wal") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        join(path, sizeof(path), pgdata, "pg_wal") != 0 || rmdir(path) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0) {
        fprintf(stderr, "managed root without pg_wal was accepted\n");
        return -1;
    }
#ifndef _WIN32
    char descriptor_target[4096];
    char linked_target[4096];
    if (join(descriptor_target, sizeof(descriptor_target), fixture_root, "descriptor-target.json") != 0 ||
        write_text(descriptor_target, canonical) != 0 ||
        join(root, sizeof(root), fixture_root, "descriptor-linked-descriptor") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, NULL) != 0 ||
        join(path, sizeof(path), root, ".oliphaunt.json") != 0 ||
        symlink("../descriptor-target.json", path) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0) {
        fprintf(stderr, "managed root with linked descriptor was accepted\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-linked-global") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        join(path, sizeof(path), pgdata, "global") != 0 ||
        join(linked_target, sizeof(linked_target), pgdata, "global-real") != 0 ||
        rename(path, linked_target) != 0 || symlink("global-real", path) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0) {
        fprintf(stderr, "managed root with linked global directory was accepted\n");
        return -1;
    }

    if (join(root, sizeof(root), fixture_root, "descriptor-linked-wal") != 0 ||
        join(pgdata, sizeof(pgdata), root, "pgdata") != 0 ||
        prepare_complete_pgdata(root, canonical) != 0 ||
        join(path, sizeof(path), pgdata, "pg_wal") != 0 || rmdir(path) != 0 ||
        symlink("global", path) != 0 ||
        oliphaunt_validate_managed_root(&handle, pgdata) == 0) {
        fprintf(stderr, "managed root with linked pg_wal was accepted\n");
        return -1;
    }
#endif
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <empty-fixture-root>\n", argv[0]);
        return 2;
    }
    if (oliphaunt_path_is_filesystem_root("/") != 1 ||
        oliphaunt_path_is_filesystem_root(argv[1]) != 0) {
        fprintf(stderr, "filesystem-root validation returned an unexpected result\n");
        return 1;
    }
    if (verify_managed_root_descriptor_contract(argv[1]) != 0) {
        return 1;
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
    char native_root[4096];
    char native_pgdata[4096];
    char native_pgdata_slash[4096];
    char misnamed_pgdata[4096];
    char wasix_descriptor[4096];
    if (join(explicit_dir, sizeof(explicit_dir), argv[1], "explicit") != 0 ||
        join(env_dir, sizeof(env_dir), argv[1], "environment") != 0 ||
        join(work_dir, sizeof(work_dir), argv[1], "work") != 0 ||
        join(runtime_dir, sizeof(runtime_dir), work_dir, "runtime") != 0 ||
        join(runtime_lib_dir, sizeof(runtime_lib_dir), runtime_dir, "lib") != 0 ||
        join(runtime_postgresql_dir, sizeof(runtime_postgresql_dir), runtime_lib_dir, "postgresql") != 0 ||
        join(out_dir, sizeof(out_dir), work_dir, "out") != 0 ||
        join(fallback_dir, sizeof(fallback_dir), out_dir, "modules") != 0 ||
        join(missing_dir, sizeof(missing_dir), argv[1], "missing") != 0 ||
        join(native_root, sizeof(native_root), argv[1], "native-root") != 0 ||
        join(native_pgdata, sizeof(native_pgdata), native_root, "pgdata") != 0 ||
        join(native_pgdata_slash, sizeof(native_pgdata_slash), native_pgdata, "") != 0 ||
        join(misnamed_pgdata, sizeof(misnamed_pgdata), native_root, "data") != 0 ||
        join(wasix_descriptor, sizeof(wasix_descriptor), native_root, ".oliphaunt.json") != 0) {
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
            "source work-tree fallback",
            oliphaunt_resolve_embedded_module_dir(NULL, runtime_dir),
            fallback_dir) != 0) {
        return 1;
    }

    OliphauntHandle handle = {0};
    static const char wasix_descriptor_text[] =
        "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"wasix\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"wasix-pg18-v1\"}\n";
    if (prepare_complete_pgdata(native_root, wasix_descriptor_text) != 0) {
        fprintf(stderr, "failed to prepare foreign-family managed-root fixture\n");
        return 1;
    }
    if (oliphaunt_validate_managed_root(&handle, native_pgdata_slash) != 0) {
        fprintf(stderr, "foreign-family root was unexpectedly rejected: %s\n", handle.last_error);
        return 1;
    }
    FILE *marker = fopen(wasix_descriptor, "rb");
    char observed_descriptor[sizeof(wasix_descriptor_text)] = {0};
    if (marker == NULL ||
        fread(observed_descriptor, 1, sizeof(wasix_descriptor_text) - 1, marker) != sizeof(wasix_descriptor_text) - 1 ||
        fclose(marker) != 0 ||
        strcmp(observed_descriptor, wasix_descriptor_text) != 0) {
        fprintf(stderr, "foreign-family root descriptor was modified\n");
        return 1;
    }
    marker = fopen(wasix_descriptor, "ab");
    if (marker == NULL || fputs("{}", marker) < 0 || fclose(marker) != 0) {
        perror(wasix_descriptor);
        return 1;
    }
    if (oliphaunt_validate_managed_root(&handle, native_pgdata) == 0 ||
        strstr(handle.last_error, "no supported .oliphaunt.json descriptor") == NULL) {
        fprintf(stderr, "root descriptor with trailing fields was unexpectedly accepted\n");
        return 1;
    }
    if (unlink(wasix_descriptor) != 0) {
        perror(wasix_descriptor);
        return 1;
    }
    if (oliphaunt_validate_managed_root(&handle, misnamed_pgdata) == 0 ||
        strstr(handle.last_error, "declares PGDATA at pgdata") == NULL) {
        fprintf(stderr, "misnamed PGDATA was unexpectedly accepted\n");
        return 1;
    }
    puts("liboliphaunt module-dir precedence and root descriptor behavior passed");
    return 0;
}
