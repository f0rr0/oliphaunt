#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$script_dir/fetch-pinned-git-checkout.sh"
real_git="$(command -v git)"
real_mv="$(command -v mv)"
real_uname="$(command -v uname)"
original_path="$PATH"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-pinned-git-test.XXXXXX")"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "pinned Git checkout test failed: $*" >&2
  exit 1
}

upstream="$test_root/upstream"
mkdir -p "$upstream/extension"
"$real_git" init --quiet "$upstream"
"$real_git" -C "$upstream" config user.name "Oliphaunt Test"
"$real_git" -C "$upstream" config user.email "oliphaunt@example.invalid"
printf '* text=auto\n' >"$upstream/.gitattributes"
printf 'one\n' >"$upstream/extension/source.txt"
printf '[package]\nname = "fixture"\nversion = "0.0.0"\n' >"$upstream/extension/Cargo.toml"
"$real_git" -C "$upstream" add .gitattributes extension
"$real_git" -C "$upstream" commit --quiet -m one
commit_one="$("$real_git" -C "$upstream" rev-parse HEAD)"
printf 'two\n' >"$upstream/extension/source.txt"
"$real_git" -C "$upstream" add extension/source.txt
"$real_git" -C "$upstream" commit --quiet -m two
commit_two="$("$real_git" -C "$upstream" rev-parse HEAD)"

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

checkout=""
is_fetch=0
previous=""
for argument in "$@"; do
  if [ "$previous" = -C ]; then
    checkout="$argument"
  fi
  [ "$argument" != fetch ] || is_fetch=1
  previous="$argument"
done
printf 'args=%s\n' "$*" >>"$FAKE_GIT_LOG"
if [ "$is_fetch" = 1 ]; then
  printf 'fetch=1 allow_protocol=%s terminal_prompt=%s askpass=%s lfs_skip=%s\n' \
    "${GIT_ALLOW_PROTOCOL:-}" "${GIT_TERMINAL_PROMPT:-}" "${GIT_ASKPASS:-}" "${GIT_LFS_SKIP_SMUDGE:-}" \
    >>"$FAKE_GIT_LOG"
  case "${FAKE_GIT_MODE:-success}" in
    transport)
      mkdir -p "$checkout/.git/objects"
      printf partial >"$checkout/.git/objects/partial-download"
      exit 128
      ;;
    transient)
      transient_count=0
      if [ -f "$FAKE_TRANSIENT_COUNTER" ]; then
        transient_count="$(cat "$FAKE_TRANSIENT_COUNTER")"
      fi
      transient_count=$((transient_count + 1))
      printf '%s\n' "$transient_count" >"$FAKE_TRANSIENT_COUNTER"
      if [ "$transient_count" -le "$FAKE_TRANSIENT_FAILURES" ]; then
        mkdir -p "$checkout/.git/objects"
        printf partial >"$checkout/.git/objects/partial-download"
        exit 128
      fi
      [ ! -e "$checkout/.git/objects/partial-download" ] || exit 88
      ;;
    hang)
      trap 'exit 143' TERM
      while :; do sleep 1; done
      ;;
    interrupt)
      trap 'exit 143' TERM
      kill -TERM "$PPID"
      while :; do sleep 1; done
      ;;
    mutate)
      printf 'concurrent user state\n' >"$FAKE_MUTATE_DEST/concurrent-user-file"
      ;;
    success | wrong)
      ;;
    *) exit 2 ;;
  esac
  requested_commit="${@: -1}"
  if [ "${FAKE_GIT_MODE:-success}" = wrong ]; then
    requested_commit="$FAKE_WRONG_COMMIT"
  fi
  unset GIT_ALLOW_PROTOCOL
  exec "$REAL_GIT" -C "$checkout" \
    fetch --quiet --force --no-tags --depth=1 --no-recurse-submodules \
    "file://$FAKE_GIT_REMOTE" "$requested_commit"
fi
exec "$REAL_GIT" "$@"
EOF
chmod +x "$fake_bin/git"

cat >"$fake_bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
last=""
for argument in "$@"; do last="$argument"; done
if [ -n "${FAKE_MV_FAIL_TARGET:-}" ] && [ "$last" = "$FAKE_MV_FAIL_TARGET" ] && [ ! -e "$FAKE_MV_FAILURE_MARKER" ]; then
  : >"$FAKE_MV_FAILURE_MARKER"
  exit 91
