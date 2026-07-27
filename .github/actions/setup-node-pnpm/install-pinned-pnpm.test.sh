#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-pinned-pnpm.test.sh: $*" >&2
  exit 1
}

root="$(git rev-parse --show-toplevel)"
installer="$root/.github/actions/setup-node-pnpm/install-pinned-pnpm.sh"
action="$root/.github/actions/setup-node-pnpm/action.yml"
extractor="$root/.github/actions/setup-moon/toolchain-archive.py"
curl_flags="$root/tools/dev/curl-platform-flags.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

if grep -Eq 'uses:[[:space:]]+actions/setup-node@|corepack([[:space:]]|$)|install-pinned-toolchain|moon-plugins|moon-cli' \
  "$action" "$installer"; then
  fail "standalone Node/pnpm action reintroduced an unverified or Moon bootstrap"
fi
grep -Fq 'uses: ./.github/actions/setup-node-runtime' "$action" ||
  fail "standalone action does not compose the verified Node runtime"
# shellcheck disable=SC2016 # The assertion intentionally matches literal shell syntax in the action.
grep -Fq 'export_dir="$(cygpath -w "$export_dir")"' "$action" ||
  fail "standalone action does not export a native Windows pnpm path"
if grep -Eq 'pnpm[ -]store|pnpm-store-|steps\.pnpm-store' "$action"; then
  fail "standalone setup must not cache a pnpm store before caller dependency installation"
fi

fixture="$tmp/pnpm-11.5.0.tgz"
manifest="$tmp/pnpm.toml"
proto_file="$tmp/prototools"
metadata="$tmp/metadata.env"
"${PYTHON:-python3}" - "$fixture" "$manifest" "$metadata" <<'PY'
import hashlib
import io
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
manifest = pathlib.Path(sys.argv[2])
metadata = pathlib.Path(sys.argv[3])
version = "11.5.0"
files = {
    "bin/pnpm.mjs": b"#!/usr/bin/env node\nprocess.stdout.write('11.5.0\\n');\n",
    "bin/pnpx.mjs": b"#!/usr/bin/env node\nprocess.stdout.write('fixture-pnpx\\n');\n",
    "dist/node-gyp-bin/node-gyp": b"#!/usr/bin/env sh\nexit 0\n",
    "dist/node-gyp-bin/node-gyp.cmd": b"@ECHO OFF\r\nEXIT /B 0\r\n",
    "dist/node_modules/node-gyp/bin/node-gyp.js": b"#!/usr/bin/env node\nprocess.exit(0);\n",
    "dist/pnpm.mjs": b"export const fixture = true;\n",
    "package.json": b'{"name":"pnpm","version":"11.5.0"}\n',
}
executables = {
    "bin/pnpm.mjs",
    "bin/pnpx.mjs",
    "dist/node-gyp-bin/node-gyp",
    "dist/node-gyp-bin/node-gyp.cmd",
    "dist/node_modules/node-gyp/bin/node-gyp.js",
}
directories = {"package"}
for relative in files:
    parts = pathlib.PurePosixPath("package", relative).parts
    directories.update("/".join(parts[:depth]) for depth in range(2, len(parts)))

with tarfile.open(archive, "w:gz", format=tarfile.USTAR_FORMAT) as stream:
    for directory in sorted(directories, key=lambda value: value.encode("utf-8")):
        info = tarfile.TarInfo(f"{directory}/")
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        info.mtime = 0
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        stream.addfile(info)
    for relative, content in sorted(files.items(), key=lambda item: item[0].encode("utf-8")):
        info = tarfile.TarInfo(f"package/{relative}")
        info.type = tarfile.REGTYPE
        info.size = len(content)
        info.mode = 0o755 if relative in executables else 0o644
        info.mtime = 0
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        stream.addfile(info, io.BytesIO(content))

archive_bytes = archive.read_bytes()
archive_sha256 = hashlib.sha256(archive_bytes).hexdigest()
archive_sha512 = hashlib.sha512(archive_bytes).hexdigest()
tree = hashlib.sha256(b"oliphaunt-bootstrap-tree-v2\0")
for relative, content in sorted(files.items(), key=lambda item: item[0].encode("utf-8")):
    tree.update(relative.encode("utf-8"))
    tree.update(b"\0")
    tree.update(str(len(content)).encode("ascii"))
    tree.update(b"\0")
    tree.update(b"x" if relative in executables else b"-")
    tree.update(b"\0")
    tree.update(content)
    tree.update(b"\0")

