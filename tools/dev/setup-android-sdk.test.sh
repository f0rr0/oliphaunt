#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/tools/dev/setup-android-sdk.sh"
extractor="$root/tools/dev/extract-pinned-zip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

python_bin=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)'; then
    python_bin="$candidate"
    break
  fi
done
[ -n "$python_bin" ] || {
  echo "Python 3.8 or newer is required" >&2
  exit 1
}

mkdir -p "$tmp/fixtures" "$tmp/config" "$tmp/bin" "$tmp/home"
"$python_bin" - "$tmp" <<'PY'
import hashlib
import stat
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1])
fixtures = root / "fixtures"
config = root / "config"

def sdkmanager(version):
    return f'''#!/usr/bin/env bash
set -euo pipefail
sdk_root=""
operation=""
packages=()
for argument in "$@"; do
  case "$argument" in
    --sdk_root=*) sdk_root="${{argument#--sdk_root=}}" ;;
    --version) operation=version ;;
    --licenses) operation=licenses ;;
    --install) operation=install ;;
    *) packages+=("$argument") ;;
  esac
done
[ -n "$sdk_root" ]
case "$operation" in
  version)
    printf '{version}\\n'
    ;;
  licenses)
    exit 0
    ;;
  install)
    expected=(
      platform-tools
      'platforms;android-36'
      'build-tools;36.0.0'
      'cmake;3.22.1'
      'ndk;27.0.12077973'
    )
    [ "${{#packages[@]}}" = "${{#expected[@]}}" ]
    for index in "${{!expected[@]}}"; do
      [ "${{packages[$index]}}" = "${{expected[$index]}}" ]
    done
    mkdir -p \
      "$sdk_root/platform-tools" \
      "$sdk_root/platforms/android-36" \
      "$sdk_root/build-tools/36.0.0" \
      "$sdk_root/cmake/3.22.1/bin" \
      "$sdk_root/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$sdk_root/platform-tools/adb"
    chmod +x "$sdk_root/platform-tools/adb"
    printf 'AndroidVersion.ApiLevel=36\\n' > "$sdk_root/platforms/android-36/source.properties"
    printf 'fake-android-jar\\n' > "$sdk_root/platforms/android-36/android.jar"
    printf 'Pkg.Revision=36.0.0\\n' > "$sdk_root/build-tools/36.0.0/source.properties"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$sdk_root/build-tools/36.0.0/aapt2"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$sdk_root/build-tools/36.0.0/zipalign"
    chmod +x "$sdk_root/build-tools/36.0.0/aapt2" "$sdk_root/build-tools/36.0.0/zipalign"
    printf 'Pkg.Revision = 3.22.1\\n' > "$sdk_root/cmake/3.22.1/source.properties"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$sdk_root/cmake/3.22.1/bin/cmake"
    chmod +x "$sdk_root/cmake/3.22.1/bin/cmake"
    printf 'Pkg.Revision = 27.0.12077973\\n' > "$sdk_root/ndk/27.0.12077973/source.properties"
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$sdk_root/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"
    chmod +x "$sdk_root/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"
    count=0
    [ ! -f "$sdk_root/fake-install-count" ] || count="$(cat "$sdk_root/fake-install-count")"
    printf '%s\\n' "$((count + 1))" > "$sdk_root/fake-install-count"
    ;;
  *)
    exit 2
    ;;
esac
'''.encode()

def avdmanager():
    return b'''#!/usr/bin/env bash
set -euo pipefail
exit 0
'''

