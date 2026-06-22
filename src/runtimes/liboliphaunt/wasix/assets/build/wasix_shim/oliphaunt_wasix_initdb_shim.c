#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__has_include)
#if __has_include("pg_config.h")
#include "pg_config.h"
#endif
#endif

#ifndef PG_VERSION
#define PG_VERSION "unknown"
#endif

#define OLIPHAUNT_UID 123

extern char **environ;
extern int pg_char_to_encoding_private(const char *name);
extern const char *pg_encoding_to_char_private(int encoding);

typedef struct LocalePipe
{
	FILE *file;
	struct LocalePipe *next;
} LocalePipe;

typedef struct ChildPipe
{
	FILE *file;
	pid_t pid;
	struct ChildPipe *next;
} ChildPipe;

typedef struct CommandSpec
{
	char **argv;
	int argc;
	char *stdin_path;
	char *stdout_path;
	bool stderr_to_stdout;
} CommandSpec;

static LocalePipe *locale_pipes;
static ChildPipe *child_pipes;

static void
free_command_spec(CommandSpec *spec)
{
	if (spec == NULL)
		return;
	if (spec->argv)
	{
		for (int i = 0; i < spec->argc; i++)
			free(spec->argv[i]);
		free(spec->argv);
	}
	free(spec->stdin_path);
	free(spec->stdout_path);
	memset(spec, 0, sizeof(*spec));
}

static char *
read_command_token(const char **cursor)
{
	const char *p = *cursor;
	while (*p == ' ' || *p == '\t' || *p == '\n')
		p++;
	if (*p == '\0')
	{
		*cursor = p;
		return NULL;
	}

	char quote = 0;
	if (*p == '\'' || *p == '"')
		quote = *p++;

	size_t capacity = strlen(p) + 1;
	char *token = malloc(capacity);
	if (token == NULL)
		return NULL;
	size_t len = 0;
	while (*p)
	{
		if (quote)
		{
			if (*p == quote)
			{
				p++;
				break;
			}
		}
		else if (*p == ' ' || *p == '\t' || *p == '\n')
		{
			break;
		}

		if (*p == '\\' && p[1] != '\0')
			p++;
		token[len++] = *p++;
	}
	token[len] = '\0';
	while (*p == ' ' || *p == '\t' || *p == '\n')
		p++;
	*cursor = p;
	return token;
}

static bool
append_command_arg(CommandSpec *spec, char *arg)
{
	char **next = realloc(spec->argv, sizeof(char *) * (spec->argc + 2));
	if (next == NULL)
	{
		free(arg);
		return false;
	}
	spec->argv = next;
	spec->argv[spec->argc++] = arg;
	spec->argv[spec->argc] = NULL;
	return true;
}

static bool
set_redirect_path(char **slot, char *path)
{
	if (path == NULL || path[0] == '\0')
	{
		free(path);
		errno = EINVAL;
		return false;
	}
	free(*slot);
	*slot = path;
	return true;
}

static bool
parse_command(const char *command, CommandSpec *spec)
{
	memset(spec, 0, sizeof(*spec));
	const char *cursor = command;
	for (;;)
	{
		char *token = read_command_token(&cursor);
		if (token == NULL)
			break;

		if (strcmp(token, "2>&1") == 0)
		{
			spec->stderr_to_stdout = true;
			free(token);
			continue;
		}
		if (strcmp(token, "<") == 0 || strcmp(token, ">") == 0)
		{
			bool input = token[0] == '<';
			free(token);
			char *path = read_command_token(&cursor);
			if (!set_redirect_path(input ? &spec->stdin_path : &spec->stdout_path, path))
				goto fail;
			continue;
		}
		if ((token[0] == '<' || token[0] == '>') && token[1] != '\0')
		{
			bool input = token[0] == '<';
			char *path = strdup(token + 1);
			free(token);
			if (!set_redirect_path(input ? &spec->stdin_path : &spec->stdout_path, path))
				goto fail;
			continue;
		}
		if (!append_command_arg(spec, token))
		{
			errno = ENOMEM;
			goto fail;
		}
	}
	if (spec->argc == 0)
	{
		errno = EINVAL;
		goto fail;
	}
	return true;

fail:
	free_command_spec(spec);
	return false;
}

static const char *
base_name(const char *path)
{
	const char *slash = strrchr(path, '/');
	return slash ? slash + 1 : path;
}

