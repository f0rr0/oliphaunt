#[cfg(feature = "aot-serializer")]
use std::env;
#[cfg(feature = "aot-serializer")]
use std::fs;
#[cfg(feature = "aot-serializer")]
use std::io;
#[cfg(feature = "aot-serializer")]
use std::num::NonZeroUsize;
#[cfg(feature = "aot-serializer")]
use std::path::{Path, PathBuf};

#[cfg(feature = "aot-serializer")]
use anyhow::{Context, anyhow, ensure};
use anyhow::{Result, bail};
#[cfg(feature = "aot-serializer")]
use zstd::stream::write::Encoder as ZstdEncoder;

#[cfg(feature = "aot-serializer")]
use crate::value_after;

pub(crate) fn aot_serializer(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("serialize") => serialize_aot_cli(&args[1..]),
        Some("probe") => probe_aot_serializer_in_process(&args[1..]),
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
    validate_aot_options(args, true)?;
    let input = value_after(args, "--input")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("--input is required"))?;
    let output = value_after(args, "--output")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("--output is required"))?;
    serialize_aot_module(
        &input,
        &output,
        target_from_args(args)?,
        threads_from_args(args)?,
    )
}

#[cfg(not(feature = "aot-serializer"))]
fn probe_aot_serializer_in_process(_args: &[String]) -> Result<()> {
    bail!(
        "xtask aot-serializer probe requires `cargo run -p xtask --features aot-serializer -- ...`"
    )
}

#[cfg(feature = "aot-serializer")]
fn probe_aot_serializer_in_process(args: &[String]) -> Result<()> {
    validate_aot_options(args, false)?;
    let target = target_from_args(args)?;
    let threads = threads_from_args(args)?;
    let engine = llvm_aot_engine(&target, threads);
    let store = wasmer::Store::new(engine.clone());
    const EMPTY_WASM: &[u8] = b"\0asm\x01\0\0\0";
    let module =
        wasmer::Module::new(&store, EMPTY_WASM).context("compile LLVM AOT probe module")?;
    let serialized = module
        .serialize()
        .context("serialize LLVM AOT probe module")?;
    print_aot_engine_config(&engine, &target, threads);
    println!("serialized-probe-bytes: {}", serialized.len());
    Ok(())
}

#[cfg(feature = "aot-serializer")]
fn serialize_aot_module(
    input: &Path,
    output: &Path,
    target: wasmer_types::target::Target,
    threads: Option<NonZeroUsize>,
) -> Result<()> {
    let engine = llvm_aot_engine(&target, threads);
    print_aot_engine_config(&engine, &target, threads);
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
fn llvm_aot_config(threads: Option<NonZeroUsize>) -> wasmer::sys::LLVM {
    use wasmer::sys::{CompilerConfig, LLVM};

    let mut llvm = LLVM::default();
    if let Some(threads) = threads {
        llvm.num_threads(threads);
    }
    if env_flag("OLIPHAUNT_WASM_WASMER_PERFMAP") {
        llvm.enable_perfmap();
    }
    if env_flag_default_true("OLIPHAUNT_WASM_AOT_NON_VOLATILE_MEMOPS") {
        llvm.enable_non_volatile_memops();
    }
    if env_flag_default_true("OLIPHAUNT_WASM_AOT_READONLY_FUNCREF_TABLE") {
        llvm.enable_readonly_funcref_table();
    }
    llvm
}

#[cfg(feature = "aot-serializer")]
fn llvm_aot_engine(
    target: &wasmer_types::target::Target,
    threads: Option<NonZeroUsize>,
) -> wasmer::Engine {
    use wasmer::sys::{EngineBuilder, Features};

    let mut features = Features::new();
    features.exceptions(true);
    EngineBuilder::new(llvm_aot_config(threads))
        .set_target(Some(target.clone()))
        .set_features(Some(features))
        .engine()
        .into()
}

#[cfg(feature = "aot-serializer")]
fn target_from_args(args: &[String]) -> Result<wasmer_types::target::Target> {
    use wasmer_types::target::{Architecture, CpuFeature, Target, Triple};

    let mut requested = None;
    for (index, argument) in args.iter().enumerate() {
        if argument.starts_with("--target=") {
            bail!("use --target followed by a target triple");
        }
        if argument == "--target" {
            ensure!(requested.is_none(), "--target may appear only once");
            let value = args
                .get(index + 1)
                .context("--target requires a target triple")?;
            ensure!(
                !value.is_empty() && !value.starts_with("--"),
                "--target requires a target triple"
            );
            requested = Some(value);
        }
    }
    let triple = match requested {
        Some(value) => value
            .parse::<Triple>()
            .map_err(|error| anyhow!("invalid AOT target {value}: {error}"))?,
        None => Triple::host(),
    };
    let mut cpu_features = CpuFeature::set();
    match triple.architecture {
        Architecture::X86_64 => {
            cpu_features.insert(CpuFeature::SSE2);
        }
        Architecture::Aarch64(_) => {
            cpu_features.insert(CpuFeature::NEON);
        }
        _ => bail!(
            "unsupported AOT target architecture: {}",
            triple.architecture
        ),
    }

    Ok(Target::new(triple, cpu_features))
}

#[cfg(feature = "aot-serializer")]
fn threads_from_args(args: &[String]) -> Result<Option<NonZeroUsize>> {
    let mut requested = None;
    for (index, argument) in args.iter().enumerate() {
        if argument.starts_with("--threads=") {
            bail!("use --threads followed by a count from 1 through 64");
        }
        if argument == "--threads" {
            ensure!(requested.is_none(), "--threads may appear only once");
            let value = args.get(index + 1).context("--threads requires a count")?;
            let count = value
                .parse::<usize>()
                .context("--threads requires an integer from 1 through 64")?;
            ensure!(
                (1..=64).contains(&count),
                "--threads must be from 1 through 64"
            );
            requested = NonZeroUsize::new(count);
        }
    }
    Ok(requested)
}

#[cfg(feature = "aot-serializer")]
fn validate_aot_options(args: &[String], allow_io: bool) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    let mut arguments = args.iter();
    while let Some(option) = arguments.next() {
        ensure!(
            matches!(option.as_str(), "--target" | "--threads")
                || (allow_io && matches!(option.as_str(), "--input" | "--output")),
            "unknown AOT option {option}"
        );
        ensure!(seen.insert(option), "duplicate AOT option {option}");
        let value = arguments
            .next()
            .with_context(|| format!("{option} requires a value"))?;
        ensure!(
            !value.is_empty() && !value.starts_with("--"),
            "{option} requires a value"
        );
    }
    Ok(())
}