executable_paths = (
    "bin/pnpm.mjs,bin/pnpx.mjs,dist/node-gyp-bin/node-gyp,"
    "dist/node-gyp-bin/node-gyp.cmd,dist/node_modules/node-gyp/bin/node-gyp.js"
)
manifest.write_text(
    f'''[toolchain]
version = "{version}"

[package]
url = "https://registry.npmjs.org/pnpm/-/pnpm-{version}.tgz"
sha256 = "{archive_sha256}"
sha512 = "{archive_sha512}"
bytes = "{len(archive_bytes)}"
expanded_bytes = "{sum(map(len, files.values()))}"
format = "tar.gz"
prefix = "package"
entry_count = "{len(directories) + len(files)}"
file_count = "{len(files)}"
tree_sha256 = "{tree.hexdigest()}"
executable_paths = "{executable_paths}"
binary_path = "bin/pnpm.mjs"
binary_sha256 = "{hashlib.sha256(files['bin/pnpm.mjs']).hexdigest()}"
companion_path = "bin/pnpx.mjs"
companion_sha256 = "{hashlib.sha256(files['bin/pnpx.mjs']).hexdigest()}"
payload_path = "dist/pnpm.mjs"
payload_sha256 = "{hashlib.sha256(files['dist/pnpm.mjs']).hexdigest()}"
''',
    encoding="utf-8",
)
metadata.write_text(
    f"ARCHIVE_SHA256={archive_sha256}\nARCHIVE_BYTES={len(archive_bytes)}\n",
    encoding="utf-8",
)
PY
printf '%s\n' 'pnpm = "11.5.0"' >"$proto_file"
# shellcheck source=/dev/null
. "$metadata"

fake_curl="$tmp/curl"
# These literal lines become the fake curl script.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  ': "${FAKE_CURL_LOG:?}" "${FAKE_CURL_SOURCE:?}"' \
  'printf "%s\n" "<CALL>" >> "$FAKE_CURL_LOG"' \
  'for argument in "$@"; do printf "<%s>\n" "$argument" >> "$FAKE_CURL_LOG"; done' \
  'output=""' \
  'url=""' \
  'bound=""' \
  'while (( $# )); do' \
  '  case "$1" in' \
  '    --output) output="$2"; shift 2 ;;' \
  '    --max-filesize) bound="$2"; shift 2 ;;' \
  '    https://*) url="$1"; shift ;;' \
  '    *) shift ;;' \
  '  esac' \
  'done' \
  '[[ -n "$output" && -n "$url" && -n "$bound" ]]' \
  'case "${FAKE_CURL_MODE:-copy}" in' \
  '  copy) cp "$FAKE_CURL_SOURCE" "$output" ;;' \
  '  bad) printf "%s" bad > "$output" ;;' \
  '  corrupt) cp "$FAKE_CURL_SOURCE" "$output"; printf Z | dd of="$output" bs=1 seek=1 count=1 conv=notrunc 2>/dev/null ;;' \
  '  fail) exit 97 ;;' \
  '  *) exit 98 ;;' \
  'esac' >"$fake_curl"
chmod 0555 "$fake_curl"

cache="$tmp/cache"
curl_log="$tmp/curl.log"
run_install() {
  local selected_cache="$1"
  local mode="${2:-copy}"
  local selected_manifest="${3:-$manifest}"
  env \
    EXPECTED_PNPM_VERSION=11.5.0 \
    FAKE_CURL_LOG="$curl_log" \
    FAKE_CURL_MODE="$mode" \
    FAKE_CURL_SOURCE="$fixture" \
    OLIPHAUNT_PNPM_ARCHIVE_EXTRACTOR="$extractor" \
    OLIPHAUNT_PNPM_CACHE_ROOT="$selected_cache" \
    OLIPHAUNT_PNPM_CURL="$fake_curl" \
    OLIPHAUNT_PNPM_CURL_PLATFORM_FLAGS="$curl_flags" \
    OLIPHAUNT_PNPM_MANIFEST="$selected_manifest" \
    OLIPHAUNT_PNPM_PROTO_FILE="$proto_file" \
    OLIPHAUNT_PNPM_TESTING=1 \
    RUNNER_OS=Windows \
    bash "$installer"
}

