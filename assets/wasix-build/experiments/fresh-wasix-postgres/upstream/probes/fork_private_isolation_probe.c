#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int global_slot = 7;

int
main(void)
{
	int stack_slot = 7;
	int status = 0;
	pid_t pid;

	pid = fork();
	if (pid < 0)
	{
		perror("fork");
		return 1;
	}
	if (pid == 0)
	{
		global_slot = 42;
		stack_slot = 42;
		_exit(0);
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 2;
	}

	printf("global=%d stack=%d status=%d exited=%d exitstatus=%d\n",
		   global_slot, stack_slot, status, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1);

	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		return 3;
	return global_slot == 7 && stack_slot == 7 ? 0 : 10;
}
