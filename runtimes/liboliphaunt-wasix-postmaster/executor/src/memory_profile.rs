//! Versioned, fail-closed linear-memory policy for the embedded postmaster.
//!
//! This is intentionally a product profile rather than a change to Wasmer's
//! generic defaults. The AOT producer and compiler-free executor select the
//! same profile without an environment or CLI override, while carrier
//! admission checks the resulting serialized allocation plan.

use anyhow::{Error, Result, bail, ensure};
use wasmer::sys::{
    BaseTunables, SerializedLinearMemoryPlan, SerializedLinearMemoryStyle, Tunables,
};
use wasmer_types::{MemoryType, Pages, target::PointerWidth, target::Target};
use wasmer_vm::MemoryStyle;

/// Identifier of the first bounded embedded-postmaster linear-memory profile.
pub const EMBEDDED_256M_V1_ID: &str =
    "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1";

/// WebAssembly page size used by the profile.
pub const WASM_PAGE_BYTES: u64 = 65_536;

/// Exact guest-visible maximum, in WebAssembly pages.
pub const EMBEDDED_256M_V1_MAXIMUM_PAGES: u32 = 4_096;

/// Exact maximum and static reservation bound, in bytes.
pub const EMBEDDED_256M_V1_MAXIMUM_BYTES: u64 =
    (EMBEDDED_256M_V1_MAXIMUM_PAGES as u64) * WASM_PAGE_BYTES;

/// Exact U64 static reservation required by Wasmer's unchecked LLVM accesses.
pub const EMBEDDED_256M_V1_STATIC_BOUND_PAGES: u32 = 65_536;

/// Exact U64 offset guard required by Wasmer's unchecked LLVM accesses.
pub const EMBEDDED_256M_V1_OFFSET_GUARD_BYTES: u64 = 0x8000_0000;

/// Maximum injected by the pinned WASIX compiler wrapper before sealing.
pub const PINNED_WASIXCC_MAXIMUM_PAGES: u32 = 65_536;

/// A closed set of product linear-memory profiles.
///
/// Adding a profile requires a new enum variant, carrier schema identity, and
/// qualification evidence. Runtime strings never construct arbitrary bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinearMemoryProfile {
    /// 256 MiB guest maximum with Wasmer's U64 4 GiB + 2 GiB trap reservation.
    Embedded256MiBV1,
}

impl LinearMemoryProfile {
    /// Return the only profile selected by the current embedded product.
    pub const fn embedded() -> Self {
        Self::Embedded256MiBV1
    }

    /// Return the stable profile identifier.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Embedded256MiBV1 => EMBEDDED_256M_V1_ID,
        }
    }

    /// Return the maximum number of WebAssembly pages.
    pub const fn maximum_pages(self) -> u32 {
        match self {
            Self::Embedded256MiBV1 => EMBEDDED_256M_V1_MAXIMUM_PAGES,
        }
    }

    /// Return the maximum number of linear-memory bytes.
    pub const fn maximum_bytes(self) -> u64 {
        match self {
            Self::Embedded256MiBV1 => EMBEDDED_256M_V1_MAXIMUM_BYTES,
        }
    }

    /// Return the static reservation bound in WebAssembly pages.
    pub const fn static_bound_pages(self) -> u32 {
        match self {
            Self::Embedded256MiBV1 => EMBEDDED_256M_V1_STATIC_BOUND_PAGES,
        }
    }

    /// Return the static offset guard in bytes.
    pub const fn offset_guard_bytes(self) -> u64 {
        match self {
            Self::Embedded256MiBV1 => EMBEDDED_256M_V1_OFFSET_GUARD_BYTES,
        }
    }

    fn tunables(self, target: &Target, boundary: &str) -> Result<BaseTunables> {
        let pointer_width = target.triple().pointer_width().map_err(|error| {
            Error::msg(format!("derive {boundary} host pointer width: {error:?}"))
        })?;
        ensure!(
            pointer_width == PointerWidth::U64,
            "{boundary} profile '{}' requires a U64 host because Wasmer's LLVM static-memory access lowering relies on the 4 GiB reservation and 2 GiB guard; got {pointer_width:?}",
            self.id()
        );
        ensure!(
            self.maximum_pages() < PINNED_WASIXCC_MAXIMUM_PAGES,
            "bounded profile must exclude the Wasm32 65536th-page end-wrap boundary"
        );
        let tunables = BaseTunables::for_target(target);
        ensure!(
            tunables.static_memory_bound.0 == self.static_bound_pages()
                && tunables.static_memory_offset_guard_size == self.offset_guard_bytes(),
            "{boundary} Wasmer U64 defaults drifted from profile '{}': bound={} guard={}",
            self.id(),
            tunables.static_memory_bound.0,
            tunables.static_memory_offset_guard_size
        );
        Ok(tunables)
    }
}

