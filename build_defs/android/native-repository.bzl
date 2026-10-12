"""Native Android inputs from the same conventional Expo npm lock graph."""

def _impl(ctx):
    data = json.decode(ctx.read(ctx.attr.metadata))
    packages = data["packages"]
    rows, identities, acquired = [], {}, {}
    for key in sorted(packages):
        row = packages[key]
        name = row["package"]
        if not (name == "react-native" or name == "react-native-safe-area-context" or name == "expo" or name.startswith("expo-") or name.startswith("@expo/")):
            continue
        identity = json.encode([name, row["version"], row["integrity"]])
        if identity in acquired:
            continue
        acquired[identity] = True
        basename = name.split("/")[-1]
        output = "acquired/" + key
        ctx.download_and_extract(
            url = "https://registry.npmjs.org/" + name + "/-/" + basename + "-" + row["version"] + ".tgz",
            integrity = row["integrity"],
            output = output,
            stripPrefix = "package",
        )
        native_source = ctx.path(output + "/android/build.gradle").exists or ctx.path(output + "/android/build.gradle.kts").exists or name == "react-native" and ctx.path(output + "/ReactAndroid/gradle.properties").exists
        if not native_source:
            continue
        if name in identities:
            fail("Native Android autolinking needs one exact locked package identity: " + name)
        identities[name] = [row["version"], row["integrity"]]
        logical = "packages/" + name
        ctx.symlink(ctx.path(output), logical)
        rows.append({"package": name, "version": row["version"], "root": str(ctx.path(logical))})
    ctx.read(ctx.attr.kotlin_catalog)
    ctx.read(ctx.attr.sdk_gradle)
    ctx.read(ctx.attr.converter)
    ctx.watch(ctx.path(ctx.attr.bun))
    ctx.file("native-inputs.json", json.encode(rows))
    result = ctx.execute([str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), str(ctx.path("native-inputs.json")), str(ctx.path(ctx.attr.kotlin_catalog)), str(ctx.path(".")), str(ctx.path(ctx.attr.sdk_gradle))], timeout = 60, quiet = True)
    if result.return_code:
        fail("Cannot project Expo release native compiler inputs:\n" + result.stdout + result.stderr)
    return ctx.repo_metadata(reproducible = True)

expo_android_sources_repository = repository_rule(
    implementation = _impl,
    attrs = {
        "metadata": attr.label(mandatory = True, allow_single_file = [".json"]),
        "kotlin_catalog": attr.label(default = Label("//src/native/sdks/kotlin:gradle/libs.versions.toml"), allow_single_file = True),
        "sdk_gradle": attr.label(default = Label("//src/native/sdks/react-native:android/build.gradle"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/android:native-metadata.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)
