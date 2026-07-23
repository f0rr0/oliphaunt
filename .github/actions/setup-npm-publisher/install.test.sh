#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/.github/actions/setup-npm-publisher/install.sh"
action="$root/.github/actions/setup-npm-publisher/action.yml"
extractor="$root/.github/actions/setup-moon/toolchain-archive.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/payload/package/bin" "$work/bin" "$work/blockers"
# These are intentionally literal composite-action source assertions.
# shellcheck disable=SC2016
{
  grep -Fq 'export_dir="$(cygpath -w "$export_dir")"' "$action"
  grep -Fq 'echo "$export_dir" >> "$GITHUB_PATH"' "$action"
  grep -Fq 'value: ${{ steps.install.outputs.node-executable }}' "$action"
  grep -Fq 'value: ${{ steps.install.outputs.npm-cli }}' "$action"
  grep -Fq 'npm_version="$("$node_executable" "$npm_cli" --version)"' "$action"
  grep -Fq 'node_executable="$(cygpath -u "$node_executable")"' "$action"
  grep -Fq 'output_node="$(cygpath -w "$output_node")"' "$action"
  grep -Fq 'output_npm_cli="$(cygpath -w "$output_npm_cli")"' "$action"
}
if grep -Eq '(^|[[:space:]])npm[[:space:]]+--version' "$action"; then
  echo "setup action reintroduced an ambient npm version probe" >&2
  exit 1
fi

cat >"$work/payload/package/bin/npm-cli.js" <<'EOF'
#!/usr/bin/env node
console.log("11.18.0");
EOF
cat >"$work/payload/package/bin/npx-cli.js" <<'EOF'
#!/usr/bin/env node
console.log("11.18.0");
EOF
printf '{"name":"npm","version":"11.18.0"}\n' >"$work/payload/package/package.json"
chmod 0755 "$work/payload/package/bin/npm-cli.js" "$work/payload/package/bin/npx-cli.js"
tar -C "$work/payload" -czf "$work/npm.tgz" package
archive_bytes="$(wc -c <"$work/npm.tgz" | tr -d '[:space:]')"
archive_sha256="$(sha256sum "$work/npm.tgz" | awk '{print $1}')"
archive_sha512="$(sha512sum "$work/npm.tgz" | awk '{print $1}')"
entry_count="$(tar -tzf "$work/npm.tgz" | wc -l | tr -d '[:space:]')"
expanded_bytes="$(
  find "$work/payload/package" -type f -printf '%s\n' | awk '{ total += $1 } END { print total }'
)"
python3 "$extractor" extract --archive "$work/npm.tgz" --format tar.gz --prefix package \
  --entry-count "$entry_count" --expected-bytes "$archive_bytes" \
  --expanded-bytes "$expanded_bytes" --destination "$work/extracted" \
  --required bin/npm-cli.js --executable bin/npm-cli.js \
  --required bin/npx-cli.js --executable bin/npx-cli.js \
  --required package.json
tree_result="$(python3 "$extractor" tree-digest --root "$work/extracted" \
  --executable bin/npm-cli.js --executable bin/npx-cli.js)"
file_count="${tree_result%% *}"
tree_sha256="${tree_result#* }"

cat >"$work/npm.toml" <<EOF
[toolchain]
version = "11.18.0"
[package]
url = "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz"
sha256 = "$archive_sha256"
sha512 = "$archive_sha512"
bytes = "$archive_bytes"
expanded_bytes = "$expanded_bytes"
format = "tar.gz"
prefix = "package"
entry_count = "$entry_count"
file_count = "$file_count"
tree_sha256 = "$tree_sha256"
executable_paths = "bin/npm-cli.js,bin/npx-cli.js"
binary_path = "bin/npm-cli.js"
binary_sha256 = "$(sha256sum "$work/payload/package/bin/npm-cli.js" | awk '{print $1}')"
binary_bytes = "$(wc -c <"$work/payload/package/bin/npm-cli.js" | tr -d '[:space:]')"
companion_path = "bin/npx-cli.js"
companion_sha256 = "$(sha256sum "$work/payload/package/bin/npx-cli.js" | awk '{print $1}')"
companion_bytes = "$(wc -c <"$work/payload/package/bin/npx-cli.js" | tr -d '[:space:]')"
package_json_sha256 = "$(sha256sum "$work/payload/package/package.json" | awk '{print $1}')"
package_json_bytes = "$(wc -c <"$work/payload/package/package.json" | tr -d '[:space:]')"
EOF

cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
joined=" $* "
for required in "--fail" "--location" "--proto =https" "--proto-redir =https" "--tlsv1.2" "--retry-all-errors" "--retry-connrefused" "--remove-on-error" "--max-filesize" "--ssl-revoke-best-effort"; do
  [[ "$joined" == *" $required "* ]] || exit 91
done
output=""
last=""
while (($#)); do
  case "$1" in --output) output="$2"; shift 2 ;; *) last="$1"; shift ;; esac
done
[ "$last" = "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz" ] || exit 92
printf '%s\n' "$joined" >>"$OLIPHAUNT_NPM_TEST_REQUEST_LOG"
cp "$OLIPHAUNT_NPM_TEST_ARCHIVE" "$output"
EOF
chmod 0755 "$work/bin/curl"
for blocked in npm corepack; do
  cat >"$work/blockers/$blocked" <<EOF