static bool
is_postgres_command(const CommandSpec *spec)
{
	if (spec->argc == 0 || spec->argv == NULL || spec->argv[0] == NULL)
		return false;
	const char *name = base_name(spec->argv[0]);
	return strcmp(name, "postgres") == 0 || strcmp(name, "oliphaunt") == 0;
}

static int
open_redirect(const char *path, int flags)
{
	return open(path, flags, 0600);
}

static bool
add_redirect_action(posix_spawn_file_actions_t *actions, int fd, int target)
{
	if (posix_spawn_file_actions_adddup2(actions, fd, target) != 0)
		return false;
	if (posix_spawn_file_actions_addclose(actions, fd) != 0)
		return false;
	return true;
}

static int
spawn_postgres_command(const CommandSpec *spec, int stdin_fd, int stdout_fd, pid_t *pid)
{
	posix_spawn_file_actions_t actions;
	int rc = posix_spawn_file_actions_init(&actions);
	if (rc != 0)
	{
		errno = rc;
		return -1;
	}

	int opened_stdin = -1;
	int opened_stdout = -1;
	if ((stdin_fd >= 0 && spec->stdin_path != NULL) ||
		(stdout_fd >= 0 && spec->stdout_path != NULL))
	{
		errno = EINVAL;
		goto fail;
	}
	if (stdin_fd >= 0 && !add_redirect_action(&actions, stdin_fd, STDIN_FILENO))
		goto fail;
	if (stdout_fd >= 0 && !add_redirect_action(&actions, stdout_fd, STDOUT_FILENO))
		goto fail;
	if (spec->stdin_path != NULL)
	{
		opened_stdin = open_redirect(spec->stdin_path, O_RDONLY);
		if (opened_stdin < 0 || !add_redirect_action(&actions, opened_stdin, STDIN_FILENO))
			goto fail;
	}
	if (spec->stdout_path != NULL)
	{
		opened_stdout = open_redirect(spec->stdout_path, O_WRONLY | O_CREAT | O_TRUNC);
		if (opened_stdout < 0 || !add_redirect_action(&actions, opened_stdout, STDOUT_FILENO))
			goto fail;
	}
	if (spec->stderr_to_stdout &&
		posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDERR_FILENO) != 0)
		goto fail;

	rc = posix_spawnp(pid, spec->argv[0], &actions, NULL, spec->argv, environ);
	posix_spawn_file_actions_destroy(&actions);
	if (opened_stdin >= 0)
		close(opened_stdin);
	if (opened_stdout >= 0)
		close(opened_stdout);
	if (rc != 0)
	{
		errno = rc;
		return -1;
	}
	return 0;

fail:
	rc = errno ? errno : EINVAL;
	posix_spawn_file_actions_destroy(&actions);
	if (opened_stdin >= 0)
		close(opened_stdin);
	if (opened_stdout >= 0)
		close(opened_stdout);
	errno = rc;
	return -1;
}

static int
wait_child_status(pid_t pid)
{
	int status = 0;
	while (waitpid(pid, &status, 0) < 0)
	{
		if (errno != EINTR)
			return -1;
	}
	return status;
}

static bool
remember_child_pipe(FILE *file, pid_t pid)
{
	ChildPipe *pipe = calloc(1, sizeof(*pipe));
	if (pipe == NULL)
		return false;
	pipe->file = file;
	pipe->pid = pid;
	pipe->next = child_pipes;
	child_pipes = pipe;
	return true;
}

static bool
forget_child_pipe(FILE *file, pid_t *pid)
{
	ChildPipe *previous = NULL;
	ChildPipe *pipe = child_pipes;

	while (pipe)
	{
		if (pipe->file == file)
		{
			if (previous)
				previous->next = pipe->next;
			else
				child_pipes = pipe->next;
			*pid = pipe->pid;
			free(pipe);
			return true;
		}
		previous = pipe;
		pipe = pipe->next;
	}
	return false;
}

static bool
remember_static_pipe(FILE *file)
{
	LocalePipe *pipe = calloc(1, sizeof(*pipe));
	if (pipe == NULL)
		return false;
	pipe->file = file;
	pipe->next = locale_pipes;
	locale_pipes = pipe;
	return true;
}

