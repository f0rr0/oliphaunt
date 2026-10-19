#include <stdio.h>
#include <sys/resource.h>

int main(void) {
  struct rlimit core;
  struct rlimit nofile;
  struct rlimit stack;

  if (getrlimit(RLIMIT_STACK, &stack) != 0) {
    perror("getrlimit(RLIMIT_STACK)");
    return 1;
  }

  if (stack.rlim_cur == RLIM_INFINITY || stack.rlim_max == RLIM_INFINITY) {
    fprintf(stderr, "stack rlimit must be finite, got cur=%llu max=%llu\n",
            (unsigned long long)stack.rlim_cur, (unsigned long long)stack.rlim_max);
    return 2;
  }

  if (stack.rlim_cur != 4 * 1024 * 1024 || stack.rlim_max != 4 * 1024 * 1024) {
    fprintf(stderr, "unexpected stack rlimit cur=%llu max=%llu\n",
            (unsigned long long)stack.rlim_cur, (unsigned long long)stack.rlim_max);
    return 3;
  }

  if (getrlimit(RLIMIT_NOFILE, &nofile) != 0) {
    perror("getrlimit(RLIMIT_NOFILE)");
    return 4;
  }
  if (nofile.rlim_cur != RLIM_INFINITY || nofile.rlim_max != RLIM_INFINITY) {
    fprintf(stderr, "file-descriptor rlimit must be unbounded\n");
    return 5;
  }

  if (getrlimit(RLIMIT_CORE, &core) != 0) {
    perror("getrlimit(RLIMIT_CORE)");
    return 6;
  }
  if (core.rlim_cur != 0 || core.rlim_max != 0) {
    fprintf(stderr, "core-dump rlimit must be disabled\n");
    return 7;
  }

  printf("rlimit-process: ok stack_cur=%llu stack_max=%llu nofile_cur=%llu nofile_max=%llu core_cur=%llu core_max=%llu\n",
         (unsigned long long)stack.rlim_cur,
         (unsigned long long)stack.rlim_max,
         (unsigned long long)nofile.rlim_cur,
         (unsigned long long)nofile.rlim_max,
         (unsigned long long)core.rlim_cur,
         (unsigned long long)core.rlim_max);
  return 0;
}
