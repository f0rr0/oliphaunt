#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: fetch-pinned-git-checkout.sh <label> <https-repository> <source-ref> <commit> <destination> <max-checkout-kib>" >&2
  exit 2
fi

label="$1"
repository="$2"
source_ref="$3"
commit="$4"
destination="$5"
max_checkout_kib="$6"
fetch_timeout_seconds="${OLIPHAUNT_EXTERNAL_PGRX_FETCH_TIMEOUT_SECONDS:-300}"
fetch_attempts="${OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS:-3}"
retry_delay_seconds="${OLIPHAUNT_EXTERNAL_PGRX_FETCH_RETRY_DELAY_SECONDS:-2}"

[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid pinned Git checkout label: $label" >&2; exit 2; }
[[ "$repository" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]] || {
  echo "pinned Git repository must be an exact credential-free HTTPS GitHub URL: $repository" >&2
  exit 2
}
[[ "$source_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid source ref for $label: $source_ref" >&2; exit 2; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid exact Git commit for $label: $commit" >&2; exit 2; }
if [[ ! "$max_checkout_kib" =~ ^[1-9][0-9]*$ ]] || [ "$max_checkout_kib" -gt 8388608 ]; then
  echo "max checkout size for $label must be between 1 KiB and 8 GiB" >&2
  exit 2
fi
if [[ ! "$fetch_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || [ "$fetch_timeout_seconds" -gt 1800 ]; then
  echo "OLIPHAUNT_EXTERNAL_PGRX_FETCH_TIMEOUT_SECONDS must be between 1 and 1800" >&2
  exit 2
fi
if [[ ! "$fetch_attempts" =~ ^[1-4]$ ]]; then
  echo "OLIPHAUNT_EXTERNAL_PGRX_FETCH_ATTEMPTS must be between 1 and 4" >&2
  exit 2
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-5]$ ]]; then
  echo "OLIPHAUNT_EXTERNAL_PGRX_FETCH_RETRY_DELAY_SECONDS must be between 0 and 5" >&2
  exit 2
fi
case "$destination" in
  /*) ;;
  *) echo "pinned Git checkout destination must be absolute: $destination" >&2; exit 2 ;;
esac

destination_parent="$(dirname "$destination")"
destination_name="$(basename "$destination")"
[[ "$destination_name" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "invalid pinned Git checkout destination name: $destination_name" >&2
  exit 2
}
mkdir -p "$destination_parent"
if [ ! -d "$destination_parent" ] || [ -L "$destination_parent" ]; then
  echo "pinned Git checkout parent must be a real directory: $destination_parent" >&2
  exit 1
fi

for command_name in git mktemp mv rm du uname; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "missing required command for pinned Git checkout: $command_name" >&2
    exit 1
  }
done

# Never inherit an ambient repository/worktree/object database into the staged
# checkout. Public upstream sources do not require interactive credentials.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

transaction_root=""
previous_checkout=""
lock_dir="$destination_parent/.$destination_name.oliphaunt-fetch.lock"
lock_owned=0
promotion_started=0
prior_moved=0
candidate_promoted=0
committed=0
active_command_pid=""
active_command_is_group=0

active_command_alive() {
  if [ -z "$active_command_pid" ]; then
    return 1
  fi
  if [ "$active_command_is_group" = 1 ]; then
    kill -0 -- "-$active_command_pid" 2>/dev/null || kill -0 "$active_command_pid" 2>/dev/null
  else
    kill -0 "$active_command_pid" 2>/dev/null
  fi
}

signal_active_command() {
  local signal="$1"
  [ -n "$active_command_pid" ] || return 0
  if [ "$active_command_is_group" = 1 ]; then
    kill "-$signal" -- "-$active_command_pid" 2>/dev/null || kill "-$signal" "$active_command_pid" 2>/dev/null || true
  else
    kill "-$signal" "$active_command_pid" 2>/dev/null || true
  fi
}

terminate_active_command() {
  local grace_ticks=50
  local elapsed_ticks=0
  [ -n "$active_command_pid" ] || return 0
  signal_active_command TERM
  while active_command_alive && [ "$elapsed_ticks" -lt "$grace_ticks" ]; do
    sleep 0.1
    elapsed_ticks=$((elapsed_ticks + 1))
  done
  if active_command_alive; then
    signal_active_command KILL
  fi
  wait "$active_command_pid" 2>/dev/null || true
  active_command_pid=""
  active_command_is_group=0
}

cleanup() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [ -n "$active_command_pid" ]; then
    terminate_active_command
  fi
  if [ "$promotion_started" = 1 ] && [ "$committed" != 1 ]; then
    if [ "$candidate_promoted" = 1 ]; then
      rm -rf "$destination" || status=1
    fi
    if [ "$prior_moved" = 1 ] && [ -d "$previous_checkout" ]; then
      mv "$previous_checkout" "$destination" || status=1
    fi
  fi
  [ -z "$transaction_root" ] || rm -rf "$transaction_root" || status=1
  if [ "$lock_owned" = 1 ]; then
    rm -rf "$lock_dir" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "another pinned Git fetch owns $lock_dir; wait for it to finish or remove a confirmed-stale lock" >&2
  exit 1
fi
lock_owned=1
printf 'pid=%s\nlabel=%s\ncommit=%s\n' "$$" "$label" "$commit" >"$lock_dir/owner"

git_status() {
  git -C "$1" status --porcelain=v1 --untracked-files=all
}

verify_checkout() {
  local checkout="$1"
  local expected_commit="$2"
  [ -d "$checkout" ] && [ ! -L "$checkout" ] && [ -d "$checkout/.git" ] && [ ! -L "$checkout/.git" ] || return 1
  [ "$(git -C "$checkout" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || return 1
  [ "$(git -C "$checkout" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" = "$expected_commit" ] || return 1
  git -C "$checkout" cat-file -e "$expected_commit^{commit}" 2>/dev/null || return 1
  [ "$(git -C "$checkout" config --local --get core.autocrlf 2>/dev/null)" = false ] || return 1
  [ "$(git -C "$checkout" config --local --get core.eol 2>/dev/null)" = lf ] || return 1
  [ -z "$(git_status "$checkout" 2>/dev/null)" ] || return 1
  git -C "$checkout" fsck --strict --no-dangling >/dev/null 2>&1
}

prior_exists=0
prior_head=""
if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ -L "$destination" ] || [ ! -d "$destination" ] || [ ! -d "$destination/.git" ] || [ -L "$destination/.git" ]; then
    echo "refusing to replace non-standard pinned Git checkout path: $destination" >&2
    exit 1
  fi
  if [ "$(git -C "$destination" rev-parse --is-inside-work-tree 2>/dev/null || true)" != true ]; then
    echo "existing pinned Git checkout is not a valid worktree: $destination" >&2
    exit 1
  fi
  prior_head="$(git -C "$destination" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  [ -n "$prior_head" ] || { echo "existing pinned Git checkout has no valid HEAD: $destination" >&2; exit 1; }
  prior_status="$(git_status "$destination" 2>/dev/null || printf '__status_failed__')"
  if [ -n "$prior_status" ]; then
    echo "refusing to fetch over a dirty external extension checkout: $destination" >&2
    echo "the existing tracked, staged, and untracked state was left untouched" >&2
    exit 1
  fi
  prior_exists=1
  if [ "$prior_head" = "$commit" ] && verify_checkout "$destination" "$commit"; then
    echo "identity-verified external extension checkout already present for $label at $commit"
    exit 0
  fi
fi

transaction_root="$(mktemp -d "$destination_parent/.$destination_name.fetch.XXXXXX")"
candidate_checkout=""
empty_home="$transaction_root/home"
mkdir -p "$empty_home"

initialize_candidate() {
  candidate_checkout="$transaction_root/candidate"
  rm -rf "$candidate_checkout"
  git init --quiet "$candidate_checkout"
  git -C "$candidate_checkout" config core.protectHFS true
  git -C "$candidate_checkout" config core.protectNTFS true
  # Upstream `text=auto` attributes must not make pinned build inputs depend on
  # whether the checkout host uses LF or CRLF worktree conventions.
  git -C "$candidate_checkout" config core.autocrlf false
  git -C "$candidate_checkout" config core.eol lf
}

run_bounded() {
  local timeout_seconds="$1"
  shift
  local elapsed_ticks=0
  local timeout_ticks=$((timeout_seconds * 10))
  local status
  # A dedicated process group lets a timeout stop Git's transport helpers as
  # well as the top-level Git process. Fall back to PID signalling only on a
  # Bash implementation that cannot enable job control.
  if set -m 2>/dev/null; then
    "$@" &
    active_command_pid="$!"
    active_command_is_group=1
    set +m
  else
    "$@" &
    active_command_pid="$!"
    active_command_is_group=0
  fi
  while active_command_alive; do
    if [ "$elapsed_ticks" -ge "$timeout_ticks" ]; then
      terminate_active_command
      return 124
    fi
    sleep 0.1
    elapsed_ticks=$((elapsed_ticks + 1))
  done
  set +e
  wait "$active_command_pid"
  status="$?"
  set -e
  active_command_pid=""
  active_command_is_group=0
  return "$status"
}

fetch_into_candidate() {
  # POSIX file-size limits are expressed in 512-byte blocks. The staged tree is
  # also measured after checkout, so both the incoming pack and final footprint
  # are bounded.
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      # Git for Windows reports an unsupported POSIX file-size resource limit.
      # The staged checkout is still isolated and rejected by the exact `du`
      # bound below before it can replace durable state.
      ;;
    *)
      ulimit -f "$((max_checkout_kib * 2))"
      ;;
  esac
  exec env \
    HOME="$empty_home" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/false \
    GIT_SSH_COMMAND=/bin/false \
    GIT_ALLOW_PROTOCOL=https \
    GIT_LFS_SKIP_SMUDGE=1 \
    git \
      -c protocol.version=2 \
      -c protocol.allow=never \
      -c protocol.https.allow=always \
      -c http.followRedirects=false \
      -c http.sslVerify=true \
      -c http.lowSpeedLimit=1 \
      -c http.lowSpeedTime=30 \
      -c http.maxRequests=1 \
      -c fetch.fsckObjects=true \
      -c transfer.fsckObjects=true \
      -C "$candidate_checkout" \
      fetch --force --no-tags --depth=1 --no-recurse-submodules "$repository" "$commit"
}

fetch_succeeded=0
attempt=1
while [ "$attempt" -le "$fetch_attempts" ]; do
  initialize_candidate
  echo "fetching exact $label commit $commit from $repository (source ref: $source_ref; attempt $attempt/$fetch_attempts)"
  if run_bounded "$fetch_timeout_seconds" fetch_into_candidate; then
    fetch_succeeded=1
    break
  else
    fetch_status="$?"
  fi
  if [ "$fetch_status" = 124 ]; then
    echo "bounded Git fetch attempt $attempt timed out after ${fetch_timeout_seconds}s for $label" >&2
  else
    echo "bounded Git fetch attempt $attempt failed for $label" >&2
  fi
  rm -rf "$candidate_checkout"
  if [ "$attempt" -lt "$fetch_attempts" ]; then
    backoff_seconds=$((retry_delay_seconds * attempt))
    if [ "$backoff_seconds" -gt 0 ]; then
      echo "retrying exact $label commit after ${backoff_seconds}s" >&2
      sleep "$backoff_seconds"
    fi
  fi
  attempt=$((attempt + 1))
done
if [ "$fetch_succeeded" != 1 ]; then
  echo "bounded Git fetch exhausted $fetch_attempts exact-commit attempts for $label" >&2
  exit 1
fi

fetched_commit="$(git -C "$candidate_checkout" rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null || true)"
if [ "$fetched_commit" != "$commit" ]; then
  echo "fetched Git identity mismatch for $label: expected $commit, got ${fetched_commit:-<missing>}" >&2
  exit 1
fi
GIT_LFS_SKIP_SMUDGE=1 git \
  -c filter.lfs.smudge= \
  -c filter.lfs.required=false \
  -C "$candidate_checkout" \
  checkout --quiet --detach --force "$commit"
verify_checkout "$candidate_checkout" "$commit" || {
  echo "staged Git checkout failed exact-commit, clean-tree, or object-integrity verification for $label" >&2
  exit 1
}
candidate_kib="$(du -sk "$candidate_checkout" | awk '{print $1}')"
if [[ ! "$candidate_kib" =~ ^[0-9]+$ ]] || [ "$candidate_kib" -gt "$max_checkout_kib" ]; then
  echo "staged Git checkout for $label exceeds ${max_checkout_kib} KiB" >&2
  exit 1
fi

# Revalidate the durable path immediately before the first rename. A user edit,
# checkout change, or concurrent creator must be preserved rather than folded
# into this transaction.
if [ "$prior_exists" = 1 ]; then
  if [ -L "$destination" ] || [ ! -d "$destination/.git" ] || \
    [ "$(git -C "$destination" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)" != "$prior_head" ] || \
    [ -n "$(git_status "$destination" 2>/dev/null || printf '__status_failed__')" ]; then
    echo "existing external extension checkout changed during fetch; preserving it and refusing promotion" >&2
    exit 1
  fi
elif [ -e "$destination" ] || [ -L "$destination" ]; then
  echo "external extension checkout appeared during fetch; refusing promotion" >&2
  exit 1
fi

previous_checkout="$transaction_root/previous"
promotion_started=1
if [ "$prior_exists" = 1 ]; then
  mv "$destination" "$previous_checkout"
  prior_moved=1
fi
mv "$candidate_checkout" "$destination"
candidate_promoted=1
verify_checkout "$destination" "$commit" || {
  echo "promoted Git checkout failed identity verification for $label; rolling back" >&2
  exit 1
}
committed=1
echo "installed identity-verified external extension checkout for $label at $commit"
