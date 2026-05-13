#ifndef LIBPGLITE_H
#define LIBPGLITE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PGLITE_ABI_VERSION 2u

#define PGLITE_CAP_PROTOCOL_RAW (1ull << 0)
#define PGLITE_CAP_PROTOCOL_STREAM (1ull << 1)
#define PGLITE_CAP_MULTI_INSTANCE (1ull << 2)
#define PGLITE_CAP_SERVER_MODE (1ull << 3)
#define PGLITE_CAP_EXTENSIONS (1ull << 4)

typedef struct PGliteHandle PGliteHandle;

typedef struct PGliteConfig {
    uint32_t abi_version;
    const char *pgdata;
    const char *runtime_dir;
    const char *username;
    const char *database;
    uint64_t reserved_flags;
    const char *const *startup_args;
    size_t startup_arg_count;
} PGliteConfig;

typedef struct PGliteResponse {
    uint8_t *data;
    size_t len;
} PGliteResponse;

int32_t pglite_init(const PGliteConfig *config, PGliteHandle **out);
int32_t pglite_exec_protocol(
    PGliteHandle *handle,
    const uint8_t *request,
    size_t request_len,
    PGliteResponse *out);
int32_t pglite_close(PGliteHandle *handle);
const char *pglite_last_error(PGliteHandle *handle);
const char *pglite_version(void);
uint64_t pglite_capabilities(void);
void pglite_free_response(PGliteResponse *response);

#ifdef __cplusplus
}
#endif

#endif