static bool
forget_static_pipe(FILE *file)
{
	LocalePipe *previous = NULL;
	LocalePipe *pipe = locale_pipes;

	while (pipe)
	{
		if (pipe->file == file)
		{
			if (previous)
				previous->next = pipe->next;
			else
				locale_pipes = pipe->next;
			free(pipe);
			return true;
		}
		previous = pipe;
		pipe = pipe->next;
	}
	return false;
}

static FILE *
open_locale_pipe(const char *command, const char *mode)
{
	if (command == NULL || mode == NULL || strcmp(command, "locale -a") != 0 ||
		strcmp(mode, "r") != 0)
	{
		errno = ENOSYS;
		return NULL;
	}

	FILE *file = tmpfile();
	if (file == NULL)
		return NULL;

	const char *encoding = getenv("PGCLIENTENCODING");
	if (encoding == NULL || encoding[0] == '\0')
		encoding = "UTF8";
	fprintf(file, "C\nC.%s\nPOSIX\n%s\n", encoding, encoding);
	rewind(file);

	if (!remember_static_pipe(file))
	{
		fclose(file);
		errno = ENOMEM;
		return NULL;
	}
	return file;
}

static FILE *
open_postgres_read_pipe(const char *command, const char *mode)
{
	if (command == NULL || mode == NULL || strcmp(mode, "r") != 0)
	{
		errno = ENOSYS;
		return NULL;
	}

	CommandSpec spec;
	if (!parse_command(command, &spec))
		return NULL;
	if (!is_postgres_command(&spec))
	{
		free_command_spec(&spec);
		errno = ENOSYS;
		return NULL;
	}

	int fds[2];
	if (pipe(fds) != 0)
		return NULL;
	(void) fcntl(fds[0], F_SETFD, FD_CLOEXEC);
	pid_t pid = -1;
	if (spawn_postgres_command(&spec, -1, fds[1], &pid) != 0)
	{
		int saved = errno;
		close(fds[0]);
		close(fds[1]);
		free_command_spec(&spec);
		errno = saved;
		return NULL;
	}
	close(fds[1]);
	FILE *file = fdopen(fds[0], mode);
	if (file == NULL)
	{
		int saved = errno;
		close(fds[0]);
		(void) wait_child_status(pid);
		free_command_spec(&spec);
		errno = saved;
		return NULL;
	}
	if (!remember_child_pipe(file, pid))
	{
		fclose(file);
		(void) wait_child_status(pid);
		free_command_spec(&spec);
		errno = ENOMEM;
		return NULL;
	}
	free_command_spec(&spec);
	return file;
}

int
oliphaunt_wasix_initdb_system(const char *command)
{
	CommandSpec spec;
	if (command == NULL || !parse_command(command, &spec))
		return -1;
	if (!is_postgres_command(&spec))
	{
		free_command_spec(&spec);
		errno = ENOSYS;
		return -1;
	}

	pid_t pid = -1;
	int rc = spawn_postgres_command(&spec, -1, -1, &pid);
	free_command_spec(&spec);
	if (rc != 0)
		return -1;
	return wait_child_status(pid);
}

int
oliphaunt_wasix_system(const char *command)
{
	return oliphaunt_wasix_initdb_system(command);
}

FILE *
oliphaunt_wasix_initdb_popen(const char *command, const char *mode)
{
	FILE *locale = open_locale_pipe(command, mode);
	if (locale != NULL)
		return locale;

	if (errno != ENOSYS)
		return NULL;
	FILE *read_pipe = open_postgres_read_pipe(command, mode);
	if (read_pipe != NULL)
		return read_pipe;
	if (errno != ENOSYS)
		return NULL;
	if (command == NULL || mode == NULL || strcmp(mode, "w") != 0)
	{
		errno = ENOSYS;
		return NULL;
	}

	CommandSpec spec;
	if (!parse_command(command, &spec))
		return NULL;
	if (!is_postgres_command(&spec))
	{
		free_command_spec(&spec);
		errno = ENOSYS;
		return NULL;
	}

	int fds[2];
	if (pipe(fds) != 0)
	{
		free_command_spec(&spec);
		return NULL;
	}
	(void) fcntl(fds[1], F_SETFD, FD_CLOEXEC);
	pid_t pid = -1;
	if (spawn_postgres_command(&spec, fds[0], -1, &pid) != 0)
	{
		int saved = errno;
		close(fds[0]);
		close(fds[1]);
		free_command_spec(&spec);
		errno = saved;
		return NULL;
	}
	close(fds[0]);
	FILE *file = fdopen(fds[1], mode);
	if (file == NULL)
	{
		int saved = errno;
		close(fds[1]);
		(void) wait_child_status(pid);
		free_command_spec(&spec);
		errno = saved;
		return NULL;
	}
	if (!remember_child_pipe(file, pid))
	{
		fclose(file);
		(void) wait_child_status(pid);
		free_command_spec(&spec);
		errno = ENOMEM;
		return NULL;
	}
	free_command_spec(&spec);
	return file;
}