fi
exec "$REAL_MV" "$@"
EOF
chmod +x "$fake_bin/mv"

cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" = 1 ] && [ "$1" = -s ] && [ -n "${FAKE_UNAME_S:-}" ]; then
  printf '%s\n' "$FAKE_UNAME_S"
  exit 0
fi
exec "$REAL_UNAME" "$@"
EOF
chmod +x "$fake_bin/uname"

git_log="$test_root/git.log"
mv_failure_marker="$test_root/mv-failed-once"
transient_counter="$test_root/transient-count"
checkout_root="$test_root/checkouts"
mkdir -p "$checkout_root"

run_fetch() {
  local destination="$1"
  local expected_commit="$2"
  local mode="${3:-success}"
  local max_kib="${4:-65536}"
  env \
    PATH="$fake_bin:$original_path" \
    REAL_GIT="$real_git" \
    REAL_MV="$real_mv" \
    REAL_UNAME="$real_uname" \
    FAKE_GIT_REMOTE="$upstream" \
    FAKE_GIT_LOG="$git_log" \
    FAKE_GIT_MODE="$mode" \
    FAKE_WRONG_COMMIT="$commit_one" \
    FAKE_MUTATE_DEST="$destination" \
    FAKE_MV_FAIL_TARGET="${FAKE_MV_FAIL_TARGET:-}" \
    FAKE_MV_FAILURE_MARKER="$mv_failure_marker" \
    FAKE_TRANSIENT_COUNTER="$transient_counter" \
    FAKE_TRANSIENT_FAILURES="${FAKE_TRANSIENT_FAILURES:-2}" \
    FAKE_UNAME_S="${FAKE_UNAME_S:-}" \
    OLIPHAUNT_EXTERNAL_PGRX_FETCH_TIMEOUT_SECONDS="${OLIPHAUNT_EXTERNAL_PGRX_FETCH_TIMEOUT_SECONDS:-5}" \
    OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS="${OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS:-3}" \
    OLIPHAUNT_EXTERNAL_PGRX_FETCH_RETRY_DELAY_SECONDS="${OLIPHAUNT_EXTERNAL_PGRX_FETCH_RETRY_DELAY_SECONDS:-0}" \
    OLIPHAUNT_EXTERNAL_PGRX_ALLOW_DIRTY="${OLIPHAUNT_EXTERNAL_PGRX_ALLOW_DIRTY:-0}" \
    "$helper" fixture \
      https://github.com/example/fixture.git \
      refs/heads/main \
      "$expected_commit" \
      "$destination" \
      "$max_kib"
}

assert_head() {
  local checkout="$1"
  local expected="$2"
  [ "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected" ] || fail "$checkout HEAD changed"
}

assert_no_debris() {
  local checkout="$1"
  local parent
  local name
  parent="$(dirname "$checkout")"
  name="$(basename "$checkout")"
  if compgen -G "$parent/.$name.fetch.*" >/dev/null; then
    fail "transaction debris remains beside $checkout"
  fi
  [ ! -e "$parent/.$name.oliphaunt-fetch.lock" ] || fail "owned lock remains beside $checkout"
}

create_directory_link() {
  local target="$1"
  local linked_path="$2"
  local host_os
  host_os="$("$real_uname" -s)"
  case "$host_os" in
    MINGW* | MSYS* | CYGWIN*)
      command -v cygpath >/dev/null 2>&1 || fail "cygpath is unavailable for the Windows linked-directory fixture"
      command -v cmd.exe >/dev/null 2>&1 || fail "cmd.exe is unavailable for the Windows linked-directory fixture"
      local target_windows
      local linked_path_windows
      target_windows="$(cygpath -aw "$target")"
      linked_path_windows="$(cygpath -aw "$linked_path")"
      # Git Bash may implement `ln -s <directory>` as a deep copy when native
      # symlink creation is unavailable. A directory junction is an actual
      # reparse-point alias and does not require Developer Mode or elevation.
      MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c mklink /J "$linked_path_windows" "$target_windows" >/dev/null || \
        fail "could not create the Windows linked-directory fixture"
      ;;
    *)
      ln -s "$target" "$linked_path"
      [ -L "$linked_path" ] || fail "could not create the POSIX linked-directory fixture"
      ;;
  esac
}

