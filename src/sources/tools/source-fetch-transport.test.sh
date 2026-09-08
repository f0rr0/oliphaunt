#!/usr/bin/env bash
set -euo pipefail
case "${0##*/}" in
  sleep) printf '%s\n' "$1" >> "$FETCH_TEST_ROOT/sleeps" ;;
  git)
    args=("$@")
    if [[ " $* " == *' fetch '* ]]; then
      count=${#args[@]}
      url=${args[$((count-2))]}
      printf '%s\n' "$url" >> "$FETCH_TEST_ROOT/requests"
      if [[ ${FETCH_TEST_FAULT:-} == all || (${FETCH_TEST_FAULT:-} == primary && "$url" != https://mirror.example.invalid/source.git) ]]; then
        echo "transport fault: $url" >&2; exit 1
      fi
      # Only substitute the transport. Real Git owns object storage, checkout,
      # pin verification, status, line endings, and symlinks in these checks.
      exec "$FETCH_TEST_GIT" -C "${args[1]}" -c protocol.file.allow=always \
        fetch --no-tags --depth=1 "$FETCH_TEST_UPSTREAM" "${FETCH_TEST_COMMIT:-${args[$((count-1))]}}"
    fi
    exec "$FETCH_TEST_GIT" -c core.autocrlf=true -c core.eol=crlf "$@"
    ;;
  curl)
    [[ "$1" == --disable ]]
    case " $* " in *' --insecure '*|*' -k '*) exit 90 ;; esac
    for required in '--proto =https' '--proto-redir =https' '--max-filesize 1073741824' '--max-time 600' '--tlsv1.2'; do
      [[ " $* " == *" $required "* ]] || exit 91
    done
    if [[ ${RUNNER_OS:-} == Windows ]]; then [[ " $* " == *' --ssl-revoke-best-effort '* ]]; fi
    url='' output=''
    while (( $# )); do
      case "$1" in --url) url=$2; shift ;; --output) output=$2; shift ;; esac
      shift
    done
    printf '%s\n' "$url" >> "$FETCH_TEST_ROOT/requests"
    if [[ ${FETCH_TEST_FAULT:-} == all || (${FETCH_TEST_FAULT:-} == primary && "$url" == https://ftp.gnu.org/*) ]]; then
      echo "transport fault: $url" >&2; exit 1
    fi
    cp "$FETCH_TEST_ARCHIVE" "$output"
    ;;
  *) exit 92 ;;
esac
