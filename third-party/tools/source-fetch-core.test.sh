#!/usr/bin/env bash
set -euo pipefail
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$tools/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
test_data="$tools/source-fetch-core.test.mts"
archive_tool="$tools/source-archive.mts"
export FETCH_TEST_GIT="$(command -v git)"
base_path="$PATH"
for scope in icu native-runtime wasix-runtime wasix-postmaster-runtime production-all; do
  plan="$scratch/plan-$scope"
  mkdir "$plan"
  bun "$tools/fetch-sources.mts" plan "$plan" "$scope" --force
  case "$scope" in
    icu|production-all) [[ -f "$plan/icu-data.json" ]] ;;
    *) [[ ! -f "$plan/icu-data.json" && -f "$plan/icu.json" ]] ;;
  esac
done
bun test "$test_data"
mkdir "$scratch/fixtures" "$scratch/bin"
bun "$test_data" prepare "$scratch/fixtures"
for name in git curl sleep; do
  cp "$tools/source-fetch-transport.test.sh" "$scratch/bin/$name"
  chmod +x "$scratch/bin/$name"
done
fail_command() {
  local expected="$1"
  shift
  if "$@" > "$scratch/failure.log" 2>&1; then
    printf 'unexpected success: %s\n' "$*" >&2
    exit 1
  fi
  grep -Eq "$expected" "$scratch/failure.log" || { cat "$scratch/failure.log" >&2; exit 1; }
}
fixtures="$scratch/fixtures"
bun "$archive_tool" validate "$fixtures/valid.tar.gz" pkg
bun "$archive_tool" extract "$fixtures/valid.tar.gz" pkg "$scratch/tar-out"
printf 'trusted bytes' > "$scratch/trusted"
for file in file.txt link.txt hard.txt; do cmp "$scratch/trusted" "$scratch/tar-out/$file"; done
[[ ! -e "$scratch/tar-out/pkg" ]]
bun "$archive_tool" validate "$fixtures/valid.zip" .
bun "$archive_tool" extract "$fixtures/valid.zip" . "$scratch/zip-out"
cmp "$scratch/trusted" "$scratch/zip-out/payload/data.bin"
for archive in "$fixtures"/*.tar.gz "$fixtures"/*.zip; do
  case "${archive##*/}" in valid.*|updated.tar.gz) continue;; esac
  prefix=pkg
  [[ "$archive" != *.zip ]] || prefix=.
  for operation in validate extract; do
    destination="$scratch/invalid-${archive##*/}"
    arguments=("$operation" "$archive" "$prefix")
    [[ "$operation" != extract ]] || arguments+=("$destination")
    if bun "$archive_tool" "${arguments[@]}" > "$scratch/failure.log" 2>&1; then
      printf 'unsafe archive accepted: %s %s\n' "$operation" "$archive" >&2
      exit 1
    fi
    ! grep -q 'usage: source-archive' "$scratch/failure.log"
    [[ ! -e "$destination" ]]
  done
done

