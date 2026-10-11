"""Native Bun entrypoints and action execution with declared TypeScript inputs."""

load(":bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

BunScriptInfo = provider(fields = ["bun", "entry_point", "files"])

BUN_TEST_ENTRYPOINT_ATTRS = {
    "_bun_test_entrypoint_template": attr.label(default = "//build_defs/foundation:bun-test-entrypoint.mts.tpl", allow_single_file = True),
}

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def bun_test_entrypoint(ctx, runner, arguments, files, environment = {}, runfiles_argument = False, runfiles_environment = []):
    """Launch computed test arguments through native Bun, including on Windows.

    File arguments are resolved through declared directory runfiles. Literal
    strings remain literal; this API does not accept shell expressions.
    """
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    executable = ctx.actions.declare_file(ctx.label.name + (".exe" if runtime.runtime_platform.startswith("windows-") else ""))
    ctx.actions.symlink(output = executable, target_file = runtime.bun, is_executable = True)
    entry = ctx.actions.declare_file(ctx.label.name + ".entry.mts")
    argument_files = [argument for argument in arguments if type(argument) == "File"]
    ctx.actions.expand_template(
        template = ctx.file._bun_test_entrypoint_template,
        output = entry,
        substitutions = {"@@CONFIG@@": json.encode({
            "workspace": ctx.workspace_name,
            "runner": _runfile(ctx, runner),
            "arguments": [{"file": _runfile(ctx, argument)} if type(argument) == "File" else {"literal": argument} for argument in arguments],
            "environment": environment,
            "runfilesArgument": runfiles_argument,
            "runfilesEnvironment": runfiles_environment,
        })},
    )
    return [DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = files + argument_files + [entry, runner, runtime.bun]))]

def bun_test_entrypoint_args(name):
    return [(native.package_name() + "/" if native.package_name() else "") + name + ".entry.mts"]

def _bun_impl(ctx):
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    suffix = ".exe" if runtime.runtime_platform.startswith("windows-") else ""
    executable = ctx.actions.declare_file(ctx.label.name + suffix)
    ctx.actions.symlink(output = executable, target_file = runtime.bun, is_executable = True)
    files = depset([ctx.file.entry_point, runtime.bun], transitive = [depset(ctx.files.data)])
    runfiles = ctx.runfiles(transitive_files = files)
    for dep in ctx.attr.data:
        runfiles = runfiles.merge(dep[DefaultInfo].default_runfiles)
    return [
        DefaultInfo(executable = executable, runfiles = runfiles),
        BunScriptInfo(bun = runtime.bun, entry_point = ctx.file.entry_point, files = runfiles.files),
    ]

def bun_action(ctx, tool, arguments = [], inputs = [], **kwargs):
    """Run a Bun tool as an action, without executing a script or shell launcher."""
    script = tool[BunScriptInfo]
    prefix = ctx.actions.args()
    prefix.add(script.entry_point)
    declared = inputs if type(inputs) == "depset" else depset(inputs)
    ctx.actions.run(
        executable = script.bun,
        arguments = [prefix] + arguments,
        inputs = depset(transitive = [declared, script.files]),
        **kwargs
    )

_ATTRS = {
    "entry_point": attr.label(allow_single_file = [".ts", ".mts"], mandatory = True),
    "data": attr.label_list(allow_files = True),
}

_bun_binary = rule(implementation = _bun_impl, attrs = _ATTRS, toolchains = [BUN_TOOLCHAIN_TYPE], executable = True)
_bun_test = rule(implementation = _bun_impl, attrs = _ATTRS, toolchains = [BUN_TOOLCHAIN_TYPE], test = True)

def _entry_args(entry_point):
    return ["$(rootpath %s)" % entry_point]

def bun_binary(name, entry_point, data = [], args = [], **kwargs):
    _bun_binary(name = name, entry_point = entry_point, data = data + [entry_point], args = _entry_args(entry_point) + args, **kwargs)

def bun_test(name, entry_point, data = [], args = [], **kwargs):
    _bun_test(name = name, entry_point = entry_point, data = data + [entry_point], args = ["test"] + _entry_args(entry_point) + args, **kwargs)

def bun_script_test(name, entry_point, data = [], args = [], **kwargs):
    _bun_test(name = name, entry_point = entry_point, data = data + [entry_point], args = _entry_args(entry_point) + args, **kwargs)

def _bun_toolchain_test_impl(ctx):
    runtime = ctx.toolchains[BUN_TOOLCHAIN_TYPE]
    return _bun_impl(ctx) + [RunEnvironmentInfo(environment = {
        "OLIPHAUNT_BUN_RUNTIME_PLATFORM": runtime.runtime_platform,
        "OLIPHAUNT_BUN_BINARY_SHA256": runtime.binary_sha256,
    })]

_bun_toolchain_test = rule(
    implementation = _bun_toolchain_test_impl,
    attrs = _ATTRS,
    toolchains = [BUN_TOOLCHAIN_TYPE],
    test = True,
)

def bun_toolchain_test(name, entry_point = "//build_defs/foundation:bun-toolchain-test.mts", data = [], args = [], **kwargs):
    _bun_toolchain_test(name = name, entry_point = entry_point, data = data + [entry_point], args = _entry_args(entry_point) + args, **kwargs)

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