assert_directory_link_aliases_target() {
  local target="$1"
  local linked_path="$2"
  local marker=".oliphaunt-link-proof.$$"
  [ -L "$linked_path" ] || fail "linked-directory fixture is not recognized as a link"
  [ -d "$linked_path" ] || fail "linked-directory fixture disappeared"
  if [ -e "$target/$marker" ] || [ -e "$linked_path/$marker" ]; then
    fail "linked-directory proof marker already exists"
  fi
  printf 'linked-directory-proof\n' >"$linked_path/$marker"
  [ "$(cat "$target/$marker" 2>/dev/null || true)" = linked-directory-proof ] || \
    fail "linked-directory fixture does not alias its target"
  rm -f "$target/$marker"
  [ ! -e "$linked_path/$marker" ] || fail "linked-directory fixture stopped aliasing its target"
}

remove_directory_link() {
  local linked_path="$1"
  local host_os
  host_os="$("$real_uname" -s)"
  case "$host_os" in
    MINGW* | MSYS* | CYGWIN*)
      local linked_path_windows
      linked_path_windows="$(cygpath -aw "$linked_path")"
      MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c rmdir "$linked_path_windows" >/dev/null || \
        fail "could not remove the Windows linked-directory fixture"
      ;;
    *)
      rm "$linked_path"
      ;;
  esac
}

fetch_count() {
  [ -f "$git_log" ] || { printf '0\n'; return; }
  grep -c '^fetch=1 ' "$git_log" || true
}

invalid_checkout="$checkout_root/invalid-url"
if env PATH="$fake_bin:$original_path" "$helper" fixture \
  http://github.com/example/fixture.git HEAD "$commit_one" "$invalid_checkout" 65536 >/dev/null 2>&1; then
  fail "non-HTTPS repository was accepted"
fi
[ ! -e "$invalid_checkout" ] || fail "invalid URL created a checkout"
if OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS=5 run_fetch "$invalid_checkout" "$commit_one" >/dev/null 2>&1; then
  fail "unbounded Git fetch attempt count was accepted"
fi
if OLIPHAUNT_EXTERNAL_PGRX_FETCH_RETRY_DELAY_SECONDS=6 run_fetch "$invalid_checkout" "$commit_one" >/dev/null 2>&1; then
  fail "unbounded Git retry delay was accepted"
fi

cache_checkout="$checkout_root/cache"
run_fetch "$cache_checkout" "$commit_one" >/dev/null
assert_head "$cache_checkout" "$commit_one"
[ "$("$real_git" -C "$cache_checkout" config --local --get core.autocrlf)" = false ] || fail "checkout does not pin core.autocrlf=false"
[ "$("$real_git" -C "$cache_checkout" config --local --get core.eol)" = lf ] || fail "checkout does not pin core.eol=lf"
[ -z "$("$real_git" -C "$cache_checkout" status --porcelain=v1 --untracked-files=all)" ] || fail "new checkout is dirty"
[ "$(cat "$cache_checkout/extension/source.txt")" = one ] || fail "new checkout has the wrong source"
grep -F 'protocol.allow=never' "$git_log" >/dev/null || fail "protocol deny-by-default was not passed to Git"
grep -F 'protocol.https.allow=always' "$git_log" >/dev/null || fail "HTTPS was not explicitly allowed"
grep -F 'http.followRedirects=false' "$git_log" >/dev/null || fail "Git redirects were not disabled"
grep -F 'http.lowSpeedTime=30' "$git_log" >/dev/null || fail "Git low-speed timeout was not configured"
grep -F 'allow_protocol=https terminal_prompt=0 askpass=/bin/false lfs_skip=1' "$git_log" >/dev/null || fail "noninteractive HTTPS-only Git environment is incomplete"
assert_no_debris "$cache_checkout"
before_fetches="$(fetch_count)"
run_fetch "$cache_checkout" "$commit_one" transport >/dev/null
[ "$(fetch_count)" = "$before_fetches" ] || fail "identity cache hit performed network I/O"