#[cfg(feature = "aot-serializer")]
fn print_aot_engine_config(
    engine: &wasmer::Engine,
    target: &wasmer_types::target::Target,
    threads: Option<NonZeroUsize>,
) {
    println!("wasmer-engine: llvm");
    println!("wasmer-engine-id: {}", engine.deterministic_id());
    println!("wasmer-target-triple: {}", target.triple());
    println!(
        "wasmer-target-cpu-features: {}",
        format_aot_cpu_features(target)
    );
    println!("wasmer-feature-exceptions: enabled");
    println!("wasmer-llvm-target-cpu: generic");
    println!(
        "wasmer-llvm-threads: {}",
        threads.map_or_else(|| "default".to_owned(), |count| count.to_string())
    );
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

#[cfg(all(test, feature = "aot-serializer"))]
mod tests {
    use super::*;

    #[test]
    fn explicit_targets_preserve_portable_cpu_baselines() {
        for (triple, baseline) in [
            ("x86_64-unknown-linux-gnu", "sse2"),
            ("x86_64-pc-windows-msvc", "sse2"),
            ("aarch64-apple-darwin", "neon"),
        ] {
            let target = target_from_args(&["--target".into(), triple.into()]).unwrap();
            assert_eq!(target.triple().to_string(), triple);
            assert_eq!(format_aot_cpu_features(&target), baseline);
        }
        assert_eq!(
            target_from_args(&[]).unwrap().triple(),
            &wasmer_types::target::Triple::host()
        );
    }

    #[test]
    fn target_arguments_fail_closed() {
        for args in [
            vec!["--target"],
            vec!["--target", "--input"],
            vec!["--target", "not-a-triple"],
            vec!["--target", "wasm32-unknown-unknown"],
            vec!["--target=invalid"],
            vec![
                "--target",
                "x86_64-unknown-linux-gnu",
                "--target",
                "aarch64-apple-darwin",
            ],
        ] {
            assert!(
                target_from_args(&args.into_iter().map(str::to_owned).collect::<Vec<_>>()).is_err()
            );
        }
    }

    #[test]
    fn target_thread_count_uses_the_llvm_setter_and_preserves_default() {
        assert_eq!(threads_from_args(&[]).unwrap(), None);
        for count in [1, 2, 64] {
            let threads = threads_from_args(&["--threads".into(), count.to_string()]).unwrap();
            assert_eq!(threads.unwrap().get(), count);
            assert!(
                format!("{:?}", llvm_aot_config(threads))
                    .contains(&format!("num_threads: {count}"))
            );
        }
        let default = std::thread::available_parallelism().unwrap_or(NonZeroUsize::new(1).unwrap());
        assert!(
            format!("{:?}", llvm_aot_config(None)).contains(&format!("num_threads: {default}"))
        );
    }

    #[test]
    fn target_thread_arguments_fail_closed() {
        for args in [
            vec!["--threads"],
            vec!["--threads", "--input"],
            vec!["--threads", "0"],
            vec!["--threads", "65"],
            vec!["--threads", "-1"],
            vec!["--threads", "many"],
            vec!["--threads", "184467440737095516160"],
            vec!["--threads=2"],
            vec!["--threads", "2", "--threads", "2"],
        ] {
            assert!(
                threads_from_args(&args.into_iter().map(str::to_owned).collect::<Vec<_>>())
                    .is_err()
            );
        }
    }

    #[test]
    fn target_cli_rejects_typos_and_ambiguous_input_options() {
        assert!(
            validate_aot_options(
                &[
                    "--target".into(),
                    "aarch64-apple-darwin".into(),
                    "--threads".into(),
                    "2".into()
                ],
                false
            )
            .is_ok()
        );
        for args in [
            vec!["--targte", "aarch64-apple-darwin"],
            vec!["--input", "--output"],
            vec!["--input", "one", "--input", "two"],
            vec!["--target=triple"],
            vec!["--threads", "2", "extra"],
        ] {
            assert!(
                validate_aot_options(
                    &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
                    true
                )
                .is_err()
            );
        }
        assert!(validate_aot_options(&["--input".into(), "one".into()], false).is_err());
    }
}
