fn main() {
    let embedded = oliphaunt_build::embed_resolved_artifacts()
        .expect("validate and embed direct Core Cargo runtime resources");
    println!(
        "cargo::rustc-env=OLIPHAUNT_EMBEDDED_RESOURCES_RS={}",
        embedded.display()
    );
}
