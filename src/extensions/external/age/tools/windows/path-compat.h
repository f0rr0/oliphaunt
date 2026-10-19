#ifndef OLIPHAUNT_AGE_WINDOWS_PATH_COMPAT_H
#define OLIPHAUNT_AGE_WINDOWS_PATH_COMPAT_H

#include <stdlib.h>
#include <string.h>
#include <windows.h>

/* Resolve actual filesystem objects, including junctions; _fullpath is only lexical. */
static char *oliphaunt_age_windows_realpath(const char *path)
{
    HANDLE handle;
    DWORD size;
    DWORD written;
    char *resolved;

    handle = CreateFileA(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (handle == INVALID_HANDLE_VALUE)
        return NULL;
    size = GetFinalPathNameByHandleA(handle, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (size == 0)
    {
        CloseHandle(handle);
        return NULL;
    }
    resolved = malloc(size);
    if (resolved == NULL)
    {
        CloseHandle(handle);
        return NULL;
    }
    written = GetFinalPathNameByHandleA(handle, resolved, size,
                                      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    CloseHandle(handle);
    if (written == 0 || written >= size)
    {
        free(resolved);
        return NULL;
    }
    return resolved;
}

static int oliphaunt_age_windows_path_below(const char *resolved, const char *directory)
{
    char *base = oliphaunt_age_windows_realpath(directory);
    size_t length;
    int contained;

    if (base == NULL)
        return 0;
    length = strlen(base);
    while (length > 0 && (base[length - 1] == '\\' || base[length - 1] == '/'))
        length--;
    /* Exact canonical spelling also fails closed on case-sensitive Windows directories. */
    contained = strlen(resolved) > length && strncmp(resolved, base, length) == 0 &&
                (resolved[length] == '\\' || resolved[length] == '/');
    free(base);
    return contained;
}

#endif
