"""Pinned PostGIS standalone libraries and independently compiled PG ABI modules."""

load("@rules_cc//cc:defs.bzl", "cc_library", "cc_shared_library")
load("//build_defs/extensions:contrib.bzl", "contrib_generated_sources")
load("//build_defs/extensions:extensions.bzl", "native_extension_modules")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE")
load("//build_defs/native:platform_config.bzl", "NATIVE_RELEASE_LINKOPTS")
load(":libraries.bzl", "postgis_configuration", "postgis_source_headers")
load(":generators.bzl", "postgis_flex")

# liblwgeom/Makefile.in SA_OBJS and NM_OBJS, with optional SFCGAL disabled.
_LWGEOM = "stringbuffer optionlist stringlist bytebuffer measures measures3d ptarray lookup3 lwgeom_api lwgeom lwpoint lwline lwpoly lwtriangle lwmpoint lwmline lwmpoly lwboundingcircle lwcollection lwcircstring lwcompound lwcurvepoly lwmcurve lwmsurface lwpsurface lwtin lwout_wkb lwin_geojson lwin_wkb lwin_twkb lwiterator lwgeom_median lwout_wkt lwout_twkb lwin_wkt lwin_encoded_polyline lwutil lwhomogenize intervaltree lwalgorithm lwstroke lwlinearreferencing lwprint gbox gserialized gserialized1 gserialized2 lwgeodetic lwgeodetic_measures lwgeodetic_tree lwrandom lwtree lwout_gml lwout_kml lwout_geojson lwout_svg lwout_x3d lwout_encoded_polyline lwgeom_debug lwgeom_geos lwgeom_geos_clean lwgeom_geos_cluster lwgeom_geos_node lwgeom_geos_split topo/lwgeom_topo topo/lwgeom_topo_polygonizer topo/lwt_edgeend topo/lwt_edgeend_star topo/lwt_node_edges lwgeom_transform lwgeom_wrapx lwunionfind effectivearea lwchaikins lwmval lwkmeans varint lwgeom_remove_irrelevant_points_for_view lwspheroid".split(" ")

# postgis/Makefile.in PG_OBJS + the PostgreSQL 18 SPGIST_OBJ recipe.
# Protobuf/SFCGAL optional profiles are disabled in the generated configuration.
_PG = "postgis_module lwgeom_accum lwgeom_union lwgeom_spheroid lwgeom_ogc lwgeom_functions_analytic lwgeom_functions_basic lwgeom_inout lwgeom_btree lwgeom_box lwgeom_box3d lwgeom_geos lwgeom_geos_predicates lwgeom_geos_prepared lwgeom_geos_clean lwgeom_geos_relatematch lwgeom_generate_grid lwgeom_export lwgeom_in_gml lwgeom_in_kml lwgeom_in_marc21 lwgeom_out_marc21 lwgeom_in_geohash lwgeom_in_geojson lwgeom_in_encoded_polyline lwgeom_triggers lwgeom_dump lwgeom_dumppoints lwgeom_functions_lrs lwgeom_functions_temporal lwgeom_rectree lwgeom_itree lwgeom_sqlmm lwgeom_transform lwgeom_window gserialized_typmod gserialized_gist_2d gserialized_gist_nd gserialized_supportfn gserialized_spgist_2d gserialized_spgist_3d gserialized_spgist_nd brin_2d brin_nd brin_common gserialized_estimate geography_inout geography_btree geography_centroid geography_measurement geography_measurement_trees geometry_inout postgis_libprotobuf mvt lwgeom_out_mvt geobuf lwgeom_out_geobuf lwgeom_out_geojson flatgeobuf lwgeom_in_flatgeobuf lwgeom_out_flatgeobuf lwgeom_remove_irrelevant_points_for_view lwgeom_remove_small_parts postgis_legacy".split(" ")
_PGCOMMON = "gserialized_gist lwgeom_transform lwgeom_cache lwgeom_pg shared_gserialized".split(" ")

POSTGIS_LWGEOM_SOURCES = ["liblwgeom/" + source + ".c" for source in _LWGEOM]
POSTGIS_PG_SOURCES = ["postgis/" + source + ".c" for source in _PG] + ["libpgcommon/" + source + ".c" for source in _PGCOMMON]

def postgis_standalone(name):
    prefix = "@postgis//:"
    postgis_configuration(name = name + "_config")
    postgis_source_headers(name = name + "_headers", root = prefix + "Version.config",
                           headers = [prefix + "postgis_headers"],
                           include_dirs = ["liblwgeom", "libpgcommon", "postgis", "deps", "deps/flatgeobuf", "deps/flatgeobuf/include", ""])
    contrib_generated_sources(name = name + "_wkt", grammar = prefix + "liblwgeom/lwin_wkt_parse.y",
                               scanner = prefix + "liblwgeom/lwin_wkt_lex.l",
                               grammar_options = ["-d", "-p", "wkt_yy"], scanner_options = ["-i"], scanner_rule = postgis_flex)
    cc_library(name = name + "_ryu", srcs = [prefix + "deps/ryu/d2s.c"],
               deps = [":" + name + "_headers"], defines = ["RYU_NO_TRAILING_ZEROS"],
               target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_lwgeom",
               srcs = [prefix + source for source in POSTGIS_LWGEOM_SOURCES] + [":" + name + "_wkt"],
               deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_wkt", ":" + name + "_ryu",
                       "//build_defs/extensions/postgis:geos", "//build_defs/extensions/postgis:proj", "//build_defs/extensions/postgis:json_c"],
               linkopts = ["-lm"], target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_flatgeobuf",
               srcs = [prefix + "deps/flatgeobuf/" + source + ".cpp" for source in ["flatgeobuf_c", "geometrywriter", "geometryreader", "packedrtree"]],
               deps = [":" + name + "_config", ":" + name + "_headers", "//build_defs/extensions/postgis:proj"],
               copts = ["-std=c++17"], defines = ["flatbuffers=postgis_flatbuffers"],
               target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)

def postgis_dependency_module(name):
    # A maintained direct shared-library rule whole-archives the six real roots;
    # module consumers use dynamic_deps to prevent a second static dependency copy.
    cc_shared_library(name = name, shared_lib_name = "liboliphaunt_postgis_deps.so",
                      deps = ["//build_defs/extensions/postgis:" + library for library in ["geos", "proj", "json_c", "libxml2", "iconv", "sqlite"]],
                      user_link_flags = ["-Wl,-z,defs"] + NATIVE_RELEASE_LINKOPTS, target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)

def native_postgis_modules(name, standalone, dependency_module):
    prefix = "@postgis//:"
    native_extension_modules(name = name,
                             srcs = [prefix + source for source in POSTGIS_PG_SOURCES],
                             deps = [standalone + "_config", standalone + "_headers", standalone + "_lwgeom", standalone + "_flatgeobuf",
                                     "//build_defs/extensions/postgis:libxml2"],
                             dynamic_deps = [dependency_module], linkopts = ["-Wl,-rpath,$$ORIGIN"])
