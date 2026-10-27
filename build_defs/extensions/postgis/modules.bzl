"""Pinned PostGIS standalone libraries and independently compiled PG ABI modules."""

load("@rules_cc//cc:defs.bzl", "cc_library", "cc_shared_library")
load("//build_defs/extensions:contrib.bzl", "contrib_generated_sources")
load("//build_defs/extensions:extensions.bzl", "extension_native_dependency_modules", "native_extension_modules")
load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_RECIPES")
load("//build_defs/extensions:external.bzl", "windows_extension_sources")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", "NATIVE_EXTENSION_PROFILES")
load("//build_defs/extensions:mobile.bzl", "MOBILE_EXTENSION_COMPATIBLE")
load("//build_defs/native:platform_config.bzl", "NATIVE_RELEASE_LINKOPTS", "NATIVE_WINDOWS_COMPATIBLE")
load(":libraries.bzl", "POSTGIS_MATH_LINKOPTS", "POSTGIS_NATIVE_COPTS", "POSTGIS_NATIVE_CXX_COPTS", "postgis_configuration", "postgis_profile", "postgis_source_headers")
load(":generators.bzl", "postgis_flex")
load(":windows_sources_test.bzl", "postgis_windows_sources_test")

# liblwgeom/Makefile.in SA_OBJS and NM_OBJS, with optional SFCGAL disabled.
_LWGEOM = "stringbuffer optionlist stringlist bytebuffer measures measures3d ptarray lookup3 lwgeom_api lwgeom lwpoint lwline lwpoly lwtriangle lwmpoint lwmline lwmpoly lwboundingcircle lwcollection lwcircstring lwcompound lwcurvepoly lwmcurve lwmsurface lwpsurface lwtin lwout_wkb lwin_geojson lwin_wkb lwin_twkb lwiterator lwgeom_median lwout_wkt lwout_twkb lwin_wkt lwin_encoded_polyline lwutil lwhomogenize intervaltree lwalgorithm lwstroke lwlinearreferencing lwprint gbox gserialized gserialized1 gserialized2 lwgeodetic lwgeodetic_measures lwgeodetic_tree lwrandom lwtree lwout_gml lwout_kml lwout_geojson lwout_svg lwout_x3d lwout_encoded_polyline lwgeom_debug lwgeom_geos lwgeom_geos_clean lwgeom_geos_cluster lwgeom_geos_node lwgeom_geos_split topo/lwgeom_topo topo/lwgeom_topo_polygonizer topo/lwt_edgeend topo/lwt_edgeend_star topo/lwt_node_edges lwgeom_transform lwgeom_wrapx lwunionfind effectivearea lwchaikins lwmval lwkmeans varint lwgeom_remove_irrelevant_points_for_view lwspheroid".split(" ")

# postgis/Makefile.in PG_OBJS + the PostgreSQL 18 SPGIST_OBJ recipe.
# Protobuf/SFCGAL optional profiles are disabled in the generated configuration.
_PG = "postgis_module lwgeom_accum lwgeom_union lwgeom_spheroid lwgeom_ogc lwgeom_functions_analytic lwgeom_functions_basic lwgeom_inout lwgeom_btree lwgeom_box lwgeom_box3d lwgeom_geos lwgeom_geos_predicates lwgeom_geos_prepared lwgeom_geos_clean lwgeom_geos_relatematch lwgeom_generate_grid lwgeom_export lwgeom_in_gml lwgeom_in_kml lwgeom_in_marc21 lwgeom_out_marc21 lwgeom_in_geohash lwgeom_in_geojson lwgeom_in_encoded_polyline lwgeom_triggers lwgeom_dump lwgeom_dumppoints lwgeom_functions_lrs lwgeom_functions_temporal lwgeom_rectree lwgeom_itree lwgeom_sqlmm lwgeom_transform lwgeom_window gserialized_typmod gserialized_gist_2d gserialized_gist_nd gserialized_supportfn gserialized_spgist_2d gserialized_spgist_3d gserialized_spgist_nd brin_2d brin_nd brin_common gserialized_estimate geography_inout geography_btree geography_centroid geography_measurement geography_measurement_trees geometry_inout postgis_libprotobuf mvt lwgeom_out_mvt geobuf lwgeom_out_geobuf lwgeom_out_geojson flatgeobuf lwgeom_in_flatgeobuf lwgeom_out_flatgeobuf lwgeom_remove_irrelevant_points_for_view lwgeom_remove_small_parts postgis_legacy".split(" ")
_PGCOMMON = "gserialized_gist lwgeom_transform lwgeom_cache lwgeom_pg shared_gserialized".split(" ")

