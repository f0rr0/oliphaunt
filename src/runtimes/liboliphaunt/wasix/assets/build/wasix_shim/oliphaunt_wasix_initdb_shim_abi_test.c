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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(condition)                                                                      \
	do                                                                                        \
	{                                                                                         \
		if (!(condition))                                                                     \
		{                                                                                     \
			fprintf(stderr, "initdb shim ABI check failed at %s:%d: %s\n", __FILE__, __LINE__, \
					#condition);                                                             \
			return 1;                                                                         \
		}                                                                                     \
	} while (0)

FILE *oliphaunt_wasix_initdb_popen(const char *command, const char *mode);
int oliphaunt_wasix_initdb_pclose(FILE *file);
uid_t oliphaunt_wasix_geteuid(void);
uid_t oliphaunt_wasix_getuid(void);
gid_t oliphaunt_wasix_getegid(void);
gid_t oliphaunt_wasix_getgid(void);
struct passwd *oliphaunt_wasix_getpwuid(uid_t uid);
int oliphaunt_wasix_getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
				   struct passwd **result);

int
pg_char_to_encoding_private(const char *name)
{
	return strcmp(name, "UTF8") == 0 ? 6 : -1;
}

const char *
pg_encoding_to_char_private(int encoding)
{
	return encoding == 6 ? "UTF8" : "";
}

static int
write_file(const char *path, const char *contents)
{
	FILE *file = fopen(path, "w");
	if (file == NULL)
		return -1;
	if (fputs(contents, file) < 0)
	{
		fclose(file);
		return -1;
	}
	return fclose(file);
}

static int
install_fake_postgres(char *dir)
{
	char path[512];
	snprintf(path, sizeof(path), "%s/postgres", dir);
	const char *script =
		"#!/bin/sh\n"
		"if [ \"$1\" = \"-V\" ] || [ \"$1\" = \"--version\" ]; then\n"
		"  echo 'postgres (PostgreSQL) fake-from-child'\n"
		"  exit 0\n"
		"fi\n"
		"cat > \"$OLIPHAUNT_INITDB_STDIN_CAPTURE\"\n";
	CHECK(write_file(path, script) == 0);
	CHECK(chmod(path, 0700) == 0);
	return 0;
}

static int
prepend_path(const char *dir)
{
	const char *old_path = getenv("PATH");
	if (old_path == NULL)
		old_path = "";
	size_t len = strlen(dir) + 1 + strlen(old_path) + 1;
	char *next = malloc(len);
	CHECK(next != NULL);
	snprintf(next, len, "%s:%s", dir, old_path);
	CHECK(setenv("PATH", next, 1) == 0);
	free(next);
	return 0;
}

static int
check_locale_and_fail_closed(void)
{
	CHECK(setenv("PGCLIENTENCODING", "UTF8", 1) == 0);
	errno = 0;
	CHECK(oliphaunt_wasix_initdb_popen("uname -a", "r") == NULL);
	CHECK(errno == ENOSYS);
	errno = 0;
	CHECK(oliphaunt_wasix_initdb_popen("locale -a", "w") == NULL);
	CHECK(errno == ENOSYS);

	FILE *file = oliphaunt_wasix_initdb_popen("locale -a", "r");
	CHECK(file != NULL);
	char contents[128] = {0};
	size_t read_len = fread(contents, 1, sizeof(contents) - 1, file);
	CHECK(oliphaunt_wasix_initdb_pclose(file) == 0);
	CHECK(read_len > 0);
	CHECK(strstr(contents, "C\n") != NULL);
	CHECK(strstr(contents, "C.UTF8\n") != NULL);
	CHECK(strstr(contents, "POSIX\n") != NULL);
	return 0;
}

static int
check_postgres_read_and_write_pipes(char *dir)
{
	CHECK(install_fake_postgres(dir) == 0);
	CHECK(prepend_path(dir) == 0);

	FILE *read_pipe = oliphaunt_wasix_initdb_popen("postgres -V 2>&1", "r");
	CHECK(read_pipe != NULL);
	char version[128] = {0};
	CHECK(fread(version, 1, sizeof(version) - 1, read_pipe) > 0);
	CHECK(oliphaunt_wasix_initdb_pclose(read_pipe) == 0);
	CHECK(strstr(version, "fake-from-child") != NULL);

	char capture[512];
	snprintf(capture, sizeof(capture), "%s/stdin.txt", dir);
	CHECK(setenv("OLIPHAUNT_INITDB_STDIN_CAPTURE", capture, 1) == 0);
	FILE *write_pipe = oliphaunt_wasix_initdb_popen("postgres --boot \"quoted arg\"", "w");
	CHECK(write_pipe != NULL);
	CHECK(fputs("bootstrap input\n", write_pipe) >= 0);
	CHECK(oliphaunt_wasix_initdb_pclose(write_pipe) == 0);

	FILE *captured = fopen(capture, "r");
	CHECK(captured != NULL);
	char captured_text[128] = {0};
	CHECK(fread(captured_text, 1, sizeof(captured_text) - 1, captured) > 0);
	CHECK(fclose(captured) == 0);
	CHECK(strstr(captured_text, "bootstrap input") != NULL);
	return 0;
}

static int
check_identity(void)
{
	CHECK(oliphaunt_wasix_geteuid() == 123);
	CHECK(oliphaunt_wasix_getuid() == 123);
	CHECK(oliphaunt_wasix_getegid() == 123);
	CHECK(oliphaunt_wasix_getgid() == 123);
	struct passwd *pw = oliphaunt_wasix_getpwuid(123);
	CHECK(pw != NULL);
	CHECK(strcmp(pw->pw_name, "postgres") == 0);
	CHECK(pw->pw_uid == 123);
	CHECK(pw->pw_gid == 123);

	struct passwd pwbuf;
	struct passwd *result = NULL;
	char buf[128];
	CHECK(oliphaunt_wasix_getpwuid_r(123, &pwbuf, buf, sizeof(buf), &result) == 0);
	CHECK(result == &pwbuf);
	CHECK(strcmp(result->pw_name, "postgres") == 0);
	CHECK(result->pw_uid == 123);
	CHECK(result->pw_gid == 123);
	result = &pwbuf;
	CHECK(oliphaunt_wasix_getpwuid_r(999, &pwbuf, buf, sizeof(buf), &result) == 0);
	CHECK(result == NULL);
	errno = 0;
	CHECK(oliphaunt_wasix_getpwuid_r(123, &pwbuf, buf, 4, &result) == ERANGE);
	CHECK(errno == ERANGE);

	errno = 0;
	CHECK(oliphaunt_wasix_getpwuid(999) == NULL);
	CHECK(errno == ENOENT);
	return 0;
}

int
main(void)
{
	char temp_template[] = "/tmp/oliphaunt-initdb-shim-XXXXXX";
	char *dir = mkdtemp(temp_template);
	CHECK(dir != NULL);
	CHECK(check_locale_and_fail_closed() == 0);
	CHECK(check_postgres_read_and_write_pipes(dir) == 0);
	CHECK(check_identity() == 0);
	return 0;
}
