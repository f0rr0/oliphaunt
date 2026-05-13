#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int
main(void)
{
	const char *name = "/wasix-upstream-libc-fork-shared-probe";
	volatile int *slot;
	int status = 0;
	pid_t pid;
	int fd;

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
		return 10;
	}
	if (pid == 0)
	{
		*slot = 42;
		_exit(0);
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 11;
	}

	printf("after_wait slot=%d status=%d exited=%d exitstatus=%d\n",
		   *slot, status, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1);
	return *slot == 42 ? 0 : 12;
}