POSTGIS_LWGEOM_SOURCES = ["liblwgeom/" + source + ".c" for source in _LWGEOM]
POSTGIS_PG_SOURCES = ["postgis/" + source + ".c" for source in _PG] + ["libpgcommon/" + source + ".c" for source in _PGCOMMON]
POSTGIS_PGCOMMON_SOURCES = ["libpgcommon/" + source + ".c" for source in _PGCOMMON]
POSTGIS_RTCORE_SOURCES = ["raster/rt_core/" + source + ".c" for source in "rt_util rt_spatial_relationship rt_mapalgebra rt_geometry rt_statistics rt_pixel rt_warp rt_gdal rt_band rt_raster rt_serialize rt_wkb rt_context".split(" ")]
POSTGIS_RASTER_SOURCES = ["raster/rt_pg/" + source + ".c" for source in "rtpostgis rtpg_internal rtpg_legacy rtpg_spatial_relationship rtpg_mapalgebra rtpg_utility rtpg_inout rtpg_wkb rtpg_geometry rtpg_raster_properties rtpg_band_properties rtpg_pixel rtpg_create rtpg_gdal rtpg_statistics".split(" ")]
POSTGIS_TOPOLOGY_SOURCES = ["topology/postgis_topology.c"]

def postgis_standalone(name, profile = "desktop"):
    if profile != "desktop":
        _mobile_standalone(name, profile)
        return
    prefix = "@postgis//:"
    flatgeobuf_sources = ["deps/flatgeobuf/" + source + ".cpp" for source in ["flatgeobuf_c", "geometrywriter", "geometryreader", "packedrtree"]]
    windows_srcs = [prefix + source for source in POSTGIS_LWGEOM_SOURCES + POSTGIS_PG_SOURCES + POSTGIS_RTCORE_SOURCES + POSTGIS_RASTER_SOURCES + POSTGIS_TOPOLOGY_SOURCES + flatgeobuf_sources]
    windows_hdrs = [prefix + "postgis_headers"]
    windows_companions = {"//src/extensions/external/postgis:tools/windows/postgis-compat.h": "oliphaunt_postgis_windows_compat.h", "//src/extensions/external/postgis:tools/windows/flatgeobuf-compat.h": "oliphaunt_flatgeobuf_windows_compat.h"}
    windows_extension_sources(
        name = name + "_windows_sources", sql_name = "postgis",
        srcs = windows_srcs, hdrs = windows_hdrs, anchor = prefix + "Version.config", anchor_name = "Version.config",
        companions = windows_companions,
        include_dirs = ["liblwgeom", "libpgcommon", "postgis", "raster", "raster/rt_core", "raster/rt_pg", "topology", "deps", "deps/flatgeobuf", "deps/flatgeobuf/include", ""],
        source_groups = ["liblwgeom", "postgis", "libpgcommon", "deps/flatgeobuf", "raster/rt_core", "raster/rt_pg", "topology"], target_compatible_with = NATIVE_WINDOWS_COMPATIBLE,
    )
    postgis_windows_sources_test(name = name + "_windows_sources_test", prepared = ":" + name + "_windows_sources",
                                srcs = windows_srcs, hdrs = windows_hdrs, anchor = prefix + "Version.config", anchor_name = "Version.config", companions = windows_companions)
    for group in ["liblwgeom", "postgis", "libpgcommon", "flatgeobuf", "rt_core", "rt_pg", "topology"]:
        native.filegroup(name = name + "_windows_" + group, srcs = [":" + name + "_windows_sources"], output_group = group + "_sources")
    native.filegroup(name = name + "_windows_pg_sources", srcs = [":" + name + "_windows_postgis", ":" + name + "_windows_libpgcommon"])
    postgis_configuration(name = name + "_config")
    postgis_source_headers(name = name + "_headers", root = prefix + "Version.config",
                           headers = [prefix + "postgis_headers"],
                           include_dirs = ["liblwgeom", "libpgcommon", "postgis", "raster", "raster/rt_core", "raster/rt_pg", "topology", "deps", "deps/flatgeobuf", "deps/flatgeobuf/include", ""])
    contrib_generated_sources(name = name + "_wkt", grammar = prefix + "liblwgeom/lwin_wkt_parse.y",
                               scanner = prefix + "liblwgeom/lwin_wkt_lex.l",
                               grammar_options = ["-d", "-p", "wkt_yy"], scanner_options = ["-i"], scanner_rule = postgis_flex)
    cc_library(name = name + "_ryu", srcs = [prefix + "deps/ryu/d2s.c"],
               deps = [":" + name + "_headers"], defines = ["RYU_NO_TRAILING_ZEROS"], copts = POSTGIS_NATIVE_COPTS,
               target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_rtcore",
               srcs = select({"//build_defs/native:windows_x64": [":" + name + "_windows_rt_core"], "//conditions:default": [prefix + source for source in POSTGIS_RTCORE_SOURCES]}),
               deps = [":" + name + "_config", ":" + name + "_lwgeom", "//build_defs/extensions/postgis:gdal"] + select({"//build_defs/native:windows_x64": [":" + name + "_windows_sources"], "//conditions:default": [":" + name + "_headers"]}),
               copts = POSTGIS_NATIVE_COPTS + select({"//build_defs/native:windows_x64": ["/FI$(location //src/extensions/external/postgis:tools/windows/postgis-compat.h)"], "//conditions:default": []}),
               additional_compiler_inputs = select({"//build_defs/native:windows_x64": ["//src/extensions/external/postgis:tools/windows/postgis-compat.h"], "//conditions:default": []}), target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_lwgeom",
               srcs = select({"//build_defs/native:windows_x64": [":" + name + "_windows_liblwgeom"], "//conditions:default": [prefix + source for source in POSTGIS_LWGEOM_SOURCES]}) + [":" + name + "_wkt"],
               deps = [":" + name + "_config"] + select({"//build_defs/native:windows_x64": [":" + name + "_windows_sources"], "//conditions:default": [":" + name + "_headers"]}) + [":" + name + "_wkt", ":" + name + "_ryu",
                       "//build_defs/extensions/postgis:geos", "//build_defs/extensions/postgis:proj", "//build_defs/extensions/postgis:json_c"],
               copts = POSTGIS_NATIVE_COPTS + select({"//build_defs/native:windows_x64": ["/FI$(location //src/extensions/external/postgis:tools/windows/postgis-compat.h)"], "//conditions:default": []}),
               local_defines = select({"//build_defs/native:windows_x64": ["YY_NO_UNISTD_H"], "//conditions:default": []}),
               additional_compiler_inputs = select({"//build_defs/native:windows_x64": ["//src/extensions/external/postgis:tools/windows/postgis-compat.h"], "//conditions:default": []}),
               linkopts = POSTGIS_MATH_LINKOPTS, target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_flatgeobuf",
               srcs = select({"//build_defs/native:windows_x64": [":" + name + "_windows_flatgeobuf"], "//conditions:default": [prefix + source for source in flatgeobuf_sources]}),
               deps = [":" + name + "_config"] + select({"//build_defs/native:windows_x64": [":" + name + "_windows_sources"], "//conditions:default": [":" + name + "_headers"]}) + ["//build_defs/extensions/postgis:proj"],
               copts = POSTGIS_NATIVE_CXX_COPTS + select({"//build_defs/native:windows_x64": ["/FI$(location //src/extensions/external/postgis:tools/windows/flatgeobuf-compat.h)"], "//conditions:default": []}),
               additional_compiler_inputs = select({"//build_defs/native:windows_x64": ["//src/extensions/external/postgis:tools/windows/flatgeobuf-compat.h"], "//conditions:default": []}),
               defines = ["flatbuffers=postgis_flatbuffers"],
               target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)

