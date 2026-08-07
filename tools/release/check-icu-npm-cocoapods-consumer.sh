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

[ "$#" -eq 1 ] || fail "usage: tools/release/$tool LIBOLIPHAUNT_ICU_DATA.tar.gz"
[ "$(uname -s)" = "Darwin" ] || fail "this regression check requires macOS"

for command in cp find git grep mktemp pod ruby sed sort tail tar uniq xcodebuild; do
  require "$command"
done

root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "must run inside the Oliphaunt git checkout"
podspec_source="$root/src/runtimes/liboliphaunt/native/icu-npm/OliphauntICU.podspec"
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
members="$scratch/archive-members.txt"
mkdir -p "$bundle_root" "$work" "$scratch/cocoapods-home" "$scratch/swiftpm-cache"

if ! tar -tzf "$archive" >"$members"; then
  fail "cannot list ICU data archive: $archive"
fi
[ -s "$members" ] || fail "ICU data archive is empty: $archive"

while IFS= read -r member || [ -n "$member" ]; do
  normalized="${member#./}"
  case "$normalized" in
    ""|.)
      continue
      ;;
    /*)
      fail "ICU data archive contains an absolute member: $member"
      ;;
  esac
  case "/$normalized/" in
    */../*)
      fail "ICU data archive contains a parent traversal: $member"
      ;;
  esac
done <"$members"

duplicate_members="$(LC_ALL=C sort "$members" | uniq -d)"
[ -z "$duplicate_members" ] ||
  fail "ICU data archive contains duplicate members: $(printf '%s\n' "$duplicate_members" | sed -n '1,5p')"
grep -Eq '^(\./)?share/icu/' "$members" ||
  fail "ICU data archive has no share/icu tree: $archive"

cp "$podspec_source" "$pod_root/OliphauntICU.podspec"
grep -Fq "s.resources = 'OliphauntICU.bundle'" "$pod_root/OliphauntICU.podspec" ||
  fail "source podspec must install OliphauntICU.bundle through s.resources"
if grep -Fq "resource_bundles" "$pod_root/OliphauntICU.podspec"; then
  fail "source podspec must not generate a CocoaPods resource-bundle target"
fi

if ! tar -xzf "$archive" -C "$bundle_root" share/icu; then
  fail "cannot extract share/icu from $archive"
fi
[ -d "$source_icu" ] || fail "staged pod has no OliphauntICU.bundle/share/icu"
source_symlink="$(find "$source_icu" -type l -print -quit)"
[ -z "$source_symlink" ] || fail "staged ICU data contains a symbolic link: $source_symlink"
source_file="$(find "$source_icu" -type f -path '*/icudt*' -print -quit)"
[ -n "$source_file" ] || fail "staged ICU data has no icudt* payload files"

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

if grep -Eq 'Generated duplicate UUIDs|Multiple commands produce' "$pod_log"; then
  tail -200 "$pod_log" >&2
  fail "CocoaPods generated a duplicate resource graph"
fi

lockfile="$work/Podfile.lock"
[ -f "$lockfile" ] || fail "CocoaPods did not create Podfile.lock"
grep -Fq 'EXTERNAL SOURCES:' "$lockfile" || fail "Podfile.lock does not record the local ICU pod"
grep -Fq ':path: OliphauntICU' "$lockfile" || fail "Podfile.lock did not resolve ICU from its local path"
if grep -Fq 'SPEC REPOS:' "$lockfile"; then
  fail "standalone CocoaPods consumer unexpectedly resolved a specs repository"
fi
if grep -Eq 'https?://|:git:' "$lockfile"; then
  fail "standalone CocoaPods consumer resolved a network dependency"
fi

pods_project="$work/Pods/Pods.xcodeproj"
pods_pbxproj="$pods_project/project.pbxproj"
[ -f "$pods_pbxproj" ] || fail "CocoaPods did not create Pods.xcodeproj"

ruby - "$pods_project" <<'RUBY'
require "xcodeproj"

project = Xcodeproj::Project.open(ARGV.fetch(0))
bundle_targets = project.targets.select do |target|
  target.name.include?("OliphauntICU") &&
    target.respond_to?(:product_type) &&
    target.product_type == "com.apple.product-type.bundle"