installation="$(run_install "$cache")"
[ "$("$installation/bin/pnpm" --version)" = "11.5.0" ] || fail "fixture pnpm version mismatch"
if [ -e "$installation/plugins" ] || [ -e "$installation/moon" ]; then
  fail "standalone installation unexpectedly contains Moon material"
fi
[ "$(grep -Fxc '<CALL>' "$curl_log")" = "1" ] || fail "initial install did not perform one download"
for expected in \
  '<--fail>' \
  '<--location>' \
  '<--proto>' \
  '<=https>' \
  '<--proto-redir>' \
  '<--tlsv1.2>' \
  '<--retry-all-errors>' \
  '<--retry-connrefused>' \
  '<--connect-timeout>' \
  '<--max-time>' \
  '<--speed-limit>' \
  '<--speed-time>' \
  '<--remove-on-error>' \
  '<--ssl-revoke-best-effort>' \
  '<--max-filesize>' \
  "<$ARCHIVE_BYTES>" \
  '<https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz>'; do
  grep -Fqx "$expected" "$curl_log" || fail "curl invocation omitted $expected"
done

rm -f "$curl_log"
cached="$(run_install "$cache" fail)"
[ "$cached" = "$installation" ] || fail "cache hit changed the installation path"
[ ! -e "$curl_log" ] || fail "valid cache hit attempted network access"

chmod 0644 "$installation/pnpm/dist/pnpm.mjs"
printf '%s\n' 'tampered payload' >"$installation/pnpm/dist/pnpm.mjs"
rm -f "$curl_log"
repaired="$(run_install "$cache" fail)"
[ "$repaired" = "$installation" ] || fail "tree repair changed the installation path"
[ ! -e "$curl_log" ] || fail "tree repair ignored the verified archive cache"
[ "$("$installation/bin/pnpm" --version)" = "11.5.0" ] || fail "tree repair did not restore pnpm"

chmod 0644 "$installation/pnpm/bin/pnpm.mjs"
rm -f "$curl_log"
run_install "$cache" fail >/dev/null
[ ! -e "$curl_log" ] || fail "mode repair ignored the verified archive cache"
[ -x "$installation/pnpm/bin/pnpm.mjs" ] || fail "executable-mode repair did not restore pnpm"

chmod 0755 "$installation/bin/pnpm"
printf '%s\n' '#!/usr/bin/env bash' 'echo injected' >"$installation/bin/pnpm"
rm -f "$curl_log"
run_install "$cache" fail >/dev/null
[ ! -e "$curl_log" ] || fail "wrapper repair ignored the verified archive cache"
[ "$("$installation/bin/pnpm" --version)" = "11.5.0" ] || fail "wrapper repair did not restore pnpm"

rm -rf "$installation"
chmod 0644 "$cache/archives/$ARCHIVE_SHA256.tgz"
printf '%s\n' corrupt >"$cache/archives/$ARCHIVE_SHA256.tgz"
rm -f "$curl_log"
installation="$(run_install "$cache")"
[ "$(grep -Fxc '<CALL>' "$curl_log")" = "1" ] || fail "corrupt archive was not redownloaded once"
[ "$("$installation/bin/pnpm" --version)" = "11.5.0" ] || fail "corrupt archive repair failed"

bad_cache="$tmp/bad-cache"
rm -f "$curl_log"
if run_install "$bad_cache" bad >"$tmp/bad.out" 2>"$tmp/bad.err"; then
  fail "size-invalid download was accepted"
fi
if find "$bad_cache/installations" -type d -name verified -print -quit 2>/dev/null | grep -q .; then
  fail "size-invalid download committed an installation"
fi

corrupt_cache="$tmp/corrupt-cache"
rm -f "$curl_log"
if run_install "$corrupt_cache" corrupt >"$tmp/corrupt.out" 2>"$tmp/corrupt.err"; then
  fail "same-size SHA-256-invalid download was accepted"
fi
grep -Fq 'downloaded SHA-256 mismatch' "$tmp/corrupt.err" ||
  fail "same-size corrupt download did not fail at SHA-256 verification"
if find "$corrupt_cache/installations" -type d -name verified -print -quit 2>/dev/null | grep -q .; then
  fail "SHA-256-invalid download committed an installation"
fi

