#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int
child_main(void)
{
	puts("child-pipe-ok");
	fflush(stdout);
	return 0;
}

int
main(int argc, char **argv)
{
	posix_spawn_file_actions_t actions;
	char buf[128];
	char output[256];
	char *child_argv[3];
	ssize_t nread;
	size_t used = 0;
	pid_t pid;
	int pipefd[2];
	int status = 0;
	int rc;

	if (argc > 1 && strcmp(argv[1], "--child") == 0)
		return child_main();

	if (pipe(pipefd) != 0)
	{
		perror("pipe");
		return 1;
	}

	rc = posix_spawn_file_actions_init(&actions);
	if (rc != 0)
	{
		errno = rc;
		perror("posix_spawn_file_actions_init");
		return 1;
	}

	if ((rc = posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDOUT_FILENO)) != 0 ||
		(rc = posix_spawn_file_actions_addclose(&actions, pipefd[0])) != 0 ||
		(rc = posix_spawn_file_actions_addclose(&actions, pipefd[1])) != 0)
	{
		errno = rc;
		fprintf(stderr, "file action failed: %s (%d)\n", strerror(errno), rc);
		return 1;
	}

	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = NULL;
	rc = posix_spawn(&pid, argv[0], &actions, NULL, child_argv, environ);
	posix_spawn_file_actions_destroy(&actions);
	close(pipefd[1]);
	if (rc != 0)
	{
		errno = rc;
		fprintf(stderr, "posix_spawn failed: %s (%d)\n", strerror(errno), rc);
		return 10;
	}

	memset(output, 0, sizeof(output));
	while ((nread = read(pipefd[0], buf, sizeof(buf))) > 0)
	{
		size_t copy = (size_t) nread;

		if (copy > sizeof(output) - used - 1)
			copy = sizeof(output) - used - 1;
		memcpy(output + used, buf, copy);
		used += copy;
	}
	close(pipefd[0]);

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 11;
	}

	printf("captured=%s", output);
	printf("status=%d exited=%d exitstatus=%d\n",
		   status, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1);

	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		return 12;
	if (strcmp(output, "child-pipe-ok\n") != 0)
		return 13;
	return 0;
}
