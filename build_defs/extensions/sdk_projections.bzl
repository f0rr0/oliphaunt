"""SDK metadata generation from the canonical, explicitly imported inputs."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "EXTENSIONS", "EXTENSION_PROFILES", "EXTENSION_RECIPES", "EXTENSION_RELEASE_METADATA")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")

def _spec(ctx):
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "schema": "oliphaunt-native-sdk-extension-projections-v1",
        "catalog": {"extensions": EXTENSIONS.values()},
        "releases": EXTENSION_RELEASE_METADATA,
        "contrib": CONTRIB_MEMBERS,
        "profiles": EXTENSION_PROFILES,
        "recipes": EXTENSION_RECIPES,
    }))
    return spec

def _sdk_extension_projections_impl(ctx):
    spec = _spec(ctx)
    args = ctx.actions.args()
    args.add("--spec", spec)
    args.add("--components", ctx.file._components)
    args.add("--sdk", ctx.attr.sdk)
    args.add("--generated", ctx.outputs.generated)
    args.add("--descriptors", ctx.outputs.descriptors)
    bun_action(
        ctx, ctx.attr._generator,
        arguments = [args],
        inputs = depset([spec, ctx.file._components]),
        outputs = [ctx.outputs.generated, ctx.outputs.descriptors],
        mnemonic = "NativeSdkExtensionProjections",
        progress_message = "Generate %s SDK extension metadata from declared canonical inputs" % ctx.attr.sdk,
    )
    return [
        DefaultInfo(files = depset([ctx.outputs.generated, ctx.outputs.descriptors])),
        OutputGroupInfo(generated = depset([ctx.outputs.generated]), descriptors = depset([ctx.outputs.descriptors])),
    ]

_sdk_extension_projections = rule(
    implementation = _sdk_extension_projections_impl,
    attrs = {
        "sdk": attr.string(mandatory = True, values = ["ts", "react-native", "kotlin"]),
        "generated": attr.output(mandatory = True),
        "descriptors": attr.output(mandatory = True),
        "_components": attr.label(default = "//src/extensions/catalog:native-components.toml", allow_single_file = True),
        "_generator": attr.label(default = "//build_defs/extensions:sdk_projections", providers = [BunScriptInfo], cfg = "exec"),
    },
)

def sdk_extension_projections(name, sdk = "ts", generated = "src/generated/extensions.ts", descriptors = "src/extensions.ts"):
    _sdk_extension_projections(name = name, sdk = sdk, generated = generated, descriptors = descriptors)

def _metadata_impl(ctx):
    spec = _spec(ctx)
    args = ctx.actions.args()
    args.add("--spec", spec)
    args.add("--components", ctx.file._components)
    args.add("--metadata", ctx.outputs.out)
    bun_action(
        ctx, ctx.attr._generator,
        arguments = [args],
        inputs = depset([spec, ctx.file._components]),
        outputs = [ctx.outputs.out],
        mnemonic = "NativeSdkExtensionMetadata",
    )
    return [DefaultInfo(files = depset([ctx.outputs.out]))]

sdk_extension_metadata = rule(
    implementation = _metadata_impl,
    attrs = {
        "out": attr.output(mandatory = True),
        "_components": attr.label(default = "//src/extensions/catalog:native-components.toml", allow_single_file = True),
        "_generator": attr.label(default = "//build_defs/extensions:sdk_projections", providers = [BunScriptInfo], cfg = "exec"),
    },
)
