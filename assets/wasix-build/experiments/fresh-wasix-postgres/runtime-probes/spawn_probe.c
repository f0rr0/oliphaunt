#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wasi/api_wasix.h>

#undef stdout

extern char **environ;

int
main(int argc, char **argv)
{
	pid_t pid;
	int status;
	int rc;
	int pipefd[2];
	posix_spawn_file_actions_t actions;
	char *child_argv[3];

	if (argc < 2)
	{
		fprintf(stderr, "usage: spawn_probe /path/to/program\n");
		return 2;
	}

	child_argv[0] = argv[1];
	child_argv[1] = "-V";
	child_argv[2] = NULL;

	if (argc >= 3 && strcmp(argv[2], "raw") == 0)
	{
		__wasi_process_handles_t handles;
		__wasi_errno_t wasi_rc;
		__wasi_option_pid_t join_pid;
		__wasi_join_status_t join_status;
		char args[4096];

		snprintf(args, sizeof(args), "%s\n-V", argv[1]);
		wasi_rc = __wasi_proc_spawn(argv[1], 0, args, "",
									__WASI_STDIO_MODE_NULL,
									__WASI_STDIO_MODE_PIPED,
									__WASI_STDIO_MODE_INHERIT,
									".", &handles);
		if (wasi_rc != 0)
		{
			fprintf(stderr, "__wasi_proc_spawn failed: %d\n", wasi_rc);
			return 1;
		}

		printf("spawned pid %d stdout tag %d fd %d\n",
			   (int) handles.pid,
			   (int) handles.stdout.tag,
			   (int) handles.stdout.u.some);
		if (handles.stdout.tag)
		{
			char buf[256];
			ssize_t n;

			while ((n = read(handles.stdout.u.some, buf, sizeof(buf))) > 0)
				(void) write(STDOUT_FILENO, buf, n);
			close(handles.stdout.u.some);
		}

		join_pid.tag = 1;
		join_pid.u.some = handles.pid;
		wasi_rc = __wasi_proc_join(&join_pid, 0, &join_status);
		if (wasi_rc != 0)
		{
			fprintf(stderr, "__wasi_proc_join failed: %d\n", wasi_rc);
			return 1;
		}
		printf("join tag %d normal %d\n",
			   (int) join_status.tag,
			   (int) join_status.u.exit_normal);
		return join_status.tag == __WASI_JOIN_STATUS_TYPE_EXIT_NORMAL &&
			join_status.u.exit_normal == 0 ? 0 : 1;
	}
	else if (argc >= 3 && strcmp(argv[2], "pipe") == 0)
	{
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
			(rc = posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)) != 0 ||
			(rc = posix_spawn_file_actions_addclose(&actions, pipefd[0])) != 0 ||
			(rc = posix_spawn_file_actions_addclose(&actions, pipefd[1])) != 0)
		{
			errno = rc;
			fprintf(stderr, "file action failed: %s (%d)\n", strerror(errno), rc);
			return 1;
		}
		rc = posix_spawn(&pid, argv[1], &actions, NULL, child_argv, environ);
		posix_spawn_file_actions_destroy(&actions);
		close(pipefd[1]);
	}
	else
		rc = posix_spawn(&pid, argv[1], NULL, NULL, child_argv, environ);
	if (rc != 0)
	{
		errno = rc;
		fprintf(stderr, "posix_spawn failed: %s (%d)\n", strerror(errno), rc);
		return 1;
	}

	printf("spawned pid %d\n", (int) pid);
	if (argc >= 3 && strcmp(argv[2], "pipe") == 0)
	{
		char buf[256];
		ssize_t n;

		while ((n = read(pipefd[0], buf, sizeof(buf))) > 0)
			(void) write(STDOUT_FILENO, buf, n);
		close(pipefd[0]);
	}
	if (waitpid(pid, &status, 0) < 0)
	{
		perror("waitpid");
		return 1;
	}

	printf("status %d\n", status);
	return status == 0 ? 0 : 1;
}
