#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif

#include <dlfcn.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

typedef int (*OliphauntEnsureScope)(char *error, size_t error_capacity);
typedef int (*OliphauntReadScopeValue)(void);

static void fail(const char *message, const char *detail) {
    fprintf(stderr, "%s%s%s\n", message, detail != NULL ? ": " : "", detail != NULL ? detail : "");
    exit(1);
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fail("usage: liboliphaunt_symbol_scope_host PROVIDER CONSUMER", NULL);
    }

    void *provider = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (provider == NULL) {
        fail("failed to load symbol provider locally", dlerror());
    }

    (void)dlerror();
    OliphauntEnsureScope ensure_scope =
        (OliphauntEnsureScope)dlsym(provider, "oliphaunt_ensure_extension_symbol_scope");
    const char *detail = dlerror();
    if (detail != NULL || ensure_scope == NULL) {
        fail("failed to resolve production symbol-scope helper", detail);
    }

    (void)dlerror();
    void *consumer = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
    if (consumer != NULL) {
        fail("negative control unexpectedly resolved a locally scoped provider", NULL);
    }
    if (dlerror() == NULL) {
        fail("negative control failed without a dynamic-loader diagnostic", NULL);
    }

    char error[512] = {0};
    if (ensure_scope(error, sizeof(error)) != 0) {
        fail("production symbol-scope promotion failed", error);
    }

    consumer = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
    if (consumer == NULL) {
        fail("consumer still cannot resolve the promoted provider", dlerror());
    }
    (void)dlerror();
    OliphauntReadScopeValue read_value =
        (OliphauntReadScopeValue)dlsym(consumer, "oliphaunt_scope_test_read");
    detail = dlerror();
    if (detail != NULL || read_value == NULL) {
        fail("failed to resolve consumer probe", detail);
    }
    if (read_value() != 4242) {
        fail("consumer resolved the wrong provider value", NULL);
    }

    (void)dlclose(consumer);
    (void)dlclose(provider);
    return 0;
}