def write_archive(name, version, layout="cmdline-tools"):
    path = fixtures / name
    entries = {
        f"{layout}/bin/sdkmanager": sdkmanager(version),
        f"{layout}/bin/avdmanager": avdmanager(),
        f"{layout}/source.properties": b"Pkg.Revision=20.0\n",
        f"{layout}/lib/sdkmanager-classpath.jar": b"fake-classpath\n",
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for member, contents in entries.items():
            info = zipfile.ZipInfo(member)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (
                stat.S_IFREG
                | (0o755 if member.endswith(("sdkmanager", "avdmanager")) else 0o644)
            ) << 16
            archive.writestr(info, contents)
    return hashlib.sha256(path.read_bytes()).hexdigest()

good_sha = write_archive("android.zip", "20.0")
wrong_version_sha = write_archive("android-wrong-version.zip", "19.0")
wrong_layout_sha = write_archive("android-wrong-layout.zip", "20.0", "not-cmdline-tools")

def manifest(name, digest):
    (config / name).write_text(f'''[packages]
command_line_tools_build = "14742923"
command_line_tools_revision = "20.0"
ndk = "27.0.12077973"
cmake = "3.22.1"
compile_sdk = "36"
build_tools = "36.0.0"

[command_line_tools.linux]
url = "https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip"
mirror_url = "https://edgedl.me.gvt1.com/edgedl/android/repository/commandlinetools-linux-14742923_latest.zip"
sha256 = "{digest}"
entry_count = "4"
''', encoding="utf-8")

manifest("android.toml", good_sha)
manifest("android-bad-sha.toml", "0" * 64)
manifest("android-wrong-version.toml", wrong_version_sha)
manifest("android-wrong-layout.toml", wrong_layout_sha)
PY

"$python_bin" - "$tmp/bin/curl" <<'PY'
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_text(r'''#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ]
printf '%s\n' "$url" >> "$CURL_LOG"
case "$CURL_MODE" in
  mirror)
    case "$url" in
      https://dl.google.com/*) printf 'corrupt-primary\n' > "$output" ;;
      https://edgedl.me.gvt1.com/*) cp "$ANDROID_ARCHIVE" "$output" ;;
      *) exit 22 ;;
    esac
    ;;
  fail-all)
    exit 22
    ;;
  *)
    echo "unknown CURL_MODE=$CURL_MODE" >&2
    exit 2
    ;;
esac
''', encoding="utf-8")
path.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
PY

common_env=(
  "HOME=$tmp/home"
  "OLIPHAUNT_ANDROID_ZIP_EXTRACTOR=$extractor"
  "OLIPHAUNT_ANDROID_CURL=$tmp/bin/curl"
  "ANDROID_SDKMANAGER_INSTALL_ATTEMPTS=1"
  "ANDROID_SDKMANAGER_RETRY_DELAY=0"
  "CURL_LOG=$tmp/curl.log"
)

run_android() {
  env "${common_env[@]}" \
    "OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST=${ANDROID_MANIFEST:-$tmp/config/android.toml}" \
    "ANDROID_ARCHIVE=${ANDROID_ARCHIVE:-$tmp/fixtures/android.zip}" \
    "CURL_MODE=${CURL_MODE:-mirror}" \
    "$installer" \
      --sdk-root "${SDK_ROOT:-$tmp/sdk}" \
      --ndk-version 27.0.12077973 \
      --cmake-version 3.22.1 \
      --compile-sdk 36
}

# The official mirror is a bounded fallback, and installed identities are exact.
: > "$tmp/curl.log"
run_android > "$tmp/first.out"
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "2" ]
grep -q '^https://dl.google.com/android/repository/' "$tmp/curl.log"
grep -q '^https://edgedl.me.gvt1.com/edgedl/android/repository/' "$tmp/curl.log"
grep -qx 'Pkg.Revision=20.0' "$tmp/sdk/cmdline-tools/latest/source.properties"
[ -x "$tmp/sdk/cmdline-tools/latest/bin/avdmanager" ]
grep -qx 'Pkg.Revision = 27.0.12077973' "$tmp/sdk/ndk/27.0.12077973/source.properties"
grep -qx 'Pkg.Revision = 3.22.1' "$tmp/sdk/cmake/3.22.1/source.properties"
grep -qx 'Pkg.Revision=36.0.0' "$tmp/sdk/build-tools/36.0.0/source.properties"
grep -qx 'AndroidVersion.ApiLevel=36' "$tmp/sdk/platforms/android-36/source.properties"
[ -x "$tmp/sdk/platform-tools/adb" ]
grep -qx 1 "$tmp/sdk/fake-install-count"

# Fully valid local state performs no transport and no repository package install.
: > "$tmp/curl.log"
CURL_MODE=fail-all run_android > "$tmp/cache-hit.out"
[ ! -s "$tmp/curl.log" ]
grep -qx 1 "$tmp/sdk/fake-install-count"

# Command-line-tools are only cache-valid when every executable consumed by
# later CI phases retains its executable bit. This is the exact failure mode
# that would otherwise surface much later while creating an emulator AVD.
chmod a-x "$tmp/sdk/cmdline-tools/latest/bin/avdmanager"
: > "$tmp/curl.log"
run_android > "$tmp/avdmanager-repair.out"
[ -x "$tmp/sdk/cmdline-tools/latest/bin/avdmanager" ]
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "2" ]

# A corrupt command-line-tools cache is replaced from verified archive bytes.
printf 'Pkg.Revision=0.0\n' > "$tmp/sdk/cmdline-tools/latest/source.properties"
: > "$tmp/curl.log"
run_android > "$tmp/cmdline-repair.out"
grep -qx 'Pkg.Revision=20.0' "$tmp/sdk/cmdline-tools/latest/source.properties"
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "2" ]

