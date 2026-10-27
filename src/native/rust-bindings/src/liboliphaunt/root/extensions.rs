use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use super::NativeRuntimeProfile;
use super::files::copy_file_preserving_permissions;
use crate::error::{Error, Result};
use crate::extension::{
    Extension, extension_data_files, extension_install_sql_file_belongs, extension_sql_file_belongs,
};

pub(super) fn selected_extension_names(extensions: &[Extension]) -> Vec<&'static str> {
    let mut names = extensions
        .iter()
        .map(|extension| extension.sql_name())
        .collect::<Vec<_>>();
    names.sort_unstable();
    names.dedup();
    names
}

pub(super) fn core_share_file(relative: &Path) -> bool {
    if relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == OsStr::new("extension"))
    {
        return false;
    }
    !Extension::ALL
        .iter()
        .flat_map(|extension| extension_data_files(*extension))
        .any(|file| relative == Path::new(file))
}

pub(super) fn packaged_extension_module_files() -> BTreeSet<String> {
    Extension::ALL
        .iter()
        .flat_map(|extension| {
            extension
                .native_module_files()
                .chain(extension.native_dependency_module_files())
        })
        .collect()
}

pub(super) struct ResolvedExtensionModules {
    pub(super) extension: Extension,
    pub(super) source_root: PathBuf,
    pub(super) files: Vec<String>,
    pub(super) embedded_fallback_file: Option<String>,
}

impl ResolvedExtensionModules {
    pub(super) fn sql_members(&self) -> impl Iterator<Item = &'static str> {
        self.extension
            .sql_members()
            .iter()
            .copied()
            .filter(|member| {
                *member == self.extension.sql_name()
                    || self.extension.package().is_none_or(|package| {
                        let prefix = format!(
                            "extension/{}/share/postgresql/extension/{member}",
                            package.product
                        );
                        package.resources.iter().any(|resource| {
                            resource.0 == format!("{prefix}.control")
                                || resource
                                    .0
                                    .strip_prefix(&format!("{prefix}--"))
                                    .is_some_and(|file| file.ends_with(".sql"))
                        })
                    })
            })
    }

    pub(super) fn data_files(&self) -> impl Iterator<Item = &'static str> {
        extension_data_files(self.extension)
            .iter()
            .copied()
            .filter(|relative| {
                self.extension.package().is_none_or(|package| {
                    let path = format!("extension/{}/share/postgresql/{relative}", package.product);
                    package.resources.iter().any(|resource| resource.0 == path)
                })
            })
    }

    pub(super) fn module_source(
        &self,
        profile: NativeRuntimeProfile,
        embedded_modules: Option<&Path>,
        module: &str,
    ) -> Result<PathBuf> {
        let directory = if profile.needs_embedded_modules() {
            "lib/modules"
        } else {
            "lib/postgresql"
        };
        let source = self.source_root.join(directory).join(module);
        if !profile.needs_embedded_modules()
            || source.is_file()
            || self.embedded_fallback_file.as_deref() != Some(module)
        {
            return Ok(source);
        }
        embedded_modules
            .map(|directory| directory.join(module))
            .ok_or_else(|| {
                Error::Engine(
                    "native liboliphaunt runtime requires embedded PostgreSQL extension modules"
                        .to_owned(),
                )
            })
    }
}

