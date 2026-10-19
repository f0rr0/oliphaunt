#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t got_sigchld;

static void
sigchld_handler(int signo)
{
	(void) signo;
	got_sigchld = 1;
}

int
main(int argc, char **argv)
{
	struct sigaction action;
	char *child_argv[3];
	int status;
	pid_t pid;
	int rc;

	if (argc == 2 && strcmp(argv[1], "--child") == 0)
		return 0;

	memset(&action, 0, sizeof(action));
	action.sa_handler = sigchld_handler;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGCHLD, &action, NULL) != 0)
	{
		perror("sigaction SIGCHLD");
		return 1;
	}

	child_argv[0] = argv[0];
	child_argv[1] = "--child";
	child_argv[2] = NULL;

	rc = posix_spawn(&pid, argv[0], NULL, NULL, child_argv, environ);
	if (rc != 0)
	{
		errno = rc;
		perror("posix_spawn");
		return 2;
	}

	for (int i = 0; i < 200 && !got_sigchld; i++)
		usleep(10000);

	rc = waitpid(pid, &status, WNOHANG);
	if (rc < 0)
	{
		perror("waitpid WNOHANG");
		return 3;
	}
	if (rc == 0)
	{
		printf("child not reapable after wait: got_sigchld=%ld\n", (long) got_sigchld);
		return 4;
	}

	printf("got_sigchld=%ld waitpid=%d exited=%d exitstatus=%d\n",
		   (long) got_sigchld, rc, WIFEXITED(status),
		   WIFEXITED(status) ? WEXITSTATUS(status) : -1);

	if (!got_sigchld)
		return 5;
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		return 6;

	return 0;
}