end
unless bundle_targets.empty?
  abort "generated ICU resource-bundle targets: #{bundle_targets.map(&:name).join(', ')}"
end

resource_files = project.files.each_with_object([]) do |reference, files|
  path = reference.path.to_s
  files << path if File.extname(path) == ".res"
end
unless resource_files.empty?
  abort "individual ICU .res file references: #{resource_files.first(10).join(', ')}"
end

bundle_references = project.files.select { |reference| reference.path.to_s == "OliphauntICU.bundle" }
unless bundle_references.length == 1
  abort "expected one opaque OliphauntICU.bundle reference, found #{bundle_references.length}"
end
RUBY

if grep -Fq '.res' "$pods_pbxproj"; then
  fail "Pods project contains individual .res resource entries"
fi
if grep -Fq 'OliphauntICU-OliphauntICU' "$pods_pbxproj"; then
  fail "Pods project contains a generated OliphauntICU resource-bundle target"
fi
generated_bundle_metadata="$(find "$work/Pods" -type f -name 'ResourceBundle-*OliphauntICU*' -print -quit)"
[ -z "$generated_bundle_metadata" ] ||
  fail "CocoaPods generated resource-bundle target metadata: $generated_bundle_metadata"

resources_script="$work/Pods/Target Support Files/Pods-OliphauntICUSmoke/Pods-OliphauntICUSmoke-resources.sh"
[ -f "$resources_script" ] || fail "CocoaPods did not generate its aggregate resource script"
bundle_install_count="$(grep -F 'install_resource ' "$resources_script" | grep -F -c 'OliphauntICU.bundle' || true)"
[ "$bundle_install_count" -gt 0 ] || fail "aggregate resource script does not install OliphauntICU.bundle"
invalid_icu_install="$(grep -F 'install_resource ' "$resources_script" | grep -F 'OliphauntICU' | grep -Fv 'OliphauntICU.bundle' || true)"
[ -z "$invalid_icu_install" ] || fail "aggregate resource script installs non-bundle ICU resources"

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

if grep -Fq 'Multiple commands produce' "$xcode_log"; then
  tail -200 "$xcode_log" >&2
  fail "xcodebuild reported duplicate resource outputs"
fi
grep -Fq '** BUILD SUCCEEDED **' "$xcode_log" || fail "xcodebuild did not report success"

app="$derived_data/Build/Products/Release-iphonesimulator/OliphauntICUSmoke.app"
built_icu="$app/OliphauntICU.bundle/share/icu"
[ -d "$app" ] || fail "xcodebuild did not produce the expected app: $app"
[ -d "$built_icu" ] || fail "built app is missing OliphauntICU.bundle/share/icu"

ruby - "$source_icu" "$built_icu" <<'RUBY'
require "digest"

def tree_manifest(root)
  Dir.chdir(root) do
    Dir.glob("**/*", File::FNM_DOTMATCH).sort.each_with_object([]) do |relative, entries|
      next if relative.split(File::SEPARATOR).any? { |part| part == "." || part == ".." }

      stat = File.lstat(relative)
      if stat.directory?
        entries << ["directory", relative]
      elsif stat.file?
        entries << ["file", relative, stat.size, Digest::SHA256.file(relative).hexdigest]
      else
        abort "unsupported ICU tree entry: #{File.join(root, relative)}"
      end
    end
  end
end

source_root, built_root = ARGV
source = tree_manifest(source_root)
built = tree_manifest(built_root)
unless source == built
  source_only = source - built
  built_only = built - source
  warn "source-only ICU entries: #{source_only.first(10).inspect}" unless source_only.empty?
  warn "built-only ICU entries: #{built_only.first(10).inspect}" unless built_only.empty?
  abort "built ICU tree does not byte-match the staged source tree"
end

files = source.count { |entry| entry[0] == "file" }
bytes = source.sum { |entry| entry[0] == "file" ? entry[2] : 0 }
puts "Built ICU bundle matches source: #{files} files, #{bytes} bytes"
RUBY

echo "$tool: PASS ($archive)"
