#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile int parent_private_value = 7;
static volatile sig_atomic_t got_sigchld = 0;

static void
on_sigchld(int signum)
{
	(void) signum;
	got_sigchld = 1;
}

int
main(int argc, char **argv)
{
	char *child_argv[3];
	struct sigaction sa;
	int status = 0;
	pid_t pid;

	if (argc == 2 && strcmp(argv[1], "--child") == 0)
		return 0;

	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = on_sigchld;
	sigemptyset(&sa.sa_mask);
	if (sigaction(SIGCHLD, &sa, NULL) < 0)
	{
		perror("sigaction");
		return 1;
	}

	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = NULL;

	pid = vfork();
	if (pid < 0)
	{
		perror("vfork");
		return 1;
	}

	if (pid == 0)
	{
		execve(argv[0], child_argv, environ);
		perror("execve");
		_exit(127);
	}

	for (int i = 0; i < 200 && !got_sigchld; i++)
		usleep(10000);

	if (!got_sigchld)
	{
		fprintf(stderr, "SIGCHLD was not delivered for vfork+exec child\n");
		return 2;
	}

	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 3;
	}

	printf("vfork_pid=%d exited=%d exitstatus=%d parent_value=%d\n",
		   (int) pid,
		   WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1,
		   parent_private_value);

	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		return 4;
	if (parent_private_value != 7)
		return 5;

	return 0;
}
