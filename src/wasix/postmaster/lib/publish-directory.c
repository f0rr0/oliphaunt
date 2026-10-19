#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// Node's filesystem API cannot request an atomic no-replace directory rename.
// Keep that native operation here; never fall back to a check-then-rename.
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  for (int i = 2; i < 4; i++)
    if (!*argv[i] || strchr(argv[i], '/') || !strcmp(argv[i], ".") ||
        !strcmp(argv[i], "..")) return 2;
  int parent = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) { perror("open publication parent"); return 1; }
  struct stat source;
  int result = fstatat(parent, argv[2], &source, AT_SYMLINK_NOFOLLOW);
  if (result || !S_ISDIR(source.st_mode)) {
    fprintf(stderr, "publication source is not a regular directory\n");
    close(parent);
    return 1;
  }
#if defined(__linux__)
  result = renameat2(parent, argv[2], parent, argv[3], RENAME_NOREPLACE);
#elif defined(__APPLE__)
  result = renameatx_np(parent, argv[2], parent, argv[3], RENAME_EXCL);
#else
#error "Atomic directory publication requires Linux or macOS"
#endif
  if (result) perror("atomic no-replace directory publication");
  else if ((result = fsync(parent))) perror("sync published directory parent");
  close(parent);
  return result ? 1 : 0;
}
