#define _GNU_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ROOT "wasix-directory-fsync-probe"
#define ORIGINAL ROOT "/original"
#define RENAMED ROOT "/renamed"
#define ORIGINAL_ENTRY ORIGINAL "/entry"
#define RENAMED_ENTRY RENAMED "/entry"

static void
cleanup(void)
{
	(void) unlink(ORIGINAL_ENTRY);
	(void) unlink(RENAMED_ENTRY);
	(void) rmdir(ORIGINAL);
	(void) rmdir(RENAMED);
	(void) rmdir(ROOT);
}

static int
fail(const char *operation, int code)
{
	fprintf(stderr, "%s failed errno=%d (%s)\n",
			operation, errno, strerror(errno));
	cleanup();
	return code;
}

int
main(void)
{
	int directory_fd;
	int duplicate_fd;
	int entry_fd;

	cleanup();
	if (mkdir(ROOT, 0700) != 0)
		return fail("mkdir probe root", 1);
	if (mkdir(ORIGINAL, 0700) != 0)
		return fail("mkdir original directory", 2);

	directory_fd = open(ORIGINAL, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (directory_fd < 0)
		return fail("open original directory", 3);
	duplicate_fd = dup(directory_fd);
	if (duplicate_fd < 0)
		return fail("dup directory descriptor", 4);
	if (close(directory_fd) != 0)
		return fail("close original directory descriptor", 5);

	entry_fd = open(ORIGINAL_ENTRY, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (entry_fd < 0)
		return fail("create directory entry", 6);
	if (write(entry_fd, "durable", 7) != 7)
		return fail("write directory entry", 7);
	if (fsync(entry_fd) != 0)
		return fail("fsync directory entry", 8);
	if (close(entry_fd) != 0)
		return fail("close directory entry", 9);

	if (rename(ORIGINAL, RENAMED) != 0)
		return fail("rename opened directory", 10);
	errno = 0;
	if (access(ORIGINAL, F_OK) == 0 || errno != ENOENT)
	{
		fprintf(stderr,
				"original path unexpectedly resolves after rename: errno=%d (%s)\n",
				errno, strerror(errno));
		cleanup();
		return 11;
	}

	/*
	 * Both calls must traverse wasi fd_datasync/fd_sync and target the open
	 * directory description retained by duplicate_fd. Reopening ORIGINAL at
	 * either boundary cannot pass because the path no longer exists.
	 */
	if (fdatasync(duplicate_fd) != 0)
		return fail("fdatasync renamed directory descriptor", 12);
	if (fsync(duplicate_fd) != 0)
		return fail("fsync renamed directory descriptor", 13);
	if (close(duplicate_fd) != 0)
		return fail("close duplicate directory descriptor", 14);

	if (access(RENAMED_ENTRY, F_OK) != 0)
		return fail("verify renamed directory entry", 15);
	cleanup();
	printf("directory-fsync ok identity=dup+rename datasync=full-sync\n");
	return 0;
}
