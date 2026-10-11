"""Native Bun entrypoints and action execution with declared TypeScript inputs."""

load(":bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")
load(":bun-sources.bzl", "bun_source_directory", "bun_source_path", "bun_source_runfile", "bun_source_tree", _BUN_SOURCE_TOOLCHAINS = "BUN_SOURCE_TOOLCHAINS")

BUN_SOURCE_TOOLCHAINS = _BUN_SOURCE_TOOLCHAINS

BunScriptInfo = provider(fields = ["bun", "entry_point", "entry_path", "files"])

BUN_TEST_ENTRYPOINT_ATTRS = {
    "_bun_test_entrypoint_template": attr.label(default = "//build_defs/foundation:bun-test-entrypoint.mts.tpl", allow_single_file = True),
}

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _bun_test_entrypoint(ctx, runner, arguments, files, environment = {}, runfiles_argument = False, runfiles_environment = [], source_files = None, test_runner = False, additional_runfiles = None):
    """Launch computed test arguments through native Bun, including on Windows.

    File arguments are resolved through declared directory runfiles. Literal
    strings remain literal; this API does not accept shell expressions.
    """
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    sources = bun_source_tree(ctx, ctx.label.name + ".sources", [runner] + (files if source_files == None else source_files))
    executable = ctx.actions.declare_file(ctx.label.name + (".exe" if runtime.runtime_platform.startswith("windows-") else ""))
    ctx.actions.symlink(output = executable, target_file = runtime.bun, is_executable = True)
    entry = ctx.actions.declare_file(ctx.label.name + ".entry.mts")
    argument_files = [argument for argument in arguments if type(argument) == "File"]
    ctx.actions.expand_template(
        template = ctx.file._bun_test_entrypoint_template,
        output = entry,
        substitutions = {"@@CONFIG@@": json.encode({
            "workspace": ctx.workspace_name,
            "runfilesSibling": executable.basename + ".runfiles",
            "runner": bun_source_runfile(ctx, sources, runner),
            "testRunner": test_runner,
            "sourceRoot": _runfile(ctx, sources.trees.get(ctx.workspace_name, bun_source_directory(ctx, sources, runner))),
            "arguments": [{"file": _runfile(ctx, argument)} if type(argument) == "File" else {"literal": argument} for argument in arguments],
            "environment": environment,
            "runfilesArgument": runfiles_argument,
            "runfilesEnvironment": runfiles_environment,
        })},
    )
    runfiles = ctx.runfiles(files = files + argument_files + [entry, runner, runtime.bun], transitive_files = sources.files)
    if additional_runfiles != None:
        runfiles = runfiles.merge(additional_runfiles)
    return struct(info = DefaultInfo(executable = executable, runfiles = runfiles), executable = executable, sources = sources)

def bun_test_entrypoint(ctx, runner, arguments, files, **kwargs):
    return [_bun_test_entrypoint(ctx, runner, arguments, files, **kwargs).info]

def bun_test_entrypoint_args(name):
    label = native.package_relative_label(":" + name)
    # Bazel launches native executables from the main repository's runfiles.
    repository = "../" + label.repo_name + "/" if label.repo_name else ""
    package = label.package + "/" if label.package else ""
    return [repository + package + name + ".entry.mts"]

def _bun_impl(ctx):
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    result = _bun_test_entrypoint(ctx, ctx.file.entry_point, [], ctx.files.data, test_runner = ctx.attr.test_runner)
    info = result.info
    runfiles = info.default_runfiles
    for dep in ctx.attr.data:
        runfiles = runfiles.merge(dep[DefaultInfo].default_runfiles)
    return [
        DefaultInfo(executable = result.executable, runfiles = runfiles),
        BunScriptInfo(bun = runtime.bun, entry_point = ctx.file.entry_point, entry_path = bun_source_path(ctx, result.sources, ctx.file.entry_point), files = runfiles.files),
    ]

