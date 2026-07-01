use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

use oliphaunt::{
    Extension, ExtensionArtifactPolicy, ExtensionModuleAsset, ExtensionRedistribution,
    ExtensionSmokeCoverage, ExtensionSmokePlan, ExtensionSourceKind, ExtensionSqlAsset,
    MobileStaticLinkStatus, NATIVE_EXTENSION_MANIFEST, Oliphaunt,
    required_shared_preload_libraries, resolve_extension_selection,
};

fn generated_wasm_extension_catalog() -> serde_json::Value {
    let catalog_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/generated/extensions.catalog.json");
    let catalog_text = std::fs::read_to_string(&catalog_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", catalog_path.display()));
    serde_json::from_str(&catalog_text)
        .unwrap_or_else(|error| panic!("parse {}: {error}", catalog_path.display()))
}

fn generated_rust_sdk_extension_metadata() -> serde_json::Value {
    let catalog_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extensions/generated/sdk/rust.json");
    let catalog_text = std::fs::read_to_string(&catalog_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", catalog_path.display()));
    serde_json::from_str(&catalog_text)
        .unwrap_or_else(|error| panic!("parse {}: {error}", catalog_path.display()))
}

#[test]
fn extension_metadata_distinguishes_sql_only_modules_and_dependencies() {
    assert_eq!(Extension::Pgtap.native_module_file(), None);
    assert_eq!(Extension::Pgtap.native_module_stem(), None);
    assert_eq!(Extension::Hstore.native_module_stem(), Some("hstore"));
    assert_eq!(
        Extension::PgHashids.native_module_stem(),
        Some("pg_hashids")
    );
    assert_eq!(Extension::Pgcrypto.native_module_stem(), Some("pgcrypto"));
    assert_eq!(Extension::Postgis.native_module_stem(), Some("postgis-3"));
    assert_eq!(Extension::UuidOssp.native_module_stem(), Some("uuid-ossp"));
    let postgis_data_files = NATIVE_EXTENSION_MANIFEST
        .iter()
        .find(|entry| entry.extension == Extension::Postgis)
        .expect("PostGIS must have a native extension manifest row")
        .data_files;
    assert!(postgis_data_files.contains(&"contrib/postgis-3.6/postgis.sql"));
    assert!(postgis_data_files.contains(&"contrib/postgis-3.6/spatial_ref_sys.sql"));
    assert!(postgis_data_files.contains(&"proj/proj.db"));
    assert_eq!(Extension::Graph.native_module_stem(), Some("graph"));
    assert_eq!(Extension::PgSearch.native_module_stem(), Some("pg_search"));
    assert_eq!(Extension::Earthdistance.dependencies(), &[Extension::Cube]);
    assert!(Extension::ALL_PG18_SUPPORTED.contains(&Extension::Pgtap));
    assert!(Extension::EXTERNAL_PG18_SUPPORTED.contains(&Extension::Graph));
    assert!(Extension::EXTERNAL_PG18_SUPPORTED.contains(&Extension::PgSearch));
    assert!(!Extension::Graph.first_party_artifact());
    assert!(!Extension::PgSearch.first_party_artifact());
    assert!(matches!(
        Extension::Graph.artifact_policy(),
        ExtensionArtifactPolicy::External {
            source_kind: ExtensionSourceKind::Pgrx,
            redistribution: ExtensionRedistribution::Allowed,
            requires_shared_preload: false,
            ..
        }
    ));
    assert!(matches!(
        Extension::PgSearch.artifact_policy(),
        ExtensionArtifactPolicy::External {
            source_kind: ExtensionSourceKind::Pgrx,
            redistribution: ExtensionRedistribution::RequiresCommercialLicense,
            requires_shared_preload: true,
            ..
        }
    ));
    assert_eq!(
        Extension::PgSearch.required_shared_preload_library(),
        Some("pg_search")
    );
    assert_eq!(Extension::Graph.required_shared_preload_library(), None);
    assert_eq!(
        required_shared_preload_libraries(&[Extension::PgSearch, Extension::PgSearch]),
        vec!["pg_search"]
    );
}

#[test]
fn native_extension_manifest_covers_every_supported_pg18_extension() {
    let manifest_extensions = NATIVE_EXTENSION_MANIFEST
        .iter()
        .map(|entry| entry.extension)
        .collect::<Vec<_>>();
    assert_eq!(manifest_extensions, Extension::ALL_PG18_SUPPORTED);

    for entry in NATIVE_EXTENSION_MANIFEST {
        assert_eq!(entry.pg_major, 18);
        assert!(entry.pg18_supported);
        assert_eq!(entry.sql_name, entry.extension.sql_name());
        assert_eq!(entry.creates_extension, entry.extension.creates_extension());
        assert_eq!(entry.dependencies, entry.extension.dependencies());
        assert_eq!(
            entry.module_file_name(),
            entry.extension.native_module_file()
        );
        assert_eq!(
            Extension::by_sql_name(entry.sql_name),
            Some(entry.extension)
        );
        assert_eq!(
            entry.coverage.direct_c_abi,
            ExtensionSmokeCoverage::InstallLoadRestartBackupRestore
        );
        assert_eq!(
            entry.coverage.broker,
            ExtensionSmokeCoverage::InstallLoadRestartBackupRestore
        );
        assert_eq!(
            entry.coverage.server,
            ExtensionSmokeCoverage::InstallLoadRestartBackupRestore
        );
        assert_eq!(
            entry.first_party_artifact(),
            entry.extension.first_party_artifact()
        );
        match entry.extension.native_module_stem() {
            Some(stem) => {
                assert_eq!(entry.module, ExtensionModuleAsset::NativeModule { stem });
                assert_eq!(
                    entry.mobile_static_link,
                    MobileStaticLinkStatus::PendingRegistry
                );
            }
            None => {
                assert_eq!(entry.module, ExtensionModuleAsset::SqlOnly);
                assert_eq!(
                    entry.mobile_static_link,
                    MobileStaticLinkStatus::NotRequiredSqlOnly
                );
            }
        }
        if entry.creates_extension {
            assert_eq!(entry.sql_assets, ExtensionSqlAsset::ControlAndSql);
            assert_eq!(entry.smoke, ExtensionSmokePlan::CreateExtensionCascade);
            let sql_name = if entry.sql_name == "uuid-ossp" {
                "\"uuid-ossp\""
            } else {
                entry.sql_name
            };
            assert_eq!(
                entry.smoke_sql(),
                format!("CREATE EXTENSION {sql_name} CASCADE")
            );
        } else {
            assert_eq!(entry.sql_assets, ExtensionSqlAsset::LoadableModuleOnly);
            assert_eq!(entry.smoke, ExtensionSmokePlan::LoadSharedLibrary);
            assert_eq!(entry.smoke_sql(), format!("LOAD '{}'", entry.sql_name));
        }
    }
}

#[test]
fn native_release_ready_manifest_matches_generated_rust_metadata() {
    let metadata = generated_rust_sdk_extension_metadata();
    let generated_rows = metadata["extensions"]
        .as_array()
        .expect("generated Rust SDK extension metadata must define extensions");
    assert_eq!(metadata["consumer"].as_str(), Some("rust"));

    let release_ready_sql_names = Extension::RELEASE_READY_PG18_SUPPORTED
        .iter()
        .map(|extension| extension.sql_name().to_owned())
        .collect::<BTreeSet<_>>();
    let generated_release_ready_sql_names = generated_rows
        .iter()
        .filter(|row| row["desktop-release-ready"].as_bool() == Some(true))
        .map(|row| {
            row["sql-name"]
                .as_str()
                .expect("generated Rust SDK extension rows must define sql-name")
                .to_owned()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        generated_release_ready_sql_names, release_ready_sql_names,
        "Rust SDK release-ready extension set must come from generated metadata"
    );

    for row in generated_rows {
        let sql_name = row["sql-name"]
            .as_str()
            .expect("generated Rust SDK extension rows must define sql-name");
        let extension = Extension::by_sql_name(sql_name)
            .unwrap_or_else(|| panic!("generated Rust SDK metadata contains unknown {sql_name}"));
        assert_eq!(row["postgres-major"].as_u64(), Some(18));
        assert_eq!(
            row["creates-extension"].as_bool(),
            Some(extension.creates_extension())
        );
        assert_eq!(
            row["native-module-stem"].as_str(),
            extension.native_module_stem()
        );
        assert_eq!(
            row["mobile-release-ready"].as_bool(),
            Some(extension.mobile_release_ready())
        );
        assert_eq!(
            row["desktop-release-ready"].as_bool(),
            Some(extension.desktop_release_ready())
        );
        assert_eq!(
            Extension::by_release_ready_sql_name(sql_name),
            extension.desktop_release_ready().then_some(extension)
        );
        assert!(
            row["target-status"].is_object(),
            "generated Rust SDK metadata must include target-status for {sql_name}"
        );
        assert!(
            row["support"].is_object(),
            "generated Rust SDK metadata must include support for {sql_name}"
        );
        let dependencies = extension
            .dependencies()
            .iter()
            .map(|dependency| dependency.sql_name())
            .collect::<Vec<_>>();
        assert_eq!(
            row["selected-extension-dependencies"]
                .as_array()
                .expect(
                    "generated Rust SDK extension rows must define selected-extension-dependencies"
                )
                .iter()
                .map(|value| value.as_str().expect("dependency names must be strings"))
                .collect::<Vec<_>>(),
            dependencies
        );
        assert_eq!(
            row["runtime-share-data-files"]
                .as_array()
                .expect("generated Rust SDK extension rows must define runtime-share-data-files")
                .iter()
                .map(|value| value.as_str().expect("data file paths must be strings"))
                .collect::<Vec<_>>(),
            NATIVE_EXTENSION_MANIFEST
                .iter()
                .find(|entry| entry.extension == extension)
                .expect("native manifest must include generated extension")
                .data_files
                .to_vec()
        );
    }
}

#[test]
fn native_extension_manifest_matches_build_required_artifacts() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh");
    let output = Command::new(&script)
        .arg("--print-required-extension-artifacts")
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run native extension artifact inventory {}: {error}",
                script.display()
            )
        });
    assert!(
        output.status.success(),
        "native extension artifact inventory failed with status {} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let mut actual_controls = BTreeSet::new();
    let mut actual_modules = BTreeSet::new();
    for line in String::from_utf8(output.stdout).unwrap().lines() {
        let Some((kind, name)) = line.split_once(':') else {
            panic!("native extension artifact inventory line must use <kind>:<name>: {line}");
        };
        match kind {
            "control" => {
                actual_controls.insert(name.to_owned());
            }
            "module" => {
                actual_modules.insert(name.to_owned());
            }
            _ => panic!("unknown native extension artifact kind '{kind}' in line {line}"),
        }
    }

    let expected_controls = NATIVE_EXTENSION_MANIFEST
        .iter()
        .filter(|entry| entry.first_party_artifact())
        .filter(|entry| entry.creates_extension)
        .map(|entry| entry.sql_name.to_owned())
        .collect::<BTreeSet<_>>();
    let expected_modules = NATIVE_EXTENSION_MANIFEST
        .iter()
        .filter(|entry| entry.first_party_artifact())
        .filter_map(|entry| match entry.module {
            ExtensionModuleAsset::NativeModule { stem } => Some(stem.to_owned()),
            ExtensionModuleAsset::SqlOnly => None,
        })
        .collect::<BTreeSet<_>>();

    assert_eq!(
        actual_controls, expected_controls,
        "build-required extension control files must match NATIVE_EXTENSION_MANIFEST"
    );
    assert_eq!(
        actual_modules, expected_modules,
        "build-required native extension modules must match NATIVE_EXTENSION_MANIFEST"
    );
}

