#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void
print_addr(const char *label, void *ptr)
{
	uintptr_t value = (uintptr_t) ptr;

	printf("%s=%p mod4096=%lu mod65536=%lu\n",
		   label, ptr,
		   (unsigned long) (value % 4096),
		   (unsigned long) (value % 65536));
}

int
main(void)
{
	const char *name = "/wasix-upstream-mmap-fixed-probe";
	const size_t size = 1024 * 1024;
	const size_t align = 65536;
	int fd;
	char *raw;
	char *aligned;
	char *fixed;

	shm_unlink(name);
	fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
	if (fd < 0)
	{
		perror("shm_open");
		return 1;
	}
	if (ftruncate(fd, size + align) < 0)
	{
		perror("ftruncate");
		return 1;
	}

	raw = mmap(NULL, size + align, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (raw == MAP_FAILED)
	{
		perror("mmap raw");
		return 1;
	}
	print_addr("raw", raw);

	aligned = (char *) ((((uintptr_t) raw) + align - 1) & ~(uintptr_t) (align - 1));
	print_addr("aligned_target", aligned);

	fixed = mmap(aligned, size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED, fd, 0);
	if (fixed == MAP_FAILED)
	{
		printf("mmap MAP_FIXED failed errno=%d %s\n", errno, strerror(errno));
		return 10;
	}
	print_addr("fixed", fixed);

	if (fixed != aligned)
	{
		printf("MAP_FIXED returned wrong address\n");
		return 11;
	}

	fixed[0] = 'x';
	if (aligned[0] != 'x')
	{
		printf("fixed mapping is not address-identical\n");
		return 12;
	}

	if (munmap(fixed, size) < 0)
	{
		perror("munmap fixed");
		return 13;
	}
	close(fd);
	shm_unlink(name);
	return 0;
}
