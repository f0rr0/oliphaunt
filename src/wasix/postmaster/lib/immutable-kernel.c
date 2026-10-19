/* Stable Node-API entry points; this tiny Linux ioctl binding needs no SDK headers. */
#include <errno.h>
#include <linux/fs.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern int napi_get_value_int32(napi_env, napi_value, int32_t *);
extern int napi_get_value_uint32(napi_env, napi_value, uint32_t *);
extern int napi_create_uint32(napi_env, uint32_t, napi_value *);
extern int napi_throw_error(napi_env, const char *, const char *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);

static napi_value flags(napi_env env, napi_callback_info info) {
    napi_value args[2], result;
    size_t count = 2;
    void *operation;
    int32_t fd;
    uint32_t value = 0;
    if (napi_get_cb_info(env, info, &count, args, NULL, &operation) ||
        count != ((uintptr_t)operation == FS_IOC_SETFLAGS ? 2u : 1u) ||
        napi_get_value_int32(env, args[0], &fd) || fd < 0 ||
        (count == 2 && napi_get_value_uint32(env, args[1], &value))) {
        napi_throw_error(env, NULL, "invalid immutable ioctl arguments");
        return NULL;
    }
    if (ioctl(fd, (unsigned long)(uintptr_t)operation, &value) < 0) {
        napi_throw_error(env, NULL, strerror(errno));
        return NULL;
    }
    if (napi_create_uint32(env, value, &result)) return NULL;
    return result;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value get, set;
    if (napi_create_function(env, "getFlags", 8, flags, (void *)(uintptr_t)FS_IOC_GETFLAGS, &get) ||
        napi_create_function(env, "setFlags", 8, flags, (void *)(uintptr_t)FS_IOC_SETFLAGS, &set) ||
        napi_set_named_property(env, exports, "getFlags", get) ||
        napi_set_named_property(env, exports, "setFlags", set)) return NULL;
    return exports;
}