#[test]
fn release_ready_extension_catalog_is_exact_and_excludes_external_candidates() {
    assert!(Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::Hstore));
    assert!(Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::PgHashids));
    assert!(Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::Pgcrypto));
    assert!(Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::UuidOssp));
    assert!(Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::Vector));
    assert!(Extension::FIRST_PARTY_PG18_SUPPORTED.contains(&Extension::Postgis));
    assert!(Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::Postgis));
    assert!(!Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::Graph));
    assert!(!Extension::RELEASE_READY_PG18_SUPPORTED.contains(&Extension::PgSearch));
    let expected_mobile_ready = BTreeSet::from([
        Extension::Amcheck,
        Extension::AutoExplain,
        Extension::Bloom,
        Extension::BtreeGin,
        Extension::BtreeGist,
        Extension::Citext,
        Extension::Cube,
        Extension::DictInt,
        Extension::DictXsyn,
        Extension::Earthdistance,
        Extension::FileFdw,
        Extension::Fuzzystrmatch,
        Extension::Hstore,
        Extension::Intarray,
        Extension::Isn,
        Extension::Lo,
        Extension::Ltree,
        Extension::Pageinspect,
        Extension::PgBuffercache,
        Extension::PgFreespacemap,
        Extension::PgHashids,
        Extension::PgIvm,
        Extension::Pgcrypto,
        Extension::PgSurgery,
        Extension::PgTrgm,
        Extension::PgUuidv7,
        Extension::PgVisibility,
        Extension::PgWalinspect,
        Extension::Pgtap,
        Extension::Postgis,
        Extension::PgTextsearch,
        Extension::Seg,
        Extension::Tablefunc,
        Extension::Tcn,
        Extension::TsmSystemRows,
        Extension::TsmSystemTime,
        Extension::Unaccent,
        Extension::UuidOssp,
        Extension::Vector,
    ]);
    let actual_mobile_ready = Extension::MOBILE_RELEASE_READY_PG18_SUPPORTED
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    assert_eq!(actual_mobile_ready, expected_mobile_ready);
    for extension in expected_mobile_ready {
        assert!(extension.mobile_release_ready());
    }
    for extension in [Extension::Graph, Extension::PgSearch] {
        assert!(!extension.mobile_release_ready());
    }
    assert!(Extension::Hstore.requires_mobile_static_registry());
    assert!(Extension::UuidOssp.requires_mobile_static_registry());
    assert!(!Extension::Pgtap.requires_mobile_static_registry());

    assert_eq!(
        Extension::by_release_ready_sql_name("vector"),
        Some(Extension::Vector)
    );
    assert_eq!(
        Extension::by_release_ready_sql_name("uuid-ossp"),
        Some(Extension::UuidOssp)
    );
    assert_eq!(
        Extension::by_release_ready_sql_name("pg_search"),
        None,
        "ParadeDB is tracked as an external candidate but must not enter release packages implicitly"
    );
    assert_eq!(
        Extension::by_release_ready_sql_name("postgis"),
        Some(Extension::Postgis)
    );
    let metadata = generated_rust_sdk_extension_metadata();
    let metadata_rows = metadata["extensions"].as_array().unwrap();
    let postgis_metadata = metadata_rows
        .iter()
        .find(|row| row["sql-name"] == "postgis")
        .expect("PostGIS metadata row must exist");
    assert_eq!(
        postgis_metadata["desktop-release-ready"].as_bool(),
        Some(true)
    );
    assert_eq!(
        postgis_metadata["mobile-release-ready"].as_bool(),
        Some(true)
    );
    assert_eq!(
        postgis_metadata["target-status"]["wasix"].as_str(),
        Some("supported")
    );
    assert_eq!(
        postgis_metadata["target-status"]["native"].as_str(),
        Some("supported")
    );
    assert_eq!(postgis_metadata["target-status"]["mobile"].as_str(), None);
    assert_eq!(
        postgis_metadata["support"]["mobile"]["android"].as_str(),
        Some("supported")
    );
    assert_eq!(
        postgis_metadata["support"]["mobile"]["ios"].as_str(),
        Some("supported")
    );
    for alias in [
        "core",
        "search",
        "geo",
        "vector-pack",
        "vector_pack",
        "vector+search",
    ] {
        assert_eq!(
            Extension::by_release_ready_sql_name(alias),
            None,
            "{alias} must not resolve as an extension selection alias or multi-extension selector"
        );
    }
}

