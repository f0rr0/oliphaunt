#[cfg(feature = "aot-serializer")]
use std::env;
#[cfg(feature = "aot-serializer")]
use std::fs;
#[cfg(feature = "aot-serializer")]
use std::io;
#[cfg(feature = "aot-serializer")]
use std::path::{Path, PathBuf};

#[cfg(feature = "aot-serializer")]
use anyhow::{Context, anyhow};
use anyhow::{Result, bail};
#[cfg(feature = "aot-serializer")]
use zstd::stream::write::Encoder as ZstdEncoder;

#[cfg(feature = "aot-serializer")]
use crate::value_after;

pub(crate) fn aot_serializer(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("serialize") => serialize_aot_cli(&args[1..]),
        Some("probe") => probe_aot_serializer_in_process(),
        Some(other) => bail!("unknown aot-serializer subcommand: {other}"),
        None => bail!(
            "usage: cargo run -p xtask --features aot-serializer -- aot-serializer <serialize|probe>"
        ),
    }
}

#[cfg(not(feature = "aot-serializer"))]
fn serialize_aot_cli(_args: &[String]) -> Result<()> {
    bail!("xtask aot-serializer requires `cargo run -p xtask --features aot-serializer -- ...`")
}

#[cfg(feature = "aot-serializer")]
fn serialize_aot_cli(args: &[String]) -> Result<()> {
    let input = value_after(args, "--input")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("--input is required"))?;
    let output = value_after(args, "--output")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("--output is required"))?;
    serialize_aot_module(&input, &output)
}

#[cfg(not(feature = "aot-serializer"))]
fn probe_aot_serializer_in_process() -> Result<()> {
    bail!(
        "xtask aot-serializer probe requires `cargo run -p xtask --features aot-serializer -- ...`"
    )
}

#[cfg(feature = "aot-serializer")]
fn probe_aot_serializer_in_process() -> Result<()> {
    let engine = llvm_aot_engine();
    let store = wasmer::Store::new(engine.clone());
    const EMPTY_WASM: &[u8] = b"\0asm\x01\0\0\0";
    let module =
        wasmer::Module::new(&store, EMPTY_WASM).context("compile LLVM AOT probe module")?;
    let serialized = module
        .serialize()
        .context("serialize LLVM AOT probe module")?;
    print_aot_engine_config(&engine);
    println!("serialized-probe-bytes: {}", serialized.len());
    Ok(())
}

#[cfg(feature = "aot-serializer")]
fn serialize_aot_module(input: &Path, output: &Path) -> Result<()> {
    let engine = llvm_aot_engine();
    print_aot_engine_config(&engine);
    println!("host-target: {}-{}", env::consts::OS, env::consts::ARCH);

    let store = wasmer::Store::new(engine);
    let bytes = fs::read(input).with_context(|| format!("read {}", input.display()))?;
    let module = wasmer::Module::new(&store, &bytes)
        .with_context(|| format!("compile {}", input.display()))?;
    let serialized = module.serialize().context("serialize module")?;

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let file = fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
    let mut encoder = ZstdEncoder::new(file, 19)
        .with_context(|| format!("create zstd encoder for {}", output.display()))?;
    let mut serialized_slice = serialized.as_ref();
    io::copy(&mut serialized_slice, &mut encoder)
        .with_context(|| format!("write {}", output.display()))?;
    encoder
        .finish()
        .with_context(|| format!("finish {}", output.display()))?;
    println!(
        "serialized {} bytes to {}",
        serialized.len(),
        output.display()
    );
    Ok(())
}

#[cfg(feature = "aot-serializer")]
fn llvm_aot_engine() -> wasmer::Engine {
    use wasmer::sys::{CompilerConfig, EngineBuilder, Features, LLVM};

    let mut features = Features::new();
    features.exceptions(true);
    let mut llvm = LLVM::default();
    if env_flag("OLIPHAUNT_WASM_WASMER_PERFMAP") {
        llvm.enable_perfmap();
    }
    if env_flag_default_true("OLIPHAUNT_WASM_AOT_NON_VOLATILE_MEMOPS") {
        llvm.enable_non_volatile_memops();
    }
    if env_flag_default_true("OLIPHAUNT_WASM_AOT_READONLY_FUNCREF_TABLE") {
        llvm.enable_readonly_funcref_table();
    }
    EngineBuilder::new(llvm)
        .set_target(Some(portable_aot_target()))
        .set_features(Some(features))
        .engine()
        .into()
}

#[cfg(feature = "aot-serializer")]
fn portable_aot_target() -> wasmer_types::target::Target {
    use wasmer_types::target::{Architecture, CpuFeature, Target, Triple};

    let triple = Triple::host();
    let mut cpu_features = CpuFeature::set();
    match triple.architecture {
        Architecture::X86_64 => {
            cpu_features.insert(CpuFeature::SSE2);
        }
        Architecture::Aarch64(_) => {
            cpu_features.insert(CpuFeature::NEON);
        }
        _ => {}
    }

    Target::new(triple, cpu_features)
}

#[cfg(feature = "aot-serializer")]
fn print_aot_engine_config(engine: &wasmer::Engine) {
    let target = portable_aot_target();
    println!("wasmer-engine: llvm");
    println!("wasmer-engine-id: {}", engine.deterministic_id());
    println!("wasmer-target-triple: {}", target.triple());
    println!(
        "wasmer-target-cpu-features: {}",
        format_aot_cpu_features(&target)
    );
    println!("wasmer-feature-exceptions: enabled");
    println!("wasmer-llvm-target-cpu: generic");
    println!(
        "wasmer-llvm-non-volatile-memops: {}",
        enabled_label(env_flag_default_true(
            "OLIPHAUNT_WASM_AOT_NON_VOLATILE_MEMOPS"
        ))
    );
    println!(
        "wasmer-llvm-readonly-funcref-table: {}",
        enabled_label(env_flag_default_true(
            "OLIPHAUNT_WASM_AOT_READONLY_FUNCREF_TABLE"
        ))
    );
}

#[cfg(feature = "aot-serializer")]
fn format_aot_cpu_features(target: &wasmer_types::target::Target) -> String {
    let mut features = target
        .cpu_features()
        .iter()
        .map(|feature| feature.to_string())
        .collect::<Vec<_>>();
    features.sort();
    if features.is_empty() {
        "none".to_owned()
    } else {
        features.join(",")
    }
}

#[cfg(feature = "aot-serializer")]
fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            let value = value.trim();
            !value.is_empty()
                && !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
        })
        .unwrap_or(false)
}

#[cfg(feature = "aot-serializer")]
fn env_flag_default_true(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            let value = value.trim();
            !matches!(
                value.to_ascii_lowercase().as_str(),
                "" | "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(true)
}

#[cfg(feature = "aot-serializer")]
fn enabled_label(enabled: bool) -> &'static str {
    if enabled { "enabled" } else { "disabled" }
}
