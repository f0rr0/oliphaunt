#ifndef OLIPHAUNT_PLATFORM_H
#define OLIPHAUNT_PLATFORM_H

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif

#include <direct.h>
#include <fcntl.h>
#include <io.h>
#include <limits.h>
#include <process.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <windows.h>

#ifndef OLIPHAUNT_PLATFORM_EXTERNAL_POSIX_SHIMS
typedef SSIZE_T ssize_t;
typedef int mode_t;
typedef int uid_t;
typedef int gid_t;

#ifndef PATH_MAX
#define PATH_MAX MAX_PATH
#endif

#ifndef S_ISDIR
#define S_ISDIR(mode) (((mode) & _S_IFDIR) != 0)
#endif

#ifndef S_ISREG
#define S_ISREG(mode) (((mode) & _S_IFREG) != 0)
#endif

#ifndef S_ISLNK
#define S_ISLNK(mode) 0
#endif
#endif

#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif

#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 1
#endif

#ifndef OLIPHAUNT_PLATFORM_EXTERNAL_POSIX_SHIMS
#ifndef PTHREAD_STACK_MIN
#define PTHREAD_STACK_MIN (64 * 1024)
#endif

#define strdup _strdup
#define open _open
#define read _read
#define write _write
#define close _close
#define access _access
#define unlink _unlink
#define rmdir _rmdir
#define getcwd _getcwd
#define getpid _getpid
#define mkdir(path, mode) _mkdir(path)
#define stat _stat64
#define lstat _stat64
#ifndef X_OK
#define X_OK 0
#endif
#ifndef O_CLOEXEC
#define O_CLOEXEC _O_NOINHERIT
#endif

static inline int oliphaunt_fchmod(int fd, mode_t mode) {
    (void)fd;
    (void)mode;
    return 0;
}

#define fchmod oliphaunt_fchmod
#endif

typedef SRWLOCK pthread_mutex_t;
typedef CONDITION_VARIABLE pthread_cond_t;
typedef INIT_ONCE pthread_once_t;
typedef HANDLE pthread_t;

typedef struct pthread_attr_t {
    size_t stack_size;
} pthread_attr_t;

#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
#define PTHREAD_COND_INITIALIZER CONDITION_VARIABLE_INIT
#define PTHREAD_ONCE_INIT INIT_ONCE_STATIC_INIT

static inline int pthread_mutex_init(pthread_mutex_t *mutex, void *attr) {
    (void)attr;
    InitializeSRWLock(mutex);
    return 0;
}

static inline int pthread_mutex_destroy(pthread_mutex_t *mutex) {
    (void)mutex;
    return 0;
}

static inline int pthread_mutex_lock(pthread_mutex_t *mutex) {
    AcquireSRWLockExclusive(mutex);
    return 0;
}

static inline int pthread_mutex_unlock(pthread_mutex_t *mutex) {
    ReleaseSRWLockExclusive(mutex);
    return 0;
}

static inline int pthread_cond_init(pthread_cond_t *cond, void *attr) {
    (void)attr;
    InitializeConditionVariable(cond);
    return 0;
}

static inline int pthread_cond_destroy(pthread_cond_t *cond) {
    (void)cond;
    return 0;
}

static inline int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
    return SleepConditionVariableSRW(cond, mutex, INFINITE, 0) ? 0 : (int)GetLastError();
}

static BOOL CALLBACK oliphaunt_win_init_qpc_frequency(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once;
    (void)context;
    return QueryPerformanceFrequency((LARGE_INTEGER *)parameter);
}

static inline int oliphaunt_clock_gettime(int clock_id, struct timespec *ts) {
    if (clock_id == CLOCK_MONOTONIC) {
        static LARGE_INTEGER frequency;
        static INIT_ONCE frequency_once = INIT_ONCE_STATIC_INIT;
        LARGE_INTEGER counter;
        if (!InitOnceExecuteOnce(&frequency_once, oliphaunt_win_init_qpc_frequency, &frequency, NULL) ||
            !QueryPerformanceCounter(&counter)) {
            return -1;
        }
        ts->tv_sec = (time_t)(counter.QuadPart / frequency.QuadPart);
        ts->tv_nsec = (long)(((counter.QuadPart % frequency.QuadPart) * 1000000000LL) / frequency.QuadPart);
        return 0;
    }
    return timespec_get(ts, TIME_UTC) == TIME_UTC ? 0 : -1;
}

static inline DWORD oliphaunt_deadline_to_timeout_ms(const struct timespec *deadline) {
    struct timespec now;
    if (deadline == NULL || oliphaunt_clock_gettime(CLOCK_REALTIME, &now) != 0) {
        return INFINITE;
    }
    int64_t seconds = (int64_t)deadline->tv_sec - (int64_t)now.tv_sec;
    int64_t nanoseconds = (int64_t)deadline->tv_nsec - (int64_t)now.tv_nsec;
    int64_t milliseconds = seconds * 1000 + nanoseconds / 1000000;
    if (nanoseconds > 0 && milliseconds == 0) {
        milliseconds = 1;
    }
    if (milliseconds <= 0) {
        return 0;
    }
    if (milliseconds > (int64_t)0x7fffffff) {
        return 0x7fffffff;
    }
    return (DWORD)milliseconds;
}

