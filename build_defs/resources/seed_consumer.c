#include "postgres_fe.h"
#include "catalog/catversion.h"
#include "catalog/pg_control.h"
#include "oliphaunt.h"
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t read_u32(const uint8_t *data) {
    return ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
           ((uint32_t)data[2] << 8) | (uint32_t)data[3];
}

/* Test-only negative fixtures retain the canonical ControlFileData CRC. */
static int corrupt_control_file(const char *path, int catalog) {
    unsigned char bytes[PG_CONTROL_FILE_SIZE];
    ControlFileData control;
    pg_crc32c crc;
    FILE *file = fopen(path, "r+b");
    if (file == NULL) return 2;
    if (fread(bytes, 1, sizeof(bytes), file) != sizeof(bytes) ||
        fgetc(file) != EOF || ferror(file)) {
        fclose(file);
        return 2;
    }
    memcpy(&control, bytes, sizeof(control));
    INIT_CRC32C(crc);
    COMP_CRC32C(crc, bytes, offsetof(ControlFileData, crc));
    FIN_CRC32C(crc);
    if (!EQ_CRC32C(crc, control.crc) ||
        control.pg_control_version != PG_CONTROL_VERSION ||
        control.catalog_version_no != CATALOG_VERSION_NO) {
        fclose(file);
        fputs("fixture requires an original compatible control file with a valid CRC32C\n", stderr);
        return 2;
    }
    if (catalog) control.catalog_version_no ^= 1U;
    else control.pg_control_version ^= 1U;
    memcpy(bytes, &control, sizeof(control));
    INIT_CRC32C(crc);
    COMP_CRC32C(crc, bytes, offsetof(ControlFileData, crc));
    FIN_CRC32C(crc);
    memcpy(bytes + offsetof(ControlFileData, crc), &crc, sizeof(control.crc));
    if (fseek(file, 0, SEEK_SET) != 0 ||
        fwrite(bytes, 1, sizeof(bytes), file) != sizeof(bytes) || fflush(file) != 0) {
        fclose(file);
        return 2;
    }
    if (fclose(file) != 0) return 2;
    printf("corrupted %s with valid CRC32C\n", catalog ? "CATALOG_VERSION_NO" : "PG_CONTROL_VERSION");
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts(oliphaunt_version());
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "--corrupt-control") == 0)
        return corrupt_control_file(argv[2], 0);
    if (argc == 3 && strcmp(argv[1], "--corrupt-catalog") == 0)
        return corrupt_control_file(argv[2], 1);
    if (argc != 5) return 2;
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION, .pgdata = argv[1], .runtime_dir = argv[2],
        .username = "postgres", .database = "postgres", .icu_data_dir = getenv("ICU_DATA"),
    };
    OliphauntHandle *database = NULL;
    OliphauntErrorCapture error = {0};
    if (oliphaunt_init_with_error(&config, &database, &error) != 0 || database == NULL) {
        fprintf(stderr, "seed open failed: %s\n", error.message);
        return 1;
    }
    OliphauntResponse response = {0};
    int failed = oliphaunt_exec_simple_query_with_error(database, argv[3], strlen(argv[3]), &response, &error) != 0;
    size_t expected = strlen(argv[4]);
    int found = 0, complete = 0, ready = 0;
    size_t cursor = 0;
    while (!failed && cursor < response.len) {
        if (response.len - cursor < 5) { failed = 1; break; }
        const uint8_t *message = response.data + cursor;
        uint32_t length = read_u32(message + 1);
        if (length < 4 || (size_t)length + 1 > response.len - cursor) { failed = 1; break; }
        if (message[0] == 'E') failed = 1;
        if (message[0] == 'C') complete = 1;
        if (message[0] == 'Z') ready = 1;
        if (message[0] == 'D' && length >= 10 && message[5] == 0 && message[6] == 1) {
            uint32_t value_length = read_u32(message + 7);
            if ((size_t)value_length == expected && value_length == length - 10 &&
                memcmp(message + 11, argv[4], expected) == 0) found = 1;
        }
        cursor += (size_t)length + 1;
    }
    if (failed || !found || !complete || !ready)
        fprintf(stderr, "seed query did not return expected PostgreSQL row: %s: %s\n", argv[3], error.message);
    oliphaunt_free_response(&response);
    if (oliphaunt_close(database) != 0) return 1;
    return !failed && found && complete && ready ? 0 : 1;
}
