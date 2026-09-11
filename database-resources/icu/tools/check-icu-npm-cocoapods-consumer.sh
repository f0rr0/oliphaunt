#!/usr/bin/env bash
set -euo pipefail

tool="check-icu-npm-cocoapods-consumer.sh"

fail() {
  echo "$tool: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

[ "$#" -eq 1 ] || fail "usage: runtimes/liboliphaunt-native/tools/$tool LIBOLIPHAUNT_ICU_DATA.tar.gz"
[ "$(uname -s)" = "Darwin" ] || fail "this regression check requires macOS"

for command in cp diff find git grep mktemp pod ruby tail xcodebuild; do
  require "$command"
done

root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "must run inside the Oliphaunt git checkout"
podspec_source="$root/database-resources/icu/npm/OliphauntICU.podspec"
[ -f "$podspec_source" ] || fail "missing source podspec: $podspec_source"

archive_input="$1"
[ -f "$archive_input" ] || fail "missing ICU data archive: $archive_input"
archive_directory="$(cd "$(dirname "$archive_input")" && pwd -P)"
archive="$archive_directory/$(basename "$archive_input")"
case "$archive" in
  *.tar.gz)
    ;;
  *)
    fail "ICU data archive must end in .tar.gz: $archive"
    ;;
esac

cd "$root"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-icu-cocoapods.XXXXXX")"
scratch="$(cd "$scratch" && pwd -P)"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

work="$scratch/consumer"
pod_root="$work/OliphauntICU"
bundle_root="$pod_root/OliphauntICU.bundle"
source_icu="$bundle_root/share/icu"
derived_data="$scratch/DerivedData"
pod_log="$scratch/pod-install.log"
xcode_log="$scratch/xcodebuild.log"
mkdir -p "$bundle_root" "$work" "$scratch/cocoapods-home" "$scratch/swiftpm-cache"
cp "$podspec_source" "$pod_root/OliphauntICU.podspec"
"$root/tools/dev/bun.sh" -e '
  import { extractPortableArchiveTree } from "./tools/packaging/portable-archive.mts";
  extractPortableArchiveTree(process.argv[1], process.argv[2], "share/icu");
' "$archive" "$source_icu"

ruby - "$source_icu" <<'RUBY'
root = ARGV.fetch(0)
resources = Dir.glob(File.join(root, "**", "*.res")).select { |file| File.file?(file) }
duplicates = resources.group_by { |file| File.basename(file) }.values.select { |files| files.length > 1 }
abort "ICU payload has no repeated .res basename and does not exercise the CocoaPods regression" if duplicates.empty?
puts "ICU collision stimulus: #{duplicates.length} repeated .res basename groups"
RUBY

ruby - "$work" <<'RUBY'
require "fileutils"
require "xcodeproj"

root = File.expand_path(ARGV.fetch(0))
project_path = File.join(root, "OliphauntICUSmoke.xcodeproj")

File.write(File.join(root, "main.c"), <<~SOURCE)
  int main(int argc, char **argv) {
    return argc > 0 && argv[0] != 0 ? 0 : 1;
  }
SOURCE

File.write(File.join(root, "Info.plist"), <<~PLIST)
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key>
    <string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>$(PRODUCT_NAME)</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSRequiresIPhoneOS</key>
    <true/>
  </dict>
  </plist>
PLIST

File.write(File.join(root, "Podfile"), <<~PODFILE)
  platform :ios, '17.0'
  install! 'cocoapods', :deterministic_uuids => true

  target 'OliphauntICUSmoke' do
    pod 'OliphauntICU', :path => 'OliphauntICU'
  end
PODFILE

project = Xcodeproj::Project.new(project_path)
project.root_object.attributes["LastUpgradeCheck"] = "1600"
target = project.new_target(:application, "OliphauntICUSmoke", :ios, "17.0")
source = project.main_group.new_file("main.c")
target.add_file_references([source])

target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings["CODE_SIGNING_ALLOWED"] = "NO"
  settings["CODE_SIGNING_REQUIRED"] = "NO"
  settings["CURRENT_PROJECT_VERSION"] = "1"
  settings["ENABLE_USER_SCRIPT_SANDBOXING"] = "NO"
  settings["GENERATE_INFOPLIST_FILE"] = "NO"
  settings["INFOPLIST_FILE"] = "Info.plist"
  settings["IPHONEOS_DEPLOYMENT_TARGET"] = "17.0"
  settings["MARKETING_VERSION"] = "1.0"
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.oliphaunt.icu-cocoapods-smoke"
  settings["PRODUCT_NAME"] = "$(TARGET_NAME)"
  settings["SUPPORTED_PLATFORMS"] = "iphonesimulator"
  settings["TARGETED_DEVICE_FAMILY"] = "1,2"
end

project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.set_launch_target(target)
scheme.save_as(project_path, "OliphauntICUSmoke", true)
RUBY

if ! (
  cd "$work"
  env \
    COCOAPODS_DISABLE_STATS=true \
    COCOAPODS_SKIP_UPDATE_MESSAGE=true \
    CP_HOME_DIR="$scratch/cocoapods-home" \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    pod install
) >"$pod_log" 2>&1; then
  tail -200 "$pod_log" >&2
  fail "CocoaPods installation failed"
fi

machine_arch="$(uname -m)"
case "$machine_arch" in
  arm64|x86_64)
    ;;
  *)
    fail "unsupported macOS runner architecture: $machine_arch"
    ;;
esac

if ! xcodebuild \
  -workspace "$work/OliphauntICUSmoke.xcworkspace" \
  -scheme OliphauntICUSmoke \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" \
  -clonedSourcePackagesDirPath "$scratch/swiftpm-cache" \
  -disableAutomaticPackageResolution \
  -skipPackageUpdates \
  ARCHS="$machine_arch" \
  ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build >"$xcode_log" 2>&1; then
  grep -n -E 'error:|Multiple commands produce|BUILD FAILED|The following build commands failed' "$xcode_log" | tail -160 >&2 ||
    tail -200 "$xcode_log" >&2
  fail "xcodebuild failed"
fi

app="$derived_data/Build/Products/Release-iphonesimulator/OliphauntICUSmoke.app"
built_icu="$app/OliphauntICU.bundle/share/icu"
[ -d "$app" ] || fail "xcodebuild did not produce the expected app: $app"
[ -d "$built_icu" ] || fail "built app is missing OliphauntICU.bundle/share/icu"

unsupported="$(find "$built_icu" ! -type f ! -type d -print -quit)"
[ -z "$unsupported" ] || fail "built ICU tree contains an unsupported entry: $unsupported"
diff -r "$source_icu" "$built_icu" || fail "built ICU tree does not byte-match the staged source tree"

echo "$tool: PASS ($archive)"