static inline int pthread_cond_timedwait(
    pthread_cond_t *cond,
    pthread_mutex_t *mutex,
    const struct timespec *deadline) {
    DWORD timeout_ms = oliphaunt_deadline_to_timeout_ms(deadline);
    if (SleepConditionVariableSRW(cond, mutex, timeout_ms, 0)) {
        return 0;
    }
    DWORD error = GetLastError();
    return error == ERROR_TIMEOUT ? ETIMEDOUT : (int)error;
}

static inline int pthread_cond_broadcast(pthread_cond_t *cond) {
    WakeAllConditionVariable(cond);
    return 0;
}

static inline int pthread_attr_init(pthread_attr_t *attr) {
    attr->stack_size = 0;
    return 0;
}

static inline int pthread_attr_destroy(pthread_attr_t *attr) {
    (void)attr;
    return 0;
}

static inline int pthread_attr_setstacksize(pthread_attr_t *attr, size_t stack_size) {
    attr->stack_size = stack_size;
    return 0;
}

typedef struct OliphauntWinThreadStart {
    void *(*start)(void *);
    void *arg;
} OliphauntWinThreadStart;

static unsigned __stdcall oliphaunt_win_thread_main(void *arg) {
    OliphauntWinThreadStart *state = (OliphauntWinThreadStart *)arg;
    void *(*start)(void *) = state->start;
    void *start_arg = state->arg;
    free(state);
    (void)start(start_arg);
    return 0;
}

static inline int pthread_create(
    pthread_t *thread,
    const pthread_attr_t *attr,
    void *(*start)(void *),
    void *arg) {
    OliphauntWinThreadStart *state = (OliphauntWinThreadStart *)calloc(1, sizeof(*state));
    if (state == NULL) {
        return ENOMEM;
    }
    state->start = start;
    state->arg = arg;
    uintptr_t handle = _beginthreadex(
        NULL,
        attr != NULL ? (unsigned)attr->stack_size : 0,
        oliphaunt_win_thread_main,
        state,
        0,
        NULL);
    if (handle == 0) {
        int rc = errno != 0 ? errno : EINVAL;
        free(state);
        return rc;
    }
    *thread = (HANDLE)handle;
    return 0;
}

static inline int pthread_join(pthread_t thread, void **value_ptr) {
    (void)value_ptr;
    if (thread == NULL) {
        return EINVAL;
    }
    DWORD rc = WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
    return rc == WAIT_OBJECT_0 ? 0 : (int)GetLastError();
}

static BOOL CALLBACK oliphaunt_win_once_callback(
    PINIT_ONCE once,
    PVOID parameter,
    PVOID *context) {
    (void)once;
    (void)context;
    void (*callback)(void) = (void (*)(void))parameter;
    callback();
    return TRUE;
}

static inline int pthread_once(pthread_once_t *once, void (*callback)(void)) {
    return InitOnceExecuteOnce(once, oliphaunt_win_once_callback, (PVOID)callback, NULL)
               ? 0
               : (int)GetLastError();
}

static inline int oliphaunt_setenv(const char *name, const char *value, int overwrite) {
    if (!overwrite) {
        size_t required = 0;
        getenv_s(&required, NULL, 0, name);
        if (required > 0) {
            return 0;
        }
    }
    return _putenv_s(name, value != NULL ? value : "");
}

static inline int oliphaunt_unsetenv(const char *name) {
    return _putenv_s(name, "");
}

static inline char *oliphaunt_realpath(const char *path, char *resolved) {
    DWORD required = GetFullPathNameA(path, 0, NULL, NULL);
    if (required == 0) {
        return NULL;
    }
    char *buffer = resolved != NULL ? resolved : (char *)malloc(required);
    if (buffer == NULL) {
        errno = ENOMEM;
        return NULL;
    }
    DWORD written = GetFullPathNameA(path, required, buffer, NULL);
    if (written == 0 || written >= required) {
        if (resolved == NULL) {
            free(buffer);
        }
        return NULL;
    }
    return buffer;
}

#ifndef OLIPHAUNT_PLATFORM_EXTERNAL_POSIX_SHIMS
#define setenv oliphaunt_setenv
#define unsetenv oliphaunt_unsetenv
#define realpath oliphaunt_realpath
#define clock_gettime oliphaunt_clock_gettime
#endif

#define LOCK_EX 1
#define LOCK_NB 2
#define LOCK_UN 4

static inline int flock(int fd, int operation) {
    intptr_t os_handle = _get_osfhandle(fd);
    if (os_handle == -1) {
        errno = EBADF;
        return -1;
    }
    HANDLE handle = (HANDLE)os_handle;
    OVERLAPPED overlapped;
    memset(&overlapped, 0, sizeof(overlapped));
    if ((operation & LOCK_UN) != 0) {
        if (UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &overlapped)) {
            return 0;
        }
    } else {
        DWORD flags = 0;
        if ((operation & LOCK_EX) != 0) {
            flags |= LOCKFILE_EXCLUSIVE_LOCK;
        }
        if ((operation & LOCK_NB) != 0) {
            flags |= LOCKFILE_FAIL_IMMEDIATELY;
        }
        if (LockFileEx(handle, flags, 0, MAXDWORD, MAXDWORD, &overlapped)) {
            return 0;
        }
    }
    DWORD error = GetLastError();
    errno = error == ERROR_LOCK_VIOLATION ? EWOULDBLOCK : EACCES;
    return -1;
}

#else

#include <pthread.h>
#include <signal.h>
#include <sys/types.h>

#endif

#endif
