#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include "liboliphaunt_internal.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static int restore_failure;
static const char *restore_destination;

static int sync_restore_parent(OliphauntHandle *handle, const char *path) {
    if (restore_failure == 2) {
        set_error(handle, "injected parent sync I/O failure");
        return -1;
    }
    return oliphaunt_sync_directory(handle, path);
}

static int sync_restore_tree(OliphauntHandle *handle, const char *path) {
    if (restore_failure == 1) {
        set_error(handle, "injected staging sync I/O failure");
        return -1;
    }
    return oliphaunt_sync_directory_tree(handle, path);
}

static char *restore_parent_dup(const char *path) {
    if (restore_failure == 3 && oliphaunt_path_exists(restore_destination)) return NULL;
    return oliphaunt_path_parent_dup(path);
}

/* Exercise both public restore entry points without a PostgreSQL producer. */
#define oliphaunt_sync_directory sync_restore_parent
#define oliphaunt_sync_directory_tree sync_restore_tree
#define oliphaunt_path_parent_dup restore_parent_dup
#include "../src/liboliphaunt_archive.c"
#undef oliphaunt_sync_directory
#undef oliphaunt_sync_directory_tree
#undef oliphaunt_path_parent_dup

/* This fixture restores one root at a time and does not test lock-key hashing. */
void pg_sha256_init(void *ctx) { (void)ctx; }
void pg_sha256_update(void *ctx, const uint8_t *data, size_t len) {
    (void)ctx; (void)data; (void)len;
}
void pg_sha256_final(void *ctx, uint8_t *dest) { (void)ctx; memset(dest, 0, 32); }

/* Restore errors belong to the operation scope, never a resident database handle. */
bool oliphaunt_try_begin_handle_call(OliphauntHandle *handle) {
    (void)handle;
    assert(!"restore must not use a database handle for error capture");
    return false;
}
void oliphaunt_end_handle_call(void) { assert(!"restore must not lease a database handle"); }

/* Windows portability headers remap read after the public ABI is declared. */
#ifndef read
#define read _read
#endif

typedef struct ArchiveFile {
    FILE *file;
    size_t max_chunk;
    size_t fail_after;
    size_t transferred;
} ArchiveFile;

static int32_t write_archive(void *context, const uint8_t *data, size_t len) {
    ArchiveFile *archive = context;
    if (archive->fail_after && archive->transferred >= archive->fail_after) return -1;
    if (len > archive->max_chunk) archive->max_chunk = len;
    archive->transferred += len;
    return fwrite(data, 1, len, archive->file) == len ? 0 : -1;
}

static int32_t read_archive(void *context, uint8_t *data, size_t capacity, size_t *read_len) {
    ArchiveFile *archive = context;
    if (archive->fail_after && archive->transferred >= archive->fail_after) return -1;
    /* Deliberately fragment headers and data across callback boundaries. */
    if (capacity > 137) capacity = 137;
    *read_len = fread(data, 1, capacity, archive->file);
    archive->transferred += *read_len;
    return ferror(archive->file) ? -1 : 0;
}

static void fixture_file(const char *root, const char *name, const char *contents) {
    char *path = oliphaunt_join_path(root, name);
    assert(path != NULL);
    FILE *file = fopen(path, "wb");
    assert(file != NULL);
    assert(fwrite(contents, 1, strlen(contents), file) == strlen(contents));
    assert(fclose(file) == 0);
    free(path);
}

