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
	int status = 1234;
	pid_t pid;
	pid_t rc;
	int spawn_rc;

	if (argc == 2 && strcmp(argv[1], "--child") == 0)
	{
		usleep(300000);
		return 7;
	}

	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = NULL;

	spawn_rc = posix_spawn(&pid, argv[0], NULL, NULL, child_argv, environ);
	if (spawn_rc != 0)
	{
		errno = spawn_rc;
		perror("posix_spawn");
		return 1;
	}

	rc = waitpid(pid, &status, WNOHANG);
	if (rc != 0)
	{
		fprintf(stderr, "waitpid(pid, WNOHANG) returned %d status=%d errno=%d\n",
				rc, status, errno);
		return 2;
	}
	if (status != 0)
	{
		fprintf(stderr, "waitpid(pid, WNOHANG) left status=%d\n", status);
		return 3;
	}

	status = 1234;
	rc = waitpid(-1, &status, WNOHANG);
	if (rc != 0)
	{
		fprintf(stderr, "waitpid(-1, WNOHANG) returned %d status=%d errno=%d\n",
				rc, status, errno);
		return 4;
	}
	if (status != 0)
	{
		fprintf(stderr, "waitpid(-1, WNOHANG) left status=%d\n", status);
		return 5;
	}

	rc = waitpid(pid, &status, 0);
	if (rc != pid)
	{
		fprintf(stderr, "waitpid(pid, 0) returned %d expected %d errno=%d\n",
				rc, pid, errno);
		return 6;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 7)
	{
		fprintf(stderr, "unexpected child status=%d exited=%d exitstatus=%d\n",
				status, WIFEXITED(status),
				WIFEXITED(status) ? WEXITSTATUS(status) : -1);
		return 7;
	}

	printf("waitpid-wnohang-any ok pid=%d\n", pid);
	return 0;
}