/// Derive compiler tunables for the explicit embedded profile.
pub fn compiler_tunables_for_target(target: &Target) -> Result<BaseTunables> {
    LinearMemoryProfile::embedded().tunables(target, "AOT compiler")
}

/// Derive compiler-free executor tunables for the explicit embedded profile.
pub fn executor_tunables_for_target(target: &Target) -> Result<BaseTunables> {
    LinearMemoryProfile::embedded().tunables(target, "headless executor")
}

/// Return the expected module memory type used to prove the selected tunables.
pub fn admitted_memory_type(minimum_pages: u32) -> Result<MemoryType> {
    let profile = LinearMemoryProfile::embedded();
    ensure!(
        minimum_pages <= profile.maximum_pages(),
        "initial memory exceeds profile maximum"
    );
    Ok(MemoryType::new(
        Pages(minimum_pages),
        Some(Pages(profile.maximum_pages())),
        true,
    ))
}

/// Describe and validate the style derived by one tunables boundary.
pub fn derived_static_style(tunables: &BaseTunables, minimum_pages: u32) -> Result<(u32, u64)> {
    let profile = LinearMemoryProfile::embedded();
    match tunables.memory_style(&admitted_memory_type(minimum_pages)?) {
        MemoryStyle::Static {
            bound,
            offset_guard_size,
        } => {
            ensure!(
                bound.0 == profile.static_bound_pages()
                    && offset_guard_size == profile.offset_guard_bytes(),
                "derived static style differs from profile '{}'",
                profile.id()
            );
            Ok((bound.0, offset_guard_size))
        }
        MemoryStyle::Dynamic { .. } => {
            bail!("bounded profile unexpectedly derived a moving dynamic memory style")
        }
    }
}

/// Reject an AOT artifact unless its module type and compiled allocation plan
/// exactly match the selected U64 trap-preserving embedded profile.
pub fn validate_serialized_memory_plans(plans: &[SerializedLinearMemoryPlan]) -> Result<()> {
    let profile = LinearMemoryProfile::embedded();
    ensure!(
        plans.len() == 1,
        "profile '{}' requires exactly one linear memory, found {}",
        profile.id(),
        plans.len()
    );
    let plan = plans[0];
    ensure!(
        plan.minimum_pages <= profile.maximum_pages(),
        "artifact initial memory exceeds profile maximum"
    );
    ensure!(
        plan.maximum_pages == Some(profile.maximum_pages()),
        "artifact maximum memory differs from profile '{}': {:?}",
        profile.id(),
        plan.maximum_pages
    );
    ensure!(plan.shared, "artifact linear memory is not shared");
    ensure!(
        plan.maximum_pages.unwrap() < PINNED_WASIXCC_MAXIMUM_PAGES,
        "artifact admits the Wasm32 65536th-page end-wrap boundary"
    );
    ensure!(
        plan.style
            == SerializedLinearMemoryStyle::Static {
                bound_pages: profile.static_bound_pages(),
                offset_guard_bytes: profile.offset_guard_bytes(),
            },
        "artifact linear-memory style is not the exact nonmoving profile: {:?}",
        plan.style
    );
    Ok(())
}

