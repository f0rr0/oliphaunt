"""Declare one offline Robolectric SDK without acquiring unused Android APIs."""

def _robolectric_sdk_impl(ctx):
    jar = ctx.file.jar
    version = jar.basename.removeprefix("android-all-instrumented-").removesuffix(".jar")
    properties = ctx.actions.declare_file(ctx.label.name + ".properties")
    relative = "../" * len(ctx.label.package.split("/")) + jar.short_path
    ctx.actions.write(properties, "org.robolectric\\:android-all-instrumented\\:%s=%s\n" % (version, relative))
    return [DefaultInfo(files = depset([properties]), runfiles = ctx.runfiles(files = [properties, jar]))]

robolectric_sdk = rule(
    implementation = _robolectric_sdk_impl,
    attrs = {"jar": attr.label(mandatory = True, allow_single_file = [".jar"])},
)
