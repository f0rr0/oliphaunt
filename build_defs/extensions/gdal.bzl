"""Direct, static GDAL 3.13.3 for the selected PostGIS raster closure.

Source lists follow the pinned upstream CMake targets, without invoking CMake.
The public target carries ordinary CcInfo; mobile archives consume the actual
object owners returned by postgis_gdal_object_roots().
"""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_DEPENDENCIES")
load("@rules_cc//cc:defs.bzl", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/extensions/postgis:libraries.bzl", "postgis_profile", "postgis_source_headers")

_SOURCE = "@postgis_gdal//:"
_OBJECT_SUFFIXES = ["", "_c", "_zlib", "_jpeg", "_jpeg12", "_tiff", "_geotiff", "_lerc"]
_PUBLIC_DIRS = ["port", "gcore", "gcore/multidim", "ogr", "ogr/ogrsf_frmts", "alg", "apps", "frmts/vrt"]
_PRIVATE_DIRS = [
    "frmts", "frmts/mem", "frmts/raw", "frmts/gtiff",
    "gcore/mdreader", "alg/marching_squares", "alg/viewshed",
    "ogr/ogrsf_frmts/generic", "ogr/ogrsf_frmts/gmlutils",
    "ogr/ogrsf_frmts/geojson", "ogr/ogrsf_frmts/shape", "ogr/ogrsf_frmts/shape/shapelib",
    "ogr/ogrsf_frmts/vrt", "third_party/libdivide", "third_party/LercLib",
]
_LOCAL_DEFINES = [
    "GDAL_COMPILATION", "HAVE_TIFF", "PAM_ENABLED", "WITHOUT_DERIVED", "NO_HFA_SUPPORT",
    "FRMT_gtiff", "FRMT_vrt", "FRMT_mem", "SHAPE_ENABLED", "GEOJSON_ENABLED", "VRT_ENABLED",
    "HAVE_GEOS", "HAVE_LIBXML2", "HAVE_LIBZ", "ZIP_SUPPORT", "GDAL_NO_AUTOLOAD",
    "GDAL_VRT_DISABLE_PYTHON", "GDAL_VRT_ENABLE_RAWRASTERBAND", "INTERNAL_QHULL",
    "INTERNAL_LIBTIFF", "INTERNAL_LIBGEOTIFF", "LERC_SUPPORT",
    "RENAME_INTERNAL_ZLIB_SYMBOLS", "RENAME_INTERNAL_LIBJPEG_SYMBOLS",
    "RENAME_INTERNAL_LIBTIFF_SYMBOLS", "RENAME_INTERNAL_LIBGEOTIFF_SYMBOLS",
    "RENAME_INTERNAL_SHAPELIB_SYMBOLS", "SHPAPI_CALL=", "SAOffset=vsi_l_offset", "USE_CPL",
]

def postgis_gdal_object_roots(name):
    """Actual GDAL object owners, excluding separately owned dependencies."""
    return [":" + name + suffix for suffix in _OBJECT_SUFFIXES]

def _configuration_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + "/cpl_config.h")
    version = ctx.actions.declare_file(ctx.label.name + "/gdal_version.h")
    full_version = ctx.actions.declare_file(ctx.label.name + "/gdal_version_full/gdal_version.h")
    sfcgal = ctx.actions.declare_file(ctx.label.name + "/ogr_sfcgal.h")
    ctx.actions.expand_template(template = ctx.file.config, output = output, substitutions = {})
    # generate_gdal_version_h.cmake keeps release date/name/nickname only in
    # the full header. Disable the same block in the ordinary public header;
    # the immutable source archive needs no Git or workspace-status stamping.
    ctx.actions.expand_template(template = ctx.file.version, output = version, substitutions = {
        "#if !defined(DO_NOT_DEFINE_GDAL_DATE_NAME)": "#if 0 /* Release fields are in gdal_version_full/gdal_version.h. */",
    })
    ctx.actions.expand_template(template = ctx.file.version, output = full_version, substitutions = {})
    ctx.actions.expand_template(template = ctx.file.sfcgal, output = sfcgal, substitutions = {
        "@SFCGAL_VERSION_MAJOR@": "0", "@SFCGAL_VERSION_MINOR@": "0", "@SFCGAL_VERSION_PATCH@": "0",
    })
    outputs = [output, version, full_version, sfcgal]
    return [DefaultInfo(files = depset(outputs)), CcInfo(compilation_context = cc_common.create_compilation_context(
        headers = depset(outputs), includes = depset([output.dirname]),
    ))]

_configuration = rule(
    implementation = _configuration_impl,
    attrs = {
        "config": attr.label(default = "//build_defs/extensions/gdal:cpl_config.h", allow_single_file = True),
        "version": attr.label(default = _SOURCE + "gcore/gdal_version.h.in", allow_single_file = True),
        "sfcgal": attr.label(default = _SOURCE + "ogr/ogr_sfcgal.h.in", allow_single_file = True),
    },
)