pub(super) fn resolve_extension_modules(
    profile: NativeRuntimeProfile,
    install_dir: &Path,
    extension_artifact_dirs: &[PathBuf],
    extensions: &[Extension],
) -> Result<Vec<ResolvedExtensionModules>> {
    #[derive(serde::Deserialize)]
    struct MemberDescriptor {
        schema: String,
        sql_name: String,
        dependency_modules: Vec<String>,
    }

    let module_profile = if profile.needs_embedded_modules() {
        "modules"
    } else {
        "postgresql"
    };

    extensions
        .iter()
        .map(|&extension| {
            let source_root = super::runtime::extension_artifact_root_for(
                install_dir,
                extension_artifact_dirs,
                extension,
            )
            .to_path_buf();
            let main_module = extension.native_module_file();
            let candidates: Vec<_> = extension.native_dependency_module_files().collect();
            let mut files: Vec<_> = extension.native_module_files().collect();
            let mut embedded_fallback_file = None;
            let dependencies = if let Some(package) = extension.package() {
                // The immutable resource index owns the selected package's shape;
                // older carriers may statically link what a new recipe splits out.
                let indexed = |module: &str| {
                    let relative = format!(
                        "extension/{}/lib/{module_profile}/{module}",
                        package.product
                    );
                    package
                        .resources
                        .iter()
                        .any(|resource| resource.0 == relative)
                };
                if profile.needs_embedded_modules()
                    && main_module.as_ref().is_some_and(|module| !indexed(module))
                {
                    embedded_fallback_file = main_module.clone();
                }
                files.retain(|module| Some(module) == main_module.as_ref() || indexed(module));
                candidates
                    .iter()
                    .filter(|module| indexed(module))
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                let descriptor_path = source_root.join("extension.json");
                match fs::read(&descriptor_path) {
                    Ok(bytes) => {
                        let descriptor: MemberDescriptor =
                            serde_json::from_slice(&bytes).map_err(|error| {
                                Error::Engine(format!(
                                    "read native extension descriptor {}: {error}",
                                    descriptor_path.display()
                                ))
                            })?;
                        if descriptor.schema != "oliphaunt-extension-member-payload-v1"
                            || descriptor.sql_name != extension.sql_name()
                            || descriptor.dependency_modules.iter().any(|module| {
                                !(candidates.contains(module)
                                    || files.contains(module)
                                        && Some(module) != main_module.as_ref())
                            })
                            || descriptor
                                .dependency_modules
                                .iter()
                                .collect::<BTreeSet<_>>()
                                .len()
                                != descriptor.dependency_modules.len()
                        {
                            return Err(Error::Engine(format!(
                                "invalid native extension module declaration in {}",
                                descriptor_path.display()
                            )));
                        }
                        descriptor
                            .dependency_modules
                            .into_iter()
                            .filter(|module| candidates.contains(module))
                            .collect()
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        // Undeclared legacy installs expose only present dependency
                        // sidecars. Actual loading still proves their runtime linkage.
                        if profile.needs_embedded_modules() {
                            embedded_fallback_file = main_module.clone();
                        }
                        candidates
                            .into_iter()
                            .filter(|module| {
                                source_root
                                    .join("lib")
                                    .join(module_profile)
                                    .join(module)
                                    .is_file()
                            })
                            .collect()
                    }
                    Err(error) => {
                        return Err(Error::Engine(format!(
                            "read native extension descriptor {}: {error}",
                            descriptor_path.display()
                        )));
                    }
                }
            };
            files.extend(dependencies);
            Ok(ResolvedExtensionModules {
                extension,
                source_root,
                files,
                embedded_fallback_file,
            })
        })
        .collect()
}

pub(super) fn embedded_core_module_files() -> BTreeSet<String> {
    ["dict_snowball", "plpgsql"]
        .map(|stem| format!("{stem}{}", std::env::consts::DLL_SUFFIX))
        .into_iter()
        .collect()
}

pub(super) fn copy_extension_sql_files(
    source_share: &Path,
    target_share: &Path,
    extension: Extension,
) -> Result<()> {
    copy_named_extension_sql_files(
        source_share,
        target_share,
        extension.sql_name(),
        extension.creates_extension(),
    )
}

pub(super) fn copy_named_extension_sql_files(
    source_share: &Path,
    target_share: &Path,
    sql_name: &str,
    require_control: bool,
) -> Result<()> {
    let source_dir = source_share.join("extension");
    let target_dir = target_share.join("extension");
    let mut copied_control = false;
    let mut copied_sql = false;
    let entries = match fs::read_dir(&source_dir) {
        Ok(entries) => entries,
        Err(err) if !require_control && err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(Error::Engine(format!(
                "read extension dir {}: {err}",
                source_dir.display()
            )));
        }
    };
    for entry in entries {
        let entry = entry.map_err(|err| {
            Error::Engine(format!("read entry in {}: {err}", source_dir.display()))
        })?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if extension_sql_file_belongs(sql_name, &file_name) {
            if extension_sql_file_is_control(sql_name, &file_name) {
                copied_control = true;
            } else if extension_install_sql_file_belongs(sql_name, &file_name) {
                copied_sql = true;
            }
            copy_file_preserving_permissions(&entry.path(), &target_dir.join(&file_name))?;
        }
    }
    if require_control {
        if !copied_control || !target_dir.join(format!("{sql_name}.control")).is_file() {
            return Err(Error::Engine(format!(
                "native extension '{sql_name}' is not available for PostgreSQL 18: missing control file in {}",
                source_dir.display()
            )));
        }
        if !copied_sql {
            return Err(Error::Engine(format!(
                "native extension '{sql_name}' is not available for PostgreSQL 18: missing SQL install file in {}",
                source_dir.display()
            )));
        }
    }
    Ok(())
}

