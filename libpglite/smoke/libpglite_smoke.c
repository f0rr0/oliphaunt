#include "../include/libpglite.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void push_query(unsigned char **buf, size_t *len, const char *sql) {
    size_t sql_len = strlen(sql) + 1;
    size_t frame_len = sql_len + 4;
    *len = frame_len + 1;
    *buf = (unsigned char *)calloc(*len, 1);
    (*buf)[0] = 'Q';
    (*buf)[1] = (unsigned char)((frame_len >> 24) & 0xff);
    (*buf)[2] = (unsigned char)((frame_len >> 16) & 0xff);
    (*buf)[3] = (unsigned char)((frame_len >> 8) & 0xff);
    (*buf)[4] = (unsigned char)(frame_len & 0xff);
    memcpy(*buf + 5, sql, sql_len);
}

static int contains_tag(const PGliteResponse *response, unsigned char tag) {
    size_t off = 0;
    while (off + 5 <= response->len) {
        unsigned char current = response->data[off];
        uint32_t len = ((uint32_t)response->data[off + 1] << 24) |
                       ((uint32_t)response->data[off + 2] << 16) |
                       ((uint32_t)response->data[off + 3] << 8) |
                       (uint32_t)response->data[off + 4];
        if (len < 4 || off + 1 + len > response->len) {
            return 0;
        }
        if (current == tag) {
            return 1;
        }
        off += 1 + len;
    }
    return 0;
}

static int run_cycle(const char *pgdata, const char *runtime_dir) {
    PGliteConfig config = {
        .abi_version = PGLITE_ABI_VERSION,
        .pgdata = pgdata,
        .runtime_dir = runtime_dir,
        .username = "postgres",
        .database = "postgres",
        .reserved_flags = 0,
    };
    PGliteHandle *db = NULL;
    fprintf(stderr, "opening pgdata: %s\n", pgdata);
    int rc = pglite_init(&config, &db);
    if (rc != 0 || db == NULL) {
        fprintf(stderr, "pglite_init failed: %s\n", pglite_last_error(db));
        return 1;
    }

    unsigned char *query = NULL;
    size_t query_len = 0;
    push_query(&query, &query_len, "SELECT 1 AS value");

    PGliteResponse response = {0};
    fprintf(stderr, "executing raw protocol: SELECT 1 AS value\n");
    rc = pglite_exec_protocol(db, query, query_len, &response);
    free(query);
    if (rc != 0) {
        fprintf(stderr, "pglite_exec_protocol failed: %s\n", pglite_last_error(db));
        pglite_close(db);
        return 1;
    }
    if (!contains_tag(&response, 'T') || !contains_tag(&response, 'D') ||
        !contains_tag(&response, 'C') || !contains_tag(&response, 'Z')) {
        fprintf(stderr, "SELECT 1 response did not contain T/D/C/Z protocol tags\n");
        pglite_free_response(&response);
        pglite_close(db);
        return 1;
    }
    pglite_free_response(&response);

    fprintf(stderr, "closing database\n");
    rc = pglite_close(db);
    if (rc != 0) {
        fprintf(stderr, "pglite_close failed\n");
        return 1;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <pgdata> <runtime-dir>\n", argv[0]);
        return 2;
    }

    fprintf(stderr, "libpglite version: %s\n", pglite_version());
    fprintf(stderr, "libpglite capabilities: 0x%llx\n", (unsigned long long)pglite_capabilities());

    const char *cycles_value = getenv("LIBPGLITE_SMOKE_CYCLES");
    if (cycles_value == NULL || cycles_value[0] == '\0') {
        cycles_value = getenv("PGLITE_OXIDE_NATIVE_SMOKE_CYCLES");
    }
    int cycles = cycles_value != NULL && cycles_value[0] != '\0' ? atoi(cycles_value) : 1;
    if (cycles < 1) {
        cycles = 1;
    }

    for (int cycle = 0; cycle < cycles; cycle++) {
        fprintf(stderr, "same-process cycle %d\n", cycle + 1);
        if (run_cycle(argv[1], argv[2]) != 0) {
            return 1;
        }
    }

    fprintf(stderr, "native libpglite smoke passed\n");
    return 0;
}
