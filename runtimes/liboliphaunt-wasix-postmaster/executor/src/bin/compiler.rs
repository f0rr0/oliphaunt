use std::{env, ffi::OsString, fs, num::NonZeroUsize, path::PathBuf};

use anyhow::{Context, Result, bail, ensure};
use oliphaunt_wasix_postmaster_executor::memory_profile::{
    LinearMemoryProfile, compiler_tunables_for_target, derived_static_style,
    validate_serialized_memory_plans, verify_module_bytes,
};
use wasmer::{
    Engine, Module,
    sys::{CompilerConfig, NativeEngineExt},
};
use wasmer_compiler_llvm::{LLVM, LLVMOptLevel};
use wasmer_types::{
    Features, ModuleHash,
    target::{CpuFeature, Target, Triple},
};

const USAGE: &str = "usage: oliphaunt-wasix-postmaster-compiler --llvm --llvm-opt-level aggressive [--compiler-threads N] --enable-exceptions --enable-threads -o OUTPUT MODULE\n       oliphaunt-wasix-postmaster-compiler verify-aot MODULE ARTIFACT";

#[derive(Debug)]
struct Options {
    input: PathBuf,
    output: PathBuf,
    compiler_threads: Option<NonZeroUsize>,
}

fn take_value(arguments: &[OsString], index: &mut usize, option: &str) -> Result<OsString> {
    *index += 1;
    arguments
        .get(*index)
        .cloned()
        .with_context(|| format!("{option} requires a value; {USAGE}"))
}

fn parse() -> Result<Option<Options>> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() == 1 && arguments[0] == "--version" {
        println!(
            "oliphaunt-wasix-postmaster-compiler {} {}",
            oliphaunt_wasix_postmaster_executor::VERSION,
            LinearMemoryProfile::embedded().id()
        );
        return Ok(None);
    }

    let mut llvm = false;
    let mut exceptions = false;
    let mut threads = false;
    let mut output = None;
    let mut input = None;
    let mut compiler_threads = None;
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        match argument.to_str() {
            Some("--llvm") => llvm = true,
            Some("--enable-exceptions") => exceptions = true,
            Some("--enable-threads") => threads = true,
            Some("--llvm-opt-level") => {
                let value =
                    take_value(&arguments, &mut index, argument.to_string_lossy().as_ref())?;
                ensure!(
                    value == "aggressive",
                    "the product compiler requires --llvm-opt-level aggressive"
                );
            }
            Some("--compiler-threads") => {
                let value =
                    take_value(&arguments, &mut index, argument.to_string_lossy().as_ref())?;
                let parsed = value
                    .to_str()
                    .context("compiler thread count is not UTF-8")?
                    .parse::<usize>()
                    .context("compiler thread count is not an integer")?;
                compiler_threads = Some(
                    NonZeroUsize::new(parsed).context("compiler thread count must be positive")?,
                );
            }
            Some("-o") => {
                ensure!(output.is_none(), "output path was supplied more than once");
                output = Some(PathBuf::from(take_value(&arguments, &mut index, "-o")?));
            }
            Some(value) if value.starts_with('-') => {
                bail!("unsupported option '{value}'; {USAGE}")
            }
            _ => {
                ensure!(
                    input.is_none(),
                    "more than one input module was supplied; {USAGE}"
                );
                input = Some(PathBuf::from(argument));
            }
        }
        index += 1;
    }
    ensure!(llvm, "the product compiler requires --llvm");
    ensure!(
        exceptions,
        "the product compiler requires --enable-exceptions"
    );
    ensure!(threads, "the product compiler requires --enable-threads");
    Ok(Some(Options {
        input: input.with_context(|| USAGE.to_owned())?,
        output: output.with_context(|| USAGE.to_owned())?,
        compiler_threads,
    }))
}

