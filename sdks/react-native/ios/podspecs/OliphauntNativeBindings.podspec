require "json"
require "shellwords"

package = JSON.parse(File.read(File.expand_path("../../package.json", __dir__)))
swift_sdk_version = ENV.fetch("OLIPHAUNT_REACT_NATIVE_SWIFT_SDK_VERSION") do
  package.fetch("oliphaunt", {}).fetch("swiftSdkVersion", package["version"])
end
swift_sdk_git = ENV.fetch("OLIPHAUNT_SWIFT_SDK_GIT_URL", "https://github.com/f0rr0/oliphaunt.git")
swift_sdk_tag = ENV.fetch("OLIPHAUNT_SWIFT_SDK_TAG", swift_sdk_version)
swift_sdk_commit = ENV["OLIPHAUNT_SWIFT_SDK_COMMIT"]
swift_sdk_branch = ENV["OLIPHAUNT_SWIFT_SDK_BRANCH"]
swift_sdk_source = { :git => swift_sdk_git }
if swift_sdk_commit && !swift_sdk_commit.empty?
  swift_sdk_source[:commit] = swift_sdk_commit
elsif swift_sdk_branch && !swift_sdk_branch.empty?
  swift_sdk_source[:branch] = swift_sdk_branch
else
  swift_sdk_source[:tag] = swift_sdk_tag
end

Pod::Spec.new do |s|
  s.name = "OliphauntNativeBindings"
  s.version = swift_sdk_version
  s.summary = "Generated native bindings for the Oliphaunt Swift SDK."
  s.license = package["license"]
  s.homepage = "https://oliphaunt.dev"
  s.authors = { "Oliphaunt" => "opensource@oliphaunt.dev" }
  s.source = swift_sdk_source
  s.platforms = { :ios => "17.0" }
  s.swift_version = "6.0"
  s.source_files = "sdks/swift/Sources/OliphauntNativeBindings/**/*.swift"
  s.vendored_frameworks = "Artifacts/OliphauntNativeBindingsFFI.xcframework"
  s.requires_arc = true
  s.prepare_command = "set -- #{Shellwords.escape(swift_sdk_version)}\n" + File.read(File.join(__dir__, "prepare-native-bindings.sh"))
end
