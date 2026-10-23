"""The actual host smoke rule must cross Bun's resolved File-argument boundary."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS")
load(":host-aot-smoke.bzl", "wasix_host_aot_smoke_test")

def _archive_names():
    runtime = PRODUCTS["liboliphaunt-wasix"]["version"]
    tools = PRODUCTS["postgres-tools-wasix"]["version"]
    return [
        "liboliphaunt-wasix-portable-" + runtime + ".crate",
        "oliphaunt-extension-contrib-pg18-wasix-" + runtime + ".crate",
        "oliphaunt-extension-contrib-pg18-aot-linux-x64-" + runtime + ".crate",
        "oliphaunt-wasix-tools-" + tools + ".crate",
        "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu-" + tools + ".crate",
    ]

def _fixtures_impl(ctx):
    files = [ctx.actions.declare_file(ctx.label.name + "/" + name) for name in _archive_names()]
    for file in files:
        ctx.actions.write(file, "analysis-only declared archive fixture")
    binary = ctx.actions.declare_file(ctx.label.name + ".binary")
    ctx.actions.write(binary, "analysis-only executable fixture", is_executable = True)
    return [DefaultInfo(files = depset(files), executable = binary, runfiles = ctx.runfiles(files = files))]

_fixtures = rule(implementation = _fixtures_impl, executable = True)

def _arguments_impl(ctx):
    env = analysistest.begin(ctx)
    actions = analysistest.target_actions(env)
    entries = [action for action in actions if action.mnemonic == "TemplateExpand"]
    asserts.equals(env, 1, len(entries))
    configuration = json.decode(entries[0].substitutions["@@CONFIG@@"])
    arguments = configuration["arguments"]
    asserts.equals(env, 7, len(arguments))
    asserts.true(env, all([sorted(argument.keys()) == ["file"] for argument in arguments]))
    paths = [argument["file"] for argument in arguments]
    asserts.equals(env, sorted(_archive_names()), sorted([path.rsplit("/", 1)[-1] for path in paths[2:]]))
    asserts.true(env, all([path.startswith(configuration["workspace"] + "/") for path in paths]))
    specification = analysistest.target_under_test(env).label.name + ".inputs.json"
    metadata = [action for action in actions if action.mnemonic == "FileWrite" and specification in [file.basename for file in action.outputs.to_list()]]
    asserts.equals(env, 1, len(metadata))
    asserts.equals(env, ["runtimeVersion", "target", "toolsVersion"], sorted(json.decode(metadata[0].content).keys()))
    runfiles = analysistest.target_under_test(env)[DefaultInfo].default_runfiles.files.to_list()
    for name in _archive_names():
        asserts.true(env, name in [file.basename for file in runfiles])
    return analysistest.end(env)

_arguments_test = analysistest.make(_arguments_impl)

def wasix_host_aot_smoke_argument_tests():
    _fixtures(name = "host_aot_smoke_argument_files", tags = ["manual"])
    wasix_host_aot_smoke_test(name = "host_aot_smoke_argument_fixture", target_triple = "x86_64-unknown-linux-gnu",
        carriers = ":host_aot_smoke_argument_files", binary = ":host_aot_smoke_argument_files", tags = ["manual"])
    _arguments_test(name = "host_aot_smoke_arguments_test", target_under_test = ":host_aot_smoke_argument_fixture")
