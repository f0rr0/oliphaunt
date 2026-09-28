require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
native_sdk_version = ENV.fetch("OLIPHAUNT_REACT_NATIVE_SWIFT_SDK_VERSION") do
  package.fetch("oliphaunt", {}).fetch("swiftSdkVersion", package["version"])
end

topology = ENV.fetch("OLIPHAUNT_REACT_NATIVE_TOPOLOGY", "direct")
unless ["direct", "broker"].include?(topology)
  raise "OLIPHAUNT_REACT_NATIVE_TOPOLOGY must be direct or broker"
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
  s.source_files = "ios/*.{h,m,mm,swift}", "cpp/*.{h,cpp}"
  s.private_header_files = "cpp/*.h", "ios/OliphauntReactNative.h"
  s.exclude_files = "cpp/*.test.cpp"
  s.requires_arc = true
  if topology == "broker"
    s.platforms = { :ios => "26.0" }
    s.dependency "OliphauntBroker", native_sdk_version
    s.pod_target_xcconfig = { "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => "$(inherited) OLIPHAUNT_BROKER" }
  else
    s.dependency "Oliphaunt", native_sdk_version
  end

  install_modules_dependencies(s)
end
