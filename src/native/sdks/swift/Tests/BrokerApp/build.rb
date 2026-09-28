require "xcodeproj"
require "fileutils"
root = File.expand_path("../../../../../..", __dir__)
stage = File.join(root, "target/broker-lifecycle/ios")
source = File.join(stage, "source")
FileUtils.mkdir_p(source)
FileUtils.mkdir_p(File.join(source, "src/sdks/swift"))
FileUtils.cp_r(File.join(root, "src/native/sdks/swift/Sources"), File.join(source, "src/sdks/swift"))
FileUtils.cp(File.join(root, "src/native/runtime/include/oliphaunt.h"), File.join(source, "src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h"))
FileUtils.mkdir_p(File.join(source, "src/sdks/swift/Sources/OliphauntNativeBindings"))
FileUtils.cp(File.join(root, "target/mobile-bindings/generated/OliphauntNativeBindings.swift"), File.join(source, "src/sdks/swift/Sources/OliphauntNativeBindings"))
specs = File.join(root, "src/native/sdks/react-native/ios/podspecs")
%w[COliphaunt OliphauntCore Oliphaunt OliphauntBroker OliphauntBrokerExtension OliphauntNativeBindings].each do |name|
  content = File.read(File.join(specs, name + ".podspec"))
  content.sub!('File.expand_path("../../package.json", __dir__)', File.join(root, "src/native/sdks/react-native/package.json").inspect)
  # Local source staging already supplies the generated bindings and headers.
  content.gsub!(/^  s.prepare_command = .*$/, "")
  File.write(File.join(source, name + ".podspec"), content)
end
ffi = File.join(source, "ffi")
FileUtils.mkdir_p(ffi)
FileUtils.cp(File.join(root, "target/mobile-bindings/generated/OliphauntNativeBindingsFFI.h"), ffi)
FileUtils.cp(File.join(root, "target/mobile-bindings/generated/OliphauntNativeBindingsFFI.modulemap"), File.join(ffi, "module.modulemap"))
framework = File.join(source, "Artifacts/OliphauntNativeBindingsFFI.xcframework")
unless File.exist?(framework)
  FileUtils.mkdir_p(File.dirname(framework))
  system("xcodebuild", "-create-xcframework", "-library", File.join(root, "target/aarch64-apple-ios/debug/liboliphaunt_mobile_bindings.a"), "-headers", ffi, "-library", File.join(root, "target/aarch64-apple-ios-sim/debug/liboliphaunt_mobile_bindings.a"), "-headers", ffi, "-output", framework) or abort "XCFramework failed"
end
{"ios-arm64" => "aarch64-apple-ios", "ios-arm64-simulator" => "aarch64-apple-ios-sim"}.each do |slice, triple|
  FileUtils.cp(File.join(root, "target", triple, "debug/liboliphaunt_mobile_bindings.a"), File.join(framework, slice))
  FileUtils.cp(Dir[File.join(ffi, "*")], File.join(framework, slice, "Headers"))
end
project = Xcodeproj::Project.new(File.join(stage, "BrokerLifecycle.xcodeproj"))
app = project.new_target(:application, "BrokerLifecycle", :ios, "26.0")
worker = project.new_target(:app_extension, "OliphauntBroker", :ios, "26.0")
worker.product_type = "com.apple.product-type.extensionkit-extension"
worker.product_reference.explicit_file_type = "wrapper.extensionkit-extension"
[app, worker].each do |target|
  target.build_configurations.each do |config|
    config.build_settings.merge!({"SWIFT_VERSION" => "6.0", "PRODUCT_BUNDLE_IDENTIFIER" => (target == app ? "dev.oliphaunt.brokertest" : "dev.oliphaunt.brokertest.OliphauntBroker"), "MARKETING_VERSION" => "1.0", "CURRENT_PROJECT_VERSION" => "1", "GENERATE_INFOPLIST_FILE" => "YES", "CODE_SIGN_IDENTITY" => "-", "EX_ENABLE_EXTENSION_POINT_GENERATION" => "YES", "ENABLE_USER_SCRIPT_SANDBOXING" => "NO", "LD_RUNPATH_SEARCH_PATHS" => ["$(inherited)", "@executable_path/Frameworks"], "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => "DEBUG"})
  end
end
app.build_configurations.each do |config|
  config.build_settings["INFOPLIST_KEY_UILaunchScreen_Generation"] = "YES"
end
worker.build_configurations.each do |config|
  config.build_settings["APPLICATION_EXTENSION_API_ONLY"] = "YES"
  config.build_settings["PRODUCT_MODULE_NAME"] = "OliphauntBrokerWorker"
end
app.source_build_phase.add_file_reference(project.main_group.new_file(File.join(__dir__, "App.swift")))
templates = File.join(root, "src/native/sdks/swift/Templates/OliphauntBroker")
File.write(File.join(stage, "Worker.swift"), File.read(File.join(templates, "OliphauntBroker.swift.template")).gsub("__HOST_BUNDLE_IDENTIFIER__", "dev.oliphaunt.brokertest"))
FileUtils.cp(File.join(templates, "OliphauntBrokerHost.swift.template"), File.join(stage, "Host.swift"))
app.source_build_phase.add_file_reference(project.main_group.new_file("Host.swift"))
worker.source_build_phase.add_file_reference(project.main_group.new_file("Worker.swift"))
resources = project.main_group.new_file(File.join(root, "target/broker-lifecycle/ios-resources/oliphaunt"))
resources.last_known_file_type = "folder"
worker.resources_build_phase.add_file_reference(resources)
runtime = project.main_group.new_file(File.join(root, "target/liboliphaunt-ios-simulator/out/liboliphaunt.dylib"))
worker.build_configurations.each { |config| config.build_settings["OTHER_LDFLAGS"] = ["$(inherited)", "-Wl,-u,_oliphaunt_version", File.join(root, "target/liboliphaunt-ios-simulator/out/liboliphaunt.dylib")] }
embed_runtime = worker.new_copy_files_build_phase("Embed runtime")
embed_runtime.dst_subfolder_spec = "10"
embed_runtime.add_file_reference(runtime).settings = {"ATTRIBUTES" => ["CodeSignOnCopy"]}
app.add_dependency(worker)
embed = app.new_copy_files_build_phase("Embed broker")
embed.dst_subfolder_spec = "16"
embed.dst_path = "$(EXTENSIONS_FOLDER_PATH)"
embed.add_file_reference(worker.product_reference).settings = {"ATTRIBUTES" => ["CodeSignOnCopy", "RemoveHeadersOnCopy"]}
project.save
Xcodeproj::XCScheme.new.tap do |scheme|
  scheme.add_build_target(app)
  scheme.set_launch_target(app)
  scheme.save_as(project.path, "BrokerLifecycle", true)
end
File.write(File.join(stage, "Podfile"), <<~PODS)
platform :ios, '26.0'
project 'BrokerLifecycle.xcodeproj'
target 'BrokerLifecycle' do
  pod 'OliphauntBroker', :path => 'source'
  pod 'OliphauntCore', :path => 'source'
  pod 'OliphauntNativeBindings', :path => 'source'
end
target 'OliphauntBroker' do
    pod 'OliphauntBrokerExtension', :path => 'source'
    pod 'Oliphaunt', :path => 'source'
    pod 'COliphaunt', :path => 'source', :modular_headers => true
    pod 'OliphauntCore', :path => 'source'
    pod 'OliphauntNativeBindings', :path => 'source'
end
PODS
puts stage
