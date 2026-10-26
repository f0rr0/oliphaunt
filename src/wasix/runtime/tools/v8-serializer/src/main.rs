//! Native V8 serialization using the same engine facade as Windows consumers.
use std::path::PathBuf;

use anyhow::{Context, Result, ensure};

struct Options {
    input: PathBuf,
    output: PathBuf,
}

fn options(args: &[String]) -> Result<Options> {
    ensure!(
        args.len() == 8 && args[0] == "aot-serializer" && args[1] == "serialize",
        "usage: aot-serializer serialize --input FILE --output FILE --target x86_64-pc-windows-msvc"
    );
    let (mut input, mut output, mut target) = (None, None, None);
    for pair in args[2..].chunks_exact(2) {
        let slot = match pair[0].as_str() {
            "--input" => &mut input,
            "--output" => &mut output,
            "--target" => &mut target,
            other => anyhow::bail!("unknown V8 serializer option: {other}"),
        };
        ensure!(
            slot.is_none(),
            "duplicate V8 serializer option: {}",
            pair[0]
        );
        ensure!(
            !pair[1].is_empty() && !pair[1].starts_with("--"),
            "{} requires a value",
            pair[0]
        );
        *slot = Some(pair[1].as_str());
    }
    ensure!(
        target == Some("x86_64-pc-windows-msvc"),
        "V8 serialization requires its native Windows x64 target"
    );
    let input = PathBuf::from(input.context("--input is required")?);
    let output = PathBuf::from(output.context("--output is required")?);
    ensure!(
        input != output,
        "V8 serialization must preserve its portable input"
    );
    Ok(Options { input, output })
}

#[cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))]
fn serialize(options: &Options) -> Result<()> {
    use std::{fs, io};
    let engine: wasmer::Engine = wasmer::v8::V8::try_new()
        .context("initialize the declared Windows V8 engine")?
        .into();
    println!("wasmer-engine: v8");
    println!("wasmer-engine-id: {}", engine.deterministic_id());
    let store = wasmer::Store::new(engine);
    let bytes =
        fs::read(&options.input).with_context(|| format!("read {}", options.input.display()))?;
    let module = wasmer::Module::new(&store, &bytes)
        .with_context(|| format!("compile {}", options.input.display()))?;
    let serialized = module.serialize().context("serialize V8 module")?;
    if let Some(parent) = options.output.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::File::create(&options.output)?;
    let mut encoder = zstd::stream::write::Encoder::new(file, 19)?;
    io::copy(&mut serialized.as_ref(), &mut encoder)?;
    encoder.finish()?;
    println!(
        "serialized {} bytes to {}",
        serialized.len(),
        options.output.display()
    );
    Ok(())
}

fn main() -> Result<()> {
    let options = options(&std::env::args().skip(1).collect::<Vec<_>>())?;
    #[cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))]
    {
        serialize(&options)
    }
    #[cfg(not(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")))]
    {
        let _ = (options.input, options.output);
        anyhow::bail!("V8 serialization must execute on Windows x64 MSVC")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Options> {
        options(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn requires_exact_native_target_and_closed_options() {
        let valid = [
            "aot-serializer",
            "serialize",
            "--input",
            "guest.wasm",
            "--output",
            "guest.zst",
            "--target",
            "x86_64-pc-windows-msvc",
        ];
        let parsed = parse(&valid).unwrap();
        assert_eq!(parsed.input, PathBuf::from("guest.wasm"));
        assert_eq!(parsed.output, PathBuf::from("guest.zst"));
        for (index, replacement) in [
            (7, "x86_64-unknown-linux-gnu"),
            (4, "--input"),
            (2, "--inpt"),
            (3, "--output"),
            (5, "guest.wasm"),
        ] {
            let mut invalid = valid;
            invalid[index] = replacement;
            assert!(parse(&invalid).is_err(), "{replacement}");
        }
        assert!(parse(&valid[..7]).is_err());
    }

    #[test]
    #[cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))]
    fn production_image_round_trips_through_a_fresh_v8_engine() -> Result<()> {
        use std::fs;
        // (module (func (export "answer") (param i32) (result i32)
        //   local.get 0 i32.const 1 i32.add))
        const WASM: &[u8] = &[
            0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97,
            110, 115, 119, 101, 114, 0, 0, 10, 9, 1, 7, 0, 32, 0, 65, 1, 106, 11,
        ];
        let root = std::env::var_os("TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("v8-serializer-{}", std::process::id()));
        fs::create_dir_all(&root)?;
        let options = Options {
            input: root.join("module.wasm"),
            output: root.join("module.zst"),
        };
        fs::write(&options.input, WASM)?;
        serialize(&options)?;
        assert_eq!(fs::read(&options.input)?, WASM);
        let compressed = fs::read(&options.output)?;
        let serialized = zstd::stream::decode_all(compressed.as_slice())?;
        let engine: wasmer::Engine = wasmer::v8::V8::try_new()?.into();
        // SAFETY: these bytes came from this process's trusted production serializer.
        let module = unsafe { wasmer::Module::deserialize(&engine, serialized) }?;
        let mut store = wasmer::Store::new(engine);
        let instance = wasmer::Instance::new(&mut store, &module, &wasmer::imports! {})?;
        let answer = instance
            .exports
            .get_typed_function::<i32, i32>(&store, "answer")?;
        assert_eq!(answer.call(&mut store, 41)?, 42);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