FILE *
oliphaunt_wasix_popen(const char *command, const char *mode)
{
	return oliphaunt_wasix_initdb_popen(command, mode);
}

int
oliphaunt_wasix_initdb_pclose(FILE *file)
{
	if (file == NULL)
	{
		errno = EINVAL;
		return -1;
	}
	if (forget_static_pipe(file))
		return fclose(file);

	pid_t pid = -1;
	if (forget_child_pipe(file, &pid))
	{
		int close_rc = fclose(file);
		int status = wait_child_status(pid);
		if (close_rc != 0)
			return -1;
		return status;
	}
	errno = EINVAL;
	return -1;
}

int
oliphaunt_wasix_pclose(FILE *file)
{
	return oliphaunt_wasix_initdb_pclose(file);
}

int
__wrap_system(const char *command)
{
	return oliphaunt_wasix_initdb_system(command);
}

FILE *
__wrap_popen(const char *command, const char *mode)
{
	return oliphaunt_wasix_initdb_popen(command, mode);
}

int
__wrap_pclose(FILE *file)
{
	return oliphaunt_wasix_initdb_pclose(file);
}

int
pg_char_to_encoding(const char *name)
{
	return pg_char_to_encoding_private(name);
}

const char *
pg_encoding_to_char(int encoding)
{
	return pg_encoding_to_char_private(encoding);
}

uid_t
oliphaunt_wasix_geteuid(void)
{
	return OLIPHAUNT_UID;
}

uid_t
oliphaunt_wasix_getuid(void)
{
	return OLIPHAUNT_UID;
}

gid_t
oliphaunt_wasix_getegid(void)
{
	return OLIPHAUNT_UID;
}

gid_t
oliphaunt_wasix_getgid(void)
{
	return OLIPHAUNT_UID;
}

struct passwd *
oliphaunt_wasix_getpwuid(uid_t uid)
{
	if (uid != OLIPHAUNT_UID)
	{
		errno = ENOENT;
		return NULL;
	}

	static struct passwd pw;
	static char name[] = "postgres";
	static char passwd[] = "x";
	static char gecos[] = "Static User";
	static char dir[] = "/home/postgres";
	static char shell[] = "/bin/sh";

	pw.pw_name = name;
	pw.pw_passwd = passwd;
	pw.pw_uid = uid;
	pw.pw_gid = uid;
	pw.pw_gecos = gecos;
	pw.pw_dir = dir;
	pw.pw_shell = shell;

	return &pw;
}

int
oliphaunt_wasix_getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
			   struct passwd **result)
{
	const char *name = "postgres";
	const char *passwd = "x";
	const char *gecos = "Static User";
	const char *dir = "/home/postgres";
	const char *shell = "/bin/sh";
	char *cursor = buf;
	size_t remaining = buflen;

	if (pwd == NULL || buf == NULL || result == NULL)
	{
		errno = EINVAL;
		return EINVAL;
	}

	*result = NULL;
	if (uid != OLIPHAUNT_UID)
		return 0;

#define COPY_PASSWD_FIELD(field, value) \
	do { \
		size_t needed = strlen(value) + 1; \
		if (needed > remaining) \
		{ \
			errno = ERANGE; \
			return ERANGE; \
		} \
		memcpy(cursor, value, needed); \
		pwd->field = cursor; \
		cursor += needed; \
		remaining -= needed; \
	} while (0)

	COPY_PASSWD_FIELD(pw_name, name);
	COPY_PASSWD_FIELD(pw_passwd, passwd);
	COPY_PASSWD_FIELD(pw_gecos, gecos);
	COPY_PASSWD_FIELD(pw_dir, dir);
	COPY_PASSWD_FIELD(pw_shell, shell);

#undef COPY_PASSWD_FIELD

	pwd->pw_uid = uid;
	pwd->pw_gid = uid;
	*result = pwd;
	return 0;
}

void
oliphaunt_wasix_exit(int status)
{
	exit(status);
}
