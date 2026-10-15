#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
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
	void *frontier_after_map;
	unsigned char *morecore_segment;
	size_t i;

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
	errno = 0;
	if (munmap(map + 1, 1) == 0 || errno != EINVAL)
	{
		fprintf(stderr,
				"overlapping unaligned munmap escaped runtime ownership: errno=%d\n",
				errno);
		return 4;
	}
	errno = 0;
	if (msync(map + 1, 1, MS_SYNC) == 0 || errno != EINVAL)
	{
		fprintf(stderr,
				"overlapping unaligned msync escaped runtime ownership: errno=%d\n",
				errno);
		return 5;
	}
	if (memcmp(map, initial, sizeof(initial) - 1) != 0)
	{
		fprintf(stderr, "rejected shared operation mutated the mapping\n");
		return 6;
	}

	/* A runtime mmap may grow linear memory between allocator requests.  The
	 * allocator must claim only the exact interval returned by positive sbrk,
	 * never the gap between a cached logical break and the new frontier. */
	frontier_after_map = sbrk(0);
	morecore_segment = sbrk(65536);
	if (morecore_segment == (void *) -1)
	{
		perror("sbrk after shared mmap");
		return 7;
	}
	if (morecore_segment != frontier_after_map ||
		sbrk(0) != morecore_segment + 65536)
	{
		fprintf(stderr, "sbrk did not return its exact exclusive interval\n");
		return 8;
	}
	if ((uintptr_t) morecore_segment < (uintptr_t) map + 65536 &&
		(uintptr_t) map < (uintptr_t) morecore_segment + 65536)
	{
		fprintf(stderr, "MORECORE overlapped the runtime-owned mmap range\n");
		return 9;
	}
	memset(morecore_segment, 0x5a, 65536);
	memcpy(map, "WXYZ", 4);
	for (i = 1; i <= 256; i++)
	{
		unsigned char *allocation = malloc(i * 17);

		if (allocation == NULL)
		{
			fprintf(stderr, "malloc failed after nonconsecutive MORECORE\n");
			return 18;
		}
		memset(allocation, (int) (i & 0xff), i * 17);
		free(allocation);
	}
	if (morecore_segment[0] != 0x5a || morecore_segment[65535] != 0x5a ||
		memcmp(map, "WXYZ", 4) != 0)
	{
		fprintf(stderr, "allocator or mmap sentinel was corrupted\n");
		return 19;
	}
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
	errno = 0;
	map = mmap(NULL, sizeof(initial) - 1, PROT_READ, MAP_SHARED, fd, 0);
	if (map != MAP_FAILED || errno != EINVAL)
	{
		fprintf(stderr,
				"runtime mapping accepted an unenforced protection contract: errno=%d\n",
				errno);
		return 20;
	}

	/* Repeated full and partial unmaps must recycle only runtime-owned pages,
	 * without growing the guest heap or overwriting its MORECORE interval. */
	if (ftruncate(fd, 4 * 65536) < 0)
	{
		perror("extend mapping churn file");
		return 21;
	}
	frontier_after_map = NULL;
	for (i = 0; i < 64; i++)
	{
		char *large = mmap(NULL, 3 * 65536, PROT_READ | PROT_WRITE,
						   MAP_SHARED, fd, 0);
		char *peer = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
						  MAP_SHARED, fd, 3 * 65536);
		char *replacement;

		if (large == MAP_FAILED || peer == MAP_FAILED)
		{
			perror("mapping churn allocation");
			return 22;
		}
		if (i == 0)
			frontier_after_map = sbrk(0);
		large[0] = 'A';
		large[2 * 65536] = 'C';
		peer[0] = 'B';
		if (munmap(large + 65536, 65536) < 0)
		{
			perror("partial mapping churn unmap");
			return 23;
		}
		replacement = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
						   MAP_SHARED, fd, 65536);
		if (replacement == MAP_FAILED || replacement != large + 65536)
		{
			fprintf(stderr, "partial mapping interval was not recycled\n");
			return 24;
		}
		replacement[0] = 'R';
		if (sbrk(0) != frontier_after_map || large[0] != 'A' ||
			large[2 * 65536] != 'C' || peer[0] != 'B' ||
			morecore_segment[0] != 0x5a || morecore_segment[65535] != 0x5a)
		{
			fprintf(stderr, "mapping churn grew memory or corrupted another owner\n");
			return 25;
		}
		if (munmap(large, 65536) < 0 ||
			munmap(large + 2 * 65536, 65536) < 0 ||
			munmap(replacement, 65536) < 0 || munmap(peer, 65536) < 0)
		{
			perror("mapping churn final unmap");
			return 26;
		}
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
