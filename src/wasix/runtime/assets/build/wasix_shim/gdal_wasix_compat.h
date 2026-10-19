#ifndef OLIPHAUNT_GDAL_WASIX_COMPAT_H
#define OLIPHAUNT_GDAL_WASIX_COMPAT_H

#include <errno.h>
#include <sys/types.h>

/*
 * GDAL's process-spawn portability layer unconditionally compiles its
 * fork-based fallback on non-Windows targets. WASIX intentionally does not
 * expose fork(2), and PostGIS raster does not use GDAL's subprocess helpers.
 * Keep the API's normal failure behavior while making that unused fallback
 * portable to the WASIX libc.
 */
static inline pid_t oliphaunt_gdal_wasix_fork_unavailable(void)
{
    errno = ENOSYS;
    return -1;
}

#define fork oliphaunt_gdal_wasix_fork_unavailable

#endif
