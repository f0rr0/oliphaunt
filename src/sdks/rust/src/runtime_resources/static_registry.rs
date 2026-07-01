use super::*;

pub(super) fn mobile_static_registry_source_value(
    metadata: &MobileStaticRegistryMetadata,
) -> &'static str {
    if metadata.state == MobileStaticRegistryState::Complete {
        STATIC_REGISTRY_SOURCE_MANIFEST_VALUE
    } else {
        ""
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StaticRegistryModule {
    pub(super) extension_sql_name: String,
    pub(super) module_stem: String,
    pub(super) symbol_prefix: String,
    pub(super) sql_symbols: Vec<String>,
    pub(super) symbol_aliases: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StaticRegistryArchive {
    pub(super) module_stem: String,
    pub(super) target: String,
    pub(super) relative_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StaticRegistryDependencyArchive {
    pub(super) name: String,
    pub(super) target: String,
    pub(super) relative_path: PathBuf,
}

pub(super) fn write_static_registry_package(
    root: &Path,
    runtime_dir: &Path,
    extensions: &[RuntimeResourceExtension],
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<()> {
    let package_dir = root.join("static-registry");
    fs::create_dir_all(&package_dir)
        .map_err(|err| Error::Engine(format!("create {}: {err}", package_dir.display())))?;
    let modules = static_registry_modules(runtime_dir, extensions, mobile_static_registry)?;
    if mobile_static_registry.state == MobileStaticRegistryState::Complete {
        let source = static_registry_source_text(&modules);
        fs::write(package_dir.join(STATIC_REGISTRY_SOURCE_FILE), source).map_err(|err| {
            Error::Engine(format!(
                "write static registry source {}: {err}",
                package_dir.join(STATIC_REGISTRY_SOURCE_FILE).display()
            ))
        })?;
    }
    let archives = copy_prebuilt_mobile_static_archives(&package_dir, extensions)?;
    let dependency_archives =
        copy_prebuilt_mobile_static_dependency_archives(&package_dir, extensions)?;
    fs::write(
        package_dir.join("manifest.properties"),
        static_registry_manifest_text(
            mobile_static_registry,
            &modules,
            &archives,
            &dependency_archives,
        ),
    )
    .map_err(|err| {
        Error::Engine(format!(
            "write static registry manifest {}: {err}",
            package_dir.join("manifest.properties").display()
        ))
    })
}

pub(super) fn copy_prebuilt_mobile_static_archives(
    package_dir: &Path,
    extensions: &[RuntimeResourceExtension],
) -> Result<Vec<StaticRegistryArchive>> {
    let mut copied = BTreeMap::<(String, String), StaticRegistryArchive>::new();
    for extension in extensions {
        let Some(stem) = extension.native_module_stem.as_deref() else {
            continue;
        };
        let RuntimeResourceExtensionSource::Prebuilt { root, .. } = &extension.source else {
            continue;
        };
        for archive in &extension.mobile_static_archives {
            validate_relative_artifact_path(root, "mobile static archive", &archive.relative_path)?;
            let source = root.join(&archive.relative_path);
            let target_relative = PathBuf::from(STATIC_REGISTRY_ARCHIVES_DIR)
                .join(&archive.target)
                .join("extensions")
                .join(stem)
                .join(format!("liboliphaunt_extension_{stem}.a"));
            let key = (stem.to_owned(), archive.target.clone());
            if copied.contains_key(&key) {
                return Err(Error::InvalidConfig(format!(
                    "selected extension '{}' repeats mobile static archive target '{}'",
                    extension.sql_name, archive.target
                )));
            }
            copy_portable_tree(&source, &package_dir.join(&target_relative))?;
            copied.insert(
                key,
                StaticRegistryArchive {
                    module_stem: stem.to_owned(),
                    target: archive.target.clone(),
                    relative_path: target_relative,
                },
            );
        }
    }
    Ok(copied.into_values().collect())
}

pub(super) fn copy_prebuilt_mobile_static_dependency_archives(
    package_dir: &Path,
    extensions: &[RuntimeResourceExtension],
) -> Result<Vec<StaticRegistryDependencyArchive>> {
    let mut copied = BTreeMap::<(String, String), StaticRegistryDependencyArchive>::new();
    for extension in extensions {
        let RuntimeResourceExtensionSource::Prebuilt { root, .. } = &extension.source else {
            continue;
        };
        for archive in &extension.mobile_static_dependency_archives {
            validate_relative_artifact_path(
                root,
                "mobile static dependency archive",
                &archive.relative_path,
            )?;
            let source = root.join(&archive.relative_path);
            let file_name = archive
                .relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    Error::InvalidConfig(format!(
                        "selected extension '{}' has mobile static dependency archive without a portable file name: {}",
                        extension.sql_name,
                        archive.relative_path.display()
                    ))
                })?;
            let target_relative = PathBuf::from(STATIC_REGISTRY_ARCHIVES_DIR)
                .join(&archive.target)
                .join("dependencies")
                .join(&archive.name)
                .join(file_name);
            let key = (archive.name.clone(), archive.target.clone());
            if copied.contains_key(&key) {
                return Err(Error::InvalidConfig(format!(
                    "selected extension '{}' repeats mobile static dependency archive '{}' for target '{}'",
                    extension.sql_name, archive.name, archive.target
                )));
            }
            copy_portable_tree(&source, &package_dir.join(&target_relative))?;
            copied.insert(
                key,
                StaticRegistryDependencyArchive {
                    name: archive.name.clone(),
                    target: archive.target.clone(),
                    relative_path: target_relative,
                },
            );
        }
    }
    Ok(copied.into_values().collect())
}

pub(super) fn static_registry_modules(
    runtime_dir: &Path,
    extensions: &[RuntimeResourceExtension],
    mobile_static_registry: &MobileStaticRegistryMetadata,
) -> Result<Vec<StaticRegistryModule>> {
    if mobile_static_registry.state != MobileStaticRegistryState::Complete {
        return Ok(Vec::new());
    }
    let registered_stems = mobile_static_registry
        .native_module_stems
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut modules_by_stem = BTreeMap::<String, StaticRegistryModule>::new();
    let mut prefixes = BTreeSet::new();
    for extension in extensions {
        let Some(module_stem) = extension.native_module_stem.as_deref() else {
            continue;
        };
        if !registered_stems.contains(module_stem) {
            continue;
        }
        let symbol_prefix = extension
            .static_symbol_prefix
            .clone()
            .unwrap_or_else(|| static_registry_symbol_prefix(module_stem));
        if !prefixes.insert(symbol_prefix.clone()) {
            return Err(Error::InvalidConfig(format!(
                "mobile static registry module stem '{module_stem}' generates duplicate symbol prefix '{symbol_prefix}'"
            )));
        }
        let mut sql_symbols = collect_extension_sql_symbols(runtime_dir, extension)?;
        sql_symbols.sort();
        sql_symbols.dedup();
        let mut symbol_aliases = BTreeMap::new();
        for alias in &extension.static_symbol_aliases {
            if symbol_aliases
                .insert(alias.sql_symbol.clone(), alias.linked_symbol.clone())
                .is_some()
            {
                return Err(Error::InvalidConfig(format!(
                    "mobile static registry repeats alias '{}' for extension '{}'",
                    alias.sql_symbol, extension.sql_name
                )));
            }
        }
        modules_by_stem.insert(
            module_stem.to_owned(),
            StaticRegistryModule {
                extension_sql_name: extension.sql_name.clone(),
                module_stem: module_stem.to_owned(),
                symbol_prefix,
                sql_symbols,
                symbol_aliases,
            },
        );
    }
    let missing = registered_stems
        .difference(&modules_by_stem.keys().cloned().collect::<BTreeSet<_>>())
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "mobile static registry module stem(s) are marked complete but no selected native extension uses them: {}",
            missing.join(",")
        )));
    }
    Ok(modules_by_stem.into_values().collect())
}