int main(int argc, char **argv) {
    assert(argc == 2);
    char *source = oliphaunt_join_path(argv[1], "source");
    char *destination = oliphaunt_join_path(argv[1], "restored");
    assert(oliphaunt_mkdir_p(source, 0700) == 0);
    assert(oliphaunt_mkdir_p(destination, 0700) == 0);
    char *file = oliphaunt_join_path(source, "large");
    FILE *input = fopen(file, "wb");
    assert(input != NULL);
    unsigned char bytes[4096];
    for (size_t i = 0; i < sizeof(bytes); i++) bytes[i] = (unsigned char)i;
    for (size_t i = 0; i < 513; i++) assert(fwrite(bytes, 1, sizeof(bytes), input) == sizeof(bytes));
    assert(fclose(input) == 0);

    ArchiveFile output = {.file = tmpfile()};
    assert(output.file != NULL);
    OliphauntByteBuffer streamed = {.write = write_archive, .context = &output};
    assert(oliphaunt_archive_append_pgdata_tree(&streamed, NULL, source) == 0);
    assert(oliphaunt_archive_finish(&streamed, NULL) == 0);
    assert(streamed.data == NULL && streamed.cap == 0);
    assert(output.max_chunk <= 64 * 1024);
    assert(streamed.len == output.transferred);
    rewind(output.file);

    OliphauntByteBuffer buffered = {0};
    assert(oliphaunt_archive_append_pgdata_tree(&buffered, NULL, source) == 0);
    assert(oliphaunt_archive_finish(&buffered, NULL) == 0);
    assert(streamed.len == buffered.len);
    for (size_t off = 0; off < buffered.len;) {
        size_t take = buffered.len - off < sizeof(bytes) ? buffered.len - off : sizeof(bytes);
        assert(fread(bytes, 1, take, output.file) == take);
        assert(memcmp(bytes, buffered.data + off, take) == 0);
        off += take;
    }
    free(buffered.data);
    rewind(output.file);
    output.transferred = 0;
    OliphauntRestoreStreamOptions options = {
        .abi_version = OLIPHAUNT_ABI_VERSION, .destination = destination,
        .read_callback = read_archive, .context = &output,
    };
    assert(oliphaunt_unpack_physical_archive_stream(NULL, options.read_callback, options.context, destination) == 0);
    assert(oliphaunt_sync_directory_tree(NULL, destination) == 0);
    char *restored = oliphaunt_join_path(destination, "pgdata/large");
    assert(oliphaunt_sync_directory(NULL, restored) != 0);
    input = fopen(restored, "rb");
    assert(input != NULL);
    for (size_t block = 0; block < 513; block++) {
        assert(fread(bytes, 1, sizeof(bytes), input) == sizeof(bytes));
        for (size_t i = 0; i < sizeof(bytes); i++) assert(bytes[i] == (unsigned char)i);
    }
    assert(fgetc(input) == EOF);
    fclose(input);

    /* An interrupted source and a corrupt terminator must never succeed. */
    assert(oliphaunt_remove_tree(destination) == 0);
    assert(oliphaunt_mkdir_p(destination, 0700) == 0);
    rewind(output.file);
    output.transferred = 0;
    output.fail_after = 2048;
    assert(oliphaunt_unpack_physical_archive_stream(NULL, read_archive, &output, destination) != 0);
    assert(oliphaunt_remove_tree(destination) == 0);
    assert(oliphaunt_mkdir_p(destination, 0700) == 0);
    assert(fseek(output.file, -1, SEEK_END) == 0);
    assert(fputc(1, output.file) != EOF);
    rewind(output.file);
    output.fail_after = 0;
    assert(oliphaunt_unpack_physical_archive_stream(NULL, read_archive, &output, destination) != 0);
    output.fail_after = 1;
    streamed = (OliphauntByteBuffer){.write = write_archive, .context = &output};
    assert(oliphaunt_archive_append_pgdata_tree(&streamed, NULL, source) != 0);
    assert(streamed.write_failed && streamed.data == NULL);
    fclose(output.file);

    /* A minimal valid archive exercises real staging, validation and publication. */
    for (size_t i = 0; i < 3; i++) {
        const char *directories[] = {"base", "global", "pg_wal"};
        char *path = oliphaunt_join_path(source, directories[i]);
        assert(oliphaunt_mkdir_p(path, 0700) == 0);
        free(path);
    }
    fixture_file(source, "PG_VERSION", "18\n");
    fixture_file(source, "global/pg_control", "control");
    OliphauntByteBuffer physical = {0};
    assert(oliphaunt_archive_append_pgdata_tree(&physical, NULL, source) == 0);
    assert(oliphaunt_archive_append_pg_control(&physical, NULL, source) == 0);
    const uint8_t label[] = "backup\n";
    assert(oliphaunt_archive_append_bytes(&physical, NULL, "pgdata/backup_label", label, sizeof(label) - 1) == 0);
    assert(append_default_backup_manifest(&physical, NULL) == 0);
    assert(oliphaunt_archive_finish(&physical, NULL) == 0);
    output = (ArchiveFile){.file = tmpfile()};
    assert(output.file != NULL);
    assert(fwrite(physical.data, 1, physical.len, output.file) == physical.len);
    restore_destination = destination;
    for (int streaming = 0; streaming <= 1; streaming++) {
        for (restore_failure = 0; restore_failure <= 3; restore_failure++) {
            assert(oliphaunt_remove_tree(destination) == 0);
            rewind(output.file);
            output.transferred = 0;
            OliphauntRestoreOptions memory = {
                .abi_version = OLIPHAUNT_ABI_VERSION, .destination = destination,
                .data = physical.data, .len = physical.len,
            };
            OliphauntErrorCapture error = {0};
            int rc = streaming ? oliphaunt_restore_stream_with_error(&options, &error)
                               : oliphaunt_restore_with_error(&memory, &error);
            if ((rc == 0) != (restore_failure == 0)) fprintf(stderr, "%s\n", error.message);
            assert((rc == 0) == (restore_failure == 0));
            assert(oliphaunt_path_exists(destination) == (restore_failure != 1));
            if (restore_failure == 1) {
                assert(strcmp(error.message, "injected staging sync I/O failure") == 0);
                continue;
            }
            char *pgdata = oliphaunt_join_path(destination, "pgdata");
            assert(oliphaunt_validate_managed_root(NULL, pgdata) == 0);
            free(pgdata);
            if (restore_failure == 0) {
                assert(error.message[0] == '\0');
                continue;
            }
            assert(strstr(error.message, "restore published; destination retained") != NULL);
            assert(strstr(error.message, "final durability is unconfirmed") != NULL);
            assert(strstr(error.message, restore_failure == 2 ? "injected parent sync I/O failure"
                                                           : "out of memory") != NULL);
            rewind(output.file);
            int previous_failure = restore_failure;
            restore_failure = 0;
            rc = streaming ? oliphaunt_restore_stream_with_error(&options, &error)
                           : oliphaunt_restore_with_error(&memory, &error);
            restore_failure = previous_failure;
            assert(rc != 0 && strstr(error.message, "already exists and is not empty") != NULL);
        }
    }
    fclose(output.file);
    free(physical.data);
    free(source); free(destination); free(file); free(restored);
    return 0;
}