#[cfg(feature = "memory-profile-tool")]
mod wasm_tool {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        ops::Range,
        path::Path,
    };

    use anyhow::{Context, Result, bail, ensure};
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use wasmparser::{BinaryReader, Imports, Parser, Payload, TypeRef, Validator, WasmFeatures};

    use super::{LinearMemoryProfile, PINNED_WASIXCC_MAXIMUM_PAGES};
    use crate::SEALED_MODULE_TRANSFORMATION_ID;

    /// Schema emitted by the exact module memory-contract sealer.
    pub const RECEIPT_SCHEMA: &str = "oliphaunt.wasix-postmaster.linear-memory-module.v1";

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct RawMemoryContract {
        initial_pages: u64,
        maximum_pages: Option<u64>,
        shared: bool,
        memory64: bool,
        page_size_log2: Option<u32>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "kebab-case")]
    struct ModuleReceipt<'a> {
        schema: &'static str,
        profile_id: &'static str,
        module_sha256: String,
        source_module_sha256: Option<String>,
        import_module: &'static str,
        import_name: &'static str,
        address_width: &'static str,
        initial_pages: u64,
        maximum_pages: u64,
        maximum_bytes: u64,
        shared: bool,
        static_bound_pages: u32,
        static_offset_guard_bytes: u64,
        excludes_wasm32_end_wrap: bool,
        transformation: &'a str,
    }

    fn validate_wasm(bytes: &[u8]) -> Result<()> {
        Validator::new_with_features(WasmFeatures::default() | WasmFeatures::THREADS)
            .validate_all(bytes)
            .context("validate WebAssembly module")?;
        Ok(())
    }

    fn raw_memory_contract(bytes: &[u8]) -> Result<RawMemoryContract> {
        validate_wasm(bytes)?;
        let mut memory_imports = Vec::new();
        let mut defined_memories = 0_u32;
        for payload in Parser::new(0).parse_all(bytes) {
            match payload? {
                Payload::ImportSection(section) => {
                    for import in section.into_imports() {
                        let import = import?;
                        if let TypeRef::Memory(memory) = import.ty {
                            memory_imports.push((
                                import.module.to_owned(),
                                import.name.to_owned(),
                                RawMemoryContract {
                                    initial_pages: memory.initial,
                                    maximum_pages: memory.maximum,
                                    shared: memory.shared,
                                    memory64: memory.memory64,
                                    page_size_log2: memory.page_size_log2,
                                },
                            ));
                        }
                    }
                }
                Payload::MemorySection(section) => {
                    defined_memories += section.count();
                }
                _ => {}
            }
        }
        ensure!(
            defined_memories == 0,
            "profile requires imported linear memory; found {defined_memories} defined memories"
        );
        ensure!(
            memory_imports.len() == 1,
            "profile requires exactly one memory import, found {}",
            memory_imports.len()
        );
        let (module, name, memory) = memory_imports.pop().unwrap();
        ensure!(
            module == "env" && name == "memory",
            "profile requires the exact env.memory import, found {module}.{name}"
        );
        ensure!(!memory.memory64, "profile requires Wasm32 linear memory");
        ensure!(memory.shared, "profile requires shared linear memory");
        ensure!(
            matches!(memory.page_size_log2, None | Some(16)),
            "profile requires the standard 64 KiB WebAssembly page"
        );
        let maximum = memory
            .maximum_pages
            .context("shared memory has no explicit maximum")?;
        ensure!(
            maximum <= u64::from(PINNED_WASIXCC_MAXIMUM_PAGES),
            "memory maximum exceeds Wasm32"
        );
        ensure!(
            memory.initial_pages <= maximum,
            "memory minimum exceeds maximum"
        );
        Ok(memory)
    }

    fn imported_memory_maximum_span(
        bytes: &[u8],
        expected: RawMemoryContract,
    ) -> Result<Range<usize>> {
        let mut maximum_span = None;
        for payload in Parser::new(0).parse_all(bytes) {
            let Payload::ImportSection(section) = payload? else {
                continue;
            };
            let section_end = section.range().end;
            for imports in section {
                let Imports::Single(offset, import) = imports? else {
                    bail!("compact import encodings are not supported by the memory sealer");
                };
                let TypeRef::Memory(memory) = import.ty else {
                    continue;
                };
                ensure!(
                    maximum_span.is_none(),
                    "profile requires exactly one memory import"
                );
                ensure!(
                    import.module == "env" && import.name == "memory",
                    "profile requires the exact env.memory import"
                );

                // Parse only the validated import entry to locate its encoded
                // maximum. Re-encoding the module would also canonicalize
                // wasm-ld's relocation-width LEBs and invalidate raw custom
                // sections such as DWARF.
                let mut reader = BinaryReader::new(&bytes[offset..section_end], offset);
                ensure!(
                    reader.read_string()? == import.module,
                    "import module drifted"
                );
                ensure!(reader.read_string()? == import.name, "import name drifted");
                ensure!(reader.read_u8()? == 0x02, "memory import kind drifted");
                let flags = reader.read_u8()?;
                ensure!(flags & !0b1111 == 0, "invalid memory limits flags");
                let has_maximum = flags & 0b0001 != 0;
                let shared = flags & 0b0010 != 0;
                let memory64 = flags & 0b0100 != 0;
                let has_page_size = flags & 0b1000 != 0;
                ensure!(!memory64, "profile requires Wasm32 linear memory");
                ensure!(shared, "profile requires shared linear memory");
                ensure!(has_maximum, "shared memory has no explicit maximum");

                let initial = u64::from(reader.read_var_u32()?);
                let start = reader.original_position();
                let maximum = u64::from(reader.read_var_u32()?);
                let end = reader.original_position();
                let page_size_log2 = has_page_size.then(|| reader.read_var_u32()).transpose()?;
                ensure!(
                    initial == memory.initial
                        && maximum == memory.maximum.context("memory maximum disappeared")?
                        && memory64 == memory.memory64
                        && shared == memory.shared
                        && page_size_log2 == memory.page_size_log2,
                    "raw memory import differs from its parsed contract"
                );
                ensure!(
                    expected
                        == (RawMemoryContract {
                            initial_pages: initial,
                            maximum_pages: Some(maximum),
                            shared,
                            memory64,
                            page_size_log2,
                        }),
                    "located memory import differs from the validated module contract"
                );
                maximum_span = Some(start..end);
            }
        }
        maximum_span.context("validated env.memory import was not located")
    }

    fn encode_u32_leb_exact_width(value: u32, width: usize) -> Result<Vec<u8>> {
        ensure!((1..=5).contains(&width), "invalid u32 LEB width {width}");
        let mut remaining = u64::from(value);
        let mut encoded = Vec::with_capacity(width);
        for index in 0..width {
            let last = index + 1 == width;
            let byte = (remaining & 0x7f) as u8;
            remaining >>= 7;
            if last {
                ensure!(
                    remaining == 0,
                    "value {value} does not fit LEB width {width}"
                );
                encoded.push(byte);
            } else {
                encoded.push(byte | 0x80);
            }
        }
        Ok(encoded)
    }

    fn rewrite_memory_maximum(
        bytes: &[u8],
        contract: RawMemoryContract,
        maximum_pages: u32,
    ) -> Result<(Vec<u8>, Range<usize>)> {
        let span = imported_memory_maximum_span(bytes, contract)?;
        let replacement = encode_u32_leb_exact_width(maximum_pages, span.len())?;
        let mut rewritten = bytes.to_vec();
        rewritten[span.clone()].copy_from_slice(&replacement);
        ensure!(
            rewritten.len() == bytes.len(),
            "memory rewrite changed module length"
        );
        ensure!(
            rewritten[..span.start] == bytes[..span.start]
                && rewritten[span.end..] == bytes[span.end..],
            "memory rewrite changed bytes outside the maximum field"
        );
        Ok((rewritten, span))
    }

    fn receipt<'a>(
        bytes: &[u8],
        source_bytes: Option<&[u8]>,
        contract: RawMemoryContract,
        transformation: &'a str,
    ) -> Result<ModuleReceipt<'a>> {
        let profile = LinearMemoryProfile::embedded();
        ensure!(
            contract.maximum_pages == Some(u64::from(profile.maximum_pages())),
            "module maximum does not match profile '{}'",
            profile.id()
        );
        ensure!(
            contract.initial_pages <= u64::from(profile.maximum_pages()),
            "module minimum exceeds profile maximum"
        );
        ensure!(
            profile.maximum_pages() < PINNED_WASIXCC_MAXIMUM_PAGES,
            "profile does not exclude the Wasm32 65536th-page boundary"
        );
        Ok(ModuleReceipt {
            schema: RECEIPT_SCHEMA,
            profile_id: profile.id(),
            module_sha256: hex::encode(Sha256::digest(bytes)),
            source_module_sha256: source_bytes.map(|source| hex::encode(Sha256::digest(source))),
            import_module: "env",
            import_name: "memory",
            address_width: "wasm32",
            initial_pages: contract.initial_pages,
            maximum_pages: profile.maximum_pages().into(),
            maximum_bytes: profile.maximum_bytes(),
            shared: contract.shared,
            static_bound_pages: profile.static_bound_pages(),
            static_offset_guard_bytes: profile.offset_guard_bytes(),
            excludes_wasm32_end_wrap: true,
            transformation,
        })
    }

    fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("create {}", path.display()))?;
        output
            .write_all(bytes)
            .with_context(|| format!("write {}", path.display()))?;
        output
            .sync_all()
            .with_context(|| format!("sync {}", path.display()))?;
        Ok(())
    }

    /// Verify a module already sealed to the selected profile and emit its
    /// canonical receipt JSON.
    pub fn verify_module_bytes(bytes: &[u8]) -> Result<String> {
        let contract = raw_memory_contract(bytes)?;
        let receipt = receipt(bytes, None, contract, "verified-existing-v1")?;
        serde_json::to_string_pretty(&receipt).context("serialize module memory receipt")
    }

    /// Verify a module file already sealed to the selected profile and emit
    /// its canonical receipt JSON.
    pub fn verify_module(path: &Path) -> Result<String> {
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        verify_module_bytes(&bytes)
    }

    /// Rewrite only a pinned-toolchain module's encoded memory maximum into
    /// the selected profile, prove the same-width edit is byte-reversible, and
    /// write new module/receipt files.
    pub fn seal_module(input: &Path, output: &Path, receipt_path: &Path) -> Result<()> {
        let source = fs::read(input).with_context(|| format!("read {}", input.display()))?;
        let source_contract = raw_memory_contract(&source)?;
        ensure!(
            source_contract.maximum_pages == Some(u64::from(PINNED_WASIXCC_MAXIMUM_PAGES)),
            "sealer input must carry the pinned wasixcc {}-page maximum, found {:?}",
            PINNED_WASIXCC_MAXIMUM_PAGES,
            source_contract.maximum_pages
        );
        let profile = LinearMemoryProfile::embedded();
        ensure!(
            source_contract.initial_pages <= u64::from(profile.maximum_pages()),
            "module minimum cannot fit the selected profile"
        );
        let (sealed, maximum_span) =
            rewrite_memory_maximum(&source, source_contract, profile.maximum_pages())?;
        let sealed_contract = raw_memory_contract(&sealed)?;
        ensure!(
            sealed_contract.maximum_pages == Some(u64::from(profile.maximum_pages())),
            "sealed module maximum differs"
        );
        let sealed_span = imported_memory_maximum_span(&sealed, sealed_contract)?;
        ensure!(
            sealed_span == maximum_span,
            "memory-maximum field moved during the same-width rewrite"
        );
        let (reversed, reversed_span) =
            rewrite_memory_maximum(&sealed, sealed_contract, PINNED_WASIXCC_MAXIMUM_PAGES)?;
        ensure!(
            reversed_span == maximum_span && reversed == source,
            "memory-maximum transformation changed bytes outside its reversible field"
        );
        let receipt = receipt(
            &sealed,
            Some(&source),
            sealed_contract,
            SEALED_MODULE_TRANSFORMATION_ID,
        )?;
        let mut receipt_bytes =
            serde_json::to_vec_pretty(&receipt).context("serialize module memory receipt")?;
        receipt_bytes.push(b'\n');
        write_new(output, &sealed)?;
        if let Err(error) = write_new(receipt_path, &receipt_bytes) {
            let _ = fs::remove_file(output);
            return Err(error);
        }
        Ok(())
    }

    /// Return a canonical JSON object describing the selected profile.
    pub fn profile_json() -> Result<String> {
        let profile = LinearMemoryProfile::embedded();
        #[derive(Serialize)]
        #[serde(rename_all = "kebab-case")]
        struct Profile {
            id: &'static str,
            address_width: &'static str,
            supported_host_pointer_width: &'static str,
            maximum_pages: u32,
            maximum_bytes: u64,
            static_bound_pages: u32,
            static_offset_guard_bytes: u64,
            static_access_lowering: &'static str,
            requires_shared: bool,
            requires_import: &'static str,
            excludes_wasm32_end_wrap: bool,
        }
        serde_json::to_string_pretty(&Profile {
            id: profile.id(),
            address_width: "wasm32",
            supported_host_pointer_width: "u64",
            maximum_pages: profile.maximum_pages(),
            maximum_bytes: profile.maximum_bytes(),
            static_bound_pages: profile.static_bound_pages(),
            static_offset_guard_bytes: profile.offset_guard_bytes(),
            static_access_lowering: "wasmer-llvm-unchecked-reservation-and-guard-v1",
            requires_shared: true,
            requires_import: "env.memory",
            excludes_wasm32_end_wrap: true,
        })
        .context("serialize linear-memory profile")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn selected_profile_is_strictly_below_wasm32_end_wrap() {
            let profile = LinearMemoryProfile::embedded();
            assert_eq!(profile.maximum_pages(), 4_096);
            assert_eq!(profile.maximum_bytes(), 256 * 1024 * 1024);
            assert!(profile.maximum_pages() < PINNED_WASIXCC_MAXIMUM_PAGES);
            assert_eq!(super::super::WASM_PAGE_BYTES, 65_536);
        }

        #[test]
        fn sealer_changes_only_the_explicit_memory_maximum() {
            let source = wat::parse_str(
                r#"(module $named_module
                    (import "env" "memory" (memory 2 65536 shared))
                    (func $read (export "read") (result i32)
                        i32.const 0
                        i32.load))"#,
            )
            .unwrap();
            let directory = tempfile::tempdir().unwrap();
            let input = directory.path().join("input.wasm");
            let output = directory.path().join("sealed.wasm");
            let receipt_path = directory.path().join("receipt.json");
            fs::write(&input, &source).unwrap();

            seal_module(&input, &output, &receipt_path).unwrap();
            let sealed = fs::read(&output).unwrap();
            let contract = raw_memory_contract(&sealed).unwrap();
            assert_eq!(contract.maximum_pages, Some(4_096));
            assert_eq!(contract.initial_pages, 2);
            assert!(contract.shared);
            let receipt: serde_json::Value =
                serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
            assert_eq!(
                receipt["source-module-sha256"],
                hex::encode(Sha256::digest(&source))
            );
            assert_eq!(
                receipt["module-sha256"],
                hex::encode(Sha256::digest(&sealed))
            );
            assert_eq!(receipt["transformation"], SEALED_MODULE_TRANSFORMATION_ID);
            verify_module_bytes(&sealed).unwrap();
        }

        #[test]
        fn sealer_preserves_relocation_width_immediates() {
            // wasm-ld emits padded relocation-width LEBs. The function body
            // contains global.get 0 as `23 80 80 80 80 00`; canonicalizing it
            // would shift code offsets without updating raw DWARF sections.
            let source = hex::decode(concat!(
                "0061736d01000000010401600000021b0203656e76066d656d6f7279",
                "02030280800403656e760167037f00030201000a0b0109002380808080001a0b"
            ))
            .unwrap();
            validate_wasm(&source).unwrap();
            let source_contract = raw_memory_contract(&source).unwrap();
            let maximum_span = imported_memory_maximum_span(&source, source_contract).unwrap();
            assert_eq!(maximum_span, 31..34);
            assert_eq!(&source[maximum_span.clone()], &[0x80, 0x80, 0x04]);

            let directory = tempfile::tempdir().unwrap();
            let input = directory.path().join("input.wasm");
            let output = directory.path().join("sealed.wasm");
            let receipt = directory.path().join("receipt.json");
            fs::write(&input, &source).unwrap();
            seal_module(&input, &output, &receipt).unwrap();

            let sealed = fs::read(output).unwrap();
            assert_eq!(sealed.len(), source.len());
            assert_eq!(&sealed[maximum_span.clone()], &[0x80, 0xa0, 0x00]);
            assert_eq!(&sealed[..maximum_span.start], &source[..maximum_span.start]);
            assert_eq!(&sealed[maximum_span.end..], &source[maximum_span.end..]);
            assert!(
                sealed
                    .windows(6)
                    .any(|bytes| bytes == [0x23, 0x80, 0x80, 0x80, 0x80, 0x00])
            );
            let changed: Vec<_> = source
                .iter()
                .zip(&sealed)
                .enumerate()
                .filter_map(|(index, (before, after))| (before != after).then_some(index))
                .collect();
            assert_eq!(changed, [32, 33]);

            let sealed_contract = raw_memory_contract(&sealed).unwrap();
            assert_eq!(sealed_contract.maximum_pages, Some(4_096));
            let (restored, restored_span) =
                rewrite_memory_maximum(&sealed, sealed_contract, PINNED_WASIXCC_MAXIMUM_PAGES)
                    .unwrap();
            assert_eq!(restored_span, maximum_span);
            assert_eq!(restored, source);
            verify_module_bytes(&sealed).unwrap();
        }

        #[test]
        fn exact_width_u32_leb_encoding_fails_closed() {
            assert_eq!(
                encode_u32_leb_exact_width(4_096, 3).unwrap(),
                [0x80, 0xa0, 0x00]
            );
            assert_eq!(
                encode_u32_leb_exact_width(65_536, 3).unwrap(),
                [0x80, 0x80, 0x04]
            );
            assert_eq!(
                encode_u32_leb_exact_width(u32::MAX, 5).unwrap(),
                [0xff, 0xff, 0xff, 0xff, 0x0f]
            );
            assert!(encode_u32_leb_exact_width(128, 1).is_err());
            assert!(encode_u32_leb_exact_width(0, 0).is_err());
            assert!(encode_u32_leb_exact_width(0, 6).is_err());
        }

        #[test]
        fn invalid_memory_import_shapes_fail_closed() {
            for wat in [
                r#"(module (import "other" "memory" (memory 2 65536 shared)))"#,
                r#"(module (memory 2 4 shared))"#,
                r#"(module
                    (import "env" "memory" (memory 2 65536 shared))
                    (memory 2 4 shared))"#,
                r#"(module
                    (import "env" "memory" (memory 2 65536 shared))
                    (import "env" "memory2" (memory 2 65536 shared)))"#,
            ] {
                assert!(raw_memory_contract(&wat::parse_str(wat).unwrap()).is_err());
            }

            let compact = hex::decode(concat!(
                "0061736d0100000002150103656e76007f01066d656d6f7279",
                "020302808004"
            ))
            .unwrap();
            let expected = RawMemoryContract {
                initial_pages: 2,
                maximum_pages: Some(65_536),
                shared: true,
                memory64: false,
                page_size_log2: None,
            };
            assert!(imported_memory_maximum_span(&compact, expected).is_err());
        }
    }
}

