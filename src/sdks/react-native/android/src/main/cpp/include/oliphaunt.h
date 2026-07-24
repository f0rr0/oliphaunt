#ifndef OLIPHAUNT_H
#define OLIPHAUNT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OLIPHAUNT_ABI_VERSION 6u
#define OLIPHAUNT_INIT_OPTIONS_ABI_VERSION 1u
#define OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION 1u

#define OLIPHAUNT_CAP_PROTOCOL_RAW (1ull << 0)
#define OLIPHAUNT_CAP_PROTOCOL_STREAM (1ull << 1)
#define OLIPHAUNT_CAP_MULTI_INSTANCE (1ull << 2)
#define OLIPHAUNT_CAP_SERVER_MODE (1ull << 3)
#define OLIPHAUNT_CAP_EXTENSIONS (1ull << 4)
#define OLIPHAUNT_CAP_QUERY_CANCEL (1ull << 5)
#define OLIPHAUNT_CAP_BACKUP_RESTORE (1ull << 6)
#define OLIPHAUNT_CAP_SIMPLE_QUERY (1ull << 7)
#define OLIPHAUNT_CAP_STATIC_EXTENSIONS (1ull << 8)
#define OLIPHAUNT_CAP_LOGICAL_REOPEN (1ull << 9)

#define OLIPHAUNT_BACKUP_FORMAT_SQL 1u
#define OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE 2u
#define OLIPHAUNT_BACKUP_FORMAT_OLIPHAUNT_ARCHIVE 3u

#if defined(_WIN32) && defined(OLIPHAUNT_BUILDING_DLL)
#define OLIPHAUNT_API __declspec(dllexport)
#elif defined(_WIN32)
#define OLIPHAUNT_API __declspec(dllimport)
#else
#define OLIPHAUNT_API
#endif

/*
 * The caller already owns an equivalent root lock for this PGDATA path.
 *
 * Leave this flag unset for plain C, Swift, Kotlin, and other direct C ABI
 * callers; oliphaunt_init will then take a non-blocking stable filesystem lease
 * for <parent-of-pgdata> and create <parent-of-pgdata>/.oliphaunt.lock as the
 * visible root marker. The Rust SDK sets this flag because it owns a stronger
 * process-plus-filesystem root coordinator across direct, broker, server,
 * backup, and restore paths.
 */
#define OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK (1ull << 0)

#define OLIPHAUNT_RESTORE_REPLACE_EXISTING (1ull << 0)

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
 * Registers statically linked PostgreSQL extension modules for the embedded
 * backend's normal LOAD path.
 *
 * Call this before oliphaunt_init in processes that link extension code directly
 * into the application or SDK library. The registry is process-wide and becomes
 * immutable once backend startup begins. Each extension name is the module stem
 * used by SQL, for example AS 'vector', and each symbol row exposes the C
 * symbols PostgreSQL would otherwise resolve with dlsym().
 */

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
 * Every successful oliphaunt_init or oliphaunt_init_ex establishes a current
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
    const char *pgdata;
    const char *runtime_dir;
    const char *username;
    const char *database;
    uint64_t reserved_flags;
    const char *const *startup_args;
    size_t startup_arg_count;
} OliphauntConfig;

/*
 * Optional, versioned additions to oliphaunt_init.
 *
 * module_dir selects the exact directory PostgreSQL uses for $libdir while
 * this embedded handle is active. It is copied during initialization and must
 * name an existing directory. A NULL OliphauntInitOptions preserves the
 * oliphaunt_init contract, including the OLIPHAUNT_EMBEDDED_MODULE_DIR host
 * override and release-layout discovery fallbacks.
 */
typedef struct OliphauntInitOptions {
    uint32_t abi_version;
    const char *module_dir;
    uint64_t reserved_flags;
} OliphauntInitOptions;

typedef struct OliphauntResponse {
    uint8_t *data;
    size_t len;
} OliphauntResponse;

typedef struct OliphauntArchiveFile {
    const char *path;
    const uint8_t *data;
    size_t len;
    uint32_t mode;
    uint64_t reserved_flags;
} OliphauntArchiveFile;

typedef struct OliphauntBackupOptions {
    uint32_t abi_version;
    uint32_t format;
    const OliphauntArchiveFile *generated_files;
    size_t generated_file_count;
    uint64_t reserved_flags;
} OliphauntBackupOptions;

typedef struct OliphauntRestoreOptions {
    uint32_t abi_version;
    const char *root;
    uint32_t format;
    const uint8_t *data;
    size_t len;
    uint64_t flags;
} OliphauntRestoreOptions;

typedef int32_t (*OliphauntStreamCallback)(void *context, const uint8_t *data, size_t len);

OLIPHAUNT_API int32_t oliphaunt_init(const OliphauntConfig *config, OliphauntHandle **out);
OLIPHAUNT_API int32_t oliphaunt_init_ex(
    const OliphauntConfig *config,
    const OliphauntInitOptions *options,
    OliphauntHandle **out);
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
OLIPHAUNT_API int32_t oliphaunt_backup(OliphauntHandle *handle, uint32_t format, OliphauntResponse *out);
OLIPHAUNT_API int32_t oliphaunt_backup_ex(
    OliphauntHandle *handle,
    const OliphauntBackupOptions *options,
    OliphauntResponse *out);
OLIPHAUNT_API int32_t oliphaunt_restore(const OliphauntRestoreOptions *options);
OLIPHAUNT_API int32_t oliphaunt_cancel(OliphauntHandle *handle);
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
OLIPHAUNT_API int32_t oliphaunt_register_static_extensions(const OliphauntStaticExtension *extensions, size_t count);
OLIPHAUNT_API const char *oliphaunt_last_error(OliphauntHandle *handle);
OLIPHAUNT_API const char *oliphaunt_version(void);
OLIPHAUNT_API uint64_t oliphaunt_capabilities(void);
OLIPHAUNT_API void oliphaunt_free_response(OliphauntResponse *response);

#ifdef __cplusplus
}
#endif

#endif