def _jpeg12_impl(ctx):
    # Upstream copies the JPEG sources under distinct names beside its 12-bit
    # headers. Keep the matching TIFF include's relative directory layout too.
    root = ctx.label.name + "/"
    sources = []
    headers = []
    for source in ctx.files.sources:
        output = ctx.actions.declare_file(root + "frmts/jpeg/libjpeg12/" + source.basename[:-2] + "12.c")
        ctx.actions.expand_template(template = source, output = output, substitutions = {})
        sources.append(output)
    for source in ctx.files.headers + [ctx.file.more_config]:
        output = ctx.actions.declare_file(root + "frmts/jpeg/libjpeg12/" + ("jmorecfg.h" if source == ctx.file.more_config else source.basename))
        ctx.actions.expand_template(template = source, output = output, substitutions = {})
        headers.append(output)
    tiff = ctx.actions.declare_file(root + "frmts/gtiff/libtiff/tif_jpeg_12.c")
    ctx.actions.expand_template(template = ctx.file.tiff, output = tiff, substitutions = {})
    # The renamed 12-bit wrapper includes the shared implementation textually.
    # Keep it beside the wrapper without adding another standalone object.
    tiff_impl = ctx.actions.declare_file(root + "frmts/gtiff/libtiff/tif_jpeg.c")
    ctx.actions.expand_template(template = ctx.file.tiff_impl, output = tiff_impl, substitutions = {})
    headers.append(tiff_impl)
    return [DefaultInfo(files = depset(sources + headers + [tiff])),
            OutputGroupInfo(sources = depset(sources), headers = depset(headers), tiff = depset([tiff])),
            CcInfo(compilation_context = cc_common.create_compilation_context(
                headers = depset(headers), includes = depset([headers[0].dirname]),
            ))]

_jpeg12 = rule(
    implementation = _jpeg12_impl,
    attrs = {
        "sources": attr.label_list(default = [_SOURCE + "jpeg_sources"], allow_files = True),
        "headers": attr.label_list(default = [_SOURCE + "jpeg12_headers"], allow_files = True),
        "more_config": attr.label(default = _SOURCE + "frmts/jpeg/libjpeg12/jmorecfg.h.12", allow_single_file = True),
        "tiff": attr.label(default = _SOURCE + "frmts/gtiff/libtiff/tif_jpeg_12.c", allow_single_file = True),
        "tiff_impl": attr.label(default = _SOURCE + "frmts/gtiff/libtiff/tif_jpeg.c", allow_single_file = True),
    },
)

