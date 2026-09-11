#include "liboliphaunt_internal.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

typedef struct OliphauntRegisteredStaticExtension {
    OliphauntStaticExtension extension;
    OliphauntStaticExtensionSymbol *symbols;
    char *name;
    char **symbol_names;
    struct OliphauntRegisteredStaticExtension *next;
} OliphauntRegisteredStaticExtension;

static pthread_mutex_t static_registry_mutex = PTHREAD_MUTEX_INITIALIZER;
static OliphauntRegisteredStaticExtension *static_registry = NULL;

#ifdef _MSC_VER
extern const OliphauntStaticExtension *liboliphaunt_builtin_static_extensions(size_t *count);
#else
extern const OliphauntStaticExtension *liboliphaunt_builtin_static_extensions(size_t *count) __attribute__((weak));
#endif

static const OliphauntStaticExtension *builtin_static_extensions(size_t *count) {
    if (liboliphaunt_builtin_static_extensions == NULL) {
        if (count != NULL) {
            *count = 0;
        }
        return NULL;
    }
    return liboliphaunt_builtin_static_extensions(count);
}

static const OliphauntStaticExtension *lookup_static_extension(
    const OliphauntStaticExtension *extensions,
    size_t count,
    const char *name) {
    if (extensions == NULL || name == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < count; i++) {
        if (strcmp(extensions[i].name, name) == 0) {
            return &extensions[i];
        }
    }
    return NULL;
}

static const OliphauntStaticExtension *lookup_registered_static_extension(const char *name) {
    if (name == NULL) {
        return NULL;
    }
    for (OliphauntRegisteredStaticExtension *entry = static_registry; entry != NULL; entry = entry->next) {
        if (strcmp(entry->extension.name, name) == 0) {
            return &entry->extension;
        }
    }
    return NULL;
}

static bool is_portable_static_name(const char *value) {
    if (value == NULL || value[0] == '\0') {
        return false;
    }
    size_t len = strlen(value);
    if (len > 128) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        unsigned char ch = (unsigned char)value[i];
        if ((ch >= 'a' && ch <= 'z') ||
            (ch >= 'A' && ch <= 'Z') ||
            (ch >= '0' && ch <= '9') ||
            ch == '_' || ch == '-' || ch == '.') {
            continue;
        }
        return false;
    }
    return true;
}

static bool is_portable_static_symbol_name(const char *value) {
    if (value == NULL || value[0] == '\0') {
        return false;
    }
    /*
     * A module name is also a package/filesystem identity, so it has the
     * deliberately small bound above. A linked-object symbol is not: valid
     * toolchain-generated symbols (notably C++ symbols linked into PostGIS)
     * can be substantially longer than 128 bytes. Walk the complete symbol
     * spelling and constrain its alphabet without imposing a package-name
     * limit on the native linker contract.
     */
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
        unsigned char ch = *cursor;
        if ((ch >= 'a' && ch <= 'z') ||
            (ch >= 'A' && ch <= 'Z') ||
            (ch >= '0' && ch <= '9') ||
            ch == '_' || ch == '-' || ch == '.') {
            continue;
        }
        return false;
    }
    return true;
}

static const char *file_stem(const char *filename, char *buffer, size_t buffer_len) {
    if (filename == NULL || filename[0] == '\0' || buffer == NULL || buffer_len == 0) {
        return "";
    }
    const char *base = strrchr(filename, '/');
    base = base != NULL ? base + 1 : filename;
    size_t len = strlen(base);
    const char *suffixes[] = {".dylib", ".so", ".bundle", ".dll"};
    for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
        size_t suffix_len = strlen(suffixes[i]);
        if (len > suffix_len && strcmp(base + len - suffix_len, suffixes[i]) == 0) {
            len -= suffix_len;
            break;
        }
    }
    if (len >= buffer_len) {
        len = buffer_len - 1;
    }
    memcpy(buffer, base, len);
    buffer[len] = '\0';
    return buffer;
}