_DEPENDENCY_ARTIFACTS = EXTENSION_RECIPES["postgis"]["artifacts"]
_DEPENDENCY_MODULES = {condition: extension_native_dependency_modules(_DEPENDENCY_ARTIFACTS.get("native_dependency_modules", []), configuration, _DEPENDENCY_ARTIFACTS.get("native_dependency_modules_by_target", {})) for condition, configuration in NATIVE_EXTENSION_PROFILES.items()}

def _gdal_resources_impl(ctx):
    names = [path.split("/")[-1] for path in _DEPENDENCY_ARTIFACTS["data_files"] if path.startswith("share/postgresql/gdal/")]
    files = [file for file in ctx.files.inputs if file.basename in names]
    if sorted([file.basename for file in files]) != sorted(names):
        fail("GDAL resources differ from the canonical PostGIS runtime file inventory")
    return [DefaultInfo(files = depset(files))]

postgis_gdal_resources = rule(implementation = _gdal_resources_impl, attrs = {"inputs": attr.label_list(default = ["@postgis_gdal//:data"], allow_files = True)})

def postgis_dependency_module_labels(label):
    """Use the dependency DLL only in profiles whose recipe carries one."""
    return select({condition: [label] if any([module.startswith("liboliphaunt_postgis_deps.") for module in modules]) else [] for condition, modules in _DEPENDENCY_MODULES.items()} | {"//conditions:default": []})

