"""Import compiler APIs from the existing, checksummed Gradle wrapper contract."""

def _gradle_api_impl(ctx):
    properties = {}
    for line in ctx.read(ctx.attr.wrapper).splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            properties[key] = value.replace("\\:", ":")
    url = properties.get("distributionUrl", "")
    digest = properties.get("distributionSha256Sum", "")
    if not url.startswith("https://services.gradle.org/distributions/gradle-") or not url.endswith("-bin.zip"):
        fail("Gradle API acquisition requires the canonical HTTPS binary wrapper distribution")
    if len(digest) != 64 or any([char not in "0123456789abcdef" for char in digest.elems()]):
        fail("Gradle API acquisition requires the wrapper's exact SHA-256")
    version = url.split("/")[-1].removeprefix("gradle-").removesuffix("-bin.zip")
    ctx.download_and_extract(url = url, sha256 = digest, strip_prefix = "gradle-" + version)
    ctx.file("BUILD.bazel", """load("@rules_java//java:defs.bzl", "java_import")
package(default_visibility = ["//visibility:public"])
# Gradle is a compile/runtime dependency of its consumer plugin. It is never
# invoked to construct a repository product.
java_import(name = "api", jars = glob(["lib/*.jar", "lib/plugins/*.jar"]), neverlink = True)
java_import(name = "test_runtime", jars = glob(["lib/*.jar", "lib/plugins/*.jar"]))
""")
    return ctx.repo_metadata(reproducible = True)

gradle_api_repository = repository_rule(
    implementation = _gradle_api_impl,
    attrs = {"wrapper": attr.label(default = Label("//src/native/sdks/kotlin:gradle/wrapper/gradle-wrapper.properties"), allow_single_file = True)},
)
