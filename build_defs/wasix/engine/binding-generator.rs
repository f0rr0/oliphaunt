use bindgen::callbacks::{ItemInfo, ParseCallbacks};

#[derive(Debug)]
struct Wee8Renamer;

impl ParseCallbacks for Wee8Renamer {
    fn generated_link_name_override(&self, item: ItemInfo<'_>) -> Option<String> {
        item.name
            .starts_with("wasm")
            .then(|| format!("wee8_{}", item.name))
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let [
        header,
        output,
        rustfmt,
        rustfmt_config,
        resource_headers,
        includes @ ..,
    ] = arguments.as_slice()
    else {
        return Err(
            "expected HEADER OUTPUT RUSTFMT RUSTFMT_CONFIG CLANG_RESOURCE_HEADERS SDK_INCLUDE..."
                .into(),
        );
    };
    if includes.is_empty() {
        return Err("declared Windows SDK include directories are required".into());
    }
    let mut builder = bindgen::Builder::default()
        .header(header)
        .clang_args([
            "--target=x86_64-pc-windows-msvc",
            "-nostdinc",
            "-isystem",
            resource_headers,
        ])
        .detect_include_paths(false)
        .derive_default(true)
        .derive_debug(true)
        .parse_callbacks(Box::new(Wee8Renamer))
        .rustfmt_configuration_file(Some(rustfmt_config.into()))
        .with_rustfmt(rustfmt);
    for include in includes {
        builder = builder.clang_args(["-isystem", include]);
    }
    builder.generate()?.write_to_file(output)?;
    Ok(())
}
