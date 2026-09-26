#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static unsigned long long positive(const char *text) {
  char *end;
  errno = 0;
  unsigned long long value = strtoull(text, &end, 10);
  return text[0] >= '1' && text[0] <= '9' && !*end && !errno ? value : 0;
}

static int exited(int fd) {
  struct pollfd entry = {.fd = fd, .events = POLLIN};
  return poll(&entry, 1, 0) == 1 && (entry.revents & POLLIN);
}

int main(int argc, char **argv) {
  unsigned long long pid = 0, expected = 0;
  int signum = 0;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--pid") && !pid) pid = positive(argv[i + 1]);
    else if (!strcmp(argv[i], "--identity") && !expected &&
             !strncmp(argv[i + 1], "linux-starttime:", 16))
      expected = positive(argv[i + 1] + 16);
    else if (!strcmp(argv[i], "--signal") && !signum) {
      const char *name = argv[i + 1];
      if (!strncmp(name, "SIG", 3)) name += 3;
      if (!strcasecmp(name, "TERM")) signum = SIGTERM;
      else if (!strcasecmp(name, "KILL")) signum = SIGKILL;
      else if (!strcasecmp(name, "INT")) signum = SIGINT;
      else if (!strcasecmp(name, "QUIT")) signum = SIGQUIT;
      else {
        unsigned long long value = positive(name);
        if (value < NSIG) signum = (int)value;
      }
    } else return 2;
  }
  if (argc != 7 || !pid || pid > INT_MAX || !expected || !signum) return 2;

  // Pin the process before reading its birth identity. A reused numeric PID
  // must never redirect the signal to a different process.
  int fd = (int)syscall(SYS_pidfd_open, (int)pid, 0);
  if (fd < 0) {
    if (errno == ESRCH) return 0;
    perror("pidfd_open");
    return 125;
  }
  char path[64], *record = NULL;
  size_t capacity = 0;
  snprintf(path, sizeof(path), "/proc/%llu/stat", pid);
  FILE *stream = fopen(path, "r");
  unsigned long long actual = 0;
  if (stream) {
    if (getline(&record, &capacity, stream) >= 0) {
      char *field = strrchr(record, ')');
      if (field && field[1] == ' ') {
        char *state;
        field = strtok_r(field + 2, " \n", &state);
        for (int i = 0; i < 19 && field; i++) field = strtok_r(NULL, " \n", &state);
        if (field) actual = positive(field);
      }
    }
    fclose(stream);
  }
  free(record);
  int status = 0;
  if (actual != expected) {
    if (!exited(fd)) {
      fprintf(stderr, "refusing to signal reused or unreadable process identity: pid=%llu expected=linux-starttime:%llu actual=linux-starttime:%llu\n", pid, expected, actual);
      status = 125;
    }
  } else if (syscall(SYS_pidfd_send_signal, fd, signum, NULL, 0) < 0 && errno != ESRCH) {
    perror("pidfd_send_signal");
    status = 125;
  }
  close(fd);
  return status;
}
