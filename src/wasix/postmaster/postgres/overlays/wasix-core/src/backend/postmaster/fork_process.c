/*
 * fork_process.c
 *	 Fail-closed fork wrapper for the WASIX EXEC_BACKEND build.
 *
 * The selected postmaster path uses vfork() followed immediately by execv().
 * Full address-space cloning is outside this runtime's process model.
 */
#include "postgres.h"

#include <errno.h>

#include "postmaster/fork_process.h"

#ifndef WIN32
pid_t
fork_process(void)
{
	errno = ENOTSUP;
	return -1;
}

#endif							/* ! WIN32 */