pub(super) fn collect_extension_sql_symbols(
    runtime_dir: &Path,
    extension: &RuntimeResourceExtension,
) -> Result<Vec<String>> {
    if !extension.creates_extension {
        return Ok(Vec::new());
    }
    let extension_dir = runtime_dir.join("share/postgresql/extension");
    let prefix = format!("{}--", extension.sql_name);
    let mut symbols = BTreeSet::new();
    let mut found_sql_file = false;
    for entry in fs::read_dir(&extension_dir)
        .map_err(|err| Error::Engine(format!("read {}: {err}", extension_dir.display())))?
    {
        let entry = entry.map_err(|err| {
            Error::Engine(format!("read entry in {}: {err}", extension_dir.display()))
        })?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with(&prefix) || !file_name.ends_with(".sql") {
            continue;
        }
        found_sql_file = true;
        let path = entry.path();
        let text = fs::read_to_string(&path).map_err(|err| {
            Error::Engine(format!("read extension SQL {}: {err}", path.display()))
        })?;
        for symbol in module_pathname_c_symbols(&text)? {
            symbols.insert(symbol);
        }
    }
    if !found_sql_file {
        return Err(Error::InvalidConfig(format!(
            "selected extension {} has no packaged SQL files in {}",
            extension.sql_name,
            extension_dir.display()
        )));
    }
    Ok(symbols.into_iter().collect())
}

