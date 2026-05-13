#include <stdio.h>
#include <sys/resource.h>

int main(void) {
  struct rlimit lim;

  if (getrlimit(RLIMIT_STACK, &lim) != 0) {
    perror("getrlimit(RLIMIT_STACK)");
    return 1;
  }

  if (lim.rlim_cur == RLIM_INFINITY || lim.rlim_max == RLIM_INFINITY) {
    fprintf(stderr, "stack rlimit must be finite, got cur=%llu max=%llu\n",
            (unsigned long long)lim.rlim_cur, (unsigned long long)lim.rlim_max);
    return 2;
  }

  if (lim.rlim_cur != 4 * 1024 * 1024 || lim.rlim_max != 4 * 1024 * 1024) {
    fprintf(stderr, "unexpected stack rlimit cur=%llu max=%llu\n",
            (unsigned long long)lim.rlim_cur, (unsigned long long)lim.rlim_max);
    return 3;
  }

  printf("rlimit-stack: ok cur=%llu max=%llu\n",
         (unsigned long long)lim.rlim_cur, (unsigned long long)lim.rlim_max);
  return 0;
}