static void free_static_registry_entries(OliphauntRegisteredStaticExtension *entries, size_t count) {
    if (entries == NULL) {
        return;
    }
    for (size_t i = 0; i < count; i++) {
        free(entries[i].name);
        if (entries[i].symbol_names != NULL) {
            for (size_t j = 0; j < entries[i].extension.symbol_count; j++) {
                free(entries[i].symbol_names[j]);
            }
            free(entries[i].symbol_names);
        }
        free(entries[i].symbols);
    }
    free(entries);
}

static int validate_static_extensions(const OliphauntStaticExtension *extensions, size_t count) {
    if (count == 0) {
        return 0;
    }
    if (extensions == NULL) {
        set_error(NULL, "static extension registration requires extensions when count is non-zero");
        return -1;
    }
    for (size_t i = 0; i < count; i++) {
        const OliphauntStaticExtension *extension = &extensions[i];
        if (extension->abi_version != OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION ||
            extension->reserved_flags != 0 ||
            !is_portable_static_name(extension->name) ||
            extension->magic == NULL ||
            (extension->symbol_count > 0 && extension->symbols == NULL)) {
            set_error(NULL, "invalid static extension registration entry");
            return -1;
        }
        size_t builtin_count = 0;
        const OliphauntStaticExtension *builtins = builtin_static_extensions(&builtin_count);
        if (lookup_static_extension(builtins, builtin_count, extension->name) != NULL) {
            set_error(NULL, "static extension registration conflicts with built-in extension");
            return -1;
        }
        for (size_t existing = 0; existing < i; existing++) {
            if (strcmp(extensions[existing].name, extension->name) == 0) {
                set_error(NULL, "duplicate static extension registration entry");
                return -1;
            }
        }
        for (size_t j = 0; j < extension->symbol_count; j++) {
            if (!is_portable_static_symbol_name(extension->symbols[j].name) ||
                extension->symbols[j].address == NULL) {
                set_error(NULL, "invalid static extension symbol registration entry");
                return -1;
            }
            for (size_t existing = 0; existing < j; existing++) {
                if (strcmp(extension->symbols[existing].name, extension->symbols[j].name) == 0) {
                    set_error(NULL, "duplicate static extension symbol registration entry");
                    return -1;
                }
            }
        }
    }
    return 0;
}

static int copy_static_extensions(
    const OliphauntStaticExtension *extensions,
    size_t count,
    OliphauntRegisteredStaticExtension **out_entries) {
    *out_entries = NULL;
    if (count == 0) {
        return 0;
    }
    OliphauntRegisteredStaticExtension *entries =
        (OliphauntRegisteredStaticExtension *)calloc(count, sizeof(OliphauntRegisteredStaticExtension));
    if (entries == NULL) {
        set_error(NULL, "out of memory allocating static extension registry");
        return -1;
    }
    for (size_t i = 0; i < count; i++) {
        const OliphauntStaticExtension *source = &extensions[i];
        OliphauntRegisteredStaticExtension *target = &entries[i];
        target->name = strdup(source->name);
        if (target->name == NULL) {
            set_error(NULL, "out of memory copying static extension name");
            free_static_registry_entries(entries, count);
            return -1;
        }
        target->extension = *source;
        target->extension.name = target->name;
        if (source->symbol_count > 0) {
            target->symbols = (OliphauntStaticExtensionSymbol *)calloc(
                source->symbol_count,
                sizeof(OliphauntStaticExtensionSymbol));
            target->symbol_names = (char **)calloc(source->symbol_count, sizeof(char *));
            if (target->symbols == NULL || target->symbol_names == NULL) {
                set_error(NULL, "out of memory copying static extension symbols");
                free_static_registry_entries(entries, count);
                return -1;
            }
            for (size_t j = 0; j < source->symbol_count; j++) {
                target->symbol_names[j] = strdup(source->symbols[j].name);
                if (target->symbol_names[j] == NULL) {
                    set_error(NULL, "out of memory copying static extension symbol name");
                    free_static_registry_entries(entries, count);
                    return -1;
                }
                target->symbols[j].name = target->symbol_names[j];
                target->symbols[j].address = source->symbols[j].address;
            }
            target->extension.symbols = target->symbols;
        }
    }
    *out_entries = entries;
    return 0;
}

