#include "liboliphaunt_internal.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

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
    char *restored = oliphaunt_join_path(destination, "pgdata/large");
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
    free(source); free(destination); free(file); free(restored);
    return 0;
}
