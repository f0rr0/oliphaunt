#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <wasi/libc.h>

static volatile uint32_t futex_word = 7;

static void *delayed_wake(void *arg) {
  (void)arg;
  usleep(100000);
  futex_word = 8;
  int ret = __wasilibc_futex_wake_wasix((int *)&futex_word, 1);
  if (ret != 0) {
    fprintf(stderr, "wake failed ret=%d\n", ret);
  }
  return 0;
}

int main(void) {
  int ret = __wasilibc_futex_wait_wasix(&futex_word, 0, 99, 0);
  if (ret != -EWOULDBLOCK) {
    fprintf(stderr, "not-equal wait ret=%d expected=%d\n", ret, -EWOULDBLOCK);
    return 1;
  }

  pthread_t thread;
  if (pthread_create(&thread, 0, delayed_wake, 0) != 0) {
    perror("pthread_create");
    return 2;
  }

  ret = __wasilibc_futex_wait_wasix(&futex_word, 0, 7, 0);
  if (pthread_join(thread, 0) != 0) {
    perror("pthread_join");
    return 3;
  }
  if (ret != -ETIMEDOUT) {
    fprintf(stderr, "zero-timeout wait ret=%d expected=%d\n", ret, -ETIMEDOUT);
    return 4;
  }

  puts("futex-timeout: ok");
  return 0;
}