# Only transport and retry delays are substituted. The source owner still runs
# its real Git checkout, archive verification, extraction and atomic promotion.
fetch() {
  local root="$1" pin="$2" mode="${3:-fetch}"
  PATH="$scratch/bin:$base_path" FETCH_TEST_ROOT="$root" FETCH_TEST_UPSTREAM="$root/upstream" \
    bash -c 'source "$1"; fetch_source "$2" "$3" "$4" "$5"' \
    source-fetch-test "$tools/fetch-sources.sh" "$pin" "$root/checkouts" "$root/archives" "$mode"
}
root="$scratch/archive"
mkdir -p "$root/archives"
sha="$(jq -r .sha256 "$fixtures/valid.json")"
cache="$root/archives/libiconv-$sha.tar.gz"
checkout="$root/checkouts/libiconv"
printf 'prior cache' > "$cache"
export FETCH_TEST_FAULT=all FETCH_TEST_ARCHIVE=''
fail_command 'transport fault:' fetch "$root" "$fixtures/valid.json"
grep -q 'https://ftp.gnu.org' "$scratch/failure.log"
grep -q 'https://ftpmirror.gnu.org' "$scratch/failure.log"
[[ "$(cat "$cache")" == 'prior cache' && ! -e "$checkout" ]]
export FETCH_TEST_FAULT=primary FETCH_TEST_ARCHIVE="$fixtures/updated.tar.gz"
fail_command 'archive sha256: expected' fetch "$root" "$fixtures/valid.json"
[[ "$(cat "$cache")" == 'prior cache' ]]
: > "$root/requests"
export FETCH_TEST_ARCHIVE="$fixtures/valid.tar.gz"
RUNNER_OS=Windows fetch "$root" "$fixtures/valid.json"
printf '%s\n' 'https://ftp.gnu.org/gnu/libiconv/libiconv-1.19.tar.gz' 'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz' > "$scratch/expected"
cmp "$scratch/expected" "$root/requests"
cmp "$cache" "$fixtures/valid.tar.gz"
cmp "$scratch/trusted" "$checkout/file.txt"
grep -q 'url=https://ftpmirror.gnu.org/' "$checkout/.oliphaunt-source-pin"
FETCH_TEST_FAULT=all fetch "$root" "$fixtures/valid.json" verify
bun "$root_dir/runtimes/liboliphaunt-wasix/tools/verify-source-tree.mts" --checkout "$checkout" --manifest "$fixtures/source.toml"
export FETCH_TEST_FAULT='' FETCH_TEST_ARCHIVE="$fixtures/traversal.tar.gz"
fail_command 'traversal|unsafe|escape' fetch "$root" "$fixtures/unsafe.json"
cmp "$scratch/trusted" "$checkout/file.txt"
export FETCH_TEST_ARCHIVE="$fixtures/updated.tar.gz"
fetch "$root" "$fixtures/updated.json"
[[ "$(cat "$checkout/file.txt")" == 'updated trusted bytes' ]]
printf 'local edit' > "$checkout/file.txt"
fail_command 'was modified' fetch "$root" "$fixtures/updated.json" verify
FETCH_TEST_ARCHIVE="$fixtures/valid.tar.gz" fail_command 'was modified' fetch "$root" "$fixtures/valid.json"
[[ "$(cat "$checkout/file.txt")" == 'local edit' ]]
[[ "$(ls -A "$root/checkouts")" == libiconv ]]

root="$scratch/zip"
checkout="$root/checkouts/fixture"
mkdir -p "$checkout"
printf keep > "$checkout/local"
export FETCH_TEST_ARCHIVE="$fixtures/valid.zip"
fail_command 'is unmanaged' fetch "$root" "$fixtures/zip.json"
[[ ! -s "$root/requests" && "$(cat "$checkout/local")" == keep ]]
rm -r "$checkout"
fetch "$root" "$fixtures/zip.json"
cmp "$scratch/trusted" "$checkout/payload/data.bin"
fetch "$root" "$fixtures/zip.json" verify

init_repo() {
  local repository="$1" contents="$2" branch="${3:-old}"
  mkdir -p "$repository"
  git -C "$repository" init --quiet --initial-branch="$branch"
  git -C "$repository" config user.name 'Source Fetch Test'
  git -C "$repository" config user.email source-fetch@example.invalid
  printf '%s' "$contents" > "$repository/source.txt"
  git -C "$repository" add source.txt
  git -C "$repository" commit --quiet -m 'test source'
}
root="$scratch/git"
init_repo "$root/upstream" 'new bytes' upstream
commit="$(git -C "$root/upstream" rev-parse HEAD)"
bun "$test_data" git-pin "$root" "$commit"
checkout="$root/checkouts/source"
init_repo "$checkout" prior
prior="$(git -C "$checkout" rev-parse HEAD)"
FETCH_TEST_FAULT=all fail_command 'transport fault' fetch "$root" "$root/pin.json"
primary=https://primary.example.invalid/source.git
mirror=https://mirror.example.invalid/source.git
printf '%s\n' "$primary" "$mirror" "$primary" "$mirror" "$primary" > "$scratch/expected"
cmp "$scratch/expected" "$root/requests"
printf '%s\n' 5 10 > "$scratch/expected"
cmp "$scratch/expected" "$root/sleeps"
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$prior" ]]
jq '.commit = "1111111111111111111111111111111111111111"' "$root/pin.json" > "$root/wrong.json"
FETCH_TEST_FAULT=primary FETCH_TEST_COMMIT="$commit" fail_command 'expected exact commit' fetch "$root" "$root/wrong.json"
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$prior" ]]
: > "$root/requests"
: > "$root/sleeps"
FETCH_TEST_FAULT=primary fetch "$root" "$root/pin.json"
printf '%s\n' "$primary" "$mirror" > "$scratch/expected"
cmp "$scratch/expected" "$root/requests"
[[ ! -s "$root/sleeps" ]]
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$commit" ]]
[[ "$(git -C "$checkout" remote get-url origin)" == "$primary" ]]
[[ "$(git -C "$checkout" branch --show-current)" == pinned ]]
: > "$root/requests"
FETCH_TEST_FAULT=all fetch "$root" "$root/pin.json" verify
FETCH_TEST_FAULT=all fetch "$root" "$root/pin.json"
[[ ! -s "$root/requests" ]]
printf 'local edit' > "$checkout/source.txt"
fail_command 'uncommitted changes' fetch "$root" "$root/pin.json"
[[ "$(cat "$checkout/source.txt")" == 'local edit' ]]
[[ "$(ls -A "$root/checkouts")" == source ]]

