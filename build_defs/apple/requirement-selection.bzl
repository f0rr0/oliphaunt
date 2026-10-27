"""Conventional pins choose genuine completed Files or explicit current producers."""

def native_apple_requirement_inputs(required, current_version, selected, completed, current, local_current = False):
    if completed:
        if sorted(completed) != ["base-xcframework", "runtime-resources"]:
            return {"error": "completed Apple native archive tuple is incomplete"}
        return {"record": {}, "archives": completed, "local_current": False}
    if "liboliphaunt-native" not in selected or required != current_version:
        return {"error": "unpublished Apple native requirement must be explicitly selected at its conventional version"}
    if current and current["owner"] == "liboliphaunt-native" and current["version"] == required:
        return {"record": current, "archives": {role: {"owner": current["owner"], "version": current["version"], "file": current[group]} for role, group in [("base-xcframework", "framework"), ("runtime-resources", "resources")]}, "local_current": False}
    if local_current:
        return {"record": {"owner": "liboliphaunt-native", "version": required, "file": {"path": "//src/native/runtime:apple_ios_manifest"}},
                "archives": {role: {"owner": "liboliphaunt-native", "version": required, "file": {"path": label}} for role, label in [("base-xcframework", "//src/native/runtime:apple_swiftpm"), ("runtime-resources", "//src/native/runtime:apple_resources")]}, "local_current": True}
    return {"error": "unpublished Apple native requirement needs its final Mac producer capture"}

def swift_requirement_inputs(required, selected, catalog, current):
    source_key = "oliphaunt-swift/" + required + "/swift-source-tag:" + required
    binding_key = "oliphaunt-swift/" + required + "/github-release:oliphaunt-swift-" + required + "-bindings.xcframework.zip"
    source, bindings = catalog.get(source_key), catalog.get(binding_key)
    if bool(source) != bool(bindings):
        return {"error": "completed Swift source/binding supplier tuple is incomplete"}
    if source:
        return {"source": source, "bindings": bindings, "completed": True}
    if "oliphaunt-swift" in selected and current and current["owner"] == "oliphaunt-swift" and current["version"] == required:
        return {"source": current, "bindings": {"file": current["bindingsArchive"]}, "completed": False}
    return {"error": "Swift requirement needs its completed Files or explicitly selected final source producer"}
