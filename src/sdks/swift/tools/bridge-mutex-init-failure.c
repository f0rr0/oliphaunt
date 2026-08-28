#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#define pthread_mutex_init oliphaunt_test_pthread_mutex_init
#define pthread_mutex_destroy oliphaunt_test_pthread_mutex_destroy
#include "../Sources/COliphaunt/bridge.c"
#undef pthread_mutex_init
#undef pthread_mutex_destroy

#include <errno.h>

static int mutex_init_calls;
static int mutex_destroy_calls;

int oliphaunt_test_pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attributes) {
    (void)mutex;
    (void)attributes;
    mutex_init_calls += 1;
    return EAGAIN;
}

int oliphaunt_test_pthread_mutex_destroy(pthread_mutex_t *mutex) {
    (void)mutex;
    mutex_destroy_calls += 1;
    return 0;
}

int main(void) {
    OliphauntConfig config = {0};
    OliphauntSession *session = (OliphauntSession *)(uintptr_t)1;
    int32_t rc = oliphaunt_swift_open(NULL, &config, &session);
    if (rc == 0 || session != NULL || mutex_init_calls != 1 || mutex_destroy_calls != 0) {
        fprintf(stderr, "Swift bridge accepted a failed session mutex initialization\n");
        return 1;
    }

    char error[256] = {0};
    char expected_status[32];
    snprintf(expected_status, sizeof(expected_status), "(%d)", EAGAIN);
    size_t required = oliphaunt_swift_copy_last_error(NULL, error, sizeof(error));
    if (required != strlen(error) ||
        strstr(error, "failed to initialize OliphauntSession error mutex") == NULL ||
        strstr(error, expected_status) == NULL) {
        fprintf(stderr, "Swift bridge did not preserve the mutex failure: %s\n", error);
        return 1;
    }

    puts("Swift bridge mutex initialization failure handling passed");
    return 0;
}
