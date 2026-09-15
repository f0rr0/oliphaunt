#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/tools/dev/setup-android-sdk.sh"
extractor="$root/tools/dev/extract-pinned-zip.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM


mkdir -p "$tmp/fixtures" "$tmp/config" "$tmp/bin" "$tmp/home"
bash "$root/tools/dev/bun.sh" - "$tmp" <<'TS'
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {zipArchive} from './tools/packaging/testdata/zip-fixture.mts';
const root = process.argv[2];
const sha = data => createHash('sha256').update(data).digest('hex');
const write = (name, data) => writeFileSync(root + '/' + name, data);

function archive(name, version, layout = 'cmdline-tools') {
  const entries = {
    [layout + '/bin/sdkmanager']: "#!/usr/bin/env bash\nset -euo pipefail\nsdk_root=\"\"\noperation=\"\"\npackages=()\nfor argument in \"$@\"; do\n  case \"$argument\" in\n    --sdk_root=*) sdk_root=\"${argument#--sdk_root=}\" ;;\n    --version) operation=version ;;\n    --licenses) operation=licenses ;;\n    --install) operation=install ;;\n    *) packages+=(\"$argument\") ;;\n  esac\ndone\n[ -n \"$sdk_root\" ]\ncase \"$operation\" in\n  version)\n    printf '{version}\\n'\n    ;;\n  licenses)\n    exit 0\n    ;;\n  install)\n    expected=(\n      platform-tools\n      'platforms;android-36'\n      'build-tools;36.0.0'\n      'cmake;3.22.1'\n      'ndk;27.0.12077973'\n    )\n    [ \"${#packages[@]}\" = \"${#expected[@]}\" ]\n    for index in \"${!expected[@]}\"; do\n      [ \"${packages[$index]}\" = \"${expected[$index]}\" ]\n    done\n    mkdir -p \\\n      \"$sdk_root/platform-tools\" \\\n      \"$sdk_root/platforms/android-36\" \\\n      \"$sdk_root/build-tools/36.0.0\" \\\n      \"$sdk_root/cmake/3.22.1/bin\" \\\n      \"$sdk_root/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin\"\n    printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$sdk_root/platform-tools/adb\"\n    chmod +x \"$sdk_root/platform-tools/adb\"\n    printf 'AndroidVersion.ApiLevel=36\\n' > \"$sdk_root/platforms/android-36/source.properties\"\n    printf 'fake-android-jar\\n' > \"$sdk_root/platforms/android-36/android.jar\"\n    printf 'Pkg.Revision=36.0.0\\n' > \"$sdk_root/build-tools/36.0.0/source.properties\"\n    printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$sdk_root/build-tools/36.0.0/aapt2\"\n    printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$sdk_root/build-tools/36.0.0/zipalign\"\n    printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$sdk_root/build-tools/36.0.0/apksigner\"\n    chmod +x \\\n      \"$sdk_root/build-tools/36.0.0/aapt2\" \\\n      \"$sdk_root/build-tools/36.0.0/zipalign\" \\\n      \"$sdk_root/build-tools/36.0.0/apksigner\"\n    printf 'Pkg.Revision = 3.22.1\\n' > \"$sdk_root/cmake/3.22.1/source.properties\"\n    printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$sdk_root/cmake/3.22.1/bin/cmake\"\n    chmod +x \"$sdk_root/cmake/3.22.1/bin/cmake\"\n    printf 'Pkg.Revision = 27.0.12077973\\n' > \"$sdk_root/ndk/27.0.12077973/source.properties\"\n    printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$sdk_root/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/clang\"\n    chmod +x \"$sdk_root/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/clang\"\n    count=0\n    [ ! -f \"$sdk_root/fake-install-count\" ] || count=\"$(cat \"$sdk_root/fake-install-count\")\"\n    printf '%s\\n' \"$((count + 1))\" > \"$sdk_root/fake-install-count\"\n    ;;\n  *)\n    exit 2\n    ;;\nesac\n".replace('{version}', version),
    [layout + '/bin/avdmanager']: '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    [layout + '/bin/apkanalyzer']: '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
    [layout + '/source.properties']: 'Pkg.Revision=20.0\n',
    [layout + '/lib/sdkmanager-classpath.jar']: 'fake-classpath\n',
  };
  const bytes = zipArchive(Object.entries(entries).map(([name,data]) => ({name,data,method: 8,externalAttributes: (name.includes('/bin/') ? 0o100755 : 0o100644) << 16})));
  write('fixtures/' + name, bytes);
  return sha(bytes);
}
for (const [name, digest] of [
  ['android.toml', archive('android.zip','20.0')],
  ['android-bad-sha.toml','0'.repeat(64)],
  ['android-wrong-version.toml',archive('android-wrong-version.zip','19.0')],
  ['android-wrong-layout.toml',archive('android-wrong-layout.zip','20.0','not-cmdline-tools')],
]) write('config/' + name, "[packages]\ncommand_line_tools_build = \"14742923\"\ncommand_line_tools_revision = \"20.0\"\nndk = \"27.0.12077973\"\ncmake = \"3.22.1\"\ncompile_sdk = \"36\"\nbuild_tools = \"36.0.0\"\n\n[command_line_tools.linux]\nurl = \"https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip\"\nmirror_url = \"https://edgedl.me.gvt1.com/edgedl/android/repository/commandlinetools-linux-14742923_latest.zip\"\nsha256 = \"{digest}\"\nentry_count = \"5\"\n\n[command_line_tools.mac]\nurl = \"https://dl.google.com/android/repository/commandlinetools-mac-14742923_latest.zip\"\nmirror_url = \"https://edgedl.me.gvt1.com/edgedl/android/repository/commandlinetools-mac-14742923_latest.zip\"\nsha256 = \"{digest}\"\nentry_count = \"5\"\n".replaceAll('{digest}', digest));

