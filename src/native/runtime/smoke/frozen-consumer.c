#include "oliphaunt.h"
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    const char *startup[] = { "-c", argv[4] };
    const OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = argv[1],
        .runtime_dir = argv[2],
        .username = "postgres",
        .database = "postgres",
        .startup_args = startup,
        .startup_arg_count = 2,
    };
    OliphauntHandle *database = NULL;
    if (oliphaunt_init(&config, &database) != 0 || database == NULL) return 1;
    OliphauntResponse response = {0};
    const int result = oliphaunt_exec_simple_query(database, argv[3], strlen(argv[3]), &response);
    if (result != 0) {
        char error[OLIPHAUNT_ERROR_CAPTURE_CAPACITY];
        oliphaunt_copy_last_error(database, error, sizeof(error));
        fprintf(stderr, "%s\n", error);
    }
    int answer = 0, failed = result != 0, ready = 0;
    /* Simple-query returns PostgreSQL frames; SQL errors are not C ABI errors. */
    size_t offset = 0;
    while (offset < response.len) {
        if (response.len - offset < 5) { failed = 1; break; }
        const unsigned char *frame = response.data + offset;
        const size_t length = ((size_t)frame[1] << 24) | ((size_t)frame[2] << 16) |
                              ((size_t)frame[3] << 8) | frame[4];
        if (length < 4 || length > response.len - offset - 1) { failed = 1; break; }
        if (frame[0] == 'E') {
            fprintf(stderr, "SQL ErrorResponse in frozen package consumer\n");
            failed = 1;
        }
        if (frame[0] == 'Z') ready = 1;
        /* One text-format column containing exactly 42. */
        if (frame[0] == 'D' && length == 12 && frame[5] == 0 && frame[6] == 1 &&
            frame[7] == 0 && frame[8] == 0 && frame[9] == 0 && frame[10] == 2 &&
            frame[11] == '4' && frame[12] == '2') answer = 1;
        offset += length + 1;
    }
    oliphaunt_free_response(&response);
    const int closed = oliphaunt_close(database);
    return failed || closed != 0 || !answer || !ready;
}
