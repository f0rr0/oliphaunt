"""Compile the authenticated conventional held Swift source package."""
load("@rules_swift//swift:swift_library.bzl", "swift_library")
load("@rules_swift//swift:swift_interop_hint.bzl", "swift_interop_hint")
load("@rules_cc//cc:defs.bzl", "cc_library")

def captured_swift_package(runtime, targets, language_version):
    """Project paths/edges from genuine Package.swift; maintained rules compile."""
    native.alias(name = "liboliphaunt", actual = runtime)
    for module, target in targets.items():
        dependencies = [":" + name for name in target["dependencies"]]
        if target.get("publicHeaders"):
            include = target["path"] + "/" + target["publicHeaders"]
            hint = module + "_module"
            swift_interop_hint(name = hint, module_name = module, module_map = include + "/module.modulemap")
            cc_library(name = module, srcs = native.glob([target["path"] + "/*.c"]),
                hdrs = native.glob([include + "/*.h"]), includes = [include],
                defines = [target["define"]], deps = dependencies, aspect_hints = [":" + hint])
        else:
            swift_library(name = module, module_name = module, package_name = "Oliphaunt",
                srcs = native.glob([target["path"] + "/*.swift"]),
                deps = dependencies, copts = ["-swift-version", language_version])
