"""Maintained Kotlin compiler options from the conventional SDK version catalog."""

load("@oliphaunt_kotlin_manifest//:metadata.bzl", "KOTLIN")
load("@rules_kotlin//kotlin:core.bzl", "define_kt_toolchain", "kt_javac_options")
load("@rules_kotlin//src/main/starlark/core/repositories:versions.bzl", "versions")

def kotlin_sdk_toolchain(name):
    if versions.KOTLIN_CURRENT_COMPILER_RELEASE.version != KOTLIN["compilerVersion"]:
        fail("Maintained Kotlin compiler must match the conventional libs.versions.toml pin")
    kt_javac_options(name = name + "_javac", release = KOTLIN["jvmTarget"])
    define_kt_toolchain(
        name = name,
        language_version = KOTLIN["languageVersion"],
        api_version = KOTLIN["languageVersion"],
        jvm_target = KOTLIN["jvmTarget"],
        javac_options = ":" + name + "_javac",
    )