# Corrupt package metadata is removed and reinstalled under the exact package path.
rm "$tmp/sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"
: > "$tmp/curl.log"
CURL_MODE=fail-all run_android > "$tmp/package-repair.out"
[ ! -s "$tmp/curl.log" ]
grep -qx 'Pkg.Revision = 27.0.12077973' "$tmp/sdk/ndk/27.0.12077973/source.properties"
grep -qx 2 "$tmp/sdk/fake-install-count"

# Checksum, layout, and executable-version failures never promote command-line-tools.
if ANDROID_MANIFEST="$tmp/config/android-bad-sha.toml" SDK_ROOT="$tmp/sdk-bad-sha" \
  run_android > "$tmp/bad-sha.out" 2> "$tmp/bad-sha.err"; then
  echo "expected Android checksum failure" >&2
  exit 1
fi
[ ! -e "$tmp/sdk-bad-sha/cmdline-tools/latest" ]

if ANDROID_MANIFEST="$tmp/config/android-wrong-layout.toml" \
  ANDROID_ARCHIVE="$tmp/fixtures/android-wrong-layout.zip" SDK_ROOT="$tmp/sdk-wrong-layout" \
  run_android > "$tmp/wrong-layout.out" 2> "$tmp/wrong-layout.err"; then
  echo "expected Android layout failure" >&2
  exit 1
fi
[ ! -e "$tmp/sdk-wrong-layout/cmdline-tools/latest" ]

if ANDROID_MANIFEST="$tmp/config/android-wrong-version.toml" \
  ANDROID_ARCHIVE="$tmp/fixtures/android-wrong-version.zip" SDK_ROOT="$tmp/sdk-wrong-version" \
  run_android > "$tmp/wrong-version.out" 2> "$tmp/wrong-version.err"; then
  echo "expected Android command-line-tools version failure" >&2
  exit 1
fi
[ ! -e "$tmp/sdk-wrong-version/cmdline-tools/latest" ]

# An interruption after moving corrupt local state restores that exact directory.
interrupt_root="$tmp/sdk-interrupt"
mkdir -p "$interrupt_root/cmdline-tools/latest"
printf 'preserve-me\n' > "$interrupt_root/cmdline-tools/latest/marker"
if OLIPHAUNT_ANDROID_TESTING=1 OLIPHAUNT_ANDROID_TEST_INTERRUPT_AFTER_BACKUP=1 \
  SDK_ROOT="$interrupt_root" run_android > "$tmp/interrupt.out" 2> "$tmp/interrupt.err"; then
  echo "expected injected Android installer interruption" >&2
  exit 1
fi
grep -qx preserve-me "$interrupt_root/cmdline-tools/latest/marker"
if find "$interrupt_root/cmdline-tools" -maxdepth 1 \
  \( -name '.command-line-tools.install.*' -o -name '.command-line-tools.backup.*' -o -name '.command-line-tools.archive.*' \) \
  -print -quit | grep -q .; then
  echo "interrupted Android installer left private staging state" >&2
  exit 1
fi

# Retry knobs are bounded before any network access.
for retry_case in attempts delay; do
  : > "$tmp/curl.log"
  retry_env=(ANDROID_SDKMANAGER_INSTALL_ATTEMPTS=1 ANDROID_SDKMANAGER_RETRY_DELAY=0)
  if [ "$retry_case" = attempts ]; then
    retry_env=(ANDROID_SDKMANAGER_INSTALL_ATTEMPTS=9 ANDROID_SDKMANAGER_RETRY_DELAY=0)
  else
    retry_env=(ANDROID_SDKMANAGER_INSTALL_ATTEMPTS=1 ANDROID_SDKMANAGER_RETRY_DELAY=61)
  fi
  if env "${common_env[@]}" "${retry_env[@]}" \
    "OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST=$tmp/config/android.toml" \
    "ANDROID_ARCHIVE=$tmp/fixtures/android.zip" CURL_MODE=fail-all \
    "$installer" --sdk-root "$tmp/sdk-unbounded-$retry_case" \
      > "$tmp/unbounded-$retry_case.out" 2> "$tmp/unbounded-$retry_case.err"; then
    echo "expected unbounded Android retry $retry_case to fail" >&2
    exit 1
  fi
  [ ! -s "$tmp/curl.log" ]
done

echo "Android SDK bootstrap fault tests passed"