#[test]
fn target_specific_release_readiness_can_diverge_from_wasix_support() {
    let catalog = generated_wasm_extension_catalog();
    let wasm_postgis = catalog["extensions"]
        .as_array()
        .expect("generated wasm extension catalog must have an extensions array")
        .iter()
        .find(|extension| extension["sql-name"].as_str() == Some("postgis"))
        .expect("generated wasm extension catalog must contain PostGIS");

    assert_eq!(wasm_postgis["promotion"]["stable"].as_bool(), Some(true));
    assert!(Extension::Postgis.first_party_artifact());
    assert!(Extension::Postgis.desktop_release_ready());
    assert!(Extension::Postgis.mobile_release_ready());
    assert_eq!(
        Extension::by_release_ready_sql_name("postgis"),
        Some(Extension::Postgis)
    );
}

#[test]
fn pg18_blocked_extensions_remain_out_of_release_ready_catalog() {
    let catalog = generated_wasm_extension_catalog();
    let extensions = catalog["extensions"]
        .as_array()
        .expect("generated wasm extension catalog must have an extensions array");

    let blocked_ids = extensions
        .iter()
        .filter(|extension| {
            !extension["promotion"]["stable"]
                .as_bool()
                .expect("generated wasm extension catalog rows must have promotion.stable")
        })
        .map(|extension| {
            extension["id"]
                .as_str()
                .expect("generated wasm extension catalog rows must have an id")
                .to_owned()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        blocked_ids,
        BTreeSet::from(["age".to_owned()]),
        "every PG18.4 non-stable extension needs an explicit blocker before release-ready parity can move"
    );

    for (id, sql_name, requested, packaged, blocker) in
        [("age", "age", false, false, "ExecInitExtraTupleSlot")]
    {
        let extension = extensions
            .iter()
            .find(|extension| extension["id"].as_str() == Some(id))
            .unwrap_or_else(|| panic!("generated wasm extension catalog must contain {id}"));
        assert_eq!(extension["sql-name"].as_str(), Some(sql_name));
        assert_eq!(
            extension["promotion"]["requested"].as_bool(),
            Some(requested),
            "{id} build request state must match its current PG18.4 blocker status"
        );
        assert_eq!(
            extension["promotion"]["stable"].as_bool(),
            Some(false),
            "{id} must not be treated as PG18.4 release-ready until its blocker is resolved"
        );
        assert_eq!(
            extension["promotion"]["packaged"].as_bool(),
            Some(packaged),
            "{id} packaged state must match the generated WASIX artifact evidence"
        );
        assert!(
            extension["promotion"]["blocker"]
                .as_str()
                .unwrap_or_default()
                .contains(blocker),
            "{id} must record the concrete PG18.4 blocker"
        );
        assert_eq!(Extension::by_release_ready_sql_name(sql_name), None);
    }
}

#[test]
fn extension_catalog_cli_lists_release_ready_prebuilt_availability_without_native_env() {
    let Some(resources_bin) = option_env!("CARGO_BIN_EXE_oliphaunt-resources") else {
        eprintln!(
            "skipping extension catalog CLI smoke: cargo did not provide runtime-resource generator binary path"
        );
        return;
    };

    let output = Command::new(resources_bin)
        .arg("--list-extensions")
        .env_remove("LIBOLIPHAUNT_PATH")
        .env_remove("OLIPHAUNT_POSTGRES")
        .env_remove("OLIPHAUNT_INITDB")
        .env_remove("OLIPHAUNT_INSTALL_DIR")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "extension catalog CLI failed with status {} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with(
        "sql_name\tpg_major\tcreates_extension\tnative_module_stem\tdependencies\tshared_preload\tdesktop_prebuilt\tmobile_prebuilt\tmobile_static_registry_required\tmobile_static_archive_targets\tdata_files\tartifact\n"
    ));
    let catalog_lines = stdout.lines().skip(1).collect::<Vec<_>>();
    let catalog = catalog_lines
        .iter()
        .map(|line| {
            let columns = line.split('\t').collect::<Vec<_>>();
            assert_eq!(
                columns.len(),
                12,
                "catalog row must have 12 columns: {line}"
            );
            (columns[0], columns)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    for expected in Extension::RELEASE_READY_PG18_SUPPORTED {
        let row = catalog
            .get(expected.sql_name())
            .unwrap_or_else(|| panic!("catalog must advertise {}", expected.sql_name()));
        assert_eq!(row[1], "18");
        assert_eq!(
            row[2],
            if expected.creates_extension() {
                "yes"
            } else {
                "no"
            }
        );
        assert_eq!(row[3], expected.native_module_stem().unwrap_or("-"));
        assert_eq!(row[6], "yes");
        assert_eq!(
            row[7],
            if expected.mobile_release_ready() {
                "yes"
            } else {
                "no"
            }
        );
        assert_eq!(
            row[8],
            if expected.requires_mobile_static_registry() {
                "yes"
            } else {
                "no"
            }
        );
        assert_eq!(row[11], "first-party");
    }
    for extension in [Extension::DictXsyn, Extension::Postgis, Extension::Unaccent] {
        let row = catalog
            .get(extension.sql_name())
            .unwrap_or_else(|| panic!("catalog must advertise {}", extension.sql_name()));
        let expected = NATIVE_EXTENSION_MANIFEST
            .iter()
            .find(|entry| entry.extension == extension)
            .expect("native manifest must include extension")
            .data_files
            .join(",");
        assert!(
            row[10] == expected,
            "catalog data_files for {} must be {}, got {}",
            extension.sql_name(),
            expected,
            row[10],
        );
    }
    let postgis = catalog
        .get("postgis")
        .expect("catalog must advertise PostGIS first-party inventory");
    assert_eq!(postgis[6], "yes");
    assert_eq!(postgis[7], "yes");
    assert!(
        !stdout.contains("pg_search\t"),
        "ParadeDB must remain an internal external candidate until release gates and redistribution are resolved"
    );
}

#[test]
fn extension_selection_resolves_only_exact_extensions_and_required_dependencies() {
    let config = Oliphaunt::builder()
        .path("target/test-roots/native-direct")
        .extension(Extension::Earthdistance)
        .extension(Extension::Earthdistance)
        .build_config()
        .unwrap();

    assert_eq!(
        config.resolved_extensions().unwrap(),
        vec![Extension::Cube, Extension::Earthdistance]
    );
    assert_eq!(
        resolve_extension_selection(&[Extension::Vector, Extension::Vector]).unwrap(),
        vec![Extension::Vector]
    );
}