def bun_action(ctx, tool, arguments = [], inputs = [], **kwargs):
    """Run a Bun tool as an action, without executing a script or shell launcher."""
    script = tool[BunScriptInfo]
    prefix = ctx.actions.args()
    prefix.add_all(["--no-install", "--no-env-file", script.entry_path])
    declared = inputs if type(inputs) == "depset" else depset(inputs)
    ctx.actions.run(
        executable = script.bun,
        arguments = [prefix] + arguments,
        inputs = depset(transitive = [declared, script.files]),
        **kwargs
    )

def bun_file_action(ctx, entry_point, arguments = [], inputs = [], source_files = None, sources = None, **kwargs):
    """Run an individual Bun entrypoint from its declared regular module tree."""
    declared = inputs if type(inputs) == "depset" else depset(inputs)
    if sources == None:
        sources = bun_source_tree(ctx, ctx.label.name + ".sources", [entry_point] + (declared.to_list() if source_files == None else source_files))
    prefix = ctx.actions.args()
    prefix.add_all(["--no-install", "--no-env-file", bun_source_path(ctx, sources, entry_point)])
    ctx.actions.run(
        executable = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun,
        arguments = [prefix] + arguments,
        inputs = depset(transitive = [declared, sources.files]),
        **kwargs
    )

_ATTRS = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
    "entry_point": attr.label(allow_single_file = [".ts", ".mts"], mandatory = True),
    "data": attr.label_list(allow_files = True),
    "test_runner": attr.bool(default = False),
})

_bun_binary = rule(implementation = _bun_impl, attrs = _ATTRS, toolchains = BUN_SOURCE_TOOLCHAINS, executable = True)
_bun_test = rule(implementation = _bun_impl, attrs = _ATTRS, toolchains = BUN_SOURCE_TOOLCHAINS, test = True)

def bun_binary(name, entry_point, data = [], args = [], **kwargs):
    _bun_binary(name = name, entry_point = entry_point, data = data + [entry_point], args = bun_test_entrypoint_args(name) + args, **kwargs)

def bun_test(name, entry_point, data = [], args = [], **kwargs):
    _bun_test(name = name, entry_point = entry_point, data = data + [entry_point], args = bun_test_entrypoint_args(name) + args, test_runner = True, **kwargs)

def bun_script_test(name, entry_point, data = [], args = [], **kwargs):
    _bun_test(name = name, entry_point = entry_point, data = data + [entry_point], args = bun_test_entrypoint_args(name) + args, **kwargs)

def _bun_toolchain_test_impl(ctx):
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    return _bun_impl(ctx) + [RunEnvironmentInfo(environment = {
        "OLIPHAUNT_BUN_RUNTIME_PLATFORM": runtime.runtime_platform,
        "OLIPHAUNT_BUN_BINARY_SHA256": runtime.binary_sha256,
    })]

_bun_toolchain_test = rule(
    implementation = _bun_toolchain_test_impl,
    attrs = _ATTRS,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    test = True,
)

def bun_toolchain_test(name, entry_point = Label(":bun-toolchain-test.mts"), data = [], args = [], **kwargs):
    _bun_toolchain_test(name = name, entry_point = entry_point, data = data + [entry_point], args = bun_test_entrypoint_args(name) + args, **kwargs)

def _source_output_impl(ctx):
    arguments = ctx.actions.args()
    arguments.add_all([ctx.file.source, ctx.outputs.out])
    bun_action(ctx, ctx.attr.tool, arguments = [arguments], inputs = [ctx.file.source], outputs = [ctx.outputs.out], mnemonic = "BunSourceOutput")
    return [DefaultInfo(files = depset([ctx.outputs.out]))]

bun_source_output = rule(
    implementation = _source_output_impl,
    attrs = {
        "tool": attr.label(mandatory = True, providers = [BunScriptInfo], cfg = "exec"),
        "source": attr.label(mandatory = True, allow_single_file = True),
        "out": attr.output(mandatory = True),
    },
)
