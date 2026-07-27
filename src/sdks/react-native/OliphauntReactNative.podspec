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
  s.source_files = "ios/*.{h,m,mm,swift}"
  s.requires_arc = true
  s.dependency "Oliphaunt", native_sdk_version

  install_modules_dependencies(s)
end