#[cfg(feature = "memory-profile-tool")]
pub use wasm_tool::{profile_json, seal_module, verify_module, verify_module_bytes};

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use wasmer_types::target::{CpuFeature, Target, Triple};

    use super::*;

    fn target(triple: &str) -> Target {
        Target::new(Triple::from_str(triple).unwrap(), CpuFeature::set())
    }

    #[test]
    fn compiler_and_executor_independently_derive_exact_u64_trap_style() {
        let target = target("x86_64-unknown-linux-gnu");
        let compiler = compiler_tunables_for_target(&target).unwrap();
        let executor = executor_tunables_for_target(&target).unwrap();
        assert_eq!(
            derived_static_style(&compiler, 41).unwrap(),
            (65_536, 2_147_483_648)
        );
        assert_eq!(
            derived_static_style(&executor, 41).unwrap(),
            (65_536, 2_147_483_648)
        );
    }

    #[test]
    fn u32_host_fails_closed_instead_of_using_unchecked_compact_static_memory() {
        let target = target("i686-unknown-linux-gnu");
        assert!(compiler_tunables_for_target(&target).is_err());
        assert!(executor_tunables_for_target(&target).is_err());
    }

    #[test]
    fn serialized_plan_rejects_dynamic_or_wasm32_end_wrap_profiles() {
        let valid = SerializedLinearMemoryPlan {
            minimum_pages: 41,
            maximum_pages: Some(4_096),
            shared: true,
            style: SerializedLinearMemoryStyle::Static {
                bound_pages: 65_536,
                offset_guard_bytes: 2_147_483_648,
            },
        };
        validate_serialized_memory_plans(&[valid]).unwrap();

        let dynamic = SerializedLinearMemoryPlan {
            style: SerializedLinearMemoryStyle::Dynamic {
                offset_guard_bytes: 2_147_483_648,
            },
            ..valid
        };
        assert!(validate_serialized_memory_plans(&[dynamic]).is_err());

        let wrap = SerializedLinearMemoryPlan {
            maximum_pages: Some(65_536),
            style: SerializedLinearMemoryStyle::Static {
                bound_pages: 65_536,
                offset_guard_bytes: 2_147_483_648,
            },
            ..valid
        };
        assert!(validate_serialized_memory_plans(&[wrap]).is_err());
    }
}
