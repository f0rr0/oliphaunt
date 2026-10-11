"""Direct OpenSSL libcrypto construction for the maintained WASI profile.

Called in the canonical @openssl source repository. Host Perl expands the
upstream templates; the wasm32 toolchain compiles the resulting C units.
"""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@rules_perl//perl:perl.bzl", "perl_binary", "perl_library")
load(":openssl_sources.bzl", "OPENSSL_WASIX_C_SOURCES", "OPENSSL_WASIX_TEMPLATES")

_COMPATIBLE = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]

def _generate_impl(ctx):
    outputs = []
    for template, destination in ctx.attr.templates.items():
        file = template.files.to_list()[0]
        output = ctx.actions.declare_file(ctx.label.name + "/" + destination)
        outputs.append(output)
        args = ctx.actions.args()
        args.add("--in=" + file.path)
        args.add("--out=" + output.path)
        # ASN.1 OID registration is process-global; each upstream template
        # expansion needs a fresh interpreter to match util/dofile.pl.
        ctx.actions.run(
            executable = ctx.attr.batch[DefaultInfo].files_to_run,
            inputs = [file],
            outputs = [output],
            arguments = [args],
            mnemonic = "OpenSslWasixTemplate",
        )
    buildinf = ctx.actions.declare_file(ctx.label.name + "/crypto/buildinf.h")
    args = ctx.actions.args()
    args.add(ctx.executable.buildinf)
    args.add(buildinf)
    args.add("--")
    args.add("wasm32-wasi no-asm static")
    args.add("wasm32-wasi")
    ctx.actions.run(
        executable = ctx.attr.redirect[DefaultInfo].files_to_run,
        tools = [ctx.attr.buildinf[DefaultInfo].files_to_run],
        outputs = [buildinf],
        arguments = [args],
        env = {"SOURCE_DATE_EPOCH": "443779200"},
        mnemonic = "OpenSslWasixBuildInfo",
    )
    headers = [file for file in outputs if file.basename.endswith(".h")] + [buildinf]
    sources = [file for file in outputs if file.basename.endswith(".c")]
    # Derive the generated tree root independently of the first template depth.
    root = outputs[0].path.split("/" + ctx.label.name + "/")[0] + "/" + ctx.label.name
    return [
        DefaultInfo(files = depset(headers + sources)),
        OutputGroupInfo(headers = depset(headers), library_sources = depset(sources)),
        CcInfo(compilation_context = cc_common.create_compilation_context(
            headers = depset(headers),
            includes = depset([root + "/include", root + "/crypto", root + "/providers/common/include"]),
        )),
    ]

_openssl_generate = rule(
    implementation = _generate_impl,
    attrs = {
        "templates": attr.label_keyed_string_dict(allow_files = True),
        "batch": attr.label(executable = True, cfg = "exec", mandatory = True),
        "buildinf": attr.label(executable = True, cfg = "exec", mandatory = True),
        "redirect": attr.label(executable = True, cfg = "exec", mandatory = True),
    },
)

def wasix_openssl(name):
    """Compile the canonical static libcrypto and its built-in legacy provider."""
    perl_library(
        name = name + "_configdata",
        srcs = ["configdata/wasix/configdata.pm"],
        includes = ["configdata/wasix"],
        data = ["VERSION.dat"],
    )
    perl_library(
        name = name + "_platform",
        srcs = ["Configurations/platform.pm"] + native.glob(["Configurations/platform/*.pm"]),
        includes = ["Configurations"],
        deps = [":" + name + "_configdata"],
    )
    perl_binary(
        name = name + "_batch",
        srcs = ["util/wasix_batch_dofile.pl"],
        main = "util/wasix_batch_dofile.pl",
        perlopt = ["-Mconfigdata", "-Moids_to_c"],
        deps = [":" + name + "_configdata", ":" + name + "_platform", ":der_codegen", ":external_perl", ":perl_utils"],
    )
    generated = name + "_generated"
    _openssl_generate(
        name = generated,
        templates = OPENSSL_WASIX_TEMPLATES,
        batch = ":" + name + "_batch",
        buildinf = ":mkbuildinf",
        redirect = "//bazel:redirect_stdout",
    )
    native.filegroup(name = name + "_generated_sources", srcs = [":" + generated], output_group = "library_sources")
    native.filegroup(name = name + "_generated_headers", srcs = [":" + generated], output_group = "headers")
    cc_library(
        name = name,
        srcs = OPENSSL_WASIX_C_SOURCES + [":" + name + "_generated_sources"],
        hdrs = native.glob(["crypto/**/*.h", "include/crypto/**/*.h", "include/internal/*.h", "include/openssl/*.h", "providers/**/*.h", "providers/**/*.inc"]),
        textual_hdrs = ["crypto/des/ncbc_enc.c", "crypto/LPdir_unix.c"] + native.glob(["providers/implementations/**/*.c"]),
        deps = [":" + generated],
        includes = ["include", "crypto", "providers/implementations/macs", "providers/implementations/include", "providers/common/include", "providers/fips/include"],
        local_defines = ["NDEBUG", "OPENSSL_BUILDING_OPENSSL", "OPENSSL_PIC", "L_ENDIAN", "STATIC_LEGACY", "OPENSSL_NO_MODULE"],
        copts = ["-std=gnu11", "-O2", "-g0", "-fPIC", "-flto=thin", "-fvisibility=hidden", "-Wno-unused-command-line-argument", '-DOPENSSLDIR=\\"/oliphaunt/runtime/openssl/ssl\\"', '-DENGINESDIR=\\"/dev/null\\"', '-DMODULESDIR=\\"/dev/null\\"'],
        linkstatic = True,
        target_compatible_with = _COMPATIBLE,
        visibility = ["//visibility:public"],
    )
