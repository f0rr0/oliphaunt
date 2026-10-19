/*
 * WASIX core PostgreSQL port header.
 *
 * Keep this file factual and small. If PostgreSQL needs a semantic change,
 * add a narrow patch with an acceptance report rather than hiding it here.
 */
#ifndef PG_PORT_WASIX_CORE_H
#define PG_PORT_WASIX_CORE_H

#include <errno.h>
#include <sys/types.h>

#define PLATFORM_DEFAULT_WAL_SYNC_METHOD WAL_SYNC_METHOD_FDATASYNC

#ifndef MAP_HASSEMAPHORE
#define MAP_HASSEMAPHORE 0
#endif

#ifndef MAP_NOSYNC
#define MAP_NOSYNC 0
#endif

static inline pid_t
pg_wasix_fork(void)
{
	/* PostgreSQL's supported child path is vfork() followed by execv(). */
	errno = ENOTSUP;
	return -1;
}

#define fork pg_wasix_fork

#endif