def postgis_dependency_module(name):
    # A maintained direct shared-library rule whole-archives the six real roots;
    # module consumers use dynamic_deps to prevent a second static dependency copy.
    cc_shared_library(name = name, shared_lib_name = select({"//build_defs/native:windows_x64": "liboliphaunt_postgis_deps.dll", "//build_defs/native:macos_arm64": "liboliphaunt_postgis_deps.dylib", "//conditions:default": "liboliphaunt_postgis_deps.so"}),
                      deps = ["//build_defs/extensions/postgis:" + library for library in ["gdal", "geos", "proj", "json_c", "libxml2", "iconv", "sqlite"]],
                      features = select({"//build_defs/native:windows_x64": ["windows_export_all_symbols"], "//conditions:default": []}),
                      user_link_flags = select({"//build_defs/native:windows_x64": [], "//build_defs/native:macos_arm64": ["-Wl,-install_name,@rpath/liboliphaunt_postgis_deps.dylib"], "//conditions:default": ["-Wl,-z,defs"]}) + NATIVE_RELEASE_LINKOPTS, target_compatible_with = select({condition: [] if any([module.startswith("liboliphaunt_postgis_deps.") for module in modules]) else ["@platforms//:incompatible"] for condition, modules in _DEPENDENCY_MODULES.items()} | {"//conditions:default": ["@platforms//:incompatible"]}))

def native_postgis_modules(name, standalone, dependency_module):
    prefix = "@postgis//:"
    compatibility_inputs = select({"//build_defs/native:windows_x64": ["//src/extensions/external/postgis:tools/windows/postgis-compat.h"], "//conditions:default": []})
    native_extension_modules(name = name,
                             srcs = select({"//build_defs/native:windows_x64": [standalone + "_windows_pg_sources"], "//conditions:default": [prefix + source for source in POSTGIS_PG_SOURCES]}),
                             deps = [standalone + "_config"] + select({"//build_defs/native:windows_x64": [standalone + "_windows_sources"], "//conditions:default": [standalone + "_headers"]}) + [standalone + "_lwgeom", standalone + "_flatgeobuf", "//build_defs/extensions/postgis:libxml2"],
                             copts = select({"//build_defs/native:windows_x64": ["/D_USE_MATH_DEFINES", "/FI$(location //src/extensions/external/postgis:tools/windows/postgis-compat.h)"], "//conditions:default": []}),
                             hdrs = compatibility_inputs,
                             additional_compiler_inputs = compatibility_inputs,
                             dynamic_deps = postgis_dependency_module_labels(dependency_module), linkopts = select({"//build_defs/native:windows_x64": [], "//build_defs/native:macos_arm64": ["-Wl,-rpath,@loader_path"], "//conditions:default": ["-Wl,-rpath,$$ORIGIN"]}))
    for member, sources, group, extra in [
        ("postgis_raster", POSTGIS_RASTER_SOURCES, "rt_pg", [standalone + "_rtcore", "//build_defs/extensions/postgis:gdal"]),
        ("postgis_topology", POSTGIS_TOPOLOGY_SOURCES, "topology", []),
    ]:
        native_extension_modules(name = member,
                                 srcs = select({"//build_defs/native:windows_x64": [standalone + "_windows_" + group, standalone + "_windows_libpgcommon"], "//conditions:default": [prefix + source for source in sources + POSTGIS_PGCOMMON_SOURCES]}),
                                 deps = [standalone + "_config", standalone + "_lwgeom"] + extra + select({"//build_defs/native:windows_x64": [standalone + "_windows_sources"], "//conditions:default": [standalone + "_headers"]}),
                                 copts = select({"//build_defs/native:windows_x64": ["/D_USE_MATH_DEFINES", "/FI$(location //src/extensions/external/postgis:tools/windows/postgis-compat.h)"], "//conditions:default": []}),
                                 hdrs = compatibility_inputs, additional_compiler_inputs = compatibility_inputs,
                                 dynamic_deps = postgis_dependency_module_labels(dependency_module),
                                 linkopts = select({"//build_defs/native:windows_x64": [], "//build_defs/native:macos_arm64": ["-Wl,-rpath,@loader_path"], "//conditions:default": ["-Wl,-rpath,$$ORIGIN"]}))
        for variant in ["server", "embedded"]:
            _companion_module(name = member + "_" + variant + "_file", module = ":" + member + "_" + variant + "_module", stem = member + "-3",
                              suffix = select({"//build_defs/native:windows_x64": ".dll", "//build_defs/native:macos_arm64": ".dylib", "//conditions:default": ".so"}), target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)

