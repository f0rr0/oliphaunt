"""The original SDK's selected app resource/registry construction."""
load("//build_defs/extensions:final_leaf.bzl", "ExtensionFinalLeafInfo", "NativeAppleBaseInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _resources_impl(ctx):
    base = ctx.attr.base[NativeAppleBaseInfo]
    if len(base.archives) != 2 or len(base.archive_files) != 2:
        fail("App construction requires the two genuine declared native archive Files")
    if not ctx.attr.extensions:
        fail("The mandatory installed app must exercise a nonempty selected extension cohort")
    inputs = [base.file, ctx.file.seed] + base.archive_files
    leaves = []
    for target in ctx.attr.leaves:
        leaf = target[ExtensionFinalLeafInfo]
        if leaf.family != "native" or leaf.target != "ios-xcframework" or leaf.metadata["runtimeVersion"] != base.version:
            fail("App carrier must hold the actual declared Apple native host")
        inputs += leaf.github + [leaf.frozen]
        if leaf.validation:
            inputs.append(leaf.validation)
        members = leaf.metadata.get("members", [leaf.metadata])
        leaves.append({"product":leaf.product,"owner":leaf.owner,"version":leaf.version,
            "runtimeVersion":leaf.metadata["runtimeVersion"],"sqlNames":sorted([member["sqlName"] for member in members]),
            "github":[file.path for file in leaf.github],"frozen":leaf.frozen.path})
    resources = ctx.actions.declare_directory(ctx.label.name + "/oliphaunt")
    registry = ctx.actions.declare_file(ctx.label.name + "/oliphaunt_static_registry.c")
    selection = ctx.actions.declare_file(ctx.label.name + "/selection.json")
    seed_resources = ctx.actions.declare_directory(ctx.label.name + "/cluster-seed")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification,json.encode({"version":base.version,"baseManifest":base.file.path,
        "archives":base.archives,"leaves":leaves,"extensions":ctx.attr.extensions,
        "resources":resources.path,"registry":registry.path,"selection":selection.path,
        "seed":ctx.file.seed.path,"seedResources":seed_resources.path}) + "\n")
    bun_file_action(ctx,ctx.file._runner,arguments=[specification.path],
        inputs=inputs+[specification],source_files=[ctx.file._runner]+ctx.files._helpers,
        outputs=[resources,registry,selection,seed_resources],execution_requirements={"block-network":"1"},mnemonic="ExpoAppleSelectedResources")
    return [DefaultInfo(files=depset([resources])),OutputGroupInfo(resources=depset([resources]),registry=depset([registry]),selection=depset([selection]),seed=depset([seed_resources]))]

expo_ios_resources = rule(implementation=_resources_impl,toolchains=BUN_SOURCE_TOOLCHAINS,attrs={
    "base":attr.label(mandatory=True,providers=[NativeAppleBaseInfo]),
    "leaves":attr.label_list(mandatory=True,providers=[ExtensionFinalLeafInfo],cfg="exec"),
    "extensions":attr.string_list(mandatory=True),
    "seed":attr.label(mandatory=True,allow_single_file=[".tgz"],cfg="exec"),
    "_runner":attr.label(default=Label("//build_defs/apple:resources.mts"),allow_single_file=True),
    "_helpers":attr.label_list(default=[
        Label("//build_defs/native/apple:static-carrier-consumer.mts"),Label("//build_defs/native/apple:framework_helpers"),
        Label("//src/native/sdks/swift:generator_sources"),Label("//src/native/sdks/react-native:tools/stage-ios-app.mts"),
        Label("//src/native/sdks/react-native:tools/native-resource-closure.mts"),Label("//src/native/sdks/react-native:src/generated/extensions.json"),
        Label("//src/database-resources:contracts/native-manifest.mts"), Label("//src/database-resources:contracts/contract.json"),
    ],allow_files=True),
})