wrong_sha512_manifest="$tmp/wrong-sha512.toml"
zeros="$(printf '0%.0s' {1..128})"
sed "s/^sha512 = \".*\"$/sha512 = \"$zeros\"/" "$manifest" >"$wrong_sha512_manifest"
sha512_cache="$tmp/sha512-cache"
rm -f "$curl_log"
if run_install "$sha512_cache" copy "$wrong_sha512_manifest" >"$tmp/sha512.out" 2>"$tmp/sha512.err"; then
  fail "SHA-512-invalid manifest was accepted"
fi
grep -Fq 'downloaded SHA-512 mismatch' "$tmp/sha512.err" ||
  fail "SHA-512 mismatch did not reach SHA-512 verification"
if find "$sha512_cache/installations" -type d -name verified -print -quit 2>/dev/null | grep -q .; then
  fail "SHA-512-invalid download committed an installation"
fi

chmod 0755 "$installation/bin/pnpm"
printf '%s\n' '#!/usr/bin/env bash' 'echo preserved-after-interrupt' >"$installation/bin/pnpm"
rm -f "$curl_log"
if env \
  EXPECTED_PNPM_VERSION=11.5.0 \
  FAKE_CURL_LOG="$curl_log" \
  FAKE_CURL_MODE=fail \
  FAKE_CURL_SOURCE="$fixture" \
  OLIPHAUNT_PNPM_ARCHIVE_EXTRACTOR="$extractor" \
  OLIPHAUNT_PNPM_CACHE_ROOT="$cache" \
  OLIPHAUNT_PNPM_CURL="$fake_curl" \
  OLIPHAUNT_PNPM_CURL_PLATFORM_FLAGS="$curl_flags" \
  OLIPHAUNT_PNPM_MANIFEST="$manifest" \
  OLIPHAUNT_PNPM_PROTO_FILE="$proto_file" \
  OLIPHAUNT_PNPM_TEST_INTERRUPT_AFTER_BACKUP=1 \
  OLIPHAUNT_PNPM_TESTING=1 \
  RUNNER_OS=Windows \
  bash "$installer" >"$tmp/interrupt.out" 2>"$tmp/interrupt.err"; then
  fail "test interrupt unexpectedly succeeded"
fi
grep -Fq 'preserved-after-interrupt' "$installation/bin/pnpm" ||
  fail "transactional interrupt did not restore the prior installation"
[ ! -e "$curl_log" ] || fail "transactional repair ignored the verified archive cache"
if find "$(dirname "$installation")" -mindepth 1 -maxdepth 1 -name '.verified.*' -print -quit | grep -q .; then
  fail "transactional interrupt left a staging or backup directory"
fi
run_install "$cache" fail >/dev/null

wrong_manifest="$tmp/wrong-url.toml"
sed 's#https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz#https://example.invalid/pnpm.tgz#' \
  "$manifest" >"$wrong_manifest"
rm -f "$curl_log"
if env \
  EXPECTED_PNPM_VERSION=11.5.0 \
  FAKE_CURL_LOG="$curl_log" \
  FAKE_CURL_SOURCE="$fixture" \
  OLIPHAUNT_PNPM_CACHE_ROOT="$tmp/wrong-url-cache" \
  OLIPHAUNT_PNPM_CURL="$fake_curl" \
  OLIPHAUNT_PNPM_MANIFEST="$wrong_manifest" \
  OLIPHAUNT_PNPM_PROTO_FILE="$proto_file" \
  OLIPHAUNT_PNPM_TESTING=1 \
  bash "$installer" >"$tmp/url.out" 2>"$tmp/url.err"; then
  fail "non-canonical pnpm URL was accepted"
fi
[ ! -e "$curl_log" ] || fail "non-canonical URL reached the downloader"

if OLIPHAUNT_PNPM_MANIFEST="$manifest" bash "$installer" >"$tmp/gate.out" 2>"$tmp/gate.err"; then
  fail "test manifest override was accepted outside test mode"
fi
grep -Fq 'OLIPHAUNT_PNPM_MANIFEST is test-only' "$tmp/gate.err" ||
  fail "test override gate failed unclearly"

mkdir "$tmp/real-cache-root"
ln -s "$tmp/real-cache-root" "$tmp/symlink-cache"
rm -f "$curl_log"
if run_install "$tmp/symlink-cache" >"$tmp/symlink.out" 2>"$tmp/symlink.err"; then
  fail "symbolic-link cache root was accepted"
fi
[ ! -e "$curl_log" ] || fail "symbolic-link cache root reached the downloader"

printf '%s\n' "Pinned standalone pnpm bootstrap fault tests passed."
