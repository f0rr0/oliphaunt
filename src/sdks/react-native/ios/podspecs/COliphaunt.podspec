require "json"

package = JSON.parse(File.read(File.expand_path("../../package.json", __dir__)))
swift_sdk_version = ENV.fetch("OLIPHAUNT_REACT_NATIVE_SWIFT_SDK_VERSION") do
  package.fetch("oliphaunt", {}).fetch("swiftSdkVersion", package["version"])
end
swift_sdk_git = ENV.fetch("OLIPHAUNT_SWIFT_SDK_GIT_URL", "https://github.com/f0rr0/oliphaunt.git")
swift_sdk_tag = ENV.fetch("OLIPHAUNT_SWIFT_SDK_TAG", "oliphaunt-swift-v#{swift_sdk_version}")
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
  s.name = "COliphaunt"
  s.version = swift_sdk_version
  s.summary = "C bridge for the Oliphaunt Swift SDK."
  s.license = package["license"]
  s.homepage = "https://oliphaunt.dev"
  s.authors = { "Oliphaunt" => "opensource@oliphaunt.dev" }
  s.source = swift_sdk_source
  s.platforms = { :ios => "17.0" }
  s.source_files = "src/sdks/swift/Sources/COliphaunt/**/*.{c,h}"
  s.public_header_files = "src/sdks/swift/Sources/COliphaunt/include/COliphaunt.h", "src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h"
  s.header_mappings_dir = "src/sdks/swift/Sources/COliphaunt/include"
  s.module_map = "src/sdks/swift/Sources/COliphaunt/include/module.modulemap"
  s.module_name = "COliphaunt"
  s.requires_arc = false
end
