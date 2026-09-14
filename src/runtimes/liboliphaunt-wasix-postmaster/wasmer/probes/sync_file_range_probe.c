#define _GNU_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

_Static_assert(sizeof(off_t) == sizeof(int64_t),
			   "the postmaster sync_file_range ABI requires signed 64-bit off_t");
_Static_assert(SYNC_FILE_RANGE_WAIT_BEFORE == 1,
			   "SYNC_FILE_RANGE_WAIT_BEFORE ABI bit changed");
_Static_assert(SYNC_FILE_RANGE_WRITE == 2,
			   "SYNC_FILE_RANGE_WRITE ABI bit changed");
_Static_assert(SYNC_FILE_RANGE_WAIT_AFTER == 4,
			   "SYNC_FILE_RANGE_WAIT_AFTER ABI bit changed");

static int
expect_error(const char *name, int result, int expected_errno)
{
	if (result != -1 || errno != expected_errno)
	{
		fprintf(stderr,
				"%s returned %d errno=%d (%s), expected -1 errno=%d (%s)\n",
				name, result, errno, strerror(errno), expected_errno,
				strerror(expected_errno));
		return -1;
	}
	return 0;
}

static int
write_full(int fd, const void *buffer, size_t size)
{
	const char *cursor = buffer;

	while (size > 0)
	{
		ssize_t written = write(fd, cursor, size);

		if (written < 0)
		{
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (written == 0)
		{
			errno = EIO;
			return -1;
		}
		cursor += written;
		size -= (size_t) written;
	}
	return 0;
}

int
main(void)
{
	static const unsigned combinations[] = {
		0,
		SYNC_FILE_RANGE_WAIT_BEFORE,
		SYNC_FILE_RANGE_WRITE,
		SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE,
		SYNC_FILE_RANGE_WAIT_AFTER,
		SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WAIT_AFTER,
		SYNC_FILE_RANGE_WRITE | SYNC_FILE_RANGE_WAIT_AFTER,
		SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE |
			SYNC_FILE_RANGE_WAIT_AFTER,
	};
	const char *path = "wasix-sync-file-range-probe.dat";
	const char payload[] = "postgres-range-writeback";
	int directory_fd;
	int fd;
	int populate_fd;

	(void) unlink(path);
	populate_fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (populate_fd < 0)
	{
		perror("open sync_file_range probe");
		return 1;
	}
	if (write_full(populate_fd, payload, sizeof(payload) - 1) != 0)
	{
		perror("write sync_file_range probe");
		return 2;
	}
	if (close(populate_fd) < 0)
	{
		perror("close populated sync_file_range probe");
		return 3;
	}

	/* PostgreSQL pre_sync_fname deliberately reopens relation files O_RDONLY. */
	fd = open(path, O_RDONLY);
	if (fd < 0)
	{
		perror("reopen sync_file_range probe read-only");
		return 4;
	}

	for (size_t i = 0; i < sizeof(combinations) / sizeof(combinations[0]); i++)
	{
		if (sync_file_range(fd, 0, 0, combinations[i]) != 0)
		{
			fprintf(stderr,
					"sync_file_range flags=0x%x failed errno=%d (%s)\n",
					combinations[i], errno, strerror(errno));
			return 5;
		}
	}

	/* This is the largest finite signed exclusive end accepted by the ABI. */
	if (sync_file_range(fd, (off_t) INT64_MAX - 1, 1, 0) != 0)
	{
		perror("sync_file_range maximum finite boundary");
		return 6;
	}

	errno = 0;
	if (expect_error("negative offset", sync_file_range(fd, -1, 0, 0), EINVAL) != 0)
		return 7;
	errno = 0;
	if (expect_error("negative length", sync_file_range(fd, 0, -1, 0), EINVAL) != 0)
		return 8;
	errno = 0;
	if (expect_error("finite range overflow",
					 sync_file_range(fd, (off_t) INT64_MAX, 1, 0), EINVAL) != 0)
		return 9;
	errno = 0;
	if (expect_error("unknown flags", sync_file_range(fd, 0, 0, 8), EINVAL) != 0)
		return 10;

	/* flags=0 is legal and must still reach descriptor validation. */
	errno = 0;
	if (expect_error("bad descriptor", sync_file_range(-1, 0, 0, 0), EBADF) != 0)
		return 11;

	directory_fd = open(".", O_RDONLY | O_DIRECTORY);
	if (directory_fd < 0)
	{
		perror("open probe directory");
		return 12;
	}
	errno = 0;
	if (expect_error("directory descriptor",
					 sync_file_range(directory_fd, 0, 0, 0), EBADF) != 0)
		return 13;

	if (close(directory_fd) < 0)
	{
		perror("close sync_file_range probe directory");
		return 14;
	}
	if (close(fd) < 0)
	{
		perror("close sync_file_range probe file");
		return 14;
	}
	if (unlink(path) < 0)
	{
		perror("unlink sync_file_range probe");
		return 15;
	}

	printf("sync-file-range ok combinations=%zu namespace=oliphaunt_postmaster_v1\n",
		   sizeof(combinations) / sizeof(combinations[0]));
	return 0;
}
