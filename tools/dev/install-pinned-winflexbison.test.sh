#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/tools/dev/install-pinned-winflexbison.sh"
extractor="$root/tools/dev/extract-pinned-zip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/fixtures" "$tmp/config" "$tmp/bin"


bash "$root/tools/dev/bun.sh" - "$tmp" <<'TS'
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {zipArchive} from './tools/packaging/testdata/zip-fixture.mts';
const root = process.argv[2];
const sha = data => createHash('sha256').update(data).digest('hex');
const write = (name, data) => writeFileSync(root + '/' + name, data);

const files = {'win_flex.exe':'fixture-flex\n','win_bison.exe':'fixture-bison\n','data/README.md':'fixture-data\n'};
const bytes = zipArchive(Object.entries(files).map(([name,data]) => ({name,data,method:8,externalAttributes:(name.endsWith('.exe') ? 0o100755 : 0o100644) << 16})));
write('fixtures/winflex.zip',bytes);
const tree = createHash('sha256');
for (const [name, data] of Object.entries(files).sort(([a],[b]) => Buffer.compare(Buffer.from(a),Buffer.from(b)))) tree.update(name + '\0' + Buffer.byteLength(data) + '\0' + sha(data) + '\n');
const values = {archive_sha:sha(bytes), archive_bytes:bytes.length, expanded_bytes:Object.values(files).reduce((sum,data)=>sum+Buffer.byteLength(data),0), tree_sha:tree.digest('hex'), flex_sha:sha(files['win_flex.exe']), bison_sha:sha(files['win_bison.exe'])};
const manifest = "[toolchain]\nversion = \"1.2.3\"\nrepository = \"lexxmark/winflexbison\"\n\n[assets.windows-x64]\nurl = \"https://github.com/lexxmark/winflexbison/releases/download/v1.2.3/win_flex_bison-1.2.3.zip\"\nsha256 = \"{values['archive_sha']}\"\nbytes = \"{values['archive_bytes']}\"\nentry_count = \"3\"\nfile_count = \"3\"\nexpanded_bytes = \"{values['expanded_bytes']}\"\ntree_sha256 = \"{values['tree_sha']}\"\nflex_path = \"win_flex.exe\"\nflex_sha256 = \"{values['flex_sha']}\"\nbison_path = \"win_bison.exe\"\nbison_sha256 = \"{values['bison_sha']}\"\n".replace(/\{values\['([^']+)'\]\}/g, (_,key)=>String(values[key]));
write('config/winflexbison.toml',manifest);
write('config/bad-sha.toml',manifest.replace(values.archive_sha,'0'.repeat(64)));
write('config/bad-tree.toml',manifest.replace(values.tree_sha,'0'.repeat(64)));
write('config/bad-url.toml',manifest.replace('https://github.com/lexxmark/winflexbison/','https://example.invalid/'));

TS

cat >"$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >>"$CURL_ARGS_LOG"
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ]
case "$CURL_MODE" in
  good) cp "$WINFLEX_ARCHIVE" "$output" ;;
  fail) exit 22 ;;
  *) exit 2 ;;
esac
SH
chmod +x "$tmp/bin/curl"

run_installer() {
  env \
    "OLIPHAUNT_PINNED_TOOL_ROOT=$root" \
    "OLIPHAUNT_WINFLEXBISON_MANIFEST=${MANIFEST:-$tmp/config/winflexbison.toml}" \
    "OLIPHAUNT_PINNED_ZIP_EXTRACTOR=$extractor" \
    "OLIPHAUNT_PINNED_NATIVE_TOOL_CACHE_ROOT=${CACHE_ROOT:-$tmp/cache}" \
    "OLIPHAUNT_WINFLEXBISON_CURL=$tmp/bin/curl" \
    "WINFLEX_ARCHIVE=$tmp/fixtures/winflex.zip" \
    "CURL_ARGS_LOG=$tmp/curl-args.log" \
    "CURL_MODE=${CURL_MODE:-good}" \
    "OLIPHAUNT_WINFLEXBISON_TESTING=${TESTING:-0}" \
    "OLIPHAUNT_WINFLEXBISON_TEST_INTERRUPT_AFTER_BACKUP=${INTERRUPT:-0}" \
    "$installer"
}

payload="$(run_installer)"
[ -x "$payload/win_flex.exe" ]
[ -x "$payload/win_bison.exe" ]
[ -f "$payload/data/README.md" ]
grep -Fxq -- "--retry-all-errors" "$tmp/curl-args.log"
grep -Fxq -- "=https" "$tmp/curl-args.log"

# A complete verified cache is network-independent.
: >"$tmp/curl-args.log"
cached="$(CURL_MODE=fail run_installer)"
[ "$cached" = "$payload" ]
[ ! -s "$tmp/curl-args.log" ]

# Payload corruption is detected across the complete extracted tree and repaired.
printf 'tampered\n' >"$payload/data/README.md"
repaired="$(run_installer)"
[ "$repaired" = "$payload" ]
grep -Fxq 'fixture-data' "$payload/data/README.md"

# Archive and extracted-tree pin drift fail before promotion.
if MANIFEST="$tmp/config/bad-sha.toml" CACHE_ROOT="$tmp/bad-sha-cache" run_installer >/dev/null 2>&1; then
  echo "bad archive checksum unexpectedly succeeded" >&2
  exit 1
fi
[ ! -e "$tmp/bad-sha-cache/winflexbison/v1.2.3/windows-x64" ]
if MANIFEST="$tmp/config/bad-tree.toml" CACHE_ROOT="$tmp/bad-tree-cache" run_installer >/dev/null 2>&1; then
  echo "bad payload tree unexpectedly succeeded" >&2
  exit 1
fi
[ ! -e "$tmp/bad-tree-cache/winflexbison/v1.2.3/windows-x64" ]
if MANIFEST="$tmp/config/bad-url.toml" CACHE_ROOT="$tmp/bad-url-cache" run_installer >/dev/null 2>&1; then
  echo "noncanonical upstream URL unexpectedly succeeded" >&2
  exit 1
fi
[ ! -e "$tmp/bad-url-cache/winflexbison/v1.2.3/windows-x64" ]

# Transport failure preserves an existing invalid cache, while interrupted
# promotion restores it byte-for-byte instead of leaving a missing destination.
printf 'old-invalid\n' >"$payload/win_flex.exe"
if CURL_MODE=fail run_installer >/dev/null 2>&1; then
  echo "failed transport unexpectedly repaired the cache" >&2
  exit 1
fi
grep -Fxq 'old-invalid' "$payload/win_flex.exe"
if TESTING=1 INTERRUPT=1 run_installer >/dev/null 2>&1; then
  echo "interrupted promotion unexpectedly succeeded" >&2
  exit 1
fi
grep -Fxq 'old-invalid' "$payload/win_flex.exe"
final="$(run_installer)"
grep -Fxq 'fixture-flex' "$final/win_flex.exe"

# A symbolic-link cache root is rejected before any download or write-through.
mkdir -p "$tmp/cache-target"
ln -s "$tmp/cache-target" "$tmp/cache-link"
if CACHE_ROOT="$tmp/cache-link" run_installer >/dev/null 2>&1; then
  echo "symbolic-link cache root unexpectedly succeeded" >&2
  exit 1
fi
[ -z "$(find "$tmp/cache-target" -mindepth 1 -print -quit)" ]
