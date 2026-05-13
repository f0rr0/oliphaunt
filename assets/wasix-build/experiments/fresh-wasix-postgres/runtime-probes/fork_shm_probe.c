#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wasi/api_wasix.h>

int
main(void)
{
	const char *name = "/fresh-wasix-fork-shm-probe";
	int			fd;
	volatile int *slot;
	__wasi_pid_t pid = 0;
	__wasi_errno_t rc;
	__wasi_option_pid_t join_pid;
	__wasi_join_status_t status;

	shm_unlink(name);
	fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
	if (fd < 0)
	{
		perror("shm_open");
		return 1;
	}
	if (ftruncate(fd, 4096) < 0)
	{
		perror("ftruncate");
		return 1;
	}

	slot = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (slot == MAP_FAILED)
	{
		perror("mmap");
		return 1;
	}

	*slot = 7;
	rc = __wasi_proc_fork(1, &pid);
	if (rc != 0)
	{
		printf("proc_fork failed rc=%u\n", rc);
		return 1;
	}

	if (pid == 0)
	{
		*slot = 42;
		_exit(0);
	}

	join_pid.tag = __WASI_OPTION_SOME;
	join_pid.u.some = pid;
	rc = __wasi_proc_join(&join_pid, 0, &status);
	if (rc != 0)
	{
		printf("proc_join failed rc=%u\n", rc);
		return 1;
	}

	printf("after_join slot=%d status_tag=%u\n", *slot, status.tag);
	rc = (*slot == 42) ? 0 : 2;
	munmap((void *) slot, 4096);
	close(fd);
	shm_unlink(name);
	return rc;
}
