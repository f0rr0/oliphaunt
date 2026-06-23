#include "liboliphaunt_internal.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

typedef struct OliphauntRegisteredStaticExtension {
    OliphauntStaticExtension extension;
    OliphauntStaticExtensionSymbol *symbols;
    char *name;
    char **symbol_names;
} OliphauntRegisteredStaticExtension;

static pthread_mutex_t static_registry_mutex = PTHREAD_MUTEX_INITIALIZER;
static OliphauntRegisteredStaticExtension *static_registry = NULL;
static size_t static_registry_count = 0;
static bool static_registry_frozen = false;

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
    for (size_t i = 0; i < static_registry_count; i++) {
        if (strcmp(static_registry[i].extension.name, name) == 0) {
            return &static_registry[i].extension;
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
            if (!is_portable_static_name(extension->symbols[j].name) ||
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

static bool static_registry_matches(const OliphauntStaticExtension *extensions, size_t count) {
    if (static_registry_count != count) {
        return false;
    }
    for (size_t i = 0; i < count; i++) {
        const OliphauntStaticExtension *existing = &static_registry[i].extension;
        const OliphauntStaticExtension *incoming = &extensions[i];
        if (strcmp(existing->name, incoming->name) != 0 ||
            existing->magic != incoming->magic ||
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
    }
    return true;
}

int32_t oliphaunt_register_static_extensions(const OliphauntStaticExtension *extensions, size_t count) {
    if (validate_static_extensions(extensions, count) != 0) {
        return -1;
    }
    pthread_mutex_lock(&static_registry_mutex);
    if (static_registry_frozen && static_registry_matches(extensions, count)) {
        pthread_mutex_unlock(&static_registry_mutex);
        return 0;
    }
    pthread_mutex_unlock(&static_registry_mutex);

    OliphauntRegisteredStaticExtension *new_entries = NULL;
    if (copy_static_extensions(extensions, count, &new_entries) != 0) {
        return -1;
    }

    pthread_mutex_lock(&static_registry_mutex);
    if (static_registry_frozen) {
        pthread_mutex_unlock(&static_registry_mutex);
        free_static_registry_entries(new_entries, count);
        set_error(NULL, "static extension registry cannot be changed after backend startup");
        return -1;
    }
    OliphauntRegisteredStaticExtension *old_entries = static_registry;
    size_t old_count = static_registry_count;
    static_registry = new_entries;
    static_registry_count = count;
    pthread_mutex_unlock(&static_registry_mutex);

    free_static_registry_entries(old_entries, old_count);
    return 0;
}

const OliphauntStaticExtension *oliphaunt_static_extension_lookup(const char *filename) {
    char stem[129];
    const char *name = file_stem(filename, stem, sizeof(stem));
    size_t builtin_count = 0;
    const OliphauntStaticExtension *builtins = builtin_static_extensions(&builtin_count);
    const OliphauntStaticExtension *builtin = lookup_static_extension(builtins, builtin_count, name);
    pthread_mutex_lock(&static_registry_mutex);
    static_registry_frozen = true;
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
