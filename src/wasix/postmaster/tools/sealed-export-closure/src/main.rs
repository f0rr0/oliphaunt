use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use wasm_encoder::{ExportKind as EncoderExportKind, ExportSection};
use wasmparser::{
    ElementItems, ExternalKind, FuncType, GlobalType, MemoryType, Parser, Payload, TableType,
    TagType, TypeRef, Validator, WasmFeatures,
};

const PROOF_SCHEMA: &str = "oliphaunt.wasix-postmaster.sealed-export-closure-proof.v2";
const RECEIPT_SCHEMA: &str = "oliphaunt.wasix-postmaster.sealed-export-structure.v1";
const POLICY_ID: &str = "oliphaunt.wasix-postmaster.sealed-export-closure.v1";
const DCE_PASS: &str = "--remove-unused-module-elements";

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
struct Import {
    module: String,
    name: String,
    kind: String,
    descriptor: String,
    global_value_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct Export {
    name: String,
    kind: String,
    descriptor: String,
    global_value_type: Option<String>,
    index: u32,
    #[serde(skip)]
    external_kind: ExternalKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ModuleSummary {
    path: String,
    sha256: String,
    bytes: usize,
    non_export_sections_sha256: String,
    dylink_needed: Vec<String>,
    imported_functions: u32,
    local_functions: u32,
    imported_globals: u32,
    local_globals: u32,
    imported_tables: u32,
    local_tables: u32,
    element_function_entries: u32,
    element_unique_function_indices: u32,
    element_max_function_index: Option<u32>,
    start_function_index: Option<u32>,
    imports: Vec<Import>,
    #[serde(skip)]
    exports: Vec<Export>,
    export_counts: BTreeMap<String, u32>,
    exported_global_type_counts: BTreeMap<String, u32>,
    exported_immutable_i32_globals: u32,
    exported_local_functions: u32,
    exported_imported_functions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct ClosureProof {
    schema: &'static str,
    policy_id: &'static str,
    analyzer_version: &'static str,
    mandatory_policy_sha256: String,
    declared_main_dlsym_policy_sha256: String,
    main: ModuleSummary,
    sides: Vec<ModuleSummary>,
    mandatory_runtime_exports: Vec<String>,
    declared_main_dlsym_exports: Vec<String>,
    side_dynamic_imports: Vec<ImportRequirement>,
    retained_main_exports: Vec<String>,
    retained_main_export_descriptors: Vec<RetainedExport>,
    removed_main_export_count: usize,
    removed_main_export_names_sha256: String,
    #[serde(skip)]
    removed_main_exports: Vec<String>,
    unresolved_main_requirements: Vec<String>,
    mismatched_main_requirements: Vec<String>,
    unresolved_side_dependencies: Vec<String>,
    retained_counts: BTreeMap<String, u32>,
    removed_counts: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
struct ImportRequirement {
    side_sha256: String,
    side_path: String,
    module: String,
    name: String,
    source_kind: String,
    source_descriptor: String,
    required_export_kind: Option<String>,
    required_export_descriptor: Option<String>,
    required_global_value_type: Option<String>,
    externally_provided: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
struct RetainedExport {
    name: String,
    kind: String,
    descriptor: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct StructuralSnapshot {
    sha256: String,
    bytes: usize,
    exports: usize,
    local_functions: u32,
    local_globals: u32,
    element_function_entries: u32,
    element_unique_function_indices: u32,
    start_function_index: u32,
}

impl StructuralSnapshot {
    fn new(module: &ModuleSummary) -> Result<Self> {
        Ok(Self {
            sha256: module.sha256.clone(),
            bytes: module.bytes,
            exports: module.exports.len(),
            local_functions: module.local_functions,
            local_globals: module.local_globals,
            element_function_entries: module.element_function_entries,
            element_unique_function_indices: module.element_unique_function_indices,
            start_function_index: module
                .start_function_index
                .context("sealed main module has no start function")?,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct StructuralReceipt {
    schema: &'static str,
    policy_id: &'static str,
    analyzer_version: &'static str,
    analyzer_binary_sha256: String,
    dce_tool_sha256: String,
    dce_tool_version: String,
    dce_passes: [&'static str; 1],
    mandatory_policy_sha256: String,
    declared_main_dlsym_policy_sha256: String,
    side_manifest_sha256: String,
    allowlist_sha256: String,
    seed_proof_sha256: String,
    final_proof_sha256: String,
    seed: StructuralSnapshot,
    final_module: StructuralSnapshot,
    sides: Vec<SideIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct SideIdentity {
    path: String,
    sha256: String,
}

#[derive(Debug, Clone)]
struct RawExport {
    name: String,
    kind: ExternalKind,
    index: u32,
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn name_set_sha256(names: &[String]) -> String {
    let mut sorted = names.to_vec();
    sorted.sort();
    let mut digest = Sha256::new();
    for name in sorted {
        digest.update(name.as_bytes());
        digest.update([0]);
    }
    hex::encode(digest.finalize())
}

fn sha256_file(path: &Path) -> Result<String> {
    Ok(sha256(
        &fs::read(path).with_context(|| format!("read {}", path.display()))?,
    ))
}

fn ensure_sha256(label: &str, value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "{label} is not a lowercase SHA-256: {value}"
    );
    Ok(())
}

fn non_export_sections_sha256(bytes: &[u8]) -> Result<String> {
    ensure!(
        bytes.starts_with(b"\0asm\x01\0\0\0"),
        "not a core wasm v1 module"
    );
    let mut digest = Sha256::new();
    digest.update(&bytes[..8]);
    let mut cursor = 8;
    while cursor < bytes.len() {
        let section_start = cursor;
        let id = bytes[cursor];
        cursor += 1;
        let length = read_uleb(bytes, &mut cursor)? as usize;
        let payload_end = cursor
            .checked_add(length)
            .context("section length overflow")?;
        ensure!(payload_end <= bytes.len(), "truncated section {id}");
        if id != 7 {
            digest.update(&bytes[section_start..payload_end]);
        }
        cursor = payload_end;
    }
    Ok(hex::encode(digest.finalize()))
}

fn kind_name(kind: ExternalKind) -> &'static str {
    match kind {
        ExternalKind::Func => "function",
        ExternalKind::FuncExact => "exact-function",
        ExternalKind::Table => "table",
        ExternalKind::Memory => "memory",
        ExternalKind::Global => "global",
        ExternalKind::Tag => "tag",
    }
}

fn type_ref_kind(ty: TypeRef) -> &'static str {
    match ty {
        TypeRef::Func(_) => "function",
        TypeRef::FuncExact(_) => "exact-function",
        TypeRef::Table(_) => "table",
        TypeRef::Memory(_) => "memory",
        TypeRef::Global(_) => "global",
        TypeRef::Tag(_) => "tag",
    }
}

fn function_descriptor(ty: &FuncType) -> String {
    let params = ty
        .params()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let results = ty
        .results()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("func({params})->({results})")
}

fn global_descriptor(ty: GlobalType) -> String {
    format!(
        "global(type={},mutable={},shared={})",
        ty.content_type, ty.mutable, ty.shared
    )
}

fn table_descriptor(ty: TableType) -> String {
    format!(
        "table(element={},table64={},minimum={},maximum={},shared={})",
        ty.element_type,
        ty.table64,
        ty.initial,
        ty.maximum
            .map_or_else(|| "none".to_owned(), |value| value.to_string()),
        ty.shared
    )
}

fn memory_descriptor(ty: MemoryType) -> String {
    format!(
        "memory(memory64={},shared={},minimum={},maximum={},page-size-log2={})",
        ty.memory64,
        ty.shared,
        ty.initial,
        ty.maximum
            .map_or_else(|| "none".to_owned(), |value| value.to_string()),
        ty.page_size_log2()
    )
}

fn tag_descriptor(ty: TagType, function_types: &[FuncType]) -> Result<String> {
    let function_type = function_types
        .get(ty.func_type_idx as usize)
        .with_context(|| format!("tag has invalid function type index {}", ty.func_type_idx))?;
    Ok(format!(
        "tag(kind={:?},signature={})",
        ty.kind,
        function_descriptor(function_type)
    ))
}

fn type_ref_descriptor(ty: TypeRef, function_types: &[FuncType]) -> Result<String> {
    match ty {
        TypeRef::Func(index) => function_types
            .get(index as usize)
            .map(function_descriptor)
            .with_context(|| format!("function import has invalid type index {index}")),
        TypeRef::FuncExact(_) => bail!("exact-function imports are unsupported"),
        TypeRef::Table(ty) => Ok(table_descriptor(ty)),
        TypeRef::Memory(ty) => Ok(memory_descriptor(ty)),
        TypeRef::Global(ty) => Ok(global_descriptor(ty)),
        TypeRef::Tag(ty) => tag_descriptor(ty, function_types),
    }
}

fn export_descriptor(
    export: &RawExport,
    function_types: &[FuncType],
    function_type_indices: &[u32],
    tables: &[TableType],
    memories: &[MemoryType],
    globals: &[GlobalType],
    tags: &[TagType],
) -> Result<String> {
    match export.kind {
        ExternalKind::Func => {
            let type_index = function_type_indices
                .get(export.index as usize)
                .with_context(|| format!("exported function {} has bad index", export.name))?;
            function_types
                .get(*type_index as usize)
                .map(function_descriptor)
                .with_context(|| {
                    format!(
                        "exported function {} has bad type index {type_index}",
                        export.name
                    )
                })
        }
        ExternalKind::FuncExact => bail!("exact-function exports are unsupported"),
        ExternalKind::Table => tables
            .get(export.index as usize)
            .copied()
            .map(table_descriptor)
            .with_context(|| format!("exported table {} has bad index", export.name)),
        ExternalKind::Memory => memories
            .get(export.index as usize)
            .copied()
            .map(memory_descriptor)
            .with_context(|| format!("exported memory {} has bad index", export.name)),
        ExternalKind::Global => globals
            .get(export.index as usize)
            .copied()
            .map(global_descriptor)
            .with_context(|| format!("exported global {} has bad index", export.name)),
        ExternalKind::Tag => tags
            .get(export.index as usize)
            .copied()
            .with_context(|| format!("exported tag {} has bad index", export.name))
            .and_then(|ty| tag_descriptor(ty, function_types)),
    }
}

fn analyze(path: &Path) -> Result<ModuleSummary> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Validator::new_with_features(WasmFeatures::default() | WasmFeatures::THREADS)
        .validate_all(&bytes)
        .with_context(|| format!("validate {}", path.display()))?;

    let mut function_types = Vec::new();
    let mut function_type_indices = Vec::new();
    let mut global_types = Vec::new();
    let mut table_types = Vec::new();
    let mut memory_types = Vec::new();
    let mut tag_types = Vec::new();
    let mut imported_functions = 0;
    let mut local_functions = 0;
    let mut imported_globals = 0;
    let mut local_globals = 0;
    let mut imported_tables = 0;
    let mut local_tables = 0;
    let mut imports = Vec::new();
    let mut raw_exports = Vec::new();
    let mut dylink_needed = Vec::new();
    let mut element_function_entries = 0_u32;
    let mut element_function_indices = BTreeSet::new();
    let mut start_function_index = None;

    for payload in Parser::new(0).parse_all(&bytes) {
        match payload? {
            Payload::TypeSection(section) => {
                function_types.extend(
                    section
                        .into_iter_err_on_gc_types()
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import?;
                    ensure!(
                        !matches!(import.ty, TypeRef::FuncExact(_)),
                        "unsupported exact-function import {}.{} in {}",
                        import.module,
                        import.name,
                        path.display()
                    );
                    match import.ty {
                        TypeRef::Func(index) => {
                            imported_functions += 1;
                            function_type_indices.push(index);
                        }
                        TypeRef::FuncExact(_) => {
                            unreachable!("exact-function imports are rejected above")
                        }
                        TypeRef::Global(ty) => {
                            imported_globals += 1;
                            global_types.push(ty);
                        }
                        TypeRef::Table(ty) => {
                            imported_tables += 1;
                            table_types.push(ty);
                        }
                        TypeRef::Memory(ty) => memory_types.push(ty),
                        TypeRef::Tag(ty) => tag_types.push(ty),
                    }
                    imports.push(Import {
                        module: import.module.to_owned(),
                        name: import.name.to_owned(),
                        kind: type_ref_kind(import.ty).to_owned(),
                        descriptor: type_ref_descriptor(import.ty, &function_types)?,
                        global_value_type: match import.ty {
                            TypeRef::Global(ty) => Some(ty.content_type.to_string()),
                            _ => None,
                        },
                    });
                }
            }
            Payload::FunctionSection(section) => {
                local_functions = section.count();
                for type_index in section {
                    function_type_indices.push(type_index?);
                }
            }
            Payload::TableSection(section) => {
                local_tables = section.count();
                for table in section {
                    table_types.push(table?.ty);
                }
            }
            Payload::MemorySection(section) => {
                for memory in section {
                    memory_types.push(memory?);
                }
            }
            Payload::GlobalSection(section) => {
                local_globals = section.count();
                for global in section {
                    global_types.push(global?.ty);
                }
            }
            Payload::TagSection(section) => {
                for tag in section {
                    tag_types.push(tag?);
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    raw_exports.push(RawExport {
                        name: export.name.to_owned(),
                        kind: export.kind,
                        index: export.index,
                    });
                }
            }
            Payload::ElementSection(section) => {
                for element in section {
                    let element = element?;
                    if let ElementItems::Functions(items) = element.items {
                        for index in items {
                            let index = index?;
                            element_function_entries += 1;
                            element_function_indices.insert(index);
                        }
                    }
                }
            }
            Payload::StartSection { func, .. } => start_function_index = Some(func),
            Payload::CustomSection(section) if section.name() == "dylink.0" => {
                let reader = wasmparser::Dylink0SectionReader::new(wasmparser::BinaryReader::new(
                    section.data(),
                    section.data_offset(),
                ));
                for subsection in reader {
                    if let wasmparser::Dylink0Subsection::Needed(needed) = subsection? {
                        dylink_needed.extend(needed.iter().map(|name| (*name).to_owned()));
                    }
                }
            }
            _ => {}
        }
    }

    let mut export_names = BTreeSet::new();
    let mut export_counts = BTreeMap::new();
    let mut exports = Vec::new();
    for raw in raw_exports {
        ensure!(
            raw.kind != ExternalKind::FuncExact,
            "unsupported exact-function export {} in {}",
            raw.name,
            path.display()
        );
        ensure!(
            export_names.insert(raw.name.clone()),
            "duplicate export name {} in {}",
            raw.name,
            path.display()
        );
        let kind = kind_name(raw.kind).to_owned();
        *export_counts.entry(kind.clone()).or_default() += 1;
        exports.push(Export {
            descriptor: export_descriptor(
                &raw,
                &function_types,
                &function_type_indices,
                &table_types,
                &memory_types,
                &global_types,
                &tag_types,
            )?,
            name: raw.name,
            kind,
            global_value_type: match raw.kind {
                ExternalKind::Global => global_types
                    .get(raw.index as usize)
                    .map(|ty| ty.content_type.to_string()),
                _ => None,
            },
            index: raw.index,
            external_kind: raw.kind,
        });
    }

    let element_max_function_index = element_function_indices.iter().next_back().copied();
    let mut exported_global_type_counts = BTreeMap::new();
    let mut exported_immutable_i32_globals = 0_u32;
    let mut exported_local_functions = 0_u32;
    let mut exported_imported_functions = 0_u32;
    for export in &exports {
        match export.external_kind {
            ExternalKind::Global => {
                let ty = global_types
                    .get(export.index as usize)
                    .with_context(|| format!("exported global {} has bad index", export.name))?;
                let label = format!(
                    "{}-{}-{}",
                    ty.content_type,
                    if ty.mutable { "mutable" } else { "immutable" },
                    if ty.shared { "shared" } else { "unshared" }
                );
                *exported_global_type_counts.entry(label).or_default() += 1;
                if ty.content_type == wasmparser::ValType::I32 && !ty.mutable {
                    exported_immutable_i32_globals += 1;
                }
            }
            ExternalKind::Func => {
                if export.index < imported_functions {
                    exported_imported_functions += 1;
                } else {
                    exported_local_functions += 1;
                }
            }
            ExternalKind::FuncExact => {
                unreachable!("exact-function exports are rejected above")
            }
            _ => {}
        }
    }

    Ok(ModuleSummary {
        path: path.display().to_string(),
        sha256: sha256(&bytes),
        bytes: bytes.len(),
        non_export_sections_sha256: non_export_sections_sha256(&bytes)?,
        dylink_needed,
        imported_functions,
        local_functions,
        imported_globals,
        local_globals,
        imported_tables,
        local_tables,
        element_function_entries,
        element_unique_function_indices: element_function_indices.len() as u32,
        element_max_function_index,
        start_function_index,
        imports,
        exports,
        export_counts,
        exported_global_type_counts,
        exported_immutable_i32_globals,
        exported_local_functions,
        exported_imported_functions,
    })
}

fn read_names(path: &Path) -> Result<BTreeSet<String>> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        text.ends_with('\n') && !text.contains('\r'),
        "{} is not canonical newline text",
        path.display()
    );
    let mut names = BTreeSet::new();
    for (line_number, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        ensure!(
            !line.chars().any(char::is_whitespace),
            "{}:{}: an export name cannot contain whitespace",
            path.display(),
            line_number + 1
        );
        ensure!(
            names.insert(line.to_owned()),
            "{}:{}: duplicate export {line}",
            path.display(),
            line_number + 1
        );
    }
    Ok(names)
}

fn is_external_import(import: &Import) -> bool {
    if !matches!(import.module.as_str(), "env" | "GOT.mem" | "GOT.func") {
        return true;
    }
    matches!(
        import.name.as_str(),
        "memory"
            | "__indirect_function_table"
            | "__stack_pointer"
            | "__memory_base"
            | "__table_base"
            | "__c_longjmp"
            | "__cpp_exception"
            | "__stack_high"
            | "__stack_low"
            | "__heap_base"
    )
}

fn required_export(import: &Import) -> (Option<String>, Option<String>, Option<String>) {
    if is_external_import(import) {
        return (None, None, None);
    }
    match import.module.as_str() {
        // GOT.func is an integer address relocation. Its source global carries
        // no callable signature, so function-kind checking is the strongest
        // fact encoded by this import. Direct env function imports below are
        // compared with their full WebAssembly signature.
        "GOT.func" => (Some("function".to_owned()), None, None),
        // A GOT.mem import is a mutable slot that receives the address exported
        // by main. The provider's synthetic address global is immutable. Their
        // mutability therefore must differ; the exact relocation type is the
        // global value type, not the source slot's full global descriptor.
        "GOT.mem" => (
            Some("global".to_owned()),
            None,
            import.global_value_type.clone(),
        ),
        "env" => (
            Some(import.kind.clone()),
            Some(import.descriptor.clone()),
            None,
        ),
        _ => unreachable!("external module imports have no main requirement"),
    }
}

fn compute_proof(
    main: ModuleSummary,
    sides: Vec<ModuleSummary>,
    mandatory_path: &Path,
    dlsym_path: &Path,
) -> Result<ClosureProof> {
    ensure!(!sides.is_empty(), "at least one side module is required");
    let mandatory = read_names(mandatory_path)?;
    let declared_dlsym = read_names(dlsym_path)?;
    let main_exports = main
        .exports
        .iter()
        .map(|export| (export.name.clone(), export))
        .collect::<BTreeMap<_, _>>();

    let side_names = sides
        .iter()
        .filter_map(|side| Path::new(&side.path).file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect::<BTreeSet<_>>();
    let unresolved_side_dependencies = sides
        .iter()
        .flat_map(|side| {
            side.dylink_needed
                .iter()
                .filter(|needed| !side_names.contains(*needed))
                .map(|needed| format!("{} requires absent side module {needed}", side.path))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let mut retained = mandatory.clone();
    retained.extend(declared_dlsym.iter().cloned());
    let mut side_dynamic_imports = Vec::new();
    for side in &sides {
        for import in &side.imports {
            let externally_provided = is_external_import(import);
            let (required_export_kind, required_export_descriptor, required_global_value_type) =
                required_export(import);
            if !externally_provided {
                retained.insert(import.name.clone());
            }
            side_dynamic_imports.push(ImportRequirement {
                side_sha256: side.sha256.clone(),
                side_path: side.path.clone(),
                module: import.module.clone(),
                name: import.name.clone(),
                source_kind: import.kind.clone(),
                source_descriptor: import.descriptor.clone(),
                required_export_kind,
                required_export_descriptor,
                required_global_value_type,
                externally_provided,
            });
        }
    }
    side_dynamic_imports.sort();
    side_dynamic_imports.dedup();

    let unresolved_main_requirements = retained
        .iter()
        .filter(|name| !main_exports.contains_key(*name))
        .cloned()
        .collect::<Vec<_>>();
    let mismatched_main_requirements = side_dynamic_imports
        .iter()
        .filter_map(|requirement| {
            let required_kind = requirement.required_export_kind.as_deref()?;
            let actual = main_exports.get(&requirement.name)?;
            if actual.kind != required_kind {
                return Some(format!(
                    "{} imports {} as {} but main exports {}",
                    requirement.side_path, requirement.name, required_kind, actual.kind
                ));
            }
            if let Some(required_type) = requirement.required_global_value_type.as_deref()
                && actual.global_value_type.as_deref() != Some(required_type)
            {
                return Some(format!(
                    "{} imports {} as a GOT.mem {} address but main exports {:?}",
                    requirement.side_path,
                    requirement.name,
                    required_type,
                    actual.global_value_type
                ));
            }
            requirement
                .required_export_descriptor
                .as_ref()
                .filter(|required| actual.descriptor.as_str() != required.as_str())
                .map(|required| {
                    format!(
                        "{} imports {} as {} but main exports {}",
                        requirement.side_path, requirement.name, required, actual.descriptor
                    )
                })
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let retained_main_exports = main
        .exports
        .iter()
        .filter(|export| retained.contains(&export.name))
        .map(|export| export.name.clone())
        .collect::<Vec<_>>();
    let retained_main_export_descriptors = main
        .exports
        .iter()
        .filter(|export| retained.contains(&export.name))
        .map(|export| RetainedExport {
            name: export.name.clone(),
            kind: export.kind.clone(),
            descriptor: export.descriptor.clone(),
        })
        .collect::<Vec<_>>();
    let removed_main_exports = main
        .exports
        .iter()
        .filter(|export| !retained.contains(&export.name))
        .map(|export| export.name.clone())
        .collect::<Vec<_>>();
    let mut retained_counts = BTreeMap::new();
    let mut removed_counts = BTreeMap::new();
    for export in &main.exports {
        let counts = if retained.contains(&export.name) {
            &mut retained_counts
        } else {
            &mut removed_counts
        };
        *counts.entry(export.kind.clone()).or_default() += 1;
    }

    Ok(ClosureProof {
        schema: PROOF_SCHEMA,
        policy_id: POLICY_ID,
        analyzer_version: env!("CARGO_PKG_VERSION"),
        mandatory_policy_sha256: sha256_file(mandatory_path)?,
        declared_main_dlsym_policy_sha256: sha256_file(dlsym_path)?,
        main,
        sides,
        mandatory_runtime_exports: mandatory.into_iter().collect(),
        declared_main_dlsym_exports: declared_dlsym.into_iter().collect(),
        side_dynamic_imports,
        retained_main_exports,
        retained_main_export_descriptors,
        removed_main_export_count: removed_main_exports.len(),
        removed_main_export_names_sha256: name_set_sha256(&removed_main_exports),
        removed_main_exports,
        unresolved_main_requirements,
        mismatched_main_requirements,
        unresolved_side_dependencies,
        retained_counts,
        removed_counts,
    })
}

fn require_closed(proof: &ClosureProof) -> Result<()> {
    ensure!(
        proof.unresolved_main_requirements.is_empty()
            && proof.mismatched_main_requirements.is_empty()
            && proof.unresolved_side_dependencies.is_empty(),
        "export closure is open: unresolved-main={:?} mismatched-main={:?} unresolved-sides={:?}",
        proof.unresolved_main_requirements,
        proof.mismatched_main_requirements,
        proof.unresolved_side_dependencies
    );
    Ok(())
}

fn encode_export_section(exports: &[&Export]) -> Vec<u8> {
    let mut section = ExportSection::new();
    for export in exports {
        let kind = match export.external_kind {
            ExternalKind::Func => EncoderExportKind::Func,
            ExternalKind::Table => EncoderExportKind::Table,
            ExternalKind::Memory => EncoderExportKind::Memory,
            ExternalKind::Global => EncoderExportKind::Global,
            ExternalKind::Tag => EncoderExportKind::Tag,
            ExternalKind::FuncExact => unreachable!("exact functions are forbidden in exports"),
        };
        section.export(&export.name, kind, export.index);
    }
    let mut encoded = Vec::new();
    wasm_encoder::Section::append_to(&section, &mut encoded);
    encoded
}

fn read_uleb(bytes: &[u8], cursor: &mut usize) -> Result<u32> {
    let mut result = 0_u32;
    for shift in (0..35).step_by(7) {
        let byte = *bytes.get(*cursor).context("truncated section length")?;
        *cursor += 1;
        ensure!(shift != 28 || byte & 0xf0 == 0, "invalid u32 LEB128");
        result |= u32::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    bail!("invalid u32 LEB128")
}

fn rewrite_exports(input: &Path, output: &Path, allow: &BTreeSet<String>) -> Result<()> {
    let bytes = fs::read(input).with_context(|| format!("read {}", input.display()))?;
    ensure!(
        bytes.starts_with(b"\0asm\x01\0\0\0"),
        "not a core wasm v1 module"
    );
    let summary = analyze(input)?;
    let existing = summary
        .exports
        .iter()
        .map(|export| export.name.clone())
        .collect::<BTreeSet<_>>();
    let missing = allow.difference(&existing).cloned().collect::<Vec<_>>();
    ensure!(
        missing.is_empty(),
        "allowlist names absent from module: {missing:?}"
    );
    let retained = summary
        .exports
        .iter()
        .filter(|export| allow.contains(&export.name))
        .collect::<Vec<_>>();
    let replacement = encode_export_section(&retained);

    let mut out = bytes[..8].to_vec();
    let mut cursor = 8;
    let mut export_sections = 0;
    while cursor < bytes.len() {
        let section_start = cursor;
        let id = bytes[cursor];
        cursor += 1;
        let length = read_uleb(&bytes, &mut cursor)? as usize;
        let payload_end = cursor
            .checked_add(length)
            .context("section length overflow")?;
        ensure!(payload_end <= bytes.len(), "truncated section {id}");
        if id == 7 {
            export_sections += 1;
            out.extend_from_slice(&replacement);
        } else {
            out.extend_from_slice(&bytes[section_start..payload_end]);
        }
        cursor = payload_end;
    }
    ensure!(
        export_sections == 1,
        "expected exactly one export section, got {export_sections}"
    );
    Validator::new_with_features(WasmFeatures::default() | WasmFeatures::THREADS)
        .validate_all(&out)
        .context("validate rewritten module")?;
    fs::write(output, &out).with_context(|| format!("write {}", output.display()))?;

    let rewritten = analyze(output)?;
    let actual = rewritten
        .exports
        .iter()
        .map(|export| export.name.clone())
        .collect::<BTreeSet<_>>();
    ensure!(
        &actual == allow,
        "rewritten export set does not equal allowlist"
    );
    ensure!(
        summary.local_functions == rewritten.local_functions
            && summary.local_globals == rewritten.local_globals,
        "export rewrite unexpectedly changed local definitions"
    );
    ensure!(
        summary.non_export_sections_sha256 == rewritten.non_export_sections_sha256,
        "export rewrite changed a non-export section"
    );
    Ok(())
}

fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

#[allow(clippy::too_many_arguments)]
fn attest_final(
    seed_path: &Path,
    final_path: &Path,
    mandatory_path: &Path,
    dlsym_path: &Path,
    allowlist_path: &Path,
    seed_proof_path: &Path,
    final_proof_path: &Path,
    receipt_path: &Path,
    dce_sha256: &str,
    dce_version: &str,
    side_manifest_sha256: &str,
    side_paths: &[PathBuf],
) -> Result<()> {
    ensure_sha256("DCE tool identity", dce_sha256)?;
    ensure_sha256("side manifest identity", side_manifest_sha256)?;
    ensure!(
        !dce_version.is_empty() && !dce_version.contains(['\n', '\r']),
        "DCE tool version is empty or multiline"
    );
    let sides = side_paths
        .iter()
        .map(|path| analyze(path))
        .collect::<Result<Vec<_>>>()?;
    let seed = compute_proof(
        analyze(seed_path)?,
        sides.clone(),
        mandatory_path,
        dlsym_path,
    )?;
    require_closed(&seed)?;
    let mut final_proof = compute_proof(analyze(final_path)?, sides, mandatory_path, dlsym_path)?;
    // The final bytes are analyzed from a private transaction path, but the
    // published proof describes their canonical installed identity. Reusing
    // the seed's logical path prevents a staging-directory name from escaping
    // into an otherwise content-addressed receipt chain.
    final_proof.main.path.clone_from(&seed.main.path);
    require_closed(&final_proof)?;

    let expected_names = seed
        .retained_main_exports
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let allowlist = read_names(allowlist_path)?;
    ensure!(
        allowlist == expected_names,
        "published allowlist does not equal the derived seed closure"
    );
    let final_names = final_proof
        .main
        .exports
        .iter()
        .map(|export| export.name.clone())
        .collect::<BTreeSet<_>>();
    ensure!(
        final_names == expected_names,
        "final exports do not exactly equal the derived seed closure"
    );
    ensure!(
        final_proof.removed_main_exports.is_empty(),
        "final module retains exports outside the closure"
    );

    let seed_descriptors = seed
        .main
        .exports
        .iter()
        .filter(|export| expected_names.contains(&export.name))
        .map(|export| {
            (
                export.name.clone(),
                (export.kind.clone(), export.descriptor.clone()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for export in &final_proof.main.exports {
        let expected = seed_descriptors
            .get(&export.name)
            .with_context(|| format!("final export {} was not in seed closure", export.name))?;
        ensure!(
            expected == &(export.kind.clone(), export.descriptor.clone()),
            "final export {} changed descriptor: seed={expected:?} final={:?}",
            export.name,
            (export.kind.clone(), export.descriptor.clone())
        );
    }
    ensure!(
        seed.main.element_function_entries == final_proof.main.element_function_entries
            && seed.main.element_unique_function_indices
                == final_proof.main.element_unique_function_indices,
        "DCE changed the main function-table initializer inventory"
    );
    ensure!(
        final_proof.main.local_functions <= seed.main.local_functions
            && final_proof.main.local_globals <= seed.main.local_globals,
        "DCE increased a local definition count"
    );
    ensure!(
        final_proof.main.local_functions < seed.main.local_functions
            || final_proof.main.local_globals < seed.main.local_globals,
        "DCE did not remove any local functions or globals"
    );

    let seed_snapshot = StructuralSnapshot::new(&seed.main)?;
    let final_snapshot = StructuralSnapshot::new(&final_proof.main)?;
    let seed_bytes = json_bytes(&seed)?;
    let final_bytes = json_bytes(&final_proof)?;
    let current_exe = env::current_exe().context("resolve analyzer executable")?;
    let receipt = StructuralReceipt {
        schema: RECEIPT_SCHEMA,
        policy_id: POLICY_ID,
        analyzer_version: env!("CARGO_PKG_VERSION"),
        analyzer_binary_sha256: sha256_file(&current_exe)?,
        dce_tool_sha256: dce_sha256.to_owned(),
        dce_tool_version: dce_version.to_owned(),
        dce_passes: [DCE_PASS],
        mandatory_policy_sha256: seed.mandatory_policy_sha256.clone(),
        declared_main_dlsym_policy_sha256: seed.declared_main_dlsym_policy_sha256.clone(),
        side_manifest_sha256: side_manifest_sha256.to_owned(),
        allowlist_sha256: sha256_file(allowlist_path)?,
        seed_proof_sha256: sha256(&seed_bytes),
        final_proof_sha256: sha256(&final_bytes),
        seed: seed_snapshot,
        final_module: final_snapshot,
        sides: seed
            .sides
            .iter()
            .map(|side| SideIdentity {
                path: side.path.clone(),
                sha256: side.sha256.clone(),
            })
            .collect(),
    };
    let receipt_bytes = json_bytes(&receipt)?;
    write_bytes(seed_proof_path, &seed_bytes)?;
    write_bytes(final_proof_path, &final_bytes)?;
    write_bytes(receipt_path, &receipt_bytes)?;
    Ok(())
}

fn usage() -> ! {
    eprintln!(
        "usage:\n  oliphaunt-wasix-sealed-export-closure analyze MAIN MANDATORY DLSYM SIDE...\n  oliphaunt-wasix-sealed-export-closure seal MAIN MANDATORY DLSYM PROOF ALLOWLIST SIDE...\n  oliphaunt-wasix-sealed-export-closure rewrite INPUT ALLOWLIST OUTPUT\n  oliphaunt-wasix-sealed-export-closure attest-final SEED FINAL MANDATORY DLSYM ALLOWLIST SEED_PROOF FINAL_PROOF RECEIPT DCE_SHA256 DCE_VERSION SIDE_MANIFEST_SHA256 SIDE..."
    );
    std::process::exit(2)
}

fn next_path(args: &mut impl Iterator<Item = std::ffi::OsString>) -> PathBuf {
    PathBuf::from(args.next().unwrap_or_else(|| usage()))
}

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let Some(command) = args.next() else { usage() };
    match command.to_string_lossy().as_ref() {
        "analyze" => {
            let main = next_path(&mut args);
            let mandatory = next_path(&mut args);
            let dlsym = next_path(&mut args);
            let side_paths = args.map(PathBuf::from).collect::<Vec<_>>();
            let sides = side_paths
                .iter()
                .map(|path| analyze(path))
                .collect::<Result<Vec<_>>>()?;
            let proof = compute_proof(analyze(&main)?, sides, &mandatory, &dlsym)?;
            let bytes = json_bytes(&proof)?;
            print!("{}", String::from_utf8(bytes).unwrap());
            require_closed(&proof)?;
        }
        "seal" => {
            let main = next_path(&mut args);
            let mandatory = next_path(&mut args);
            let dlsym = next_path(&mut args);
            let proof_path = next_path(&mut args);
            let allowlist_path = next_path(&mut args);
            let side_paths = args.map(PathBuf::from).collect::<Vec<_>>();
            let sides = side_paths
                .iter()
                .map(|path| analyze(path))
                .collect::<Result<Vec<_>>>()?;
            let proof = compute_proof(analyze(&main)?, sides, &mandatory, &dlsym)?;
            require_closed(&proof)?;
            write_bytes(&proof_path, &json_bytes(&proof)?)?;
            let mut allowlist = proof.retained_main_exports.clone();
            allowlist.sort();
            allowlist.dedup();
            write_bytes(
                &allowlist_path,
                format!("{}\n", allowlist.join("\n")).as_bytes(),
            )?;
            println!(
                "proof={} allowlist={} retained={} removed={}",
                proof_path.display(),
                allowlist_path.display(),
                proof.retained_main_exports.len(),
                proof.removed_main_exports.len()
            );
        }
        "rewrite" => {
            let input = next_path(&mut args);
            let allowlist = next_path(&mut args);
            let output = next_path(&mut args);
            ensure!(args.next().is_none(), "too many arguments");
            rewrite_exports(&input, &output, &read_names(&allowlist)?)?;
            let before = analyze(&input)?;
            let after = analyze(&output)?;
            println!(
                "input-sha256={} output-sha256={} exports-before={} exports-after={} local-functions={} local-globals={}",
                before.sha256,
                after.sha256,
                before.exports.len(),
                after.exports.len(),
                after.local_functions,
                after.local_globals
            );
        }
        "attest-final" => {
            let seed = next_path(&mut args);
            let final_module = next_path(&mut args);
            let mandatory = next_path(&mut args);
            let dlsym = next_path(&mut args);
            let allowlist = next_path(&mut args);
            let seed_proof = next_path(&mut args);
            let final_proof = next_path(&mut args);
            let receipt = next_path(&mut args);
            let dce_sha256 = args
                .next()
                .unwrap_or_else(|| usage())
                .to_string_lossy()
                .into_owned();
            let dce_version = args
                .next()
                .unwrap_or_else(|| usage())
                .to_string_lossy()
                .into_owned();
            let side_manifest_sha256 = args
                .next()
                .unwrap_or_else(|| usage())
                .to_string_lossy()
                .into_owned();
            let sides = args.map(PathBuf::from).collect::<Vec<_>>();
            ensure!(!sides.is_empty(), "at least one side module is required");
            attest_final(
                &seed,
                &final_module,
                &mandatory,
                &dlsym,
                &allowlist,
                &seed_proof,
                &final_proof,
                &receipt,
                &dce_sha256,
                &dce_version,
                &side_manifest_sha256,
                &sides,
            )?;
            println!(
                "attested final sealed module: seed-proof={} final-proof={} structural-receipt={}",
                seed_proof.display(),
                final_proof.display(),
                receipt.display()
            );
        }
        _ => usage(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use wasm_encoder::{
        CodeSection, ConstExpr, EntityType, ExportKind, ExportSection, Function, FunctionSection,
        GlobalSection, GlobalType, ImportSection, Instruction, Module, StartSection, TypeSection,
        ValType,
    };

    use super::{analyze, attest_final, compute_proof, require_closed, rewrite_exports};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "oliphaunt-sealed-export-test-{}-{}-{name}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn main_module() -> Vec<u8> {
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function([ValType::I32], [ValType::I32]);
        types.ty().function([], []);
        module.section(&types);
        let mut functions = FunctionSection::new();
        functions.function(0);
        functions.function(1);
        functions.function(1);
        module.section(&functions);
        let mut globals = GlobalSection::new();
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: false,
                shared: false,
            },
            &ConstExpr::i32_const(1),
        );
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: false,
                shared: false,
            },
            &ConstExpr::i32_const(2),
        );
        module.section(&globals);
        let mut exports = ExportSection::new();
        exports.export("required", ExportKind::Func, 0);
        exports.export("runtime", ExportKind::Func, 1);
        exports.export("extra-function", ExportKind::Func, 2);
        exports.export("extra-global", ExportKind::Global, 1);
        module.section(&exports);
        module.section(&StartSection { function_index: 1 });
        let mut code = CodeSection::new();
        let mut required = Function::new([]);
        required.instruction(&Instruction::LocalGet(0));
        required.instruction(&Instruction::End);
        code.function(&required);
        for _ in 0..2 {
            let mut body = Function::new([]);
            body.instruction(&Instruction::End);
            code.function(&body);
        }
        module.section(&code);
        module.finish()
    }

    fn final_main_module() -> Vec<u8> {
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function([ValType::I32], [ValType::I32]);
        types.ty().function([], []);
        module.section(&types);
        let mut functions = FunctionSection::new();
        functions.function(0);
        functions.function(1);
        module.section(&functions);
        let mut exports = ExportSection::new();
        exports.export("required", ExportKind::Func, 0);
        exports.export("runtime", ExportKind::Func, 1);
        module.section(&exports);
        module.section(&StartSection { function_index: 1 });
        let mut code = CodeSection::new();
        let mut required = Function::new([]);
        required.instruction(&Instruction::LocalGet(0));
        required.instruction(&Instruction::End);
        code.function(&required);
        let mut runtime = Function::new([]);
        runtime.instruction(&Instruction::End);
        code.function(&runtime);
        module.section(&code);
        module.finish()
    }

    fn side_module(param: ValType, got_func: bool) -> Vec<u8> {
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function([param], [ValType::I32]);
        module.section(&types);
        let mut imports = ImportSection::new();
        if got_func {
            imports.import(
                "GOT.func",
                "required",
                EntityType::Global(GlobalType {
                    val_type: ValType::I32,
                    mutable: false,
                    shared: false,
                }),
            );
        } else {
            imports.import("env", "required", EntityType::Function(0));
        }
        module.section(&imports);
        module.finish()
    }

    fn exact_function_side_module() -> Vec<u8> {
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function([ValType::I32], [ValType::I32]);
        module.section(&types);
        let mut imports = ImportSection::new();
        imports.import("env", "required", EntityType::FunctionExact(0));
        module.section(&imports);
        module.finish()
    }

    fn write_policy(names: &[&str]) -> PathBuf {
        let path = path("policy.txt");
        fs::write(&path, format!("{}\n", names.join("\n"))).unwrap();
        path
    }

    #[test]
    fn exact_function_signatures_are_part_of_the_closure() {
        let main_path = path("main.wasm");
        let good_side_path = path("good-side.wasm");
        let bad_side_path = path("bad-side.wasm");
        fs::write(&main_path, main_module()).unwrap();
        fs::write(&good_side_path, side_module(ValType::I32, false)).unwrap();
        fs::write(&bad_side_path, side_module(ValType::I64, false)).unwrap();
        let mandatory = write_policy(&["runtime"]);
        let dlsym = write_policy(&[]);

        let good = compute_proof(
            analyze(&main_path).unwrap(),
            vec![analyze(&good_side_path).unwrap()],
            &mandatory,
            &dlsym,
        )
        .unwrap();
        require_closed(&good).unwrap();
        let bad = compute_proof(
            analyze(&main_path).unwrap(),
            vec![analyze(&bad_side_path).unwrap()],
            &mandatory,
            &dlsym,
        )
        .unwrap();
        assert_eq!(bad.mismatched_main_requirements.len(), 1);

        for file in [main_path, good_side_path, bad_side_path, mandatory, dlsym] {
            fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn got_func_is_typed_as_a_function_address_not_a_global_provider() {
        let main_path = path("got-main.wasm");
        let side_path = path("got-side.wasm");
        fs::write(&main_path, main_module()).unwrap();
        fs::write(&side_path, side_module(ValType::I32, true)).unwrap();
        let mandatory = write_policy(&["runtime"]);
        let dlsym = write_policy(&[]);
        let proof = compute_proof(
            analyze(&main_path).unwrap(),
            vec![analyze(&side_path).unwrap()],
            &mandatory,
            &dlsym,
        )
        .unwrap();
        require_closed(&proof).unwrap();
        assert!(proof.retained_main_exports.contains(&"required".to_owned()));
        for file in [main_path, side_path, mandatory, dlsym] {
            fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn unsupported_exact_function_imports_fail_closed() {
        let side_path = path("exact-function-side.wasm");
        fs::write(&side_path, exact_function_side_module()).unwrap();
        let error = analyze(&side_path).unwrap_err().to_string();
        assert!(
            error.contains("unsupported exact-function import")
                || error.contains("validate exact-function-side.wasm"),
            "unexpected exact-function rejection: {error}"
        );
        fs::remove_file(side_path).unwrap();
    }

    #[test]
    fn undeclared_or_absent_dlsym_root_fails_closed() {
        let main_path = path("dlsym-main.wasm");
        let side_path = path("dlsym-side.wasm");
        fs::write(&main_path, main_module()).unwrap();
        fs::write(&side_path, side_module(ValType::I32, false)).unwrap();
        let mandatory = write_policy(&["runtime"]);
        let dlsym = write_policy(&["unknown-runtime-symbol"]);
        let proof = compute_proof(
            analyze(&main_path).unwrap(),
            vec![analyze(&side_path).unwrap()],
            &mandatory,
            &dlsym,
        )
        .unwrap();
        assert_eq!(
            proof.unresolved_main_requirements,
            ["unknown-runtime-symbol"]
        );
        for file in [main_path, side_path, mandatory, dlsym] {
            fs::remove_file(file).unwrap();
        }
    }

    #[test]
    fn rewrite_changes_only_the_export_surface() {
        let input = path("rewrite-input.wasm");
        let output = path("rewrite-output.wasm");
        fs::write(&input, main_module()).unwrap();
        rewrite_exports(
            &input,
            &output,
            &BTreeSet::from(["required".to_owned(), "runtime".to_owned()]),
        )
        .unwrap();
        let before = analyze(&input).unwrap();
        let after = analyze(&output).unwrap();
        assert_eq!(before.local_functions, after.local_functions);
        assert_eq!(before.local_globals, after.local_globals);
        assert_eq!(
            before.non_export_sections_sha256,
            after.non_export_sections_sha256
        );
        fs::remove_file(input).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn final_attestation_binds_seed_final_and_side_identity() {
        let seed = path("attest-seed.wasm");
        let final_module = path("attest-final.wasm");
        let side = path("attest-side.wasm");
        let allowlist = path("attest-allowlist.txt");
        let seed_proof = path("attest-seed-proof.json");
        let final_proof = path("attest-final-proof.json");
        let receipt = path("attest-receipt.json");
        fs::write(&seed, main_module()).unwrap();
        fs::write(&final_module, final_main_module()).unwrap();
        fs::write(&side, side_module(ValType::I32, false)).unwrap();
        fs::write(&allowlist, b"required\nruntime\n").unwrap();
        let mandatory = write_policy(&["runtime"]);
        let dlsym = write_policy(&[]);
        attest_final(
            &seed,
            &final_module,
            &mandatory,
            &dlsym,
            &allowlist,
            &seed_proof,
            &final_proof,
            &receipt,
            &"a".repeat(64),
            "wasm-opt test",
            &"b".repeat(64),
            std::slice::from_ref(&side),
        )
        .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        assert_eq!(value["seed"]["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(value["final-module"]["sha256"].as_str().unwrap().len(), 64);
        let seed_value: serde_json::Value =
            serde_json::from_slice(&fs::read(&seed_proof).unwrap()).unwrap();
        let final_value: serde_json::Value =
            serde_json::from_slice(&fs::read(&final_proof).unwrap()).unwrap();
        assert_eq!(final_value["main"]["path"], seed_value["main"]["path"]);
        for file in [
            seed,
            final_module,
            side,
            allowlist,
            seed_proof,
            final_proof,
            receipt,
            mandatory,
            dlsym,
        ] {
            fs::remove_file(file).unwrap();
        }
    }
}
