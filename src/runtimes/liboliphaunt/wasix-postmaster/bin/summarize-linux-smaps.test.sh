#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFIER="$SCRIPT_DIR/summarize-linux-smaps.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-smaps-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

SMAPS="$TEST_ROOT/smaps"
MAPPINGS="$TEST_ROOT/mappings.tsv"
CATEGORIES="$TEST_ROOT/categories.tsv"
EXPECTED_MAPPINGS="$TEST_ROOT/expected-mappings.tsv"
EXPECTED_CATEGORIES="$TEST_ROOT/expected-categories.tsv"

cat >"$SMAPS" <<'SMAPS'
10000000-10001000 rw-s 00000000 00:01 10 /tmp/postgresql-wasix-1234
Size:                100 kB
Rss:                  80 kB
Pss:                  50 kB
Private_Clean:         1 kB
Private_Dirty:         2 kB
Private_Hugetlb:       3 kB
Shared_Clean:          4 kB
Shared_Dirty:          5 kB
Shared_Hugetlb:        6 kB
Anonymous:             7 kB
Swap:                  8 kB
11000000-11001000 rw-s 00000000 00:02 11 /dev/shm/PostgreSQL.123
Size:                 10 kB
Rss:                   9 kB
Pss:                   8 kB
Private_Dirty:         1 kB
Shared_Clean:          2 kB
Anonymous:             3 kB
Swap:                  4 kB
12000000-12001000 rw-p 00000000 00:00 0 [stack:42]
Size:                 20 kB
Rss:                  19 kB
Pss:                  18 kB
Private_Dirty:        17 kB
Shared_Clean:         16 kB
Anonymous:            15 kB
Swap:                 14 kB
13000000-13001000 rw-p 00000000 00:00 0 [heap]
Size:                 30 kB
Rss:                  29 kB
Pss:                  28 kB
Private_Dirty:        27 kB
Shared_Clean:         26 kB
Anonymous:            25 kB
Swap:                 24 kB
14000000-14001000 r-xp 00000000 00:00 0
Size:                 40 kB
Rss:                  39 kB
Pss:                  38 kB
Private_Dirty:        37 kB
Shared_Clean:         36 kB
Anonymous:            35 kB
Swap:                 34 kB
15000000-15001000 rw-p 00000000 00:00 0
Size:                 50 kB
Rss:                  49 kB
Pss:                  48 kB
Private_Dirty:        47 kB
Shared_Clean:         46 kB
Anonymous:            45 kB
Swap:                 44 kB
16000000-16001000 ---p 00000000 00:00 0
Size:                 60 kB
Rss:                   0 kB
Pss:                   0 kB
17000000-17001000 r--p 00000000 00:00 0 [vvar]
Size:                 70 kB
Rss:                  69 kB
Pss:                  68 kB
Private_Dirty:        67 kB
Shared_Clean:         66 kB
Anonymous:            65 kB
Swap:                 64 kB
18000000-18001000 r-xp 00000000 08:01 12 /opt/with space/module.so
Size:                 80 kB
Rss:                  79 kB
Pss:                  78 kB
Private_Dirty:        77 kB
Shared_Clean:         76 kB
Anonymous:            75 kB
Swap:                 74 kB
19000000-19001000 r--p 00000000 08:01 13 /opt/data.bin
Size:                 90 kB
Rss:                  89 kB
Pss:                  88 kB
Private_Dirty:        87 kB
Shared_Clean:         86 kB
Anonymous:            85 kB
Swap:                 84 kB
SMAPS

bash "$CLASSIFIER" "$SMAPS" "$MAPPINGS" "$CATEGORIES"

{
  printf 'category\taddress\tperms\toffset\tdevice\tinode\tpathname\tsize_kb\trss_kb\tpss_kb\tprivate_kb\tshared_kb\tanonymous_kb\tswap_kb\n'
  printf 'postgres-shared\t10000000-10001000\trw-s\t00000000\t00:01\t10\t/tmp/postgresql-wasix-1234\t100\t80\t50\t6\t15\t7\t8\n'
  printf 'postgres-shared\t11000000-11001000\trw-s\t00000000\t00:02\t11\t/dev/shm/PostgreSQL.123\t10\t9\t8\t1\t2\t3\t4\n'
  printf 'stack\t12000000-12001000\trw-p\t00000000\t00:00\t0\t[stack:42]\t20\t19\t18\t17\t16\t15\t14\n'
  printf 'heap\t13000000-13001000\trw-p\t00000000\t00:00\t0\t[heap]\t30\t29\t28\t27\t26\t25\t24\n'
  printf 'anonymous-exec\t14000000-14001000\tr-xp\t00000000\t00:00\t0\t\t40\t39\t38\t37\t36\t35\t34\n'
  printf 'anonymous-rw\t15000000-15001000\trw-p\t00000000\t00:00\t0\t\t50\t49\t48\t47\t46\t45\t44\n'
  printf 'anonymous-reserved\t16000000-16001000\t---p\t00000000\t00:00\t0\t\t60\t0\t0\t0\t0\t0\t0\n'
  printf 'anonymous-other\t17000000-17001000\tr--p\t00000000\t00:00\t0\t[vvar]\t70\t69\t68\t67\t66\t65\t64\n'
  printf 'file-executable\t18000000-18001000\tr-xp\t00000000\t08:01\t12\t/opt/with space/module.so\t80\t79\t78\t77\t76\t75\t74\n'
  printf 'file-backed\t19000000-19001000\tr--p\t00000000\t08:01\t13\t/opt/data.bin\t90\t89\t88\t87\t86\t85\t84\n'
} >"$EXPECTED_MAPPINGS"

{
  printf 'category\tmappings\tsize_kb\trss_kb\tpss_kb\tprivate_kb\tshared_kb\tanonymous_kb\tswap_kb\n'
  printf 'postgres-shared\t2\t110\t89\t58\t7\t17\t10\t12\n'
  printf 'stack\t1\t20\t19\t18\t17\t16\t15\t14\n'
  printf 'heap\t1\t30\t29\t28\t27\t26\t25\t24\n'
  printf 'anonymous-exec\t1\t40\t39\t38\t37\t36\t35\t34\n'
  printf 'anonymous-rw\t1\t50\t49\t48\t47\t46\t45\t44\n'
  printf 'anonymous-reserved\t1\t60\t0\t0\t0\t0\t0\t0\n'
  printf 'anonymous-other\t1\t70\t69\t68\t67\t66\t65\t64\n'
  printf 'file-executable\t1\t80\t79\t78\t77\t76\t75\t74\n'
  printf 'file-backed\t1\t90\t89\t88\t87\t86\t85\t84\n'
  printf 'total\t10\t550\t462\t424\t366\t369\t355\t350\n'
} >"$EXPECTED_CATEGORIES"

diff -u "$EXPECTED_MAPPINGS" "$MAPPINGS"
diff -u "$EXPECTED_CATEGORIES" "$CATEGORIES"

printf 'Linux smaps summary tests passed\n'