root="$scratch/git-lf"
init_repo "$root/upstream" $'first line\nsecond line\n' upstream
printf '* text=auto\n' > "$root/upstream/.gitattributes"
git -C "$root/upstream" add .gitattributes
git -C "$root/upstream" commit --quiet -m text
bun "$test_data" git-pin "$root" "$(git -C "$root/upstream" rev-parse HEAD)"
fetch "$root" "$root/pin.json"
checkout="$root/checkouts/source"
printf 'first line\nsecond line\n' > "$scratch/lf"
cmp "$scratch/lf" "$checkout/source.txt"
git -C "$checkout" config --local core.autocrlf true
git -C "$checkout" config --local core.eol crlf
rm "$checkout/source.txt"
git -C "$checkout" checkout -- source.txt
printf 'first line\r\nsecond line\r\n' > "$scratch/crlf"
cmp "$scratch/crlf" "$checkout/source.txt"
fetch "$root" "$root/pin.json"
cmp "$scratch/lf" "$checkout/source.txt"
printf '%s\n' "$primary" "$primary" > "$scratch/expected"
cmp "$scratch/expected" "$root/requests"

case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) echo 'Git symlink creation proof requires a Unix host'; exit 0;; esac
root="$scratch/git-links"
init_repo "$root/upstream" trusted upstream
mkdir "$root/outside" "$root/upstream/fixtures"
ln -s ../missing "$root/upstream/fixtures/dangling"
git -C "$root/upstream" add .
git -C "$root/upstream" commit --quiet -m dangling
commit="$(git -C "$root/upstream" rev-parse HEAD)"
bun "$test_data" git-pin "$root" "$commit"
fetch "$root" "$root/pin.json"
checkout="$root/checkouts/source"
ln -s "$root" "$scratch/git-alias"
FETCH_TEST_FAULT=all fetch "$scratch/git-alias" "$root/pin.json"
rm "$scratch/git-alias"
for transitive in false true; do
  if [[ "$transitive" == false ]]; then
    ln -s ../outside "$root/upstream/escape"
  else
    rm "$root/upstream/escape"
    ln -s z-escape/missing "$root/upstream/fixtures/a-dangling"
    ln -s ../../../../outside "$root/upstream/fixtures/z-escape"
  fi
  git -C "$root/upstream" add -A
  git -C "$root/upstream" commit --quiet -m escape
  bun "$test_data" git-pin "$root" "$(git -C "$root/upstream" rev-parse HEAD)"
  fail_command 'escaping.*symlink' fetch "$root" "$root/pin.json"
  [[ "$(git -C "$checkout" rev-parse HEAD)" == "$commit" ]]
done
rm -r "$checkout/.git"
ln -s "$root/upstream/.git" "$checkout/.git"
bun "$test_data" git-pin "$root" "$commit"
fail_command 'unsupported non-directory \.git metadata' fetch "$root" "$root/pin.json"
echo 'Source fetch: verified archives, fallback/retries, exact Git pins, LF repair, symlink containment and local-edit preservation passed'