printf 'local edit\n' >>"$cache_checkout/extension/source.txt"
printf 'untracked\n' >"$cache_checkout/local-untracked"
dirty_before="$("$real_git" -C "$cache_checkout" status --porcelain=v1 --untracked-files=all)"
before_fetches="$(fetch_count)"
if OLIPHAUNT_EXTERNAL_PGRX_ALLOW_DIRTY=1 run_fetch "$cache_checkout" "$commit_two" success >/dev/null 2>&1; then
  fail "fetch replaced a dirty checkout"
fi
[ "$("$real_git" -C "$cache_checkout" status --porcelain=v1 --untracked-files=all)" = "$dirty_before" ] || fail "dirty checkout state changed"
assert_head "$cache_checkout" "$commit_one"
[ "$(fetch_count)" = "$before_fetches" ] || fail "dirty checkout rejection performed network I/O"
assert_no_debris "$cache_checkout"

transport_checkout="$checkout_root/transport"
run_fetch "$transport_checkout" "$commit_one" >/dev/null
before_fetches="$(fetch_count)"
if run_fetch "$transport_checkout" "$commit_two" transport >/dev/null 2>&1; then
  fail "partial transport failure succeeded"
fi
[ "$(( $(fetch_count) - before_fetches ))" -eq 3 ] || fail "persistent transport failure did not stop at the bounded attempt count"
assert_head "$transport_checkout" "$commit_one"
[ "$(cat "$transport_checkout/extension/source.txt")" = one ] || fail "transport failure changed prior source"
assert_no_debris "$transport_checkout"

transient_checkout="$checkout_root/transient"
rm -f "$transient_counter"
before_fetches="$(fetch_count)"
if ! run_fetch "$transient_checkout" "$commit_two" transient >/dev/null 2>&1; then
  fail "transient Git transport did not recover within the bounded retry budget"
fi
[ "$(( $(fetch_count) - before_fetches ))" -eq 3 ] || fail "transient transport recovery did not use the expected bounded attempts"
[ "$(cat "$transient_counter")" = 3 ] || fail "transient transport counter did not reach recovery"
assert_head "$transient_checkout" "$commit_two"
assert_no_debris "$transient_checkout"

wrong_checkout="$checkout_root/wrong"
if run_fetch "$wrong_checkout" "$commit_two" wrong >/dev/null 2>&1; then
  fail "wrong fetched commit was accepted"
fi
[ ! -e "$wrong_checkout" ] || fail "wrong identity was promoted"
assert_no_debris "$wrong_checkout"

bounded_checkout="$checkout_root/bounded"
if run_fetch "$bounded_checkout" "$commit_two" success 1 >/dev/null 2>&1; then
  fail "checkout exceeding its size bound succeeded"
fi
[ ! -e "$bounded_checkout" ] || fail "oversized checkout was promoted"
assert_no_debris "$bounded_checkout"

windows_checkout="$checkout_root/windows-resource-limit"
if ! FAKE_UNAME_S=MINGW64_NT-10.0 run_fetch "$windows_checkout" "$commit_two" success >/dev/null 2>&1; then
  fail "Git for Windows resource-limit compatibility path failed"
fi
assert_head "$windows_checkout" "$commit_two"
assert_no_debris "$windows_checkout"

timeout_checkout="$checkout_root/timeout"
start_seconds="$(date +%s)"
if OLIPHAUNT_EXTERNAL_PGRX_FETCH_TIMEOUT_SECONDS=1 OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS=1 run_fetch "$timeout_checkout" "$commit_two" hang >/dev/null 2>&1; then
  fail "hung Git fetch succeeded"
fi
elapsed_seconds=$(( $(date +%s) - start_seconds ))
# One attempt may consume its one-second deadline plus the documented
# five-second TERM grace period. Leave scheduling headroom for hosted Windows
# and macOS runners without weakening the production deadline.
[ "$elapsed_seconds" -lt 12 ] || fail "Git fetch timeout was not bounded"
[ ! -e "$timeout_checkout" ] || fail "timed-out checkout was promoted"
assert_no_debris "$timeout_checkout"

