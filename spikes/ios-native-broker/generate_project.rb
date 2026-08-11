#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "pathname"
require "xcodeproj"

fixture_root = Pathname.new(__dir__).realpath
repo_root = fixture_root.join("../..").realpath
generated_root = fixture_root.join("Generated")
project_path = generated_root.join("OliphauntBrokerSpike.xcodeproj")
host_bundle_identifier = ENV.fetch(
  "OLIPHAUNT_IOS_BROKER_BUNDLE_ID",
  "dev.oliphaunt.brokerspike"
)
abort("the ExtensionFoundation binding requires host bundle ID dev.oliphaunt.brokerspike") unless host_bundle_identifier == "dev.oliphaunt.brokerspike"
extension_bundle_identifier = ENV.fetch(
  "OLIPHAUNT_IOS_BROKER_EXTENSION_BUNDLE_ID",
  "dev.oliphaunt.brokerspike.extension"
)
abort("the fixture requires extension bundle ID dev.oliphaunt.brokerspike.extension") unless extension_bundle_identifier == "dev.oliphaunt.brokerspike.extension"
development_team = ENV.fetch("OLIPHAUNT_IOS_BROKER_DEVELOPMENT_TEAM", "")
artifact_platform = ENV.fetch(
  "OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM",
  "simulator"
)
abort("unsupported broker artifact platform: #{artifact_platform}") unless %w[simulator device].include?(artifact_platform)
FileUtils.rm_rf(generated_root)
FileUtils.mkdir_p(generated_root)

project = Xcodeproj::Project.new(project_path.to_s)
project.root_object.attributes["LastSwiftUpdateCheck"] = "2640"
project.root_object.attributes["LastUpgradeCheck"] = "2640"

sources_group = project.main_group.new_group("Sources")
host_group = sources_group.new_group("Host")
extension_group = sources_group.new_group("BrokerAppExtension")

host_target = project.new_target(
  :application,
  "OliphauntBrokerSpike",
  :ios,
  "26.0"
)
extension_target = project.new_target(
  :app_extension,
  "BrokerAppExtension",
  :ios,
  "26.0"
)
extension_target.product_type = "com.apple.product-type.extensionkit-extension"
extension_target.product_reference.explicit_file_type = "wrapper.extensionkit-extension"

def apply_common_settings(target, development_team)
  target.build_configurations.each do |configuration|
    settings = configuration.build_settings
    settings["SWIFT_VERSION"] = "6.0"
    settings["MARKETING_VERSION"] = "1.0"
    settings["CURRENT_PROJECT_VERSION"] = "1"
    settings["IPHONEOS_DEPLOYMENT_TARGET"] = "26.0"
    settings["TARGETED_DEVICE_FAMILY"] = "1"
    settings["GENERATE_INFOPLIST_FILE"] = "YES"
    settings["EX_ENABLE_EXTENSION_POINT_GENERATION"] = "YES"
    settings["CODE_SIGN_STYLE"] = "Automatic"
    settings["DEVELOPMENT_TEAM"] = development_team
    settings["ENABLE_USER_SCRIPT_SANDBOXING"] = "YES"
    settings["SWIFT_STRICT_CONCURRENCY"] = "complete"
  end
end

apply_common_settings(host_target, development_team)
apply_common_settings(extension_target, development_team)

host_target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = host_bundle_identifier
  settings["PRODUCT_NAME"] = "OliphauntBrokerSpike"
  settings["INFOPLIST_KEY_CFBundleDisplayName"] = "Oliphaunt Broker Spike"
  settings["INFOPLIST_KEY_UILaunchScreen_Generation"] = "YES"
  settings["INFOPLIST_KEY_UIApplicationSceneManifest_Generation"] = "YES"
  settings["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks"]
end

extension_target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = extension_bundle_identifier
  settings["PRODUCT_NAME"] = "BrokerAppExtension"
  settings["INFOPLIST_KEY_CFBundleDisplayName"] = "Oliphaunt Broker Worker"
  settings["APPLICATION_EXTENSION_API_ONLY"] = "YES"
  settings["SKIP_INSTALL"] = "YES"
  settings["LD_RUNPATH_SEARCH_PATHS"] = [
    "$(inherited)",
    "@executable_path/Frameworks",
    "@executable_path/../../Frameworks"
  ]