pub(super) fn module_pathname_c_symbols(sql: &str) -> Result<Vec<String>> {
    let mut symbols = BTreeSet::new();
    let stripped = strip_sql_line_comments(sql);
    for statement in split_sql_statements(&stripped) {
        if !contains_ascii_case_insensitive(statement, "module_pathname")
            || !has_language_c(statement)
        {
            continue;
        }
        let Some(symbol) = explicit_module_pathname_symbol(statement)
            .or_else(|| implicit_function_symbol(statement))
        else {
            continue;
        };
        if !is_c_identifier(&symbol) {
            return Err(Error::InvalidConfig(format!(
                "extension SQL references non-portable C symbol '{symbol}'"
            )));
        }
        symbols.insert(symbol);
    }
    Ok(symbols.into_iter().collect())
}

fn strip_sql_line_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            out.push(ch);
            if in_string && chars.peek() == Some(&'\'') {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else {
                in_string = !in_string;
            }
            continue;
        }
        if !in_string && ch == '-' && chars.peek() == Some(&'-') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    out.push('\n');
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn split_sql_statements(sql: &str) -> Vec<&str> {
    let mut statements = Vec::new();
    let mut start = 0;
    let mut in_string = false;
    let mut iter = sql.char_indices().peekable();
    while let Some((index, ch)) = iter.next() {
        if ch == '\'' {
            if in_string && iter.peek().map(|(_, next)| *next) == Some('\'') {
                let _ = iter.next();
            } else {
                in_string = !in_string;
            }
        } else if !in_string && ch == ';' {
            statements.push(sql[start..index].trim());
            start = index + ch.len_utf8();
        }
    }
    if start < sql.len() {
        statements.push(sql[start..].trim());
    }
    statements
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect()
}

fn explicit_module_pathname_symbol(statement: &str) -> Option<String> {
    let lower = statement.to_ascii_lowercase();
    let module_index = lower.find("module_pathname")?;
    let mut rest = &statement[module_index + "module_pathname".len()..];
    rest = rest.trim_start();
    if let Some(after_quote) = rest.strip_prefix('\'') {
        rest = after_quote.trim_start();
    }
    rest = rest.strip_prefix(',')?.trim_start();
    parse_sql_single_quoted_literal(rest).map(|(symbol, _)| symbol)
}

fn implicit_function_symbol(statement: &str) -> Option<String> {
    let lower = statement.to_ascii_lowercase();
    let function_index = lower.find("function")?;
    let after_function = &statement[function_index + "function".len()..];
    let name_end = after_function.find('(')?;
    let raw_name = after_function[..name_end].trim();
    let identifier = last_sql_identifier(raw_name)?;
    if identifier.is_empty() {
        None
    } else {
        Some(identifier)
    }
}