pub(super) fn copy_embedded_module(
    embedded_modules: &Path,
    target_lib: &Path,
    module: &str,
) -> Result<()> {
    let source = embedded_modules.join(module);
    if !source.is_file() {
        return Err(Error::Engine(format!(
            "native embedded PostgreSQL 18 module is missing {}",
            source.display()
        )));
    }
    copy_file_preserving_permissions(&source, &target_lib.join(module))
}

pub(super) fn extension_sql_file_is_control(sql_name: &str, file_name: &str) -> bool {
    file_name == format!("{sql_name}.control")
}

pub(super) fn extension_sql_file_is_sql(file_name: &str) -> bool {
    file_name.ends_with(".sql")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn module_resolution_preserves_legacy_static_and_frozen_package_shapes() {
        let temp = TempTree::new("frozen-module-declarations");
        let root = temp.path().join("postgis");
        write_file(
            &root.join("share/postgresql/extension/postgis.control"),
            b"postgis",
        );
        let main = Extension::POSTGIS.native_module_file().unwrap();
        let dependency = Extension::POSTGIS
            .native_dependency_module_files()
            .next()
            .unwrap();
        let resolve = |profile, extension| {
            resolve_extension_modules(
                profile,
                temp.path(),
                std::slice::from_ref(&root),
                &[extension],
            )
            .unwrap()
            .remove(0)
            .files
        };

        assert_eq!(
            resolve(NativeRuntimeProfile::PostgresServer, Extension::POSTGIS),
            Extension::POSTGIS.native_module_files().collect::<Vec<_>>(),
            "statically linked installs still require every owned PostgreSQL module"
        );
        write_file(
            &root.join("lib/postgresql").join(&dependency),
            b"declared candidate",
        );
        assert_eq!(
            resolve(NativeRuntimeProfile::PostgresServer, Extension::POSTGIS),
            Extension::POSTGIS
                .native_module_files()
                .chain([dependency.clone()])
                .collect::<Vec<_>>()
        );

        static OLD_PACKAGE: crate::ExtensionPackage = crate::ExtensionPackage {
            product: "oliphaunt-extension-postgis",
            version: "3.6.3",
            runtime_version: "0.3.3",
            resources: &[
                (
                    "extension/oliphaunt-extension-postgis/lib/postgresql/postgis-3.so",
                    b"static",
                    "unused-in-resolver",
                    true,
                ),
                (
                    "extension/oliphaunt-extension-postgis/share/postgresql/proj/proj.db",
                    b"proj",
                    "unused-in-resolver",
                    false,
                ),
            ],
        };
        assert_eq!(
            resolve(
                NativeRuntimeProfile::PostgresServer,
                Extension::POSTGIS.with_package(&OLD_PACKAGE)
            ),
            vec![main.clone()],
            "an old immutable package must not inherit a new producer's module layout"
        );
        let frozen = resolve_extension_modules(
            NativeRuntimeProfile::PostgresServer,
            temp.path(),
            std::slice::from_ref(&root),
            &[Extension::POSTGIS.with_package(&OLD_PACKAGE)],
        )
        .unwrap();
        assert_eq!(frozen[0].sql_members().collect::<Vec<_>>(), ["postgis"]);
        assert_eq!(frozen[0].data_files().collect::<Vec<_>>(), ["proj/proj.db"]);

        let selected_path = Box::leak(
            format!("extension/oliphaunt-extension-postgis/lib/modules/{dependency}")
                .into_boxed_str(),
        );
        let foreign_path = Box::leak(
            format!("extension/other-product/lib/postgresql/{dependency}").into_boxed_str(),
        );
        let indexed_package = Box::leak(Box::new(crate::ExtensionPackage {
            product: OLD_PACKAGE.product,
            version: "3.6.4",
            runtime_version: OLD_PACKAGE.runtime_version,
            resources: Box::leak(
                vec![
                    (
                        selected_path as &str,
                        b"dynamic".as_slice(),
                        "unused-in-resolver",
                        true,
                    ),
                    (
                        foreign_path as &str,
                        b"foreign".as_slice(),
                        "unused-in-resolver",
                        true,
                    ),
                ]
                .into_boxed_slice(),
            ),
        }));
        assert_eq!(
            resolve(
                NativeRuntimeProfile::OliphauntEmbedded,
                Extension::POSTGIS.with_package(indexed_package)
            ),
            vec![main.clone(), dependency.clone()]
        );
        assert_eq!(
            resolve(
                NativeRuntimeProfile::PostgresServer,
                Extension::POSTGIS.with_package(indexed_package)
            ),
            vec![main.clone()],
            "a static server profile must not inherit an embedded dependency"
        );
        let server_path = Box::leak(
            format!("extension/oliphaunt-extension-postgis/lib/postgresql/{dependency}")
                .into_boxed_str(),
        );
        let server_package = Box::leak(Box::new(crate::ExtensionPackage {
            resources: Box::leak(
                vec![(
                    server_path as &str,
                    b"dynamic".as_slice(),
                    "unused-in-resolver",
                    true,
                )]
                .into_boxed_slice(),
            ),
            ..*indexed_package
        }));
        assert_eq!(
            resolve(
                NativeRuntimeProfile::PostgresServer,
                Extension::POSTGIS.with_package(server_package)
            ),
            vec![main.clone(), dependency.clone()]
        );
        assert_eq!(
            resolve(
                NativeRuntimeProfile::OliphauntEmbedded,
                Extension::POSTGIS.with_package(server_package)
            ),
            vec![main.clone()],
            "a static embedded profile must not inherit a server dependency"
        );
        fs::remove_file(root.join("lib/postgresql").join(&dependency)).unwrap();
        assert_eq!(
            resolve(
                NativeRuntimeProfile::OliphauntEmbedded,
                Extension::POSTGIS.with_package(indexed_package)
            ),
            vec![main, dependency],
            "a missing materialized file must not erase its frozen package requirement"
        );
    }

    #[test]
    fn current_member_declarations_bind_missing_modules_and_reject_other_members() {
        let temp = TempTree::new("current-module-declarations");
        let root = temp.path().join("postgis");
        write_file(
            &root.join("share/postgresql/extension/postgis.control"),
            b"postgis",
        );
        let dependency = Extension::POSTGIS
            .native_dependency_module_files()
            .next()
            .unwrap();
        let main = Extension::POSTGIS.native_module_file().unwrap();
        let declared_modules: Vec<_> = Extension::POSTGIS
            .native_module_files()
            .filter(|module| *module != main)
            .chain([dependency.clone()])
            .collect();
        let descriptor = serde_json::json!({
            "schema": "oliphaunt-extension-member-payload-v1", "sql_name": "postgis", "dependency_modules": &declared_modules,
        });
        write_file(
            &root.join("extension.json"),
            descriptor.to_string().as_bytes(),
        );
        let modules = resolve_extension_modules(
            NativeRuntimeProfile::PostgresServer,
            temp.path(),
            std::slice::from_ref(&root),
            &[Extension::POSTGIS],
        )
        .unwrap();
        assert_eq!(
            modules[0].files,
            Extension::POSTGIS
                .native_module_files()
                .chain([dependency.clone()])
                .collect::<Vec<_>>()
        );
        for (key, value) in [
            ("sql_name", serde_json::json!("hstore")),
            ("schema", serde_json::json!("unknown")),
            (
                "dependency_modules",
                serde_json::json!(["../undeclared.so"]),
            ),
            (
                "dependency_modules",
                serde_json::json!([Extension::HSTORE.native_module_file().unwrap()]),
            ),
            ("dependency_modules", serde_json::json!([&main])),
            (
                "dependency_modules",
                serde_json::json!([&dependency, &dependency]),
            ),
        ] {
            let mut changed = descriptor.clone();
            changed[key] = value;
            write_file(&root.join("extension.json"), changed.to_string().as_bytes());
            assert!(
                resolve_extension_modules(
                    NativeRuntimeProfile::PostgresServer,
                    temp.path(),
                    std::slice::from_ref(&root),
                    &[Extension::POSTGIS]
                )
                .is_err()
            );
        }
    }

    #[test]
    fn create_extension_assets_require_control_and_sql_files() {
        let temp = TempTree::new("extension-assets");
        let source_share = temp.path().join("source/share/postgresql");
        let target_share = temp.path().join("target/share/postgresql");

        write_file(
            &source_share.join("extension/hstore--1.0.sql"),
            b"select 'hstore install';\n",
        );
        let missing_control =
            copy_extension_sql_files(&source_share, &target_share, Extension::HSTORE).unwrap_err();
        assert!(
            missing_control.to_string().contains("missing control file"),
            "unexpected missing-control error: {missing_control}"
        );

        fs::remove_dir_all(&target_share).unwrap();
        fs::remove_file(source_share.join("extension/hstore--1.0.sql")).unwrap();
        write_file(
            &source_share.join("extension/hstore.control"),
            b"comment = 'hstore'\n",
        );
        let missing_sql =
            copy_extension_sql_files(&source_share, &target_share, Extension::HSTORE).unwrap_err();
        assert!(
            missing_sql.to_string().contains("missing SQL install file"),
            "unexpected missing-SQL error: {missing_sql}"
        );

        write_file(
            &source_share.join("extension/hstore--1.0.sql"),
            b"select 'hstore install';\n",
        );
        copy_extension_sql_files(&source_share, &target_share, Extension::HSTORE).unwrap();
        assert!(target_share.join("extension/hstore.control").is_file());
        assert!(target_share.join("extension/hstore--1.0.sql").is_file());
    }

    #[test]
    fn loadable_module_extension_does_not_require_create_extension_sql() {
        let temp = TempTree::new("loadable-module-extension-assets");
        let source_share = temp.path().join("source/share/postgresql");
        let target_share = temp.path().join("target/share/postgresql");

        copy_extension_sql_files(&source_share, &target_share, Extension::AUTO_EXPLAIN).unwrap();
        assert!(!source_share.join("extension").exists());
        assert!(!target_share.join("extension").exists());
    }

    #[test]
    fn extension_sql_file_belongs_uses_generated_extra_file_metadata() {
        let postgis = Extension::POSTGIS.sql_name();

        assert!(extension_sql_file_belongs(
            "pgtap",
            "pgtap--1.3.4--1.3.5.sql"
        ));
        assert!(extension_sql_file_belongs(
            postgis,
            "postgis--ANY--3.6.3.sql"
        ));
        assert!(extension_sql_file_belongs(
            postgis,
            "postgis--TEMPLATED--TO--ANY.sql"
        ));
        assert!(extension_sql_file_belongs("pgtap", "pgtap-core--1.3.5.sql"));
        assert!(extension_sql_file_belongs("pgtap", "pgtap-schema.sql"));
        assert!(extension_sql_file_belongs("pgtap", "uninstall_pgtap.sql"));
        assert!(extension_sql_file_belongs(postgis, "postgis_comments.sql"));
        assert!(extension_sql_file_belongs(
            postgis,
            "postgis_proc_set_search_path.sql"
        ));
        assert!(extension_sql_file_belongs(
            postgis,
            "postgis_raster.control"
        ));
        assert!(extension_sql_file_belongs(
            postgis,
            "postgis_raster--3.6.4.sql"
        ));
        assert!(extension_sql_file_belongs(postgis, "rtpostgis--3.6.sql"));

        assert!(!extension_sql_file_belongs("pgtap", "postgis_comments.sql"));
        assert!(!extension_sql_file_belongs(postgis, "pgtap-core.sql"));
    }

    #[test]
    fn extension_install_sql_file_belongs_excludes_ancillary_and_update_scripts() {
        assert!(!extension_install_sql_file_belongs("pgtap", "pgtap.sql"));
        assert!(extension_install_sql_file_belongs(
            "pgtap",
            "pgtap--1.3.5.sql"
        ));
        assert!(!extension_install_sql_file_belongs(
            "pgtap",
            "pgtap--1.3.4--1.3.5.sql"
        ));
        assert!(!extension_install_sql_file_belongs(
            "pgtap",
            "pgtap-core--1.3.5.sql"
        ));
        assert!(!extension_install_sql_file_belongs(
            "pgtap",
            "uninstall_pgtap.sql"
        ));
    }

    #[test]
    fn copy_extension_sql_files_preserves_update_chain_to_default_version() {
        let temp = TempTree::new("extension-update-chain");
        let source_share = temp.path().join("source/share/postgresql");
        let target_share = temp.path().join("target/share/postgresql");

        for (name, contents) in [
            (
                "hstore.control",
                "comment = 'hstore'\ndefault_version = '1.2'\n",
            ),
            ("hstore--1.0.sql", "select 'hstore install';\n"),
            ("hstore--1.0--1.1.sql", "select 'hstore update 1.1';\n"),
            ("hstore--1.1--1.2.sql", "select 'hstore update 1.2';\n"),
        ] {
            write_file(
                &source_share.join("extension").join(name),
                contents.as_bytes(),
            );
        }

        copy_extension_sql_files(&source_share, &target_share, Extension::HSTORE).unwrap();

        for name in [
            "hstore.control",
            "hstore--1.0.sql",
            "hstore--1.0--1.1.sql",
            "hstore--1.1--1.2.sql",
        ] {
            assert!(
                target_share.join("extension").join(name).is_file(),
                "selected extension runtime omitted {name}"
            );
        }
    }

    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "oliphaunt-extension-assets-test-{}-{name}-{nanos}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create temp test tree");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }
}