def _companion_module_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.stem + ctx.attr.suffix)
    ctx.actions.symlink(output = output, target_file = ctx.file.module)
    return [DefaultInfo(files = depset([output]))]

_companion_module = rule(implementation = _companion_module_impl, attrs = {"module": attr.label(allow_single_file = True), "stem": attr.string(), "suffix": attr.string()})

def _mobile_standalone(name, profile):
    settings = postgis_profile(profile)
    prefix = "@postgis//:"
    dependencies = "//build_defs/extensions/postgis/mobile:"
    postgis_configuration(name = name + "_config", profile = profile)
    postgis_source_headers(name = name + "_headers", root = prefix + "Version.config",
                           headers = [prefix + "postgis_headers"],
                           include_dirs = ["liblwgeom", "libpgcommon", "postgis", "raster", "raster/rt_core", "raster/rt_pg", "topology", "deps", "deps/flatgeobuf", "deps/flatgeobuf/include", ""])
    contrib_generated_sources(name = name + "_wkt", grammar = prefix + "liblwgeom/lwin_wkt_parse.y",
                               scanner = prefix + "liblwgeom/lwin_wkt_lex.l",
                               grammar_options = ["-d", "-p", "wkt_yy"], scanner_options = ["-i"], scanner_rule = postgis_flex)
    cc_library(name = name + "_ryu", srcs = [prefix + "deps/ryu/d2s.c"], deps = [":" + name + "_headers"],
               defines = ["RYU_NO_TRAILING_ZEROS"], copts = settings.c, target_compatible_with = settings.compatible)
    cc_library(name = name + "_lwgeom", srcs = [prefix + source for source in POSTGIS_LWGEOM_SOURCES] + [":" + name + "_wkt"],
               deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_wkt", ":" + name + "_ryu"] +
                      [dependencies + component for component in ["geos_c_objects", "proj_objects", "json_c_objects"]],
               copts = settings.c, linkopts = POSTGIS_MATH_LINKOPTS, target_compatible_with = settings.compatible)
    cc_library(name = name + "_flatgeobuf",
               srcs = [prefix + "deps/flatgeobuf/" + source + ".cpp" for source in ["flatgeobuf_c", "geometrywriter", "geometryreader", "packedrtree"]],
               deps = [":" + name + "_config", ":" + name + "_headers", dependencies + "proj_objects"],
               copts = settings.cxx, defines = ["flatbuffers=postgis_flatbuffers"], target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_rtcore", srcs = [prefix + source for source in POSTGIS_RTCORE_SOURCES],
               deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_lwgeom", dependencies + "gdal_objects"],
               copts = settings.c, target_compatible_with = settings.compatible)
