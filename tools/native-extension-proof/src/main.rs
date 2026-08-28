#![allow(dead_code)]

include!("../../../src/sdks/rust/tests/native_extensions.rs");

fn parse_usize_flag(arguments: &[String], name: &str, default: usize) -> usize {
    let flag = format!("--{name}");
    for (index, argument) in arguments.iter().enumerate() {
        if argument == &flag {
            return arguments
                .get(index + 1)
                .unwrap_or_else(|| panic!("{flag} requires a value"))
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("{flag} must be an unsigned integer"));
        }
        if let Some(value) = argument.strip_prefix(&format!("{flag}=")) {
            return value
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("{flag} must be an unsigned integer"));
        }
    }
    default
}

fn main() {
    if let Some(result) = run_direct_extension_child_from_env() {
        result.expect("native extension proof direct child failed");
        return;
    }
    unsafe {
        std::env::set_var(RELEASE_PROOF_RUNNER_ENV, "1");
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().map(String::as_str) == Some("--native-tools-npm-smoke") {
        let command = arguments
            .get(1..)
            .filter(|arguments| arguments.first().map(String::as_str) == Some("--"))
            .and_then(|arguments| arguments.get(1..))
            .filter(|command| !command.is_empty())
            .expect("usage: oliphaunt-native-extension-proof --native-tools-npm-smoke -- COMMAND [ARG ...]");
        run_native_tools_npm_smoke(command).expect("packed native npm tools smoke failed");
        return;
    }
    let shard_index = parse_usize_flag(&arguments, "shard-index", 0);
    let shard_count = parse_usize_flag(&arguments, "shard-count", 1);
    run_native_extension_release_proof(shard_index, shard_count);
}

fn run_native_tools_npm_smoke(
    command: &[String],
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let root = unique_temp_root("native-tools-npm-smoke");
    let server = block_on(
        OliphauntServer::builder()
            .storage(DatabaseStorage::Directory(root.clone()))
            .extension(Extension::PGTAP)
            .start(),
    )?;
    let child = Command::new(&command[0])
        .args(&command[1..])
        .env(
            "OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING",
            server.connection_string(),
        )
        .status();
    let close = block_on(server.close());
    let _ = fs::remove_dir_all(&root);
    let status = child?;
    close?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "packed native npm tools smoke command exited with {status}"
        ))
        .into());
    }
    println!("OLIPHAUNT_NATIVE_TOOLS_NPM_SMOKE_PASS engines=node,bun,deno");
    Ok(())
}
