#include "../include/oliphaunt.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int contains(const OliphauntResponse *response, const char *expected) {
    const size_t expected_len = strlen(expected);
    if (expected_len == 0 || response->data == NULL || response->len < expected_len) {
        return 0;
    }
    for (size_t offset = 0; offset + expected_len <= response->len; offset++) {
        if (memcmp(response->data + offset, expected, expected_len) == 0) {
            return 1;
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 5) {
        fprintf(stderr, "usage: %s <pgdata> <runtime-dir> <sql> <expected>\n", argv[0]);
        return 2;
    }
    const OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = argv[1],
        .runtime_dir = argv[2],
        .username = "postgres",
        .database = "postgres",
    };
    OliphauntHandle *database = NULL;
    if (oliphaunt_init(&config, &database) != 0 || database == NULL) {
        fprintf(stderr, "cluster-seed open failed: %s\n", oliphaunt_last_error(database));
        return 1;
    }
    OliphauntResponse response = {0};
    const int query_result = oliphaunt_exec_simple_query(
        database,
        argv[3],
        strlen(argv[3]),
        &response);
    const int matched = query_result == 0 && contains(&response, argv[4]);
    if (!matched) {
        fprintf(stderr, "cluster-seed profile probe failed: %s\n", oliphaunt_last_error(database));
    }
    oliphaunt_free_response(&response);
    if (oliphaunt_close(database) != 0) {
        fprintf(stderr, "cluster-seed close failed: %s\n", oliphaunt_last_error(NULL));
        return 1;
    }
    return matched ? 0 : 1;
}
