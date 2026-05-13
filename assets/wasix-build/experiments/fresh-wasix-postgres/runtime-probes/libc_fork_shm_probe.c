#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int
main(void)
{
	const char *name = "/fresh-wasix-libc-fork-shm-probe";
	int			fd;
	volatile int *slot;
	pid_t		pid;
	int			status = 0;
	int			result;

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
	pid = fork();
	if (pid < 0)
	{
		perror("fork");
		return 1;
	}
	if (pid == 0)
	{
		*slot = 42;
		_exit(0);
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 1;
	}

	printf("after_wait slot=%d status=%d exited=%d exitstatus=%d\n",
		   *slot, status, WIFEXITED(status), WIFEXITED(status) ? WEXITSTATUS(status) : -1);
	result = (*slot == 42) ? 0 : 2;
	munmap((void *) slot, 4096);
	close(fd);
	shm_unlink(name);
	return result;
}