fn main() -> Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.first().and_then(|value| value.to_str()) == Some("verify-aot") {
        ensure!(arguments.len() == 3, "verify-aot requires MODULE ARTIFACT");
        return verify_aot(PathBuf::from(&arguments[1]), PathBuf::from(&arguments[2]));
    }
    let Some(options) = parse()? else {
        return Ok(());
    };
    let module_bytes = fs::read(&options.input)
        .with_context(|| format!("read sealed module {}", options.input.display()))?;
    verify_module_bytes(&module_bytes)
        .with_context(|| format!("admit sealed module {}", options.input.display()))?;

    let mut compiler = LLVM::new();
    compiler
        .opt_level(LLVMOptLevel::Aggressive)
        .non_volatile_memops(true)
        .readonly_funcref_table(true);
    if let Some(threads) = options.compiler_threads {
        compiler.num_threads(threads);
    }

    // The carrier promises a relocatable architecture baseline. Never inherit
    // host features here: doing so would make an otherwise receipt-identical
    // artifact capable of trapping with SIGILL on an older embedded host.
    let target = Target::new(Triple::host(), CpuFeature::set());
    let tunables = compiler_tunables_for_target(&target)
        .context("derive product compiler linear-memory profile")?;
    let (static_bound_pages, static_offset_guard_bytes) = derived_static_style(&tunables, 0)
        .context("prove product compiler linear-memory allocation style")?;
    let mut features = Features::default();
    features.threads(true).exceptions(true);
    let mut engine = Engine::new(
        Box::new(compiler) as Box<dyn CompilerConfig>,
        target,
        features,
    );
    engine.set_tunables(tunables);

    eprintln!(
        "Compiler: llvm; profile: {}; guest-max-pages: {}; static-bound-pages: {}; static-offset-guard-bytes: {}",
        LinearMemoryProfile::embedded().id(),
        LinearMemoryProfile::embedded().maximum_pages(),
        static_bound_pages,
        static_offset_guard_bytes
    );
    let module = Module::new(&engine, &module_bytes)
        .with_context(|| format!("compile sealed module {}", options.input.display()))?;
    module
        .serialize_to_file(&options.output)
        .with_context(|| format!("write AOT artifact {}", options.output.display()))?;
    Ok(())
}

fn verify_aot(module_path: PathBuf, artifact_path: PathBuf) -> Result<()> {
    let module_bytes = fs::read(&module_path)
        .with_context(|| format!("read sealed module {}", module_path.display()))?;
    verify_module_bytes(&module_bytes)
        .with_context(|| format!("admit sealed module {}", module_path.display()))?;
    let target = Target::new(Triple::host(), CpuFeature::set());
    let tunables = compiler_tunables_for_target(&target)
        .context("derive product verifier linear-memory profile")?;
    let mut features = Features::default();
    features.threads(true).exceptions(true);
    let mut compiler = LLVM::new();
    compiler
        .opt_level(LLVMOptLevel::Aggressive)
        .non_volatile_memops(true)
        .readonly_funcref_table(true);
    let mut engine = Engine::new(
        Box::new(compiler) as Box<dyn CompilerConfig>,
        target,
        features,
    );
    engine.set_tunables(tunables);

    let file = fs::File::open(&artifact_path)
        .with_context(|| format!("open AOT artifact {}", artifact_path.display()))?;
    let mapping = wasmer::sys::OwnedBuffer::from_file(&file)
        .with_context(|| format!("map AOT artifact {}", artifact_path.display()))?;
    let expected_hash = ModuleHash::new(&module_bytes);
    let inspected = engine
        .inspect_serialized_artifact(&mapping)
        .with_context(|| format!("inspect AOT artifact {}", artifact_path.display()))?;
    ensure!(
        inspected == expected_hash,
        "AOT embedded module hash differs"
    );
    // SAFETY: the exact opened artifact was structurally inspected above and
    // remains owned by this process. Dropping the pending activation rolls all
    // code registrations back after the allocation plan is attested.
    let pending = unsafe { engine.deserialize_from_mmapped_buffer_detached_pending(mapping) }
        .with_context(|| format!("admit AOT artifact {}", artifact_path.display()))?;
    ensure!(
        pending.module_hash() == Some(expected_hash),
        "activated AOT embedded module hash differs"
    );
    validate_serialized_memory_plans(&pending.linear_memory_plans())
        .context("AOT linear-memory allocation plan differs")?;
    println!("{}", expected_hash);
    Ok(())
}
