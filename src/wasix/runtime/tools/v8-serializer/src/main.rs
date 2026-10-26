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

fn main() -> Result<()> {
    let options = options(&std::env::args().skip(1).collect::<Vec<_>>())?;
    #[cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))]
    {
        use std::{fs, io};
        let engine: wasmer::Engine = wasmer::v8::V8::try_new()
            .context("initialize the declared Windows V8 engine")?
            .into();
        println!("wasmer-engine: v8");
        println!("wasmer-engine-id: {}", engine.deterministic_id());
        let store = wasmer::Store::new(engine);
        let bytes = fs::read(&options.input)
            .with_context(|| format!("read {}", options.input.display()))?;
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
}
