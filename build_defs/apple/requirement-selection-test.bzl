"""Exercise the actual factory decisions over successive release cycles."""
load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load(":requirement-selection.bzl", "native_apple_requirement_inputs", "swift_requirement_inputs")

def _native_pair(version):
    return {role: {"publication": {"product": "liboliphaunt-native", "version": version}, "file": {"path": version + "/" + role}} for role in ["base-xcframework", "runtime-resources"]}

def _swift_pair(version):
    return {"oliphaunt-swift/" + version + "/" + artifact: {"file": {"path": version + "/" + artifact}} for artifact in ["swift-source-tag:" + version, "github-release:oliphaunt-swift-" + version + "-bindings.xcframework.zip"]}

def _selection_test(ctx):
    env = unittest.begin(ctx)
    # Native hold -> intentional adoption -> completed hold, twice. Current
    # compiler labels never enter either held branch.
    for held, adopted, newer in [("0.3.3", "0.3.4", "0.3.5"), ("0.3.4", "0.3.5", "0.3.6")]:
        old = _native_pair(held)
        hold = native_apple_requirement_inputs(held, adopted, ["liboliphaunt-native"], old, None, True)
        asserts.equals(env, old, hold["archives"])
        asserts.false(env, hold["local_current"])
        asserts.true(env, "error" in native_apple_requirement_inputs(adopted, adopted, [], {}, None, True))
        adopt = native_apple_requirement_inputs(adopted, adopted, ["liboliphaunt-native"], {}, None, True)
        asserts.true(env, adopt["local_current"])
        asserts.equals(env, "//src/native/runtime:apple_swiftpm", adopt["archives"]["base-xcframework"]["file"]["path"])
        captured = {"owner": "liboliphaunt-native", "version": adopted, "file": {"path": "real/ios.json"}, "framework": {"path": "real/base.zip", "producer": {"invocationId": "final"}}, "resources": {"path": "real/resources.tar.gz", "producer": {"invocationId": "final"}}}
        imported = native_apple_requirement_inputs(adopted, adopted, ["liboliphaunt-native"], {}, captured)
        asserts.equals(env, captured["framework"], imported["archives"]["base-xcframework"]["file"])
        asserts.true(env, "error" in native_apple_requirement_inputs(adopted, adopted, ["liboliphaunt-native"], {}, dict(captured, version = held)))
        published = _native_pair(adopted)
        next_hold = native_apple_requirement_inputs(adopted, newer, ["liboliphaunt-native"], published, captured, True)
        asserts.equals(env, published, next_hold["archives"])
        asserts.false(env, next_hold["local_current"])
        asserts.true(env, "error" in native_apple_requirement_inputs(adopted, adopted, ["liboliphaunt-native"], {"base-xcframework": published["base-xcframework"]}, captured, True))
    for held, adopted in [("0.8.2", "0.8.3"), ("0.8.3", "0.8.4")]:
        old = _swift_pair(held)
        captured = {"owner": "oliphaunt-swift", "version": adopted, "archive": {"path": "real/Oliphaunt-source.zip"}, "bindingsArchive": {"path": "real/" + adopted + "-bindings.zip", "producer": {"invocationId": "final"}}}
        hold = swift_requirement_inputs(held, ["oliphaunt-swift"], old, captured)
        asserts.true(env, hold["completed"])
        asserts.true(env, "error" in swift_requirement_inputs(adopted, [], {}, captured))
        asserts.true(env, "error" in swift_requirement_inputs(adopted, ["oliphaunt-swift"], {}, dict(captured, version = held)))
        adopt = swift_requirement_inputs(adopted, ["oliphaunt-swift"], {}, captured)
        asserts.false(env, adopt["completed"])
        asserts.equals(env, captured["bindingsArchive"], adopt["bindings"]["file"])
        published = _swift_pair(adopted)
        next_hold = swift_requirement_inputs(adopted, [], published, captured)
        asserts.true(env, next_hold["completed"])
        asserts.equals(env, published["oliphaunt-swift/" + adopted + "/github-release:oliphaunt-swift-" + adopted + "-bindings.xcframework.zip"], next_hold["bindings"])
        source = "oliphaunt-swift/" + adopted + "/swift-source-tag:" + adopted
        asserts.true(env, "error" in swift_requirement_inputs(adopted, ["oliphaunt-swift"], {source: published[source]}, captured))
    return unittest.end(env)

requirement_selection_test = unittest.make(_selection_test)
