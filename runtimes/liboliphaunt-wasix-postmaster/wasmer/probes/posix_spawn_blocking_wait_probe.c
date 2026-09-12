#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int
main(int argc, char **argv)
{
	char *child_argv[3];
	int status;
	pid_t pid;
	int rc;

	if (argc == 2 && strcmp(argv[1], "--child") == 0)
	{
		usleep(100000);
		return 0;
	}

	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = NULL;

	rc = posix_spawn(&pid, argv[0], NULL, NULL, child_argv, environ);
	if (rc != 0)
	{
		errno = rc;
		perror("posix_spawn");
		return 1;
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 2;
	}

	printf("waitpid=%d exited=%d exitstatus=%d\n",
		   pid, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1);

	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		return 3;

	return 0;
}
