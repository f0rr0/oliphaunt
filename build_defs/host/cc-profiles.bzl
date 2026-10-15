"""Standard compiler configurations backed by the declared host SDK files."""

load("@rules_cc//cc/private/toolchain:unix_cc_toolchain_config.bzl", unix_config = "cc_toolchain_config")
load("@rules_cc//cc/private/toolchain:windows_cc_toolchain_config.bzl", windows_config = "cc_toolchain_config")
load("@rules_cc//cc/toolchains:cc_toolchain.bzl", "cc_toolchain")
load("@rules_cc//cc:cc_binary.bzl", "cc_binary")
load("@apple_support//crosstool:cc_toolchain_config.bzl", apple_config = "cc_toolchain_config")
load("@apple_support//crosstool:universal_exec_tool.bzl", "force_exec")

def _driver_alias_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(output = output, target_file = ctx.file.binary, is_executable = True)
    return [DefaultInfo(files = depset([output]), executable = output)]

_driver_alias = rule(implementation = _driver_alias_impl, executable = True, attrs = {"binary": attr.label(allow_single_file = True, mandatory = True)})

def _deployment_impl(settings, attr):
    # The standard Apple configuration reads its triple from these fragments.
    # Bind them to the selected public profile rather than the runner default.
    return {"//command_line_option:macos_minimum_os": attr.macos_floor, "//command_line_option:ios_minimum_os": attr.ios_floor}

_deployment = transition(implementation = _deployment_impl, inputs = [], outputs = ["//command_line_option:macos_minimum_os", "//command_line_option:ios_minimum_os"])

def _configuration_impl(ctx):
    return [ctx.attr.configuration[0][CcToolchainConfigInfo]]

