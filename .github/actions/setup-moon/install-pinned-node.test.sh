#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/.github/actions/setup-moon/install-pinned-node.sh"
action="$root/.github/actions/setup-node-runtime/action.yml"
extractor="$root/.github/actions/setup-moon/toolchain-archive.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

grep -Fq 'export_dir="$(cygpath -w "$export_dir")"' "$action"
grep -Fq 'echo "$export_dir" >> "$GITHUB_PATH"' "$action"

mkdir -p "$work/payload/node-v22.22.3-linux-x64/bin" "$work/bin"
cat >"$work/payload/node-v22.22.3-linux-x64/bin/node" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo v22.22.3
else
  echo "fixture Node only supports --version" >&2
  exit 2
fi
EOF
chmod 0755 "$work/payload/node-v22.22.3-linux-x64/bin/node"
tar -C "$work/payload" -cJf "$work/node.tar.xz" node-v22.22.3-linux-x64
archive_bytes="$(wc -c <"$work/node.tar.xz" | tr -d '[:space:]')"
archive_sha256="$(sha256sum "$work/node.tar.xz" | awk '{print $1}')"
binary="$work/payload/node-v22.22.3-linux-x64/bin/node"
binary_bytes="$(wc -c <"$binary" | tr -d '[:space:]')"
binary_sha256="$(sha256sum "$binary" | awk '{print $1}')"

cat >"$work/node-runtime.toml" <<EOF
[toolchain]
version = "22.22.3"

[assets.x86_64-unknown-linux-gnu]
url = "https://nodejs.org/download/release/v22.22.3/node-v22.22.3-linux-x64.tar.xz"
sha256 = "$archive_sha256"
bytes = "$archive_bytes"
format = "tar.xz"
binary_path = "node-v22.22.3-linux-x64/bin/node"
binary_sha256 = "$binary_sha256"
binary_bytes = "$binary_bytes"
EOF
printf 'node = "22.22.3"\n' >"$work/.prototools"

cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
last=""
joined=" $* "
for required in "--fail" "--location" "--proto =https" "--proto-redir =https" "--tlsv1.2" "--retry-all-errors" "--retry-connrefused" "--remove-on-error" "--max-filesize"; do
  [[ "$joined" == *" $required "* ]] || {
    echo "missing hardened curl argument: $required" >&2
    exit 91
  }
done
if [ "${RUNNER_OS:-}" = Windows ]; then
  [[ "$joined" == *" --ssl-revoke-best-effort "* ]] || exit 92
fi
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) last="$1"; shift ;;
  esac
done
[ "$last" = "https://nodejs.org/download/release/v22.22.3/node-v22.22.3-linux-x64.tar.xz" ] || exit 93
printf '%s\n' "$joined" >>"$OLIPHAUNT_NODE_TEST_REQUEST_LOG"
cp "$OLIPHAUNT_NODE_TEST_ARCHIVE" "$output"
EOF
chmod 0755 "$work/bin/curl"

common=(
  OLIPHAUNT_NODE_RUNTIME_ROOT="$root"
  OLIPHAUNT_NODE_RUNTIME_MANIFEST="$work/node-runtime.toml"
  OLIPHAUNT_NODE_RUNTIME_PROTO_FILE="$work/.prototools"
  OLIPHAUNT_NODE_RUNTIME_ARCHIVE_EXTRACTOR="$extractor"
  OLIPHAUNT_NODE_RUNTIME_CACHE_ROOT="$work/cache"
  OLIPHAUNT_NODE_RUNTIME_TARGET=x86_64-unknown-linux-gnu
  OLIPHAUNT_NODE_RUNTIME_TESTING=1
  OLIPHAUNT_NODE_CURL="$work/bin/curl"
  OLIPHAUNT_NODE_TEST_ARCHIVE="$work/node.tar.xz"
  OLIPHAUNT_NODE_TEST_REQUEST_LOG="$work/requests.log"
  RUNNER_OS=Windows
)

installed="$(env "${common[@]}" bash "$installer")"
[ "$("$installed" --version)" = v22.22.3 ]
[ "$(wc -l <"$work/requests.log" | tr -d '[:space:]')" = 1 ]

# A valid installation must return before any network command is invoked.
cached="$(env "${common[@]}" OLIPHAUNT_NODE_CURL=false bash "$installer")"
[ "$cached" = "$installed" ]
[ "$(wc -l <"$work/requests.log" | tr -d '[:space:]')" = 1 ]

# A modified executable is rebuilt from the already verified archive, also offline.
chmod u+w "$installed"
printf 'tampered\n' >"$installed"
repaired="$(env "${common[@]}" OLIPHAUNT_NODE_CURL=false bash "$installer")"
[ "$repaired" = "$installed" ]
[ "$("$installed" --version)" = v22.22.3 ]

# An interrupted replacement restores the previous directory instead of exposing a partial stage.
chmod u+w "$installed"
printf 'tampered again\n' >"$installed"
set +e
env "${common[@]}" OLIPHAUNT_NODE_CURL=false \
  OLIPHAUNT_NODE_RUNTIME_TEST_INTERRUPT_AFTER_BACKUP=1 bash "$installer" >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 143 ]
grep -Fxq 'tampered again' "$installed"
env "${common[@]}" OLIPHAUNT_NODE_CURL=false bash "$installer" >/dev/null

# Target overrides are unavailable outside explicit fault-test mode.
set +e
env "${common[@]}" OLIPHAUNT_NODE_RUNTIME_TESTING=0 bash "$installer" >/dev/null 2>&1
status=$?
set -e
[ "$status" -ne 0 ]

echo "Pinned Node.js bootstrap fault tests passed."
