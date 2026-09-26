#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ROOT "wasix-upstream-dir-readdir-unlink-probe"
#define FILE_COUNT 160

static int
join_path(char *buf, size_t len, const char *dir, const char *name)
{
	int ret = snprintf(buf, len, "%s/%s", dir, name);

	return ret >= 0 && (size_t) ret < len ? 0 : -1;
}

static void
cleanup_tree(const char *path)
{
	DIR *dir;
	struct dirent *de;
	char child[512];

	dir = opendir(path);
	if (dir != NULL)
	{
		while ((de = readdir(dir)) != NULL)
		{
			struct stat st;

			if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0)
				continue;
			if (join_path(child, sizeof(child), path, de->d_name) != 0)
				continue;
			if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode))
				cleanup_tree(child);
			else
				(void) unlink(child);
		}
		closedir(dir);
	}
	(void) rmdir(path);
}

static int
make_dir(const char *path)
{
	if (mkdir(path, 0700) < 0 && errno != EEXIST)
	{
		printf("mkdir %s failed errno=%d %s\n", path, errno, strerror(errno));
		return -1;
	}
	return 0;
}

static int
create_files(const char *dir)
{
	char path[512];

	for (int i = 0; i < FILE_COUNT; i++)
	{
		int fd;

		if (snprintf(path, sizeof(path), "%s/%04d", dir, i) >= (int) sizeof(path))
			return -1;
		fd = open(path, O_CREAT | O_TRUNC | O_WRONLY, 0600);
		if (fd < 0)
		{
			printf("open %s failed errno=%d %s\n", path, errno, strerror(errno));
			return -1;
		}
		if (write(fd, "x", 1) != 1)
		{
			printf("write %s failed errno=%d %s\n", path, errno, strerror(errno));
			close(fd);
			return -1;
		}
		if (close(fd) < 0)
		{
			printf("close %s failed errno=%d %s\n", path, errno, strerror(errno));
			return -1;
		}
	}
	return 0;
}

static int
count_files(const char *dir)
{
	DIR *stream;
	struct dirent *de;
	int count = 0;

	stream = opendir(dir);
	if (stream == NULL)
	{
		printf("opendir %s failed errno=%d %s\n", dir, errno, strerror(errno));
		return -1;
	}
	errno = 0;
	while ((de = readdir(stream)) != NULL)
	{
		if (strcmp(de->d_name, ".") != 0 && strcmp(de->d_name, "..") != 0)
			count++;
		errno = 0;
	}
	if (errno != 0)
	{
		printf("readdir %s failed errno=%d %s\n", dir, errno, strerror(errno));
		closedir(stream);
		return -1;
	}
	if (closedir(stream) < 0)
	{
		printf("closedir %s failed errno=%d %s\n", dir, errno, strerror(errno));
		return -1;
	}
	return count;
}

static int
copy_flat_dir(const char *from, const char *to)
{
	DIR *stream;
	struct dirent *de;
	char src[512];
	char dst[512];

	if (make_dir(to) != 0)
		return -1;

	stream = opendir(from);
	if (stream == NULL)
	{
		printf("opendir source %s failed errno=%d %s\n", from, errno, strerror(errno));
		return -1;
	}
	while ((de = readdir(stream)) != NULL)
	{
		int in;
		int out;
		char byte;

		if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0)
			continue;
		if (join_path(src, sizeof(src), from, de->d_name) != 0 ||
			join_path(dst, sizeof(dst), to, de->d_name) != 0)
			return -1;
		in = open(src, O_RDONLY);
		if (in < 0)
		{
			printf("open source %s failed errno=%d %s\n", src, errno, strerror(errno));
			closedir(stream);
			return -1;
		}
		out = open(dst, O_CREAT | O_TRUNC | O_WRONLY, 0600);
		if (out < 0)
		{
			printf("open dest %s failed errno=%d %s\n", dst, errno, strerror(errno));
			close(in);
			closedir(stream);
			return -1;
		}
		if (read(in, &byte, 1) != 1 || write(out, &byte, 1) != 1)
		{
			printf("copy %s to %s failed errno=%d %s\n", src, dst, errno, strerror(errno));
			close(out);
			close(in);
			closedir(stream);
			return -1;
		}
		if (close(out) < 0 || close(in) < 0)
		{
			printf("close copied files failed errno=%d %s\n", errno, strerror(errno));
			closedir(stream);
			return -1;
		}
	}
	if (closedir(stream) < 0)
	{
		printf("closedir source %s failed errno=%d %s\n", from, errno, strerror(errno));
		return -1;
	}
	return 0;
}

static int
unlink_flat_dir(const char *dir)
{
	DIR *stream;
	struct dirent *de;
	char path[512];
	int seen = 0;
	int unlinked = 0;

	stream = opendir(dir);
	if (stream == NULL)
	{
		printf("opendir unlink %s failed errno=%d %s\n", dir, errno, strerror(errno));
		return -1;
	}
	errno = 0;
	while ((de = readdir(stream)) != NULL)
	{
		if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0)
			continue;
		seen++;
		if (join_path(path, sizeof(path), dir, de->d_name) != 0)
			return -1;
		if (unlink(path) < 0)
		{
			printf("unlink %s failed errno=%d %s\n", path, errno, strerror(errno));
			closedir(stream);
			return -1;
		}
		unlinked++;
		errno = 0;
	}
	if (errno != 0)
	{
		printf("readdir unlink %s failed errno=%d %s\n", dir, errno, strerror(errno));
		closedir(stream);
		return -1;
	}
	if (closedir(stream) < 0)
	{
		printf("closedir unlink %s failed errno=%d %s\n", dir, errno, strerror(errno));
		return -1;
	}
	if (seen != FILE_COUNT || unlinked != FILE_COUNT)
	{
		printf("unlink count mismatch dir=%s seen=%d unlinked=%d expected=%d\n",
			   dir, seen, unlinked, FILE_COUNT);
		return -1;
	}
	if (rmdir(dir) < 0)
	{
		printf("rmdir %s failed errno=%d %s\n", dir, errno, strerror(errno));
		return -1;
	}
	return 0;
}

int
main(void)
{
	const char *base = ROOT "/base";
	const char *db = ROOT "/base/16640";
	const char *tblspc = ROOT "/pg_tblspc";
	const char *tblspc_oid = ROOT "/pg_tblspc/16384";
	const char *version = ROOT "/pg_tblspc/16384/PG_18_probe";
	const char *moved = ROOT "/pg_tblspc/16384/PG_18_probe/16640";
	int count;

	cleanup_tree(ROOT);

	if (make_dir(ROOT) != 0 || make_dir(base) != 0 || make_dir(db) != 0 ||
		make_dir(tblspc) != 0 || make_dir(tblspc_oid) != 0 ||
		make_dir(version) != 0)
		return 1;
	if (create_files(db) != 0)
		return 2;
	count = count_files(db);
	if (count != FILE_COUNT)
	{
		printf("initial readdir count=%d expected=%d\n", count, FILE_COUNT);
		return 3;
	}
	if (copy_flat_dir(db, moved) != 0)
		return 4;
	count = count_files(moved);
	if (count != FILE_COUNT)
	{
		printf("copied readdir count=%d expected=%d\n", count, FILE_COUNT);
		return 5;
	}
	if (unlink_flat_dir(db) != 0)
		return 6;
	if (unlink_flat_dir(moved) != 0)
		return 7;

	cleanup_tree(ROOT);
	printf("directory readdir/unlink semantics ok\n");
	return 0;
}