#!/usr/bin/env bash
echo "$blocked was invoked" >>"$work/ambient.log"
exit 99
EOF
  chmod 0755 "$work/blockers/$blocked"
done

common=(
  OLIPHAUNT_NPM_PUBLISHER_ROOT="$root"
  OLIPHAUNT_NPM_PUBLISHER_MANIFEST="$work/npm.toml"
  OLIPHAUNT_NPM_PUBLISHER_ARCHIVE_EXTRACTOR="$extractor"
  OLIPHAUNT_NPM_PUBLISHER_CACHE_ROOT="$work/cache"
  OLIPHAUNT_NPM_PUBLISHER_CURL="$work/bin/curl"
  OLIPHAUNT_NPM_TEST_ARCHIVE="$work/npm.tgz"
  OLIPHAUNT_NPM_TEST_REQUEST_LOG="$work/requests.log"
  RUNNER_OS=Windows
  PATH="$work/blockers:$PATH"
)

publisher_bin="$(env "${common[@]}" bash "$installer")"
[ "$(PATH="$publisher_bin:$work/blockers:$PATH" npm --version)" = 11.18.0 ]
[ ! -e "$work/ambient.log" ]
[ "$(wc -l <"$work/requests.log" | tr -d '[:space:]')" = 1 ]

# Valid caches are fully offline and a modified CLI tree is repaired from the verified archive.
[ "$(env "${common[@]}" OLIPHAUNT_NPM_PUBLISHER_CURL=false bash "$installer")" = "$publisher_bin" ]
cli="$work/cache/installations/npm-11.18.0/verified/npm/bin/npm-cli.js"
chmod u+w "$cli"
printf 'tampered\n' >"$cli"
env "${common[@]}" OLIPHAUNT_NPM_PUBLISHER_CURL=false bash "$installer" >/dev/null
[ "$(PATH="$publisher_bin:$work/blockers:$PATH" npm --version)" = 11.18.0 ]
[ ! -e "$work/ambient.log" ]
[ "$(wc -l <"$work/requests.log" | tr -d '[:space:]')" = 1 ]

# A corrupt cached archive is redownloaded before a damaged installation is replaced.
archive="$work/cache/archives/$archive_sha256.tgz"
chmod u+w "$archive" "$cli"
printf 'corrupt archive\n' >"$archive"
printf 'corrupt cli\n' >"$cli"
env "${common[@]}" bash "$installer" >/dev/null
[ "$(PATH="$publisher_bin:$work/blockers:$PATH" npm --version)" = 11.18.0 ]
[ "$(wc -l <"$work/requests.log" | tr -d '[:space:]')" = 2 ]

# A wrong Node runtime cannot bless the staged npm tree or disturb the valid install.
mkdir -p "$work/wrong-node"
printf '%s\n' '#!/usr/bin/env bash' 'echo 0.0.0' >"$work/wrong-node/node"
chmod 0755 "$work/wrong-node/node"
set +e
env "${common[@]}" PATH="$work/wrong-node:$work/blockers:$PATH" \
  OLIPHAUNT_NPM_PUBLISHER_CURL=false bash "$installer" >/dev/null 2>&1
wrong_runtime_status=$?
set -e
[ "$wrong_runtime_status" -ne 0 ]
[ "$(PATH="$publisher_bin:$work/blockers:$PATH" npm --version)" = 11.18.0 ]

# Interrupted promotion restores the previous directory and exposes no partial stage.
chmod u+w "$cli"
printf 'interrupted prior cli\n' >"$cli"
set +e
env "${common[@]}" OLIPHAUNT_NPM_PUBLISHER_CURL=false \
  OLIPHAUNT_NPM_PUBLISHER_TESTING=1 \
  OLIPHAUNT_NPM_PUBLISHER_TEST_INTERRUPT_AFTER_BACKUP=1 \
  bash "$installer" >/dev/null 2>&1
interrupt_status=$?
set -e
[ "$interrupt_status" -eq 143 ]
grep -Fxq 'interrupted prior cli' "$cli"
[ -z "$(find "$work/cache/installations/npm-11.18.0" -maxdepth 1 -name '.*.stage.*' -print -quit)" ]
env "${common[@]}" OLIPHAUNT_NPM_PUBLISHER_CURL=false bash "$installer" >/dev/null

# A manifest/archive identity mismatch fails before promotion and preserves the valid runtime.
sed "s/^sha256 = \"$archive_sha256\"/sha256 = \"$(printf '0%.0s' {1..64})\"/" \
  "$work/npm.toml" >"$work/bad-digest.toml"
set +e
env "${common[@]}" OLIPHAUNT_NPM_PUBLISHER_MANIFEST="$work/bad-digest.toml" \
  bash "$installer" >/dev/null 2>&1
bad_digest_status=$?
set -e
[ "$bad_digest_status" -ne 0 ]
[ "$(PATH="$publisher_bin:$work/blockers:$PATH" npm --version)" = 11.18.0 ]
[ ! -e "$work/ambient.log" ]

echo "Pinned npm publisher bootstrap fault tests passed."
