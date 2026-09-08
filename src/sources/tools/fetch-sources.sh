#!/usr/bin/env bash
set -euo pipefail
source_tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_core="$source_tools/source-fetch-core.mts"
# shellcheck source=tools/dev/curl-platform-flags.sh
source "$source_tools/../../../tools/dev/curl-platform-flags.sh"

source_git() {
  local seconds=$1 directory=$2 status=0
  shift 2
  # Bound both streams, including diagnostics, without holding them in memory.
  # pipefail rejects a producer killed by SIGPIPE; the byte count also catches
  # a producer that completed its last write before head closed the pipe.
  "$source_timeout" --kill-after=5 "$seconds" git -C "$directory" \
    -c core.fsmonitor=false -c submodule.recurse=false \
    -c core.autocrlf=false -c core.eol=lf "$@" \
    2> >(head -c 16777217 > "$source_stage/git-error") |
    head -c 16777217 > "$source_stage/git-output" || status=$?
  if (( $(wc -c < "$source_stage/git-output") > 16777216 )); then status=1; fi
  # Process substitution is asynchronous: wait for its reader before inspection.
  wait
  if (( $(wc -c < "$source_stage/git-error") > 16777216 )); then status=1; fi
  cat "$source_stage/git-error" >&2
  cat "$source_stage/git-output"
  return "$status"
}

source_snapshot() {
  local checkout=$1 snapshot=$2
  mkdir -p "$snapshot"
  if [[ -d "$checkout" && ! -L "$checkout" && -d "$checkout/.git" && ! -L "$checkout/.git" ]]; then
    source_git 60 "$checkout" rev-parse --show-toplevel > "$snapshot/worktree"
    source_git 60 "$checkout" rev-parse --absolute-git-dir > "$snapshot/git-directory"
    bun "$source_core" git-identity "$pin" "$checkout" "$snapshot"
    source_git 60 "$checkout" status --porcelain=v1 --untracked-files=all > "$snapshot/status"
    # Missing pin fields make a clean checkout stale; repository errors above
    # remain fatal. The data validator compares the complete snapshot.
    source_git 60 "$checkout" rev-parse --verify HEAD > "$snapshot/head" || : > "$snapshot/head"
    source_git 60 "$checkout" branch --show-current > "$snapshot/branch" || : > "$snapshot/branch"
    source_git 60 "$checkout" remote get-url origin > "$snapshot/origin" || : > "$snapshot/origin"
    source_git 60 "$checkout" config --local --get core.autocrlf > "$snapshot/autocrlf" || : > "$snapshot/autocrlf"
    source_git 60 "$checkout" config --local --get core.eol > "$snapshot/eol" || : > "$snapshot/eol"
  fi
}

