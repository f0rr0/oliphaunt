mod build_support;

use std::env;

use build_support::{packaged_tools_dir, relay_manifest_instructions};

fn main() {
    let variables = env::vars().collect::<Vec<_>>();
    match relay_manifest_instructions(variables.clone()) {
        Ok(instructions) => {
            for instruction in instructions {
                println!("{instruction}");
            }
            match packaged_tools_dir(&variables) {
                Ok(Some(directory)) => println!(
                    "cargo::rustc-env=OLIPHAUNT_PACKAGED_TOOLS_DIR={}",
                    directory.display()
                ),
                Ok(None) => {}
                Err(error) => {
                    println!("cargo::error={error}");
                    panic!("oliphaunt-tools artifact resolution failed: {error}");
                }
            }
        }
        Err(error) => {
            println!("cargo::error={error}");
            panic!("oliphaunt-tools artifact relay failed: {error}");
        }
    }
}
