/*
 * fork_process.c
 *	 WASIX-aware wrapper for PostgreSQL postmaster fork.
 *
 * WASIX exposes fork as __wasi_proc_fork(copy_memory, &pid). The libc fork()
 * prototype is hidden when wasm exception handling is enabled, so call the
 * WASIX primitive directly rather than adding a fake fork shim.
 */
#include "postgres.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#include <wasi/api_wasix.h>

#include "libpq/pqsignal.h"
#include "miscadmin.h"
#include "postmaster/fork_process.h"

#ifndef WIN32
pid_t
fork_process(void)
{
	pid_t		result;
	const char *oomfilename;
	sigset_t	save_mask;

#ifdef LINUX_PROFILE
	struct itimerval prof_itimer;
#endif

	fflush(NULL);

#ifdef LINUX_PROFILE
	getitimer(ITIMER_PROF, &prof_itimer);
#endif

	sigprocmask(SIG_SETMASK, &BlockSig, &save_mask);
	{
		__wasi_pid_t wasi_pid = 0;
		__wasi_errno_t wasi_errno;

		wasi_errno = __wasi_proc_fork(1, &wasi_pid);
		if (wasi_errno != 0)
		{
			errno = wasi_errno;
			result = -1;
		}
		else
			result = (pid_t) wasi_pid;
	}

	if (result == 0)
	{
		MyProcPid = getpid();
#ifdef LINUX_PROFILE
		setitimer(ITIMER_PROF, &prof_itimer, NULL);
#endif

		oomfilename = getenv("PG_OOM_ADJUST_FILE");

		if (oomfilename != NULL)
		{
			int			fd = open(oomfilename, O_WRONLY, 0);

			if (fd >= 0)
			{
				const char *oomvalue = getenv("PG_OOM_ADJUST_VALUE");
				int			rc;

				if (oomvalue == NULL)
					oomvalue = "0";

				rc = write(fd, oomvalue, strlen(oomvalue));
				(void) rc;
				close(fd);
			}
		}

		pg_strong_random_init();
	}
	else
		sigprocmask(SIG_SETMASK, &save_mask, NULL);

	return result;
}

#endif							/* ! WIN32 */