fn parse_sql_single_quoted_literal(value: &str) -> Option<(String, &str)> {
    let mut chars = value.char_indices();
    let (_, first) = chars.next()?;
    if first != '\'' {
        return None;
    }
    let mut out = String::new();
    while let Some((index, ch)) = chars.next() {
        if ch == '\'' {
            if let Some((_, '\'')) = chars.clone().next() {
                let _ = chars.next();
                out.push('\'');
                continue;
            }
            let end = index + ch.len_utf8();
            return Some((out, &value[end..]));
        }
        out.push(ch);
    }
    None
}

fn last_sql_identifier(raw_name: &str) -> Option<String> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let mut iter = raw_name.char_indices().peekable();
    while let Some((index, ch)) = iter.next() {
        if ch == '"' {
            if in_quotes && iter.peek().map(|(_, next)| *next) == Some('"') {
                let _ = iter.next();
            } else {
                in_quotes = !in_quotes;
            }
        } else if !in_quotes && ch == '.' {
            parts.push(raw_name[start..index].trim());
            start = index + ch.len_utf8();
        }
    }
    parts.push(raw_name[start..].trim());
    let part = parts.last()?.trim();
    if part.starts_with('"') && part.ends_with('"') && part.len() >= 2 {
        Some(part[1..part.len() - 1].replace("\"\"", "\""))
    } else {
        Some(part.to_owned())
    }
}

fn has_language_c(statement: &str) -> bool {
    let tokens = statement
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
        .collect::<Vec<_>>();
    tokens
        .windows(2)
        .any(|window| window[0] == "language" && window[1] == "c")
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn static_registry_symbol_prefix(module_stem: &str) -> String {
    let mut out = String::from("oliphaunt_static_");
    for byte in module_stem.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'_' {
            out.push(byte as char);
        } else {
            out.push('_');
        }
    }
    out
}

