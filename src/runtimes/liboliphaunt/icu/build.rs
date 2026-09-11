use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const ARTIFACT_SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const ARTIFACT_PRODUCT: &str = "oliphaunt-icu";
const ARTIFACT_KIND: &str = "icu-data";
const ARTIFACT_TARGET: &str = "portable";

fn main() {
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_ICU_DATA_DIR");
    println!("cargo:rerun-if-env-changed=OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    if let Some(icu_root) = find_icu_data_root() {
        emit_rerun_directives(&icu_root);
        emit_icu_artifact(&out_dir, &icu_root);
    } else {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("release packaging requires package-local ICU data under payload/share/icu");
        }
        fs::write(out_dir.join("native_icu.rs"), "&[]\n").expect("write empty native ICU index");
    }
}

fn emit_icu_artifact(out_dir: &Path, icu_root: &Path) {
    let data_tree_sha256 = logical_tree_sha256(icu_root).expect("digest ICU logical data tree");
    let receipt = out_dir.join("native-icu.properties");
    fs::write(&receipt, format!("schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256={data_tree_sha256}\n")).expect("write native ICU receipt");
    emit_artifact_manifest(out_dir, icu_root, &receipt);
    let mut native = String::from("&[\n");
    for file in collect_files(icu_root)
        .expect("collect native ICU files")
        .into_iter()
        .chain([receipt.clone()])
    {
        let relative = if file == receipt {
            "manifest.properties".to_owned()
        } else {
            format!(
                "share/icu/{}",
                file.strip_prefix(icu_root)
                    .expect("ICU file path")
                    .to_string_lossy()
                    .replace('\\', "/")
            )
        };
        let digest = sha256_file(&file).expect("hash native ICU file");
        native.push_str(&format!(
            "({:?}, include_bytes!({:?}), {digest:?}, false),\n",
            format!("icu-data/oliphaunt-icu/{relative}"),
            file
        ));
    }
    if let Some((target, seed_root)) = native_seed_root() {
        println!("cargo:rerun-if-changed={}", seed_root.display());
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            assert!(
                seed_root.join("manifest.properties").is_file(),
                "native ICU seed missing for {target}"
            );
        }
        for directory in
            collect_directories(&seed_root).expect("collect native ICU seed directories")
        {
            let relative = directory
                .strip_prefix(&seed_root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let name = format!("icu-data/oliphaunt-icu/native-seeds/{target}/{relative}/");
            native.push_str(&format!("({name:?}, b\"\", \"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\", false),\n"));
        }
        for file in collect_files(&seed_root).expect("collect native ICU seed files") {
            let relative = file
                .strip_prefix(&seed_root)
                .expect("seed file path")
                .to_string_lossy()
                .replace('\\', "/");
            let digest = sha256_file(&file).expect("hash native ICU seed file");
            native.push_str(&format!(
                "({:?}, include_bytes!({:?}), {digest:?}, false),\n",
                format!("icu-data/oliphaunt-icu/native-seeds/{target}/{relative}"),
                file
            ));
        }
    }
    native.push_str("]\n");
    fs::write(out_dir.join("native_icu.rs"), native).expect("write native ICU resource index");
}

fn native_seed_root() -> Option<(&'static str, PathBuf)> {
    let target = match env::var("TARGET").unwrap_or_default().as_str() {
        "x86_64-unknown-linux-gnu" => "linux-x64-gnu",
        "aarch64-unknown-linux-gnu" => "linux-arm64-gnu",
        "aarch64-apple-darwin" => "macos-arm64",
        "x86_64-pc-windows-msvc" => "windows-x64-msvc",
        _ => return None,
    };
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"))
        .join("payload/native-seeds")
        .join(target);
    Some((target, root))
}

fn find_icu_data_root() -> Option<PathBuf> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    for candidate in icu_candidates(&manifest_dir) {
        if let Some(root) = canonical_icu_data_root(&candidate) {
            return Some(root);
        }
    }
    None
}

fn icu_candidates(manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(manifest_dir.join("payload/share/icu"));
    if let Some(path) = env::var_os("OLIPHAUNT_ICU_DATA_DIR") {
        candidates.push(PathBuf::from(path));
    }
    candidates
}

fn canonical_icu_data_root(candidate: &Path) -> Option<PathBuf> {
    if icu_root_contains_data(candidate) {
        return Some(candidate.to_path_buf());
    }
    let entries = fs::read_dir(candidate).ok()?;
    let mut dirs = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs.into_iter().find(|path| icu_root_contains_data(path))
}