static bool static_extension_matches(
    const OliphauntStaticExtension *existing,
    const OliphauntStaticExtension *incoming) {
    if (existing->magic != incoming->magic ||
        existing->init != incoming->init ||
        existing->symbol_count != incoming->symbol_count) {
        return false;
    }
    for (size_t j = 0; j < existing->symbol_count; j++) {
        if (strcmp(existing->symbols[j].name, incoming->symbols[j].name) != 0 ||
            existing->symbols[j].address != incoming->symbols[j].address) {
            return false;
        }
    }
    return true;
}

static int32_t oliphaunt_register_static_extensions_impl(const OliphauntStaticExtension *extensions, size_t count) {
    if (validate_static_extensions(extensions, count) != 0) {
        return -1;
    }
    /* Entries live for the process lifetime: PostgreSQL retains descriptor pointers.
     * Additions never move or replace an entry already visible to a backend. */
    pthread_mutex_lock(&static_registry_mutex);
    OliphauntRegisteredStaticExtension *pending = NULL;
    for (size_t i = 0; i < count; i++) {
        const OliphauntStaticExtension *existing = lookup_registered_static_extension(extensions[i].name);
        if (existing != NULL) {
            if (!static_extension_matches(existing, &extensions[i])) {
                set_error(NULL, "conflicting static extension registration for an existing module");
                goto failure;
            }
            continue;
        }
        OliphauntRegisteredStaticExtension *entry = NULL;
        if (copy_static_extensions(&extensions[i], 1, &entry) != 0) {
            goto failure;
        }
        entry->next = pending;
        pending = entry;
    }
    while (pending != NULL) {
        OliphauntRegisteredStaticExtension *entry = pending;
        pending = entry->next;
        entry->next = static_registry;
        static_registry = entry;
    }
    pthread_mutex_unlock(&static_registry_mutex);
    return 0;

failure:
    while (pending != NULL) {
        OliphauntRegisteredStaticExtension *entry = pending;
        pending = entry->next;
        free_static_registry_entries(entry, 1);
    }
    pthread_mutex_unlock(&static_registry_mutex);
    return -1;
}

int32_t oliphaunt_register_static_extensions(const OliphauntStaticExtension *extensions, size_t count) {
    OliphauntErrorScope error_scope;
    oliphaunt_error_scope_begin(&error_scope, NULL, "oliphaunt_register_static_extensions");
    int32_t rc = oliphaunt_register_static_extensions_impl(extensions, count);
    oliphaunt_error_scope_end(&error_scope, rc != 0);
    return rc;
}

const OliphauntStaticExtension *oliphaunt_static_extension_lookup(const char *filename) {
    char stem[129];
    const char *name = file_stem(filename, stem, sizeof(stem));
    size_t builtin_count = 0;
    const OliphauntStaticExtension *builtins = builtin_static_extensions(&builtin_count);
    const OliphauntStaticExtension *builtin = lookup_static_extension(builtins, builtin_count, name);
    pthread_mutex_lock(&static_registry_mutex);
    const OliphauntStaticExtension *registered = lookup_registered_static_extension(name);
    pthread_mutex_unlock(&static_registry_mutex);
    if (builtin != NULL) {
        return builtin;
    }
    return registered;
}

const void *oliphaunt_static_extension_magic(const OliphauntStaticExtension *extension) {
    if (extension == NULL || extension->magic == NULL) {
        return NULL;
    }
    return extension->magic();
}

void *oliphaunt_static_extension_symbol(const OliphauntStaticExtension *extension, const char *symbol) {
    if (extension == NULL || symbol == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < extension->symbol_count; i++) {
        if (strcmp(extension->symbols[i].name, symbol) == 0) {
            return extension->symbols[i].address;
        }
    }
    return NULL;
}

void oliphaunt_static_extension_init(const OliphauntStaticExtension *extension) {
    if (extension != NULL && extension->init != NULL) {
        extension->init();
    }
}
