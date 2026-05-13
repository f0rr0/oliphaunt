#include <stdio.h>
#include <unistd.h>
#include <wasi/api_wasix.h>

int
main(void)
{
	__wasi_join_status_t status;
	__wasi_option_pid_t join_pid;
	__wasi_pid_t pid = 0;
	__wasi_errno_t rc;

	rc = __wasi_proc_fork(1, &pid);
	if (rc != 0)
	{
		printf("proc_fork failed rc=%u\n", rc);
		return 10;
	}

	if (pid == 0)
		_exit(0);

	join_pid.tag = __WASI_OPTION_SOME;
	join_pid.u.some = pid;
	rc = __wasi_proc_join(&join_pid, 0, &status);
	if (rc != 0)
	{
		printf("proc_join failed rc=%u\n", rc);
		return 11;
	}

	printf("joined pid=%u status_tag=%u\n", pid, status.tag);
	return 0;
}