pub(super) fn static_registry_manifest_text(
    metadata: &MobileStaticRegistryMetadata,
    modules: &[StaticRegistryModule],
    archives: &[StaticRegistryArchive],
    dependency_archives: &[StaticRegistryDependencyArchive],
) -> String {
    let archive_targets = archives
        .iter()
        .map(|archive| archive.target.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let dependency_archive_targets = dependency_archives
        .iter()
        .map(|archive| archive.target.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let dependency_archive_names = dependency_archives
        .iter()
        .map(|archive| archive.name.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut text = format!(
        "packageLayout={STATIC_REGISTRY_PACKAGE_LAYOUT}\nabiVersion=1\nstate={}\nsource={}\nregisteredExtensions={}\npendingExtensions={}\nnativeModuleStems={}\nmodules={}\narchiveTargets={}\ndependencyArchiveTargets={}\ndependencyArchives={}\n",
        metadata.state.as_manifest_value(),
        if metadata.state == MobileStaticRegistryState::Complete {
            STATIC_REGISTRY_SOURCE_FILE
        } else {
            ""
        },
        metadata.registered_extensions.join(","),
        metadata.pending_extensions.join(","),
        metadata.native_module_stems.join(","),
        modules
            .iter()
            .map(|module| module.module_stem.as_str())
            .collect::<Vec<_>>()
            .join(","),
        archive_targets.join(","),
        dependency_archive_targets.join(","),
        dependency_archive_names.join(","),
    );
    for module in modules {
        let module_archives = archives
            .iter()
            .filter(|archive| archive.module_stem == module.module_stem)
            .collect::<Vec<_>>();
        let module_archive_targets = module_archives
            .iter()
            .map(|archive| archive.target.as_str())
            .collect::<Vec<_>>();
        text.push_str(&format!(
            "module.{}.extension={}\nmodule.{}.symbolPrefix={}\nmodule.{}.sqlSymbols={}\nmodule.{}.symbolAliases={}\nmodule.{}.archiveTargets={}\n",
            module.module_stem,
            module.extension_sql_name,
            module.module_stem,
            module.symbol_prefix,
            module.module_stem,
            module.sql_symbols.join(","),
            module.module_stem,
            module
                .symbol_aliases
                .iter()
                .map(|(sql_symbol, linked_symbol)| format!("{sql_symbol}:{linked_symbol}"))
                .collect::<Vec<_>>()
                .join(","),
            module.module_stem,
            module_archive_targets.join(","),
        ));
        for archive in module_archives {
            text.push_str(&format!(
                "module.{}.archive.{}={}\n",
                module.module_stem,
                archive.target,
                archive.relative_path.to_string_lossy(),
            ));
        }
    }
    for dependency in dependency_archive_names {
        let archives_for_dependency = dependency_archives
            .iter()
            .filter(|archive| archive.name == dependency)
            .collect::<Vec<_>>();
        let archive_targets = archives_for_dependency
            .iter()
            .map(|archive| archive.target.as_str())
            .collect::<Vec<_>>();
        text.push_str(&format!(
            "dependency.{}.archiveTargets={}\n",
            dependency,
            archive_targets.join(","),
        ));
        for archive in archives_for_dependency {
            text.push_str(&format!(
                "dependency.{}.archive.{}={}\n",
                dependency,
                archive.target,
                archive.relative_path.to_string_lossy(),
            ));
        }
    }
    text
}

fn static_registry_linked_symbol(module: &StaticRegistryModule, symbol: &str) -> String {
    module
        .symbol_aliases
        .get(symbol)
        .cloned()
        .unwrap_or_else(|| symbol.to_owned())
}

fn static_registry_sql_symbol_names(module: &StaticRegistryModule) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for symbol in &module.sql_symbols {
        names.insert(symbol.clone());
        names.insert(format!("pg_finfo_{symbol}"));
    }
    names
}

pub(super) fn static_registry_source_text(modules: &[StaticRegistryModule]) -> String {
    let mut out = String::new();
    out.push_str(
        "/* Generated by oliphaunt. Do not edit by hand. */\n\
         #include <stddef.h>\n\
         #include <stdint.h>\n\
         #include \"oliphaunt.h\"\n\n\
         #if defined(__APPLE__)\n\
         #define OLIPHAUNT_STATIC_OPTIONAL __attribute__((weak_import))\n\
         #elif defined(__GNUC__) || defined(__clang__)\n\
         #define OLIPHAUNT_STATIC_OPTIONAL __attribute__((weak))\n\
         #else\n\
         #define OLIPHAUNT_STATIC_OPTIONAL\n\
         #endif\n\n",
    );
    for module in modules {
        out.push_str(&format!(
            "extern const void *{}_Pg_magic_func(void);\n\
             extern void {}__PG_init(void) OLIPHAUNT_STATIC_OPTIONAL;\n",
            module.symbol_prefix, module.symbol_prefix
        ));
        for symbol in &module.sql_symbols {
            let linked_symbol = static_registry_linked_symbol(module, symbol);
            let pg_finfo_symbol = format!("pg_finfo_{symbol}");
            let linked_pg_finfo_symbol = static_registry_linked_symbol(module, &pg_finfo_symbol);
            out.push_str(&format!(
                "extern void {linked_symbol}(void);\n\
                 extern void {linked_pg_finfo_symbol}(void);\n"
            ));
        }
        let sql_symbol_names = static_registry_sql_symbol_names(module);
        for (sql_symbol, linked_symbol) in &module.symbol_aliases {
            if sql_symbol_names.contains(sql_symbol) {
                continue;
            }
            out.push_str(&format!("extern void {linked_symbol}(void);\n"));
        }
        out.push('\n');
    }
    for module in modules {
        out.push_str(&format!(
            "static const OliphauntStaticExtensionSymbol {}_symbols[] = {{\n",
            module.symbol_prefix
        ));
        for symbol in &module.sql_symbols {
            let linked_symbol = static_registry_linked_symbol(module, symbol);
            let pg_finfo_symbol = format!("pg_finfo_{symbol}");
            let linked_pg_finfo_symbol = static_registry_linked_symbol(module, &pg_finfo_symbol);
            out.push_str(&format!(
                "    {{ .name = {}, .address = (void *){} }},\n\
                 {{ .name = {}, .address = (void *){} }},\n",
                c_string_literal(symbol),
                linked_symbol,
                c_string_literal(&pg_finfo_symbol),
                linked_pg_finfo_symbol
            ));
        }
        let sql_symbol_names = static_registry_sql_symbol_names(module);
        for (sql_symbol, linked_symbol) in &module.symbol_aliases {
            if sql_symbol_names.contains(sql_symbol) {
                continue;
            }
            out.push_str(&format!(
                "    {{ .name = {}, .address = (void *){} }},\n",
                c_string_literal(sql_symbol),
                linked_symbol
            ));
        }
        out.push_str("};\n\n");
    }
    out.push_str("static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n");
    for module in modules {
        out.push_str(&format!(
            "    {{\n\
                    .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,\n\
                    .name = {},\n\
                    .magic = {}_Pg_magic_func,\n\
                    .init = {}__PG_init,\n\
                    .symbols = {}_symbols,\n\
                    .symbol_count = sizeof({}_symbols) / sizeof({}_symbols[0]),\n\
                    .reserved_flags = 0,\n\
                }},\n",
            c_string_literal(&module.module_stem),
            module.symbol_prefix,
            module.symbol_prefix,
            module.symbol_prefix,
            module.symbol_prefix,
            module.symbol_prefix
        ));
    }
    out.push_str(
        "};\n\n\
         const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {\n\
             if (count != NULL) {\n\
                 *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);\n\
             }\n\
             return liboliphaunt_static_extensions;\n\
         }\n",
    );
    out
}

fn c_string_literal(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

pub(super) fn shared_preload_libraries(extensions: &[RuntimeResourceExtension]) -> Vec<String> {
    let mut libraries = BTreeSet::new();
    for extension in extensions {
        libraries.extend(extension.shared_preload_libraries.iter().cloned());
    }
    libraries.into_iter().collect()
}

pub(super) fn mobile_static_registry_metadata(
    extensions: &[RuntimeResourceExtension],
    registered_module_stems: &[String],
) -> Result<MobileStaticRegistryMetadata> {
    let mut registered_stems = BTreeSet::new();
    for raw_stem in registered_module_stems {
        let stem = raw_stem.trim();
        if !is_portable_module_stem(stem) {
            return Err(Error::InvalidConfig(format!(
                "mobile static registry module stem '{stem}' must contain only ASCII letters, digits, '.', '_' or '-'"
            )));
        }
        registered_stems.insert(stem.to_owned());
    }

    let mut registered_extensions = Vec::new();
    let mut pending_extensions = Vec::new();
    let mut native_module_stems = Vec::new();
    let mut selected_stems = BTreeSet::new();
    for extension in extensions {
        let Some(stem) = extension.native_module_stem.as_deref() else {
            continue;
        };
        native_module_stems.push(stem.to_owned());
        selected_stems.insert(stem.to_owned());
        if registered_stems.contains(stem) {
            if !extension.mobile_prebuilt {
                return Err(Error::InvalidConfig(format!(
                    "selected extension '{}' does not have release-ready iOS/Android static artifacts; app bundles cannot mark module stem '{}' complete without a prebuilt mobile artifact",
                    extension.sql_name, stem
                )));
            }
            registered_extensions.push(extension.sql_name.clone());
        } else {
            pending_extensions.push(extension.sql_name.clone());
        }
    }
    let unknown_stems = registered_stems
        .difference(&selected_stems)
        .cloned()
        .collect::<Vec<_>>();
    if !unknown_stems.is_empty() {
        return Err(Error::InvalidConfig(format!(
            "mobile static registry module stem(s) were not selected by these runtime resources: {}",
            unknown_stems.join(",")
        )));
    }
    registered_extensions.sort();
    registered_extensions.dedup();
    pending_extensions.sort();
    pending_extensions.dedup();
    native_module_stems.sort();
    native_module_stems.dedup();
    let state = if native_module_stems.is_empty() {
        MobileStaticRegistryState::NotRequired
    } else if pending_extensions.is_empty() {
        MobileStaticRegistryState::Complete
    } else {
        MobileStaticRegistryState::Pending
    };
    Ok(MobileStaticRegistryMetadata {
        state,
        registered_extensions,
        pending_extensions,
        native_module_stems,
    })
}
