require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
native_sdk_version = ENV.fetch("OLIPHAUNT_REACT_NATIVE_SWIFT_SDK_VERSION") do
  package.fetch("oliphaunt", {}).fetch("swiftSdkVersion", package["version"])
end

Pod::Spec.new do |s|
  s.name = "OliphauntReactNative"
  s.version = package["version"]
  s.summary = package["description"]
  s.license = package["license"]
  s.homepage = "https://oliphaunt.dev"
  s.authors = { "Oliphaunt" => "opensource@oliphaunt.dev" }
  s.source = { :git => "https://github.com/f0rr0/oliphaunt.git", :tag => "oliphaunt-react-native-v#{s.version}" }
  s.platforms = { :ios => "17.0" }
  s.swift_version = "6.0"
  static_registry_sources = Dir.glob(File.join(__dir__, "ios/generated/static-registry/*.c"))
  s.source_files = "ios/*.{h,m,mm,swift}", "ios/generated/static-registry/*.c"
  if static_registry_sources.any?
    s.user_target_xcconfig = {
      "OTHER_LDFLAGS" => "$(inherited) -u _liboliphaunt_selected_static_extensions"
    }
  end
  resource_bundle = "ios/resources/OliphauntReactNativeResources.bundle"
  if Dir.exist?(File.join(__dir__, resource_bundle))
    s.resources = resource_bundle
  end
  vendored_frameworks = []
  if Dir.glob(File.join(__dir__, "ios/frameworks/**/*.xcframework")).any?
    vendored_frameworks << "ios/frameworks/**/*.xcframework"
  end
  if Dir.glob(File.join(__dir__, "ios/extension-frameworks/**/*.xcframework")).any?
    vendored_frameworks << "ios/extension-frameworks/**/*.xcframework"
  end
  unless vendored_frameworks.empty?
    s.vendored_frameworks = vendored_frameworks
  end
  s.requires_arc = true
  s.dependency "Oliphaunt", native_sdk_version

  install_modules_dependencies(s)
end
