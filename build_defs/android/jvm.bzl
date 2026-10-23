"""Release source sets and exact bundled Expo AARs using maintained JVM rules."""

load("@rules_android//android:rules.bzl", "aar_import", "android_library")
load("@rules_kotlin//kotlin:android.bzl", "kt_android_library")
load("@rules_kotlin//kotlin:core.bzl", "kt_compiler_plugin", "kt_javac_options", "kt_plugin_cfg")
load("@oliphaunt_kotlin_manifest//:metadata.bzl", "KOTLIN")

def _name(name):
    return name.replace("@", "_").replace("/", "_").replace("-", "_").replace(".", "_")

def _maven(coordinate):
    parts = coordinate.split(":")
    if parts[:2] == ["com.facebook.react", "react-android"] and len(parts) == 5 and parts[3] == "release":
        return ":react_android_release"
    classifier = "_" + parts[3] if len(parts) == 5 else ""
    return "@expo_android_maven//:" + _name(parts[0] + "_" + parts[1] + classifier)

def expo_android_jvm(metadata, safe_area_codegen):
    """All original release sources, original module namespaces and plugins."""
    # Classifier-only AAR acquisition omits its Gradle variant dependency edges.
    # Restore every original RN catalog dependency on the imported provider so
    # its own desugar action has the same classpath as the upstream compilation.
    aar_import(
        name = "react_android_release",
        aar = "@expo_android_maven//:com_facebook_react_react_android_aar_release_" + _name(metadata["reactNative"]) + "_extension",
        deps = [_maven(coordinate) for coordinate in metadata["reactNativeDependencies"]] + [_maven("org.jetbrains.kotlin:kotlin-stdlib:" + metadata["kotlin"])],
    )
    # The original upstream Gradle Java compiler has no Error Prone analyzer.
    # Keep real javac diagnostics and the conventional JDK release unchanged.
    kt_javac_options(name = "upstream_java_options", release = KOTLIN["jvmTarget"], x_ep_disable_all_checks = True)
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
            # ExpoModuleGradlePlugin adds its original modules-core project as
            # compileOnly. Preserve that provider edge for published AAR desugar.
            core = [":expo_release_classes"] if module["pika"] else []
            aar_import(name = name, aar = module["aar"], package = module["namespace"], deps = deps + core)
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
        javac_opts = ":upstream_java_options",
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
        javac_opts = ":upstream_java_options",
        srcs = [":react_native_safe_area_context_sources", "generated/react_native_safe_area_context/BuildConfig.java", safe_area_codegen],
        manifest = "source-manifest.xml",
        custom_package = safe_area["namespace"],
        deps = [":react_native_safe_area_context_resources"] + sorted({_maven(coordinate): True for coordinate in safe_area["dependencies"]}.keys()),
    )
    android_library(name = "expo_modules", manifest = "source-manifest.xml", custom_package = "expo.modules", deps = [":expo_release_classes", ":safe_area_classes"] + published)