_configuration = rule(
    implementation = _configuration_impl,
    attrs = {
        "configuration": attr.label(mandatory = True, providers = [CcToolchainConfigInfo], cfg = _deployment),
        "macos_floor": attr.string(mandatory = True),
        "ios_floor": attr.string(mandatory = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def host_builtin_include_directories(prefix, directories):
    """Builtin paths need an explicit execroot base, unlike compiler flags."""
    return ["%workspace%/" + prefix + directory for directory in directories]

def host_cc_profiles(sdk):
    """Use execroot SDK paths for compiler, include, resource and library lookup."""
    prefix = "external/" + native.repository_name()[1:] + "/"
    if sdk["family"] == "msvc":
        includes = ["compiler_include"] + ["sdk_include/" + name for name in ["ucrt", "shared", "um", "winrt", "cppwinrt"]]
        libraries = ["compiler_lib", "sdk_lib_ucrt", "sdk_lib_um"]
        windows_config(
            name = "configuration",
            cpu = "x64_windows",
            compiler = "msvc-cl",
            host_system_name = "x86_64-pc-windows-msvc",
            target_system_name = "x86_64-pc-windows-msvc",
            target_libc = "ucrt",
            abi_version = sdk["observations"]["VCToolsVersion"],
            abi_libc_version = sdk["observations"]["WindowsSDKVersion"],
            toolchain_identifier = "oliphaunt_msvc_x64",
            msvc_cl_path = "compiler_bin/cl.exe",
            msvc_ml_path = "compiler_bin/ml64.exe",
            msvc_link_path = "compiler_bin/link.exe",
            msvc_lib_path = "compiler_bin/lib.exe",
            msvc_env_include = ";".join([prefix + directory for directory in includes]),
            msvc_env_lib = ";".join([prefix + directory for directory in libraries]),
            msvc_env_path = ";".join([prefix + directory for directory in ["compiler_bin", "sdk_bin", "crt"]]),
            msvc_env_tmp = sdk["temporaryDirectory"],
            cxx_builtin_include_directories = host_builtin_include_directories(prefix, includes),
            tool_paths = {
                "ar": "compiler_bin/lib.exe",
                "ml": "compiler_bin/ml64.exe",
                "cpp": "compiler_bin/cl.exe",
                "gcc": "compiler_bin/cl.exe",
                "ld": "compiler_bin/link.exe",
                "nm": "compiler_bin/dumpbin.exe",
                "dumpbin": "compiler_bin/dumpbin.exe",
                "gcov": "unsupported.bat",
                "objcopy": "unsupported.bat",
                "objdump": "unsupported.bat",
                "strip": "unsupported.bat",
            },
            archiver_flags = ["/MACHINE:X64"],
            default_link_flags = ["/MACHINE:X64"],
            fastbuild_mode_debug_flag = "/DEBUG",
            dbg_mode_debug_flag = "/DEBUG",
            supports_parse_showincludes = True,
            shorten_virtual_includes = True,
        )
        _compiler("cc_compiler", ":configuration", sdk, [])
    else:
        for name, minimum in [("native", sdk["deploymentTargets"]["native_macos"])]:
            unix_config(
                name = "configuration_" + name,
                cpu = "darwin_arm64",
                compiler = "clang",
                host_system_name = "aarch64-apple-darwin",
                target_system_name = "arm64-apple-macosx" + minimum,
                target_libc = "macosx",
                abi_version = sdk["observations"]["xcode"],
                abi_libc_version = sdk["observations"]["macosx_version"],
                toolchain_identifier = "oliphaunt_apple_arm64_" + name,
                builtin_sysroot = prefix + "sdk_macosx",
                cxx_builtin_include_directories = host_builtin_include_directories(prefix, [sdk["resourceDirectory"] + "/include", "sdk_macosx/usr/include", "sdk_macosx/System/Library/Frameworks", "toolchain/include/c++/v1"]),
                tool_paths = {
                    "gcc": sdk["tools"]["clang"],
                    "cpp": sdk["tools"]["clang"],
                    "ar": sdk["tools"]["libtool"],
                    "ld": sdk["tools"]["ld"],
                    "nm": sdk["tools"]["nm"],
                    "strip": sdk["tools"]["strip"],
                    "gcov": "unsupported.sh",
                    "objcopy": "unsupported.sh",
                    "objdump": "unsupported.sh",
                },
                compile_flags = ["-target", "arm64-apple-macosx" + minimum, "-resource-dir", prefix + sdk["resourceDirectory"], "-isysroot", prefix + "sdk_macosx"],
                cxx_flags = ["-std=c++17"],
                link_flags = ["-target", "arm64-apple-macosx" + minimum, "-resource-dir", prefix + sdk["resourceDirectory"], "-isysroot", prefix + "sdk_macosx"],
                link_libs = ["-lc++"],
                unfiltered_compile_flags = ["-Wno-overriding-option"],
                supports_start_end_lib = False,
            )
            _compiler("cc_" + name, ":configuration_" + name, sdk, [component for other in ["iphoneos", "iphonesimulator"] for component in ["sdk_" + other, "platform_" + other + "/Library", "platform_" + other + "/usr/lib"]])
        # Build the pinned standard Apple drivers with the declared native
        # compiler. Upstream's universal_exec_tool uses an ambient shell compiler.
        cc_binary(name = "wrapped_clang", srcs = ["wrapped_clang.cc"], copts = ["-std=c++17"])
        _driver_alias(name = "wrapped_clang_pp", binary = ":wrapped_clang")
        cc_binary(name = "libtool", srcs = ["libtool.cc"], copts = ["-std=c++17"])
        for driver in ["wrapped_clang", "wrapped_clang_pp", "libtool"]:
            force_exec(name = "exec_" + driver, target = ":" + driver)
        # Match apple_support's disabled-layering configuration: a label whose
        # DefaultInfo contains no module map, rather than an absent label.
        native.filegroup(name = "modulemap", srcs = [])
        for name, cpu, selected_sdk in [
            ("package", "darwin_arm64", "macosx"),
            ("ios", "ios_arm64", "iphoneos"),
            ("ios_simulator", "ios_sim_arm64", "iphonesimulator"),
        ]:
            apple_config(
                name = "apple_configuration_" + name,
                cpu = cpu,
                wrapped_clang = ":exec_wrapped_clang",
                wrapped_clang_pp = ":exec_wrapped_clang_pp",
                libtool = ":exec_libtool",
                module_map = ":modulemap",
                c_flags = ["-resource-dir", prefix + sdk["resourceDirectory"]],
                link_flags = ["-resource-dir", prefix + sdk["resourceDirectory"]],
                cxx_flags = ["-std=c++20"] if selected_sdk in ["iphoneos", "iphonesimulator"] else [],
                cxx_builtin_include_directories = host_builtin_include_directories(prefix, [sdk["resourceDirectory"] + "/include", "sdk_" + selected_sdk + "/usr/include", "sdk_" + selected_sdk + "/System/Library/Frameworks", "toolchain/include/c++/v1"]),
                # Bazel owns the reserved Xcode environment; drivers consume our captured paths.
                extra_env = {"OLIPHAUNT_APPLE_DEVELOPER_DIRECTORY": prefix.removesuffix("/"), "OLIPHAUNT_APPLE_SDKROOT": prefix + "sdk_" + selected_sdk, "OLIPHAUNT_APPLE_TOOL_DIRECTORY": prefix + "tools"},
                tool_paths_overrides = {"cpp": prefix + sdk["tools"]["clang"], "ld": prefix + sdk["tools"]["ld"], "nm": prefix + sdk["tools"]["nm"], "strip": prefix + sdk["tools"]["strip"], "gcov": prefix + "unsupported.sh", "objdump": prefix + "unsupported.sh"},
            )
            _configuration(
                name = "configuration_" + name,
                configuration = ":apple_configuration_" + name,
                macos_floor = sdk["deploymentTargets"]["package_macos"],
                ios_floor = sdk["deploymentTargets"]["ios"],
            )
            _compiler("cc_" + name, ":configuration_" + name, sdk, [component for other in ["macosx", "iphoneos", "iphonesimulator"] if other != selected_sdk for component in ["sdk_" + other, "platform_" + other + "/Library", "platform_" + other + "/usr/lib"]], drivers = True)

def _compiler(name, configuration, sdk, exclude, drivers = False):
    components = [component for component in sdk["components"] if component["name"] not in exclude]
    for role in ["compile", "link"]:
        native.filegroup(
            name = name + "_" + role + "_files",
            srcs = [":receipt.json", ":unsupported.bat", ":unsupported.sh"] + ([":exec_wrapped_clang", ":exec_wrapped_clang_pp", ":exec_libtool"] if drivers else []) + [":" + component["name"] + "_files" for component in components if role in component["roles"]],
        )
    native.filegroup(name = name + "_all_files", srcs = [":" + name + "_compile_files", ":" + name + "_link_files"])
    cc_toolchain(
        name = name,
        toolchain_identifier = name,
        toolchain_config = configuration,
        all_files = ":" + name + "_all_files",
        ar_files = ":" + name + "_link_files",
        as_files = ":" + name + "_compile_files",
        compiler_files = ":" + name + "_compile_files",
        linker_files = ":" + name + "_link_files",
        strip_files = ":" + name + "_link_files",
        dwp_files = ":" + name + "_link_files",
        objcopy_files = ":" + name + "_link_files",
        supports_param_files = True,
    )
