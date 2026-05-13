#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void
report_mapping(const char *label, void *ptr, size_t align)
{
	uintptr_t	value = (uintptr_t) ptr;

	printf("%s=%p mod4096=%lu mod65536=%lu aligned%zu=%p\n",
		   label,
		   ptr,
		   (unsigned long) (value % 4096),
		   (unsigned long) (value % 65536),
		   align,
		   (void *) ((value + align - 1) & ~(uintptr_t) (align - 1)));
}

int
main(void)
{
	const char *name = "/fresh-wasix-mmap-probe";
	size_t		size = 1024 * 1024;
	size_t		align = 65536;
	int			fd;
	void	   *raw;
	void	   *aligned;
	void	   *fixed;

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
	report_mapping("raw", raw, align);

	aligned = (void *) ((((uintptr_t) raw) + align - 1) & ~(uintptr_t) (align - 1));
	fixed = mmap(aligned, size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED, fd, 0);
	if (fixed == MAP_FAILED)
		printf("mmap fixed over raw failed errno=%d %s\n", errno, strerror(errno));
	else
		report_mapping("fixed_over_raw", fixed, align);

	if (munmap(raw, size + align) < 0)
		printf("munmap raw failed errno=%d %s\n", errno, strerror(errno));

	fixed = mmap(aligned, size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED, fd, 0);
	if (fixed == MAP_FAILED)
		printf("mmap fixed after unmap failed errno=%d %s\n", errno, strerror(errno));
	else
		report_mapping("fixed_after_unmap", fixed, align);

	close(fd);
	shm_unlink(name);
	return 0;
}
