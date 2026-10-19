"""Require raw and framework inventories to share their actual compiled objects."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load(":mobile_members.bzl", "MOBILE_MEMBER_ARCHIVE_OBJECTS")

_ObjectsInfo = provider(fields = ["profiles"])
_MEMBER = Label(MOBILE_MEMBER_ARCHIVE_OBJECTS["pg_hashids"])
_EDGES = ["members", "dependencies", "frameworks", "archive", "deps", "roots", "actual", "library"]

def _objects_impl(target, ctx):
    profiles = {}
    if target.label == _MEMBER:
        profile = "macos-arm64" if ctx.target_platform_has_constraint(ctx.attr._macos[platform_common.ConstraintValueInfo]) else "ios-device" if ctx.target_platform_has_constraint(ctx.attr._device[platform_common.ConstraintValueInfo]) else "ios-simulator"
        objects = [file.path for item in target[CcInfo].linking_context.linker_inputs.to_list() for library in item.libraries for group in [library.objects, library.pic_objects] for file in (group or [])]
        if not objects:
            fail("The reuse probe needs the member's actual compiled object Files")
        profiles[profile] = [depset(["\n".join(sorted(objects))])]
    if ctx.rule != None:
        for edge in _EDGES:
            dependencies = getattr(ctx.rule.attr, edge, [])
            if type(dependencies) == "dict":
                dependencies = dependencies.keys()
            elif type(dependencies) != "list":
                dependencies = [dependencies]
            for dependency in dependencies:
                if type(dependency) == "Target" and _ObjectsInfo in dependency:
                    for profile, files in dependency[_ObjectsInfo].profiles.items():
                        profiles.setdefault(profile, []).append(files)
    return [_ObjectsInfo(profiles = {profile: depset(transitive = files) for profile, files in profiles.items()})]

_objects = aspect(implementation = _objects_impl, attr_aspects = _EDGES, attrs = {
    "_macos": attr.label(default = "@platforms//os:macos"),
    "_device": attr.label(default = "@apple_support//constraints:device"),
})

def _reuse_test(ctx):
    env = analysistest.begin(ctx)
    profiles = analysistest.target_under_test(env)[_ObjectsInfo].profiles
    asserts.equals(env, ["ios-device", "ios-simulator", "macos-arm64"], sorted(profiles))
    for profile, files in profiles.items():
        asserts.equals(env, 1, len(files.to_list()), profile + " raw inventories and frameworks must reuse the same compiled object Files")
    return analysistest.end(env)

mobile_cpp_reuse_test = analysistest.make(_reuse_test, extra_target_under_test_aspects = [_objects])