fetch_source() (
  set -euo pipefail
  local pin=$1 checkout_root=$2 archive_root=$3 mode=$4
  local name kind url mirror branch commit archive_name canonical checkout readiness fetched
  mkdir -p "$checkout_root" "$archive_root"
  source_stage=$(mktemp -d "$checkout_root/.source-stage-XXXXXX")
  trap 'rm -rf "$source_stage"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  bun "$source_core" fields "$pin" > "$source_stage/fields"
  { IFS= read -r -d '' name; IFS= read -r -d '' kind; IFS= read -r -d '' url
    IFS= read -r -d '' mirror; IFS= read -r -d '' branch; IFS= read -r -d '' commit
    IFS= read -r -d '' archive_name; IFS= read -r -d '' canonical
  } < "$source_stage/fields"
  checkout="$checkout_root/$name"
  # Ignore ambient Git configuration, hooks, credentials, and alternate stores.
  while IFS= read -r variable; do
    case "$variable" in GIT_*) unset "$variable" ;; esac
  done < <(compgen -e)
  : > "$source_stage/empty.gitconfig"
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$source_stage/empty.gitconfig"
  export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never
  source_timeout=$(command -v timeout || command -v gtimeout) || {
    echo 'source fetching requires GNU timeout (brew install coreutils on macOS)' >&2; exit 1;
  }
  source_snapshot "$checkout" "$source_stage/durable"
  readiness=$(bun "$source_core" inspect "$pin" "$checkout" "$source_stage/durable")
  if [[ "$readiness" == ready ]]; then exit 0; fi
  if [[ "$mode" == verify ]]; then echo "source checkout $checkout is missing or stale" >&2; exit 1; fi

  local candidate="$source_stage/checkout"
  if [[ "$kind" == git ]]; then
    source_git 60 "$checkout_root" init --quiet --template= "$candidate"
    source_git 60 "$candidate" config --local core.autocrlf false
    source_git 60 "$candidate" config --local core.eol lf
    source_git 60 "$candidate" remote add origin "$url"
    local transports=("$url") attempt transport success=false
    if [[ -n "$mirror" ]]; then transports+=("$mirror"); fi
    for attempt in 1 2 3 4 5; do
      transport=${transports[$(((attempt - 1) % ${#transports[@]}))]}
      if source_git 300 "$candidate" \
        -c protocol.allow=never -c protocol.https.allow=always -c credential.helper= \
        -c http.followRedirects=false -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=120 \
        fetch --no-tags --depth=1 "$transport" "$commit"; then success=true; break; fi
      echo "fetch $name from $transport failed on attempt $attempt/5" >&2
      if (( attempt < 5 && attempt % ${#transports[@]} == 0 )); then
        sleep "$((attempt * 5 / ${#transports[@]}))"
      fi
    done
    "$success" || exit 1
    fetched=$(source_git 60 "$candidate" rev-parse --verify 'FETCH_HEAD^{commit}')
    if [[ "$fetched" != "$commit" ]]; then
      echo "fetch for $name returned $fetched, expected exact commit $commit" >&2; exit 1
    fi
    source_git 60 "$candidate" checkout --quiet -B "$branch" "$commit"
    source_snapshot "$candidate" "$source_stage/candidate"
    bun "$source_core" git-candidate "$pin" "$candidate" "$source_stage/candidate"
  else
    local archive="$archive_root/$archive_name" download="$source_stage/$archive_name"
    if [[ "$(bun "$source_core" archive-valid "$pin" "$archive")" != valid ]]; then
      local urls=() tls=() endpoint success=false
      if [[ -n "$canonical" ]]; then urls+=("$canonical"); fi
      urls+=("$url")
      local tls_flag
      tls_flag=$(oliphaunt_curl_platform_tls_flag)
      if [[ -n "$tls_flag" ]]; then tls+=("$tls_flag"); fi
      for endpoint in "${urls[@]}"; do
        if "$source_timeout" --kill-after=5 620 curl --disable --fail --location --silent --show-error \
          --retry 8 --retry-all-errors --retry-connrefused --retry-delay 5 --retry-max-time 600 \
          --connect-timeout 20 --max-time 600 --speed-limit 1024 --speed-time 120 \
          --max-filesize 1073741824 --max-redirs 5 --proto-default https \
          --proto '=https' --proto-redir '=https' --tlsv1.2 "${tls[@]}" \
          --remove-on-error --url "$endpoint" --output "$download"; then success=true; break; fi
        echo "download $name from $endpoint failed" >&2
        rm -f "$download"
      done
      "$success" || exit 1
      # An invalid candidate never replaces even a corrupt existing cache.
      [[ "$(bun "$source_core" archive-valid "$pin" "$download")" == valid ]]
      bun "$source_core" promote "$download" "$archive"
    fi
    bun "$source_core" unpack "$pin" "$archive" "$candidate"
  fi
  # Reinspect immediately before replacing an existing checkout, including a
  # source that changed kind. The promotion helper restores a prior tree on error.
  source_snapshot "$checkout" "$source_stage/durable"
  bun "$source_core" inspect "$pin" "$checkout" "$source_stage/durable" > /dev/null
  bun "$source_core" promote "$candidate" "$checkout"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cd "$source_tools/../../.."
  source_work=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-source-plan-XXXXXX")
  source_work=$(cd "$source_work" && pwd -P)
  trap 'rm -rf "$source_work"' EXIT
  bun "$source_tools/fetch-sources.mts" plan "$source_work" "$@"
  mode=$(cat "$source_work/mode")
  if [[ "$mode" != skip ]]; then
    while IFS= read -r -d '' pin; do
      fetch_source "$pin" "$PWD/target/oliphaunt-sources/checkouts" "$PWD/target/oliphaunt-sources/archives" "$mode"
    done < "$source_work/pins"
    bun "$source_tools/fetch-sources.mts" audit "$(cat "$source_work/extension-count")"
  fi
fi