fn icu_root_contains_data(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_file() && name.starts_with("icudt") && name.ends_with(".dat") {
            return true;
        }
        if path.is_dir() && name.starts_with("icudt") && directory_has_file(&path) {
            return true;
        }
    }
    false
}

fn directory_has_file(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| entry.path().is_file())
}

fn emit_rerun_directives(root: &Path) {
    println!("cargo:rerun-if-changed={}", root.display());
    for path in collect_files(root).expect("collect ICU data files for rerun tracking") {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn emit_artifact_manifest(out_dir: &Path, icu_root: &Path, receipt: &Path) {
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by Cargo");
    let manifest_path = out_dir.join("oliphaunt-artifact.toml");
    let files = collect_files(icu_root).expect("collect ICU data files for manifest");
    let mut text = format!(
        "schema = {ARTIFACT_SCHEMA:?}\nproduct = {ARTIFACT_PRODUCT:?}\nversion = {version:?}\nkind = {ARTIFACT_KIND:?}\ntarget = {ARTIFACT_TARGET:?}\n"
    );
    for file in files {
        let relative = file
            .strip_prefix(icu_root)
            .expect("ICU file stays under ICU root")
            .to_string_lossy()
            .replace('\\', "/");
        let sha256 = sha256_file(&file).expect("hash ICU data file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            format!("share/icu/{relative}"),
            sha256,
        ));
    }
    let receipt_sha256 = sha256_file(receipt).expect("hash ICU receipt");
    text.push_str(&format!(
        "\n[[files]]\nsource = {:?}\nrelative = \"manifest.properties\"\nsha256 = {receipt_sha256:?}\nexecutable = false\n",
        receipt.display().to_string()
    ));
    if let Some((target, root)) = native_seed_root() {
        let directories = collect_directories(&root)
            .expect("collect seed directories")
            .iter()
            .map(|directory| {
                format!(
                    "native-seeds/{target}/{}",
                    directory
                        .strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                )
            })
            .collect::<Vec<_>>();
        let insert_at = text.find("\n[[files]]").unwrap_or(text.len());
        text.insert_str(insert_at, &format!("\ndirectories = {directories:?}\n"));
        for file in collect_files(&root).expect("collect native ICU seed manifest files") {
            let relative = file
                .strip_prefix(&root)
                .expect("seed relative path")
                .to_string_lossy()
                .replace('\\', "/");
            let sha256 = sha256_file(&file).expect("hash native ICU seed");
            text.push_str(&format!(
                "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
                file.display().to_string(),
                format!("native-seeds/{target}/{relative}"),
                sha256
            ));
        }
    }
    fs::write(&manifest_path, text).expect("write ICU Cargo artifact manifest");
    println!("cargo::metadata=manifest={}", manifest_path.display());
}

fn collect_directories(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut directories = Vec::new();
    if !root.exists() {
        return Ok(directories);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "seed symlink"));
        }
        if kind.is_dir() {
            directories.push(entry.path());
            directories.extend(collect_directories(&entry.path())?);
        }
    }
    directories.sort();
    Ok(directories)
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    let mut files = files
        .into_iter()
        .map(|file| {
            let relative = file
                .strip_prefix(root)
                .expect("ICU file stays under ICU root")
                .to_str()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "ICU path is not UTF-8"))?
                .replace('\\', "/");
            Ok((relative, file))
        })
        .collect::<io::Result<Vec<_>>>()?;
    files.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    Ok(files.into_iter().map(|(_, file)| file).collect())
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("ICU data must not contain symlinks: {}", path.display()),
            ));
        }
        if metadata.is_dir() {
            collect_files_inner(&path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("ICU data contains an unsupported entry: {}", path.display()),
            ));
        }
    }
    Ok(())
}

fn logical_tree_sha256(root: &Path) -> io::Result<String> {
    let files = collect_files(root)?;
    if files.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ICU data tree is empty",
        ));
    }
    let mut digest = Sha256::new();
    for file in files {
        let relative = file
            .strip_prefix(root)
            .expect("ICU file stays below logical root")
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "ICU path is not UTF-8"))?
            .replace('\\', "/");
        let bytes = fs::read(&file)?;
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(bytes.len().to_string().as_bytes());
        digest.update([0]);
        digest.update(bytes);
        digest.update([b'\n']);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