end

Dir[fixture_root.join("Host/**/*.swift")].sort.each do |source|
  reference = host_group.new_file(source)
  host_target.source_build_phase.add_file_reference(reference)
end
Dir[fixture_root.join("BrokerAppExtension/**/*.swift")].sort.each do |source|
  reference = extension_group.new_file(source)
  extension_target.source_build_phase.add_file_reference(reference)
end

package_reference = project.new(
  Xcodeproj::Project::Object::XCLocalSwiftPackageReference
)
package_reference.relative_path = repo_root.to_s
project.root_object.package_references << package_reference

def add_package_product(project, target, package_reference, product_name)
  dependency = project.new(
    Xcodeproj::Project::Object::XCSwiftPackageProductDependency
  )
  dependency.package = package_reference
  dependency.product_name = product_name
  target.package_product_dependencies << dependency
  build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  build_file.product_ref = dependency
  target.frameworks_build_phase.files << build_file
end

add_package_product(project, host_target, package_reference, "OliphauntBrokerProtocol")
if ENV["OLIPHAUNT_BROKER_INCLUDE_SDK"] == "1"
  add_package_product(project, host_target, package_reference, "Oliphaunt")
  add_package_product(project, host_target, package_reference, "OliphauntBrokerXPC")
  add_package_product(project, host_target, package_reference, "OliphauntIOSBroker")
end
add_package_product(project, extension_target, package_reference, "OliphauntBrokerProtocol")
add_package_product(project, extension_target, package_reference, "OliphauntBrokerXPC")
add_package_product(project, extension_target, package_reference, "OliphauntBrokerExtension")

native_xcframework = ENV["OLIPHAUNT_IOS_BROKER_XCFRAMEWORK"]
if native_xcframework && !native_xcframework.empty?
  native_path = Pathname.new(native_xcframework).realpath
  abort("not an XCFramework: #{native_path}") unless native_path.directory? && native_path.extname == ".xcframework"
  native_reference = project.frameworks_group.new_file(native_path.to_s)
  extension_target.frameworks_build_phase.add_file_reference(native_reference, true)

  # The simulator fixture can keep its dylib/framework private to the worker
  # bundle. A signed device framework must be embedded once in the containing
  # app; the worker already searches @executable_path/../../Frameworks.
  embed_target = artifact_platform == "device" ? host_target : extension_target
  embed_frameworks = embed_target.new_copy_files_build_phase("Embed Broker Framework")
  embed_frameworks.dst_subfolder_spec = "10"
  embedded = embed_frameworks.add_file_reference(native_reference, true)
  embedded.settings = { "ATTRIBUTES" => ["CodeSignOnCopy", "RemoveHeadersOnCopy"] }
end

runtime_resources = ENV["OLIPHAUNT_IOS_BROKER_RESOURCES"]
if runtime_resources && !runtime_resources.empty?
  resources_path = Pathname.new(runtime_resources).realpath
  abort("runtime resources must contain oliphaunt/: #{resources_path}") unless resources_path.join("oliphaunt").directory?
  resource_reference = extension_group.new_file(
    resources_path.join("oliphaunt").to_s,
    :group
  )
  extension_target.resources_build_phase.add_file_reference(resource_reference, true)
end

host_target.add_dependency(extension_target)
embed_extensions = host_target.new_copy_files_build_phase("Embed ExtensionKit Extensions")
embed_extensions.dst_subfolder_spec = "16"
embed_extensions.dst_path = "$(EXTENSIONS_FOLDER_PATH)"
embedded_extension = embed_extensions.add_file_reference(
  extension_target.product_reference,
  true
)
embedded_extension.settings = {
  "ATTRIBUTES" => ["CodeSignOnCopy", "RemoveHeadersOnCopy"]
}

project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(host_target)
scheme.set_launch_target(host_target)
scheme.save_as(project_path, "OliphauntBrokerSpike", true)

puts project_path
