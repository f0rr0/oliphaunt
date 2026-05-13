#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int
main(void)
{
	printf("before uid=%u euid=%u\n", (unsigned) getuid(), (unsigned) geteuid());
	if (seteuid(1000) != 0)
		printf("seteuid failed: %s\n", strerror(errno));
	if (setuid(1000) != 0)
		printf("setuid failed: %s\n", strerror(errno));
	printf("after uid=%u euid=%u\n", (unsigned) getuid(), (unsigned) geteuid());
	return 0;
}
