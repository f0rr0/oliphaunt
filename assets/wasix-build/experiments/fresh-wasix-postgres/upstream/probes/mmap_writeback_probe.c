#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static int
write_full(int fd, const char *buf, size_t len)
{
	while (len > 0)
	{
		ssize_t written = write(fd, buf, len);

		if (written < 0)
		{
			if (errno == EINTR)
				continue;
			return -1;
		}
		buf += written;
		len -= (size_t) written;
	}
	return 0;
}

static int
read_full(int fd, char *buf, size_t len)
{
	while (len > 0)
	{
		ssize_t got = read(fd, buf, len);

		if (got < 0)
		{
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (got == 0)
		{
			errno = EIO;
			return -1;
		}
		buf += got;
		len -= (size_t) got;
	}
	return 0;
}

static int
reset_file(int fd, const char *contents, size_t len)
{
	if (ftruncate(fd, 0) < 0)
		return -1;
	if (lseek(fd, 0, SEEK_SET) < 0)
		return -1;
	if (write_full(fd, contents, len) < 0)
		return -1;
	if (lseek(fd, 0, SEEK_SET) < 0)
		return -1;
	return 0;
}

static int
expect_file(int fd, const char *expected, size_t len)
{
	char buf[32];

	if (len > sizeof(buf))
		return -1;
	memset(buf, 0, sizeof(buf));
	if (lseek(fd, 0, SEEK_SET) < 0)
		return -1;
	if (read_full(fd, buf, len) < 0)
		return -1;
	if (memcmp(buf, expected, len) != 0)
	{
		printf("file mismatch got=\"%.*s\" expected=\"%.*s\"\n",
			   (int) len, buf, (int) len, expected);
		return 1;
	}
	return 0;
}

int
main(void)
{
	const char *path = "wasix-upstream-mmap-writeback-probe.dat";
	const char initial[] = "abcdefgh";
	int fd;
	char *map;

	unlink(path);
	fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
	{
		perror("open");
		return 1;
	}
	if (reset_file(fd, initial, sizeof(initial) - 1) < 0)
	{
		perror("reset shared");
		return 2;
	}

	map = mmap(NULL, sizeof(initial) - 1, PROT_READ | PROT_WRITE,
			   MAP_SHARED, fd, 0);
	if (map == MAP_FAILED)
	{
		perror("mmap shared");
		return 3;
	}
	memcpy(map, "WXYZ", 4);
	if (msync(map, sizeof(initial) - 1, MS_SYNC) < 0)
	{
		perror("msync shared writable");
		return 10;
	}
	if (expect_file(fd, "WXYZefgh", sizeof(initial) - 1) != 0)
		return 11;
	if (munmap(map, sizeof(initial) - 1) < 0)
	{
		perror("munmap shared");
		return 12;
	}

	if (reset_file(fd, initial, sizeof(initial) - 1) < 0)
	{
		perror("reset private");
		return 13;
	}
	map = mmap(NULL, sizeof(initial) - 1, PROT_READ | PROT_WRITE,
			   MAP_PRIVATE, fd, 0);
	if (map == MAP_FAILED)
	{
		perror("mmap private");
		return 14;
	}
	memcpy(map, "PRIV", 4);
	if (msync(map, sizeof(initial) - 1, MS_SYNC) < 0)
	{
		perror("msync private writable");
		return 15;
	}
	if (munmap(map, sizeof(initial) - 1) < 0)
	{
		perror("munmap private");
		return 16;
	}
	if (expect_file(fd, initial, sizeof(initial) - 1) != 0)
		return 17;

	close(fd);
	unlink(path);
	printf("mmap writeback semantics ok\n");
	return 0;
}
