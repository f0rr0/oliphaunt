#include "oliphaunt.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *read_text(const char *path) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) return NULL;
    if (fseek(file, 0, SEEK_END)) { fclose(file); return NULL; }
    long length = ftell(file);
    if (length < 0 || fseek(file, 0, SEEK_SET)) { fclose(file); return NULL; }
    char *text = malloc((size_t)length + 1);
    if (text == NULL) { fclose(file); return NULL; }
    size_t actual = fread(text, 1, (size_t)length, file);
    int failed = ferror(file) || actual != (size_t)length;
    fclose(file);
    if (failed) { free(text); return NULL; }
    text[actual] = '\0';
    return text;
}

static uint32_t read_u32(const uint8_t *data) {
    return ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
           ((uint32_t)data[2] << 8) | (uint32_t)data[3];
}

static int query(OliphauntHandle *database, const char *sql, const char *expected) {
    OliphauntResponse response = {0};
    OliphauntErrorCapture error = {0};
    if (oliphaunt_exec_simple_query_with_error(database, sql, strlen(sql), &response, &error)) {
        fprintf(stderr, "extension query failed: %s: %s\n", sql, error.message);
        return 1;
    }
    int failed = 0, complete = 0, ready = 0, matched = expected == NULL;
    size_t cursor = 0;
    while (cursor < response.len) {
        if (response.len - cursor < 5) { failed = 1; break; }
        const uint8_t *message = response.data + cursor;
        uint32_t length = read_u32(message + 1);
        if (length < 4 || (size_t)length + 1 > response.len - cursor) { failed = 1; break; }
        if (message[0] == 'E') failed = 1;
        if (message[0] == 'C') complete = 1;
        if (message[0] == 'Z') ready = 1;
        if (message[0] == 'D' && expected != NULL && length >= 10 &&
            message[5] == 0 && message[6] == 1) {
            uint32_t value_length = read_u32(message + 7);
            if ((size_t)value_length == strlen(expected) && value_length == length - 10 &&
                memcmp(message + 11, expected, value_length) == 0) matched = 1;
        }
        cursor += (size_t)length + 1;
    }
    if (failed || !complete || !ready || !matched) {
        fprintf(stderr, "extension query had unexpected PostgreSQL response: %s\n", sql);
        failed = 1;
    }
    oliphaunt_free_response(&response);
    return failed;
}

static int query_plan(OliphauntHandle *database, char *sql, const char *expected) {
    const char *separator = "\n-- oliphaunt-statement\n";
    while (sql != NULL) {
        char *next = strstr(sql, separator);
        if (next != NULL) { *next = '\0'; next += strlen(separator); }
        if (query(database, sql, next == NULL ? expected : NULL)) return 1;
        sql = next;
    }
    return 0;
}

int main(int argc, char **argv) {
    int plan = argc == 7 && strcmp(argv[3], "--sql-plan") == 0;
    if (!plan && argc != 6) return 2;
    char *install = NULL, *smoke = NULL, *startup = NULL;
    const char *startup_args[128];
    size_t startup_arg_count = 0;
    if (plan) {
        install = read_text(argv[4]);
        smoke = read_text(argv[5]);
        startup = read_text(argv[6]);
        if (install == NULL || smoke == NULL || startup == NULL) return 2;
        for (char *assignment = strtok(startup, "\n"); assignment != NULL; assignment = strtok(NULL, "\n")) {
            if (startup_arg_count + 2 > sizeof(startup_args) / sizeof(startup_args[0])) return 2;
            startup_args[startup_arg_count++] = "-c";
            startup_args[startup_arg_count++] = assignment;
        }
    }
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = argv[1], .runtime_dir = argv[2],
        .module_dir = getenv("OLIPHAUNT_SMOKE_MODULE_DIR"),
        .username = "postgres", .database = "postgres",
        .startup_args = startup_arg_count ? startup_args : NULL,
        .startup_arg_count = startup_arg_count,
    };
    OliphauntHandle *database = NULL;
    OliphauntErrorCapture error = {0};
    if (oliphaunt_init_with_error(&config, &database, &error) || database == NULL) {
        fprintf(stderr, "extension runtime initialization failed: %s\n", error.message);
        return 1;
    }
    int failed;
    if (plan) failed = query_plan(database, install, NULL) || query_plan(database, smoke, "candidate-extension-smoke-ok");
    else failed =
        query(database, "CREATE EXTENSION IF NOT EXISTS pg_trgm", NULL) ||
        query(database, "CREATE EXTENSION IF NOT EXISTS vector", NULL) ||
        query(database, "CREATE EXTENSION IF NOT EXISTS pgtap", NULL) ||
        query(database, "SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'", argv[3]) ||
        query(database, "SELECT extversion FROM pg_extension WHERE extname = 'vector'", argv[4]) ||
        query(database, "SELECT extversion FROM pg_extension WHERE extname = 'pgtap'", argv[5]) ||
        query(database, "SELECT plan(2)", "1..2") ||
        query(database, "SELECT ok(similarity('same', 'same') = 1, 'compiled contrib')", "ok 1 - compiled contrib") ||
        query(database, "SELECT is(('[1,2,3]'::vector <-> '[1,2,4]'::vector)::numeric, 1::numeric, 'compiled external')", "ok 2 - compiled external") ||
        query(database, "SELECT count(*) FROM finish()", "0");
    if (oliphaunt_close(database)) failed = 1;
    free(install);
    free(smoke);
    free(startup);
    return failed;
}