TS

cat >"$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
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
SH
chmod 0700 "$tmp/bin/curl"

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
[ -x "$tmp/sdk/cmdline-tools/latest/bin/apkanalyzer" ]
grep -qx 'Pkg.Revision = 27.0.12077973' "$tmp/sdk/ndk/27.0.12077973/source.properties"
grep -qx 'Pkg.Revision = 3.22.1' "$tmp/sdk/cmake/3.22.1/source.properties"
grep -qx 'Pkg.Revision=36.0.0' "$tmp/sdk/build-tools/36.0.0/source.properties"
grep -qx 'AndroidVersion.ApiLevel=36' "$tmp/sdk/platforms/android-36/source.properties"
[ -x "$tmp/sdk/platform-tools/adb" ]
[ -x "$tmp/sdk/build-tools/36.0.0/zipalign" ]
[ -x "$tmp/sdk/build-tools/36.0.0/apksigner" ]
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

chmod a-x "$tmp/sdk/cmdline-tools/latest/bin/apkanalyzer"
: > "$tmp/curl.log"
run_android > "$tmp/apkanalyzer-repair.out"
[ -x "$tmp/sdk/cmdline-tools/latest/bin/apkanalyzer" ]
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "2" ]

# A corrupt command-line-tools cache is replaced from verified archive bytes.
printf 'Pkg.Revision=0.0\n' > "$tmp/sdk/cmdline-tools/latest/source.properties"
: > "$tmp/curl.log"
run_android > "$tmp/cmdline-repair.out"
grep -qx 'Pkg.Revision=20.0' "$tmp/sdk/cmdline-tools/latest/source.properties"
[ "$(wc -l < "$tmp/curl.log" | tr -d ' ')" = "2" ]

# Corrupt package metadata is removed and reinstalled under the exact package path.
rm "$tmp/sdk/build-tools/36.0.0/apksigner"
: > "$tmp/curl.log"
CURL_MODE=fail-all run_android > "$tmp/build-tools-repair.out"
[ ! -s "$tmp/curl.log" ]
[ -x "$tmp/sdk/build-tools/36.0.0/apksigner" ]
grep -qx 2 "$tmp/sdk/fake-install-count"

# Every other exact SDK package remains independently repairable.
rm "$tmp/sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"
: > "$tmp/curl.log"
CURL_MODE=fail-all run_android > "$tmp/package-repair.out"
[ ! -s "$tmp/curl.log" ]
grep -qx 'Pkg.Revision = 27.0.12077973' "$tmp/sdk/ndk/27.0.12077973/source.properties"
grep -qx 3 "$tmp/sdk/fake-install-count"

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