interrupted_checkout="$checkout_root/interrupted"
run_fetch "$interrupted_checkout" "$commit_one" >/dev/null
if run_fetch "$interrupted_checkout" "$commit_two" interrupt >/dev/null 2>&1; then
  fail "interrupted Git fetch succeeded"
fi
assert_head "$interrupted_checkout" "$commit_one"
assert_no_debris "$interrupted_checkout"

rollback_checkout="$checkout_root/rollback"
run_fetch "$rollback_checkout" "$commit_one" >/dev/null
rm -f "$mv_failure_marker"
if FAKE_MV_FAIL_TARGET="$rollback_checkout" run_fetch "$rollback_checkout" "$commit_two" success >/dev/null 2>&1; then
  fail "injected promotion failure succeeded"
fi
assert_head "$rollback_checkout" "$commit_one"
[ "$(cat "$rollback_checkout/extension/source.txt")" = one ] || fail "promotion failure did not restore prior checkout"
assert_no_debris "$rollback_checkout"

changed_checkout="$checkout_root/changed-during-fetch"
run_fetch "$changed_checkout" "$commit_one" >/dev/null
if run_fetch "$changed_checkout" "$commit_two" mutate >/dev/null 2>&1; then
  fail "promotion ignored a concurrent checkout change"
fi
assert_head "$changed_checkout" "$commit_one"
[ -f "$changed_checkout/concurrent-user-file" ] || fail "concurrent user state was not preserved"
assert_no_debris "$changed_checkout"

replacement_checkout="$checkout_root/replacement"
run_fetch "$replacement_checkout" "$commit_one" >/dev/null
run_fetch "$replacement_checkout" "$commit_two" >/dev/null
assert_head "$replacement_checkout" "$commit_two"
[ "$(cat "$replacement_checkout/extension/source.txt")" = two ] || fail "clean transactional replacement has wrong source"
assert_no_debris "$replacement_checkout"

locked_checkout="$checkout_root/locked"
lock_dir="$checkout_root/.locked.oliphaunt-fetch.lock"
mkdir "$lock_dir"
printf 'stale sentinel\n' >"$lock_dir/owner"
if run_fetch "$locked_checkout" "$commit_one" >/dev/null 2>&1; then
  fail "existing lock was ignored"
fi
[ -f "$lock_dir/owner" ] || fail "unowned lock was removed"
[ ! -e "$locked_checkout" ] || fail "locked fetch created a checkout"
rm -rf "$lock_dir"

linked_target="$checkout_root/linked-target"
linked_checkout="$checkout_root/linked"
run_fetch "$linked_target" "$commit_one" >/dev/null
assert_head "$linked_target" "$commit_one"
create_directory_link "$linked_target" "$linked_checkout"
assert_directory_link_aliases_target "$linked_target" "$linked_checkout"
[ -z "$("$real_git" -C "$linked_target" status --porcelain=v1 --untracked-files=all)" ] || \
  fail "linked-directory proof dirtied its target"
if run_fetch "$linked_checkout" "$commit_one" >/dev/null 2>&1; then
  fail "linked checkout destination was accepted"
fi
assert_head "$linked_target" "$commit_one"
[ "$(cat "$linked_target/extension/source.txt")" = one ] || fail "linked checkout target source was mutated"
[ -z "$("$real_git" -C "$linked_target" status --porcelain=v1 --untracked-files=all)" ] || \
  fail "linked checkout target was dirtied"
assert_directory_link_aliases_target "$linked_target" "$linked_checkout"
assert_no_debris "$linked_checkout"
remove_directory_link "$linked_checkout"
[ ! -e "$linked_checkout" ] || fail "linked checkout fixture was not removed"
assert_head "$linked_target" "$commit_one"

nongit_checkout="$checkout_root/nongit"
mkdir "$nongit_checkout"
printf 'preserve\n' >"$nongit_checkout/sentinel"
if run_fetch "$nongit_checkout" "$commit_one" >/dev/null 2>&1; then
  fail "non-Git durable directory was replaced"
fi
[ "$(cat "$nongit_checkout/sentinel")" = preserve ] || fail "non-Git durable directory was mutated"
assert_no_debris "$nongit_checkout"

echo "pinned Git checkout adversarial tests passed"
