#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void)
{
	errno = 0;
	pid_t pid = fork();
	if (pid == 0) {
		_exit(0);
	}
	if (pid > 0) {
		int status = 0;
		pid_t waited = waitpid(pid, &status, 0);
		if (waited != pid) {
			perror("waitpid(child)");
			return 10;
		}
		if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
			fprintf(stderr, "child status was not clean exit: 0x%x\n", status);
			return 11;
		}
		puts("libc EH fork succeeded");
		return 0;
	}

	int fork_errno = errno;
	if (fork_errno != ENOTSUP && fork_errno != ENOSYS) {
		fprintf(stderr, "fork failed with unexpected errno=%d\n", fork_errno);
		return 20;
	}

	errno = 0;
	int status = 0;
	pid_t waited = waitpid(-1, &status, WNOHANG);
	if (waited != -1 || errno != ECHILD) {
		fprintf(stderr,
			"fork failure left observable child state: waitpid=%d errno=%d status=0x%x\n",
			(int)waited, errno, status);
		return 21;
	}

	printf("libc EH fork cleanly unsupported errno=%d\n", fork_errno);
	return 0;
}
