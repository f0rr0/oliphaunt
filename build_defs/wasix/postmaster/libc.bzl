"""The pinned patched libc uses maintained C/C++ compilation and archiving."""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load(":libc-toolchain.bzl", "LIBC_CONSTRUCTION_TRANSITION")

_COMPATIBLE = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]

def _headers_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name + "/include")
    spec = ctx.actions.declare_file(ctx.label.name + ".json")
    prefix = ctx.file.makefile.dirname + "/"
    ctx.actions.write(spec, json.encode({
        "files": [{"relative": file.path[len(prefix):], "path": file.path} for file in ctx.files.sources],
        "omit": ctx.attr.omit,
    }))
    arguments = ctx.actions.args()
    arguments.add(spec)
    arguments.add(output.path)
    bun_file_action(ctx, ctx.file._writer, source_files = [ctx.file._writer], arguments = [arguments], inputs = [spec] + ctx.files.sources, outputs = [output], mnemonic = "PostmasterLibcHeaders")
    return [DefaultInfo(files = depset([output])), CcInfo(compilation_context = cc_common.create_compilation_context(headers = depset([output]), system_includes = depset([output.path])))]

libc_headers = rule(
    implementation = _headers_impl,
    attrs = {
        "makefile": attr.label(allow_single_file = True, mandatory = True),
        "sources": attr.label_list(allow_files = True, mandatory = True),
        "omit": attr.string_list(mandatory = True),
        "_writer": attr.label(default = Label("//build_defs/wasix/postmaster:libc-headers.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def _archive_impl(ctx):
    objects = []
    records = []
    for index, dependency in enumerate(ctx.attr.deps):
        sources = json.decode(ctx.attr.source_groups[index])
        compiled = []
        for linker_input in dependency[CcInfo].linking_context.linker_inputs.to_list():
            if linker_input.user_link_flags or linker_input.additional_inputs:
                fail("Patched libc requires explicit compilation objects")
            for library in linker_input.libraries:
                compiled.extend(library.pic_objects or library.objects)
        if len(compiled) != len(sources):
            fail("Patched libc source/object membership differs for " + str(dependency.label))
        for source, file in zip(sources, compiled):
            records.append({"source": source, "path": file.path})
        objects.extend(compiled)
    output = ctx.actions.declare_file(ctx.attr.output_name)
    spec = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(spec, json.encode(records))
    arguments = ctx.actions.args()
    arguments.add_all([spec, ctx.executable._archiver, output])
    bun_file_action(ctx, ctx.file._writer, source_files = [ctx.file._writer], arguments = [arguments], inputs = [spec] + objects, tools = ctx.files._archiver_files, outputs = [output], mnemonic = "PostmasterLibcArchive")
    return [DefaultInfo(files = depset([output]))]

_libc_archive = rule(
    implementation = _archive_impl,
    attrs = {
        "deps": attr.label_list(providers = [CcInfo], mandatory = True, cfg = LIBC_CONSTRUCTION_TRANSITION),
        "source_groups": attr.string_list(mandatory = True),
        "output_name": attr.string(mandatory = True),
        "_writer": attr.label(default = Label("//build_defs/wasix/postmaster:libc-archive.mts"), allow_single_file = True),
        "_archiver": attr.label(default = Label("@wasix_toolchain//:llvm/bin/llvm-ar"), allow_single_file = True, executable = True, cfg = "exec"),
        "_archiver_files": attr.label(default = Label("@wasix_toolchain//:llvm_files"), cfg = "exec"),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def _sysroot_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    spec = ctx.actions.declare_file(ctx.label.name + ".json")
    marker = "/sysroot/sysroot-exnref-ehpic/"
    base = [file for file in ctx.files._base if marker in file.path]
    ctx.actions.write(spec, json.encode({
        "base": [{"relative": file.path.split(marker)[1], "path": file.path} for file in base],
        "headers": ctx.file.headers.path,
        "libc": ctx.file.libc.path,
        "mman": ctx.file.mman.path,
    }))
    arguments = ctx.actions.args()
    arguments.add(spec)
    arguments.add(output.path)
    bun_file_action(ctx, ctx.file._writer, source_files = [ctx.file._writer], arguments = [arguments], inputs = [spec, ctx.file.headers, ctx.file.libc, ctx.file.mman] + base, outputs = [output], mnemonic = "PostmasterLibcSysroot")
    return [DefaultInfo(files = depset([output])), CcInfo(compilation_context = cc_common.create_compilation_context(headers = depset([output]), system_includes = depset([output.path + "/include"])))]

_libc_sysroot = rule(
    implementation = _sysroot_impl,
    attrs = {
        "headers": attr.label(allow_single_file = True, mandatory = True),
        "libc": attr.label(allow_single_file = True, mandatory = True),
        "mman": attr.label(allow_single_file = True, mandatory = True),
        "_base": attr.label(default = Label("@wasix_toolchain//:linker_files")),
        "_writer": attr.label(default = Label("//build_defs/wasix/postmaster:libc-sysroot.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def patched_libc_targets(sources):
    """Canonical wasm32/POSIX/PIC/exnref Makefile-eh profile, no Make driver."""
    libc_headers(
        name = "headers",
        makefile = "Makefile-eh",
        sources = native.glob(["libc-bottom-half/headers/public/**", "libc-top-half/musl/include/**", "libc-top-half/musl/arch/generic/bits/**", "libc-top-half/musl/arch/wasm32/bits/**"]) + ["libc-top-half/musl/tools/mkalltypes.sed"],
        omit = sources["omit"],
        target_compatible_with = _COMPATIBLE,
    )
    # Package-relative paths in repository source copts are prefixed by the
    # caller's actual canonical repository, never the workspace CWD.
    prefix = native.package_relative_label(":Makefile-eh").workspace_root + "/"
    common = [
        "-O2", "-DNDEBUG", "-ftls-model=local-exec", "-D_WASI_EMULATED_MMAN", "-D_WASI_EMULATED_PROCESS_CLOCKS",
        "-fno-trapping-math", "-Wall", "-Wextra", "-Werror", "-mexception-handling", "-fwasm-exceptions",
        "-mllvm", "--wasm-enable-sjlj", "-mllvm", "--wasm-enable-eh", "-mllvm", "--wasm-use-legacy-eh=false",
        "-mthread-model", "posix", "-pthread", "-fPIC", "-nostdinc",
        "-isystem", Label("@wasix_toolchain//:llvm/bin/clang").workspace_root + "/llvm/lib/clang/21/include",
        "-I" + prefix + "libc-bottom-half/cloudlibc/src",
    ] + ["-Wno-" + name for name in ["incompatible-function-pointer-types", "null-pointer-arithmetic", "unused-parameter", "sign-compare", "unused-variable", "unused-function", "ignored-attributes", "missing-braces", "ignored-pragmas", "unused-but-set-variable", "unknown-warning-option", "unused-command-line-argument"]]
    private_headers = native.glob(["libc-bottom-half/**/*.h", "libc-top-half/**/*.h", "dlmalloc/include/**"])
    bottom_includes = ["libc-bottom-half/headers/private", "libc-bottom-half/cloudlibc/src/include", "libc-bottom-half/cloudlibc/src", "libc-top-half/musl/src/include", "libc-top-half/musl/src/internal"]
    top_includes = ["libc-top-half/musl/src/include", "libc-top-half/musl/src/internal", "libc-top-half/musl/arch/wasm32", "libc-top-half/musl/arch/generic", "libc-top-half/headers/private"]
    top_flags = ["-Wno-" + name for name in ["parentheses", "shift-op-parentheses", "bitwise-op-parentheses", "logical-op-parentheses", "string-plus-int", "dangling-else", "unknown-pragmas"]]
    special = sources["printscan"] + sources["bulk"]
    groups = [
        ("bottom", sources["bottom"], bottom_includes, []),
        ("top", [path for path in sources["top"] if path not in special and not path.endswith(".s")], top_includes, top_flags),
        ("malloc", sources["malloc"], ["dlmalloc/include"], []),
        ("printscan", sources["printscan"], top_includes, top_flags + ['-D__wasilibc_printscan_full_support_option="add -lc-printscan-long-double to the link command"']),
        ("bulk", sources["bulk"], top_includes, top_flags + ["-mbulk-memory", "-DBULK_MEMORY_THRESHOLD=32"]),
        ("mman", sources["mman"], [], []),
    ]
    for name, paths, includes, flags in groups:
        cc_library(name = name, srcs = paths, hdrs = private_headers, textual_hdrs = ["dlmalloc/src/malloc.c"] if name == "malloc" else [], deps = [":headers"], copts = common + ["-I" + prefix + path for path in includes] + flags, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "assembly", srcs = [path for path in sources["top"] if path.endswith(".s")], copts = common, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "libc", deps = [":" + name for name in ["bottom", "top", "malloc", "printscan", "bulk", "assembly"]], target_compatible_with = _COMPATIBLE)
    archive_groups = [(name, paths) for name, paths, _includes, _flags in groups if name != "mman"] + [("assembly", [path for path in sources["top"] if path.endswith(".s")])]
    _libc_archive(name = "libc_archive", deps = [":" + name for name, _paths in archive_groups], source_groups = [json.encode(paths) for _name, paths in archive_groups], output_name = "libc.a", target_compatible_with = _COMPATIBLE, exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])
    _libc_archive(name = "mman_archive", deps = [":mman"], source_groups = [json.encode(sources["mman"])], output_name = "libwasi-emulated-mman.a", target_compatible_with = _COMPATIBLE, exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])
    _libc_sysroot(name = "sysroot", headers = ":headers", libc = ":libc_archive", mman = ":mman_archive", target_compatible_with = _COMPATIBLE)
