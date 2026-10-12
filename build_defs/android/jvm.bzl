"""Release source sets and exact bundled Expo AARs using maintained JVM rules."""

load("@rules_android//android:rules.bzl", "aar_import", "android_library")
load("@rules_kotlin//kotlin:android.bzl", "kt_android_library")
load("@rules_kotlin//kotlin:core.bzl", "kt_compiler_plugin", "kt_plugin_cfg")

def _name(name):
    return name.replace("@", "_").replace("/", "_").replace("-", "_").replace(".", "_")

def _maven(coordinate):
    parts = coordinate.split(":")
    classifier = "_" + parts[3] if len(parts) == 5 else ""
    return "@expo_android_maven//:" + _name(parts[0] + "_" + parts[1] + classifier)

def expo_android_jvm(metadata, safe_area_codegen):
    """All original release sources, original module namespaces and plugins."""
    kt_compiler_plugin(
        name = "pika_compiler",
        id = "io.github.lukmccall.pika",
        target_embedded_compiler = True,
        deps = ["@expo_android_maven//:io_github_lukmccall_pika_pika_compiler"],
        options = {"enabled": "true"},
    )
    kt_plugin_cfg(
        name = "pika_expo_annotations",
        plugin = ":pika_compiler",
        options = {"introspectableAnnotation": ["expo.modules.kotlin.types.OptimizedRecord", "expo.modules.kotlin.views.OptimizedComposeProps"]},
    )
    kt_compiler_plugin(
        name = "compose_compiler",
        id = "androidx.compose.compiler.plugins.kotlin",
        target_embedded_compiler = True,
        deps = ["@expo_android_maven//:org_jetbrains_kotlin_kotlin_compose_compiler_plugin_embeddable"],
    )
    kt_compiler_plugin(
        name = "serialization_compiler",
        id = "org.jetbrains.kotlinx.serialization",
        target_embedded_compiler = True,
        deps = ["@expo_android_maven//:org_jetbrains_kotlin_kotlin_serialization_compiler_plugin_embeddable"],
    )
    sources, resources, dependencies, published = [], [], {}, []
    safe_area = None
    for module in metadata["modules"]:
        name = _name(module["name"])
        deps = sorted({_maven(coordinate): True for coordinate in module["dependencies"]}.keys())
        if module["aar"]:
            aar_import(name = name, aar = module["aar"], package = module["namespace"], deps = deps)
            published.append(":" + name)
            continue
        android_library(
            name = name + "_resources",
            manifest = module["manifest"],
            resource_files = [":" + name + "_resource_files"],
            custom_package = module["namespace"],
            deps = deps,
        )
        if module["name"] == "react-native-safe-area-context":
            safe_area = module
            continue
        sources += ([":" + name + "_sources"] if module["sources"] else []) + ["generated/" + name + "/BuildConfig.java"]
        resources.append(":" + name + "_resources")
        dependencies.update({dependency: True for dependency in deps})
    # Expo's release modules are compiled together, preserving their distinct
    # R/BuildConfig namespaces and every original release source selector.
    # The package registry is a separate app output so it can reference all
    # compiled source modules and the pinned published AARs without a cycle.
    kt_android_library(
        name = "expo_release_classes",
        srcs = sources,
        manifest = "source-manifest.xml",
        custom_package = "expo.modules",
        deps = resources + dependencies.keys(),
        plugins = [":pika_expo_annotations", ":compose_compiler", ":serialization_compiler"],
    )
    if not safe_area:
        fail("The actual app autolinks react-native-safe-area-context")
    kt_android_library(
        name = "safe_area_classes",
        srcs = [":react_native_safe_area_context_sources", "generated/react_native_safe_area_context/BuildConfig.java", safe_area_codegen],
        manifest = "source-manifest.xml",
        custom_package = safe_area["namespace"],
        deps = [":react_native_safe_area_context_resources"] + sorted({_maven(coordinate): True for coordinate in safe_area["dependencies"]}.keys()),
    )
    android_library(name = "expo_modules", manifest = "source-manifest.xml", custom_package = "expo.modules", deps = [":expo_release_classes", ":safe_area_classes"] + published)
