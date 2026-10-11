"""Declared compiler/linker inputs for conventional installed Cargo tests."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def cargo_test_toolchain(ctx):
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    files = cc.all_files.to_list()
    roots = {}
    for file in files:
        if file.path.startswith("external/"):
            roots["/".join(file.path.split("/")[:2])] = _runfile(ctx, file).split("/")[0]
    tools = {}
    for name, action in {"linker": ACTION_NAMES.cpp_link_executable, "cc": ACTION_NAMES.c_compile, "cxx": ACTION_NAMES.cpp_compile, "ar": ACTION_NAMES.cpp_link_static_library}.items():
        tool = cc_common.get_tool_for_action(feature_configuration = features, action_name = action)
        if not tool.startswith("/"):
            matches = [file for file in files if file.path == tool]
            if len(matches) != 1:
                fail("installed Cargo compiler must be a declared toolchain file: " + tool)
            roots[tool] = _runfile(ctx, matches[0])
        tools[name] = tool
    link = cc_common.create_link_variables(cc_toolchain = cc, feature_configuration = features, user_link_flags = ctx.fragments.cpp.linkopts, is_linking_dynamic_library = False, is_static_linking_mode = True)
    compile_flags = {}
    for name, action, flags in [
        ("cflags", ACTION_NAMES.c_compile, ctx.fragments.cpp.copts + ctx.fragments.cpp.conlyopts),
        ("cxxflags", ACTION_NAMES.cpp_compile, ctx.fragments.cpp.copts + ctx.fragments.cpp.cxxopts),
    ]:
        variables = cc_common.create_compile_variables(cc_toolchain = cc, feature_configuration = features, user_compile_flags = flags, use_pic = True)
        compile_flags[name] = cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = action, variables = variables)
    configuration = ctx.actions.declare_file(ctx.label.name + ".compiler.json")
    ctx.actions.write(configuration, json.encode(tools | compile_flags | {
        "args": cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link),
        "env": cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link),
        "roots": roots,
    }))
    return struct(configuration = configuration, files = files)
