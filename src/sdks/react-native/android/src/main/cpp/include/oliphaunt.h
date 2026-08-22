#ifndef OLIPHAUNT_H
#define OLIPHAUNT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OLIPHAUNT_ABI_VERSION 8u
#define OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION 1u
/* The caller already owns liboliphaunt's stable sibling root lease. */
#define OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK (1ull << 0)

#if defined(_WIN32) && defined(OLIPHAUNT_BUILDING_DLL)
#define OLIPHAUNT_API __declspec(dllexport)
#elif defined(_WIN32)
#define OLIPHAUNT_API __declspec(dllimport)
#else
#define OLIPHAUNT_API
#endif

typedef struct OliphauntHandle OliphauntHandle;

typedef struct OliphauntStaticExtensionSymbol {
    const char *name;
    void *address;
} OliphauntStaticExtensionSymbol;

typedef struct OliphauntStaticExtension {
    uint32_t abi_version;
    const char *name;
    const void *(*magic)(void);
    void (*init)(void);
    const OliphauntStaticExtensionSymbol *symbols;
    size_t symbol_count;
    uint64_t reserved_flags;
} OliphauntStaticExtension;

/*
 * Direct-mode extension compatibility contract:
 *
 * oliphaunt_init sets the process PGDATA environment variable to this config's
 * pgdata path while the embedded backend is active, because PostgreSQL
 * extensions may read PGDATA through standard process APIs. oliphaunt_detach
 * releases a logical direct-mode lease but keeps the resident backend alive;
 * oliphaunt_close is terminal for the process lifetime and restores the caller's
 * previous PGDATA value, or unsets it if it was unset.
 *
 * Every successful oliphaunt_init establishes a current
 * logical lease generation. Hosts with independent cleanup owners must capture
 * its non-zero value immediately with oliphaunt_logical_generation and use
 * oliphaunt_close_if_generation: a stale owner then cannot terminate a newer
 * logical lease on the same resident handle.
 *
 * Callers that require process environment isolation should use broker/server
 * mode through the Rust SDK instead of keeping multiple direct-mode backends in
 * one process.
 */
typedef struct OliphauntConfig {
    uint32_t abi_version;
    /* The pgdata child of an already-prepared managed root. Init does not create it. */
    const char *pgdata;
    const char *runtime_dir;
    /*
     * Exact PostgreSQL $libdir for the embedded handle. It must name an
     * existing directory. Pass NULL to use OLIPHAUNT_EMBEDDED_MODULE_DIR and
     * release-layout discovery.
     */
    const char *module_dir;
    const char *username;
    const char *database;
    /* OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK or zero. */
    uint64_t reserved_flags;
    const char *const *startup_args;
    size_t startup_arg_count;
} OliphauntConfig;

typedef struct OliphauntResponse {
    uint8_t *data;
    size_t len;
} OliphauntResponse;

typedef struct OliphauntRestoreOptions {
    uint32_t abi_version;
    /* New or existing-empty managed-root path; this is not a PGDATA path. */
    const char *destination;
    /* Bytes in the single native physical archive format returned by oliphaunt_backup. */
    const uint8_t *data;
    size_t len;
} OliphauntRestoreOptions;

typedef int32_t (*OliphauntStreamCallback)(void *context, const uint8_t *data, size_t len);

OLIPHAUNT_API int32_t oliphaunt_init(const OliphauntConfig *config, OliphauntHandle **out);
OLIPHAUNT_API int32_t oliphaunt_exec_protocol(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out);
OLIPHAUNT_API int32_t oliphaunt_exec_simple_query(
    OliphauntHandle *handle,
    const char *sql,
    size_t sql_len,
    OliphauntResponse *out);
OLIPHAUNT_API int32_t oliphaunt_exec_protocol_stream(
    OliphauntHandle *handle,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context);
/*
 * Creates a session-preserving online physical archive. If an error says that
 * backup-mode exit is unconfirmed, no later query is safe: detach/close the
 * handle and restart the process before reopening PostgreSQL.
 */
OLIPHAUNT_API int32_t oliphaunt_backup(
    OliphauntHandle *handle,
    OliphauntResponse *out);
OLIPHAUNT_API int32_t oliphaunt_restore(const OliphauntRestoreOptions *options);
OLIPHAUNT_API int32_t oliphaunt_cancel(OliphauntHandle *handle);
/* A poisoned backup session is terminally closed instead of retained. */
OLIPHAUNT_API int32_t oliphaunt_detach(OliphauntHandle *handle);
/*
 * Returns the non-zero generation of the currently published logical lease.
 * Returns zero for NULL, stale, terminally closed, or otherwise non-current
 * handles. The registry is validated before the opaque handle is dereferenced.
 */
OLIPHAUNT_API uint64_t oliphaunt_logical_generation(OliphauntHandle *handle);
/*
 * Terminally closes the process-wide resident handle only when generation
 * still owns its current logical lease. Returns 0 when terminal close completes
 * or had already completed, 1 for an active stale/non-owner generation no-op,
 * and -1 for generation zero or an internal failure.
 */
OLIPHAUNT_API int32_t oliphaunt_close_if_generation(
    uint64_t generation);
/*
 * Unconditionally performs process-terminal close for the current published
 * resident handle. Hosts with multiple cleanup owners should use
 * oliphaunt_close_if_generation and retain only its generation token.
 */
OLIPHAUNT_API int32_t oliphaunt_close(OliphauntHandle *handle);
/*
 * Registers statically linked PostgreSQL extension modules for the embedded
 * backend's normal LOAD path.
 *
 * Call this before oliphaunt_init in processes that link extension code directly
 * into the application or SDK library. The registry is process-wide and becomes
 * immutable once backend startup begins. Each extension name is the module stem
 * used by SQL, for example AS 'vector', and each symbol row exposes the C
 * symbols PostgreSQL would otherwise resolve with dlsym().
 */
OLIPHAUNT_API int32_t oliphaunt_register_static_extensions(const OliphauntStaticExtension *extensions, size_t count);
OLIPHAUNT_API const char *oliphaunt_last_error(OliphauntHandle *handle);
OLIPHAUNT_API const char *oliphaunt_version(void);
OLIPHAUNT_API void oliphaunt_free_response(OliphauntResponse *response);

#ifdef __cplusplus
}
#endif

#endif
