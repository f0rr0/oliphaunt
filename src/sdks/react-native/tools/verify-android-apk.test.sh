#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
verifier="$root/src/sdks/react-native/tools/verify-android-apk.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

manifest="$tmp/android-sdk.toml"
sdk="$tmp/Android SDK"
tools="$sdk/build-tools/36.0.0"
apk_dir="$tmp/APK output"
apk="$apk_dir/app release.apk"
log="$tmp/tools.log"
mkdir -p "$tools" "$apk_dir"
cat >"$manifest" <<'EOF'
[packages]
build_tools = "36.0.0"
EOF
printf 'Pkg.Revision = 36.0.0\n' >"$tools/source.properties"
printf 'fake-apk\n' >"$apk"

cat >"$tools/zipalign" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'zipalign'
  printf '\t%s' "$@"
  printf '\n'
} >>"$OLIPHAUNT_ANDROID_APK_VERIFY_TEST_LOG"
exit "${OLIPHAUNT_ANDROID_APK_VERIFY_TEST_ZIPALIGN_EXIT:-0}"
EOF
cat >"$tools/apksigner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'apksigner'
  printf '\t%s' "$@"
  printf '\n'
} >>"$OLIPHAUNT_ANDROID_APK_VERIFY_TEST_LOG"
exit "${OLIPHAUNT_ANDROID_APK_VERIFY_TEST_APKSIGNER_EXIT:-0}"
EOF
chmod +x "$tools/zipalign" "$tools/apksigner"

run_verifier() {
  env \
    ANDROID_HOME="$sdk" \
    ANDROID_SDK_ROOT="$sdk" \
    OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST="$manifest" \
    OLIPHAUNT_ANDROID_APK_VERIFY_TEST_LOG="$log" \
    "$verifier" "$apk"
}

# The verifier selects tools from the manifest-pinned package, preserves paths
# with spaces, and uses the exact official verification commands.
: >"$log"
run_verifier >"$tmp/success.out"
printf 'zipalign\t-c\t-P\t16\t-v\t4\t%s\n' "$apk" >"$tmp/expected.log"
printf 'apksigner\tverify\t--verbose\t%s\n' "$apk" >>"$tmp/expected.log"
cmp "$tmp/expected.log" "$log"
grep -Fq 'Verified APK with manifest-pinned zipalign and apksigner' "$tmp/success.out"

expect_failure() {
  local label="$1"
  local expected="$2"
  shift 2
  if "$@" >"$tmp/$label.out" 2>"$tmp/$label.err"; then
    echo "expected $label to fail" >&2
    exit 1
  fi
  if [ -n "$expected" ]; then
    grep -Fq "$expected" "$tmp/$label.err" || {
      echo "$label did not report expected error: $expected" >&2
      cat "$tmp/$label.err" >&2
      exit 1
    }
  fi
}

# Missing, empty, non-executable, or substituted SDK tools fail before either
# verifier can accept an artifact.
mv "$tools/apksigner" "$tools/apksigner.saved"
: >"$log"
expect_failure missing-apksigner 'missing regular executable manifest-pinned Android tool' run_verifier
[ ! -s "$log" ]
mv "$tools/apksigner.saved" "$tools/apksigner"

chmod a-x "$tools/zipalign"
: >"$log"
expect_failure non-executable-zipalign 'missing regular executable manifest-pinned Android tool' run_verifier
[ ! -s "$log" ]
chmod +x "$tools/zipalign"

ln -s "$tools/apksigner" "$tools/apksigner.link"
mv "$tools/apksigner" "$tools/apksigner.real"
mv "$tools/apksigner.link" "$tools/apksigner"
: >"$log"
expect_failure symlink-apksigner 'missing regular executable manifest-pinned Android tool' run_verifier
[ ! -s "$log" ]
rm "$tools/apksigner"
mv "$tools/apksigner.real" "$tools/apksigner"

# Either official tool rejecting the APK is fatal. apksigner is not attempted
# after an alignment rejection.
: >"$log"
expect_failure zipalign-rejection 'manifest-pinned zipalign rejected the APK' env \
  ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk" \
  OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST="$manifest" \
  OLIPHAUNT_ANDROID_APK_VERIFY_TEST_LOG="$log" \
  OLIPHAUNT_ANDROID_APK_VERIFY_TEST_ZIPALIGN_EXIT=23 \
  "$verifier" "$apk"
[ "$(wc -l <"$log" | tr -d '[:space:]')" = 1 ]
grep -q '^zipalign' "$log"

: >"$log"
expect_failure apksigner-rejection 'manifest-pinned apksigner rejected the APK' env \
  ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk" \
  OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST="$manifest" \
  OLIPHAUNT_ANDROID_APK_VERIFY_TEST_LOG="$log" \
  OLIPHAUNT_ANDROID_APK_VERIFY_TEST_APKSIGNER_EXIT=24 \
  "$verifier" "$apk"
cmp "$tmp/expected.log" "$log"

# Installed package identity, SDK-root identity, manifest shape, and artifact
# type are independently fail-closed.
printf 'Pkg.Revision=35.0.0\n' >"$tools/source.properties"
expect_failure wrong-package-revision 'does not match manifest pin 36.0.0' run_verifier
printf 'Pkg.Revision=36.0.0\n' >"$tools/source.properties"

mkdir -p "$tmp/other-sdk"
expect_failure split-sdk-roots 'resolve to different SDKs' env \
  ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$tmp/other-sdk" \
  OLIPHAUNT_ANDROID_TOOLCHAIN_MANIFEST="$manifest" \
  "$verifier" "$apk"

printf '\n[packages]\nbuild_tools = "36.0.0"\n' >>"$manifest"
expect_failure duplicate-manifest-pin 'exactly one quoted packages.build_tools value' run_verifier
cat >"$manifest" <<'EOF'
[packages]
build_tools = "../../untrusted"
EOF
expect_failure unsafe-manifest-pin 'non-empty dot-separated numbers' run_verifier
cat >"$manifest" <<'EOF'
[packages]
build_tools = "36.0.0"
EOF

ln -s "$apk" "$apk_dir/app-link.apk"
original_apk="$apk"
apk="$apk_dir/app-link.apk"
expect_failure symlink-apk 'APK must be a non-empty regular file, not a symlink' run_verifier
apk="$original_apk"

# The product-owned build invokes this verifier before its artifact-report
# writer copies the APK into release staging.
runner="$root/src/sdks/react-native/tools/expo-android-runner.sh"
verification_line="run \"\$root/src/sdks/react-native/tools/verify-android-apk.sh\" \"\$apk\""
verification_number="$(grep -nF "$verification_line" "$runner" | cut -d: -f1)"
staging_line="write_android_build_artifact_report \"\$selected_extensions\""
staging_number="$(grep -nF "$staging_line" "$runner" | cut -d: -f1)"
if [ -z "$verification_number" ] || [ -z "$staging_number" ] ||
  [ "$verification_number" -ge "$staging_number" ]; then
  echo "Android runner must verify the APK before writing its staged artifact report" >&2
  exit 1
fi

echo "verify-android-apk.test.sh: pinned tool selection and failure contracts passed"