def postgis_gdal(name, profile = "desktop", deps = [], compat_header = None):
    """Build core/GTiff/COG/MEM/VRT and GeoJSON/Shape/OGR-VRT directly."""
    if EXTENSION_DEPENDENCIES["postgis"]["gdal"]["commit"] != "c8b4c45fca87d3e6fbf80e7a7898b8a661ad0edc":
        fail("review the GDAL source/configuration inventory before changing its pin")
    if profile == "wasix":
        if not compat_header:
            fail("WASIX GDAL requires the declared upstream-recipe compatibility header")
        compatible = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
        settings = struct(compatible = compatible,
                          c = ["-std=gnu11", "-O2", "-g0", "-fPIC", "-fvisibility=hidden"],
                          cxx = ["-std=c++17", "-O2", "-g0", "-fPIC", "-fvisibility=hidden", "-fvisibility-inlines-hidden"])
    else:
        if compat_header:
            fail("the GDAL process compatibility header is specific to WASIX")
        settings = postgis_profile(profile)
    common = {"target_compatible_with": settings.compatible, "linkstatic": True}
    _configuration(name = name + "_config", target_compatible_with = settings.compatible)
    postgis_source_headers(name = name + "_headers", root = _SOURCE + "VERSION",
                           headers = [_SOURCE + "headers"], include_dirs = _PUBLIC_DIRS)
    postgis_source_headers(name = name + "_private_headers", root = _SOURCE + "VERSION",
                           headers = [_SOURCE + "headers", _SOURCE + "textual_inputs"], include_dirs = _PRIVATE_DIRS)
    base_deps = [":" + name + "_config", ":" + name + "_headers"] + deps
    private_headers = [":" + name + "_private_headers"]
    for suffix, directory in [("zlib", "frmts/zlib"), ("jpeg", "frmts/jpeg/libjpeg"), ("tiff", "frmts/gtiff/libtiff"), ("geotiff", "frmts/gtiff/libgeotiff")]:
        postgis_source_headers(name = name + "_" + suffix + "_headers", root = _SOURCE + "VERSION",
                               headers = [_SOURCE + "headers"] + ([_SOURCE + "jpeg_textual_inputs"] if suffix == "jpeg" else []), include_dirs = [directory])
    _jpeg12(name = name + "_jpeg12_generated", target_compatible_with = settings.compatible)
    for group in ["sources", "headers", "tiff"]:
        native.filegroup(name = name + "_jpeg12_" + group, srcs = [":" + name + "_jpeg12_generated"], output_group = group)
    codec_defines = _LOCAL_DEFINES + ["DEFAULT_MAX_MEM=500000000L"]
    cc_library(name = name + "_zlib", srcs = [_SOURCE + "zlib_sources"], deps = base_deps,
               implementation_deps = [":" + name + "_zlib_headers"], copts = settings.c,
               local_defines = codec_defines, **common)
    cc_library(name = name + "_jpeg", srcs = [_SOURCE + "jpeg_sources"], deps = base_deps,
               implementation_deps = [":" + name + "_jpeg_headers"], copts = settings.c,
               local_defines = codec_defines, **common)
    cc_library(name = name + "_jpeg12", srcs = [":" + name + "_jpeg12_sources"], deps = base_deps,
               implementation_deps = [":" + name + "_jpeg12_generated"], copts = settings.c,
               local_defines = codec_defines + ["JPEG_DUAL_MODE_8_12"], **common)
    cc_library(name = name + "_lerc", srcs = [_SOURCE + "lerc_sources"], deps = base_deps,
               implementation_deps = private_headers, copts = settings.cxx, local_defines = _LOCAL_DEFINES, **common)
    cc_library(name = name + "_tiff", srcs = [_SOURCE + "tiff_sources", ":" + name + "_jpeg12_tiff"],
               textual_hdrs = [":" + name + "_jpeg12_headers"], deps = base_deps,
               implementation_deps = private_headers + [":" + name + "_tiff_headers", ":" + name + "_zlib_headers", ":" + name + "_jpeg_headers", ":" + name + "_zlib", ":" + name + "_jpeg", ":" + name + "_jpeg12", ":" + name + "_lerc"],
               copts = settings.c, local_defines = codec_defines + ["HOST_FILLORDER=FILLORDER_LSB2MSB", "DONT_DEPRECATE_SPRINTF", "PIXARLOG_SUPPORT", "JPEG_SUPPORT", "OJPEG_SUPPORT", "JPEG_DUAL_MODE_8_12"], **common)
    cc_library(name = name + "_geotiff", srcs = [_SOURCE + "geotiff_sources"], deps = base_deps,
               implementation_deps = private_headers + [":" + name + "_tiff_headers", ":" + name + "_geotiff_headers", ":" + name + "_tiff"],
               copts = settings.c, local_defines = codec_defines, **common)
    cc_library(name = name + "_c", srcs = [_SOURCE + "core_c_sources"], deps = base_deps,
               implementation_deps = private_headers, copts = settings.c, local_defines = _LOCAL_DEFINES, **common)
    windows = "//build_defs/native:windows_x64"
    platform_sources = select({windows: [_SOURCE + "port_windows_sources"], "//conditions:default": [_SOURCE + "port_posix_sources"]}) if profile == "desktop" else [_SOURCE + "port_posix_sources"]
    iconv_sources = []
    iconv_defines = []
    if profile == "wasix":
        iconv_sources = [_SOURCE + "port_iconv_sources"]
        iconv_defines = ["HAVE_ICONV"]
    elif profile == "mobile-static":
        iconv_sources = select({"@platforms//os:android": [_SOURCE + "port_iconv_sources"], "//conditions:default": []})
        iconv_defines = select({"@platforms//os:android": ["HAVE_ICONV"], "//conditions:default": []})
    cc_library(name = name, srcs = [_SOURCE + "core_cpp_sources"] + platform_sources + iconv_sources,
               hdrs = [_SOURCE + "headers"], textual_hdrs = [_SOURCE + "textual_inputs"],
               deps = base_deps, implementation_deps = private_headers + [":" + name + "_zlib_headers", ":" + name + "_jpeg_headers", ":" + name + "_tiff_headers", ":" + name + "_geotiff_headers"] + postgis_gdal_object_roots(name)[1:],
               copts = settings.cxx + (["-include", "$(location " + compat_header + ")"] if compat_header else []),
               additional_compiler_inputs = [compat_header] if compat_header else [],
               local_defines = _LOCAL_DEFINES + iconv_defines,
               defines = ["CPL_DISABLE_DLL"],
               linkopts = select({windows: ["ws2_32.lib", "wbemuuid.lib"], "//build_defs/native:macos_arm64": [], "//conditions:default": ["-lm", "-pthread", "-ldl"]}) if profile == "desktop" else [],
               **common)
    native.filegroup(name = name + "_data", srcs = [_SOURCE + "data"], target_compatible_with = settings.compatible)
