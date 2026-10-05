"""Stage an aligned registry crate family and size-bounded Windows DLL parts.

This is a local packaging control. It publishes nothing and does not supply
complete engine notices or declare these candidates as release carriers.
"""
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tomllib

control = pathlib.Path(sys.argv[1]).resolve()
output = control / "family"
output.mkdir(exist_ok=False)
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--format-version=1"], encoding="utf-8"))
names = ("wasmer", "wasmer-wasix-types", "wasmer-journal", "wasmer-wasix")
packages = {}
for name in names:
    matches = [p for p in metadata["packages"] if p["name"] == name]
    assert len(matches) == 1, name
    packages[name] = matches[0]
assert packages["wasmer"]["version"] == "7.5.0"
assert all(packages[name]["version"] == "0.705.0" for name in names[1:])


def rewrite(text, name):
    """Keep Rust dependency aliases and library names; change package identity."""
    text, count = re.subn(r'^name = "[^"]+"$', f'name = "oliphaunt-{name}"',
                          text, count=1, flags=re.M)
    assert count == 1
    blocks = re.split(r'(?=^\[)', text, flags=re.M)
    for index, block in enumerate(blocks):
        header = re.match(r'\[[^\]\n]*dependencies\.([\w-]+)\]\n', block)
        if not header:
            continue
        package = re.search(r'^package = "([^"]+)"$', block, flags=re.M)
        original = package.group(1) if package else header.group(1)
        if original not in names:
            continue
        block = re.sub(r'^(?:package|path|git|rev|branch|tag|registry) = .*\n', '', block, flags=re.M)
        block, count = re.subn(r'^version = "[^"]+"$',
                               f'version = "={packages[original]["version"]}"', block, flags=re.M)
        assert count == 1, original
        blocks[index] = block.split('\n', 1)[0] + f'\npackage = "oliphaunt-{original}"\n' + block.split('\n', 1)[1]
    text = ''.join(blocks)
    parsed = tomllib.loads(text)
    assert parsed['package']['name'] == 'oliphaunt-' + name
    # Library/test source paths are valid; dependency source selectors are not.
    assert not any(key in parsed for key in ('patch', 'replace'))
    tables = [parsed]
    tables.extend(parsed.get('target', {}).values())
    for table in tables:
        for kind in ('dependencies', 'dev-dependencies', 'build-dependencies'):
            for value in table.get(kind, {}).values():
                if isinstance(value, dict):
                    assert not any(key in value for key in ('path', 'git', 'registry'))
    return text


sources = output / "sources"
sources.mkdir()
for name, package in packages.items():
    source = pathlib.Path(package["manifest_path"]).parent
    if name == 'wasmer':
        source = control / 'engine/dependency/wasmer-7.5.0'
    elif name == 'wasmer-wasix':
        source = control / 'cache-only-dependency/wasmer-wasix-0.705.0'
    assert source.is_dir(), source
    destination = sources / ("oliphaunt-" + name)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(
        '.git', '.cargo-ok', '.cargo-checksum.json', 'target', 'prebuilt'))
    manifest = destination / "Cargo.toml"
    manifest.write_text(rewrite(manifest.read_text(), name))
    (destination / "Cargo.toml.orig").unlink(missing_ok=True)

engine = sources / "oliphaunt-wasmer-v8-windows-x64-msvc"
engine.mkdir()
version = packages['wasmer']['version']
dll = (control / "engine/oliphaunt_wee8.dll").read_bytes()
compressed = gzip.compress(dll, compresslevel=9, mtime=0)
assert gzip.decompress(compressed) == dll
chunk_size = 8 * 1024 * 1024
parts = []
for index, offset in enumerate(range(0, len(compressed), chunk_size)):
    name = f'oliphaunt-wasmer-v8-windows-x64-msvc-part-{index}'
    directory = sources / name
    directory.mkdir()
    (directory / 'Cargo.toml').write_text(f'''[package]
name = "{name}"
version = "{version}"
edition = "2024"
publish = false
description = "Internal compressed engine payload, local packaging control"
[lib]
path = "lib.rs"
''')
    (directory / 'lib.rs').write_text('pub static BYTES: &[u8] = include_bytes!("payload.gz.part");\n')
    data = compressed[offset:offset + chunk_size]
    (directory / 'payload.gz.part').write_bytes(data)
    parts.append({'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
dependencies = ''.join(f'{part["name"]} = "={version}"\n' for part in parts)
(engine / 'Cargo.toml').write_text(f'''[package]
name = "oliphaunt-wasmer-v8-windows-x64-msvc"
version = "{version}"
edition = "2024"
publish = false
description = "Internal Windows V8 engine, local packaging control"
[lib]
path = "lib.rs"
[dependencies]
flate2 = "1"
{dependencies}''')
references = ',\n'.join(part['name'].replace('-', '_') + '::BYTES' for part in parts)
(engine / 'lib.rs').write_text('''use std::io::{self, Write};
pub fn write_dll(path: &std::path::Path) -> io::Result<()> {
    let compressed = [''' + references + '''].concat();
    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
    let mut file = std::fs::File::create(path)?;
    let written = io::copy(&mut decoder, &mut file)?;
    assert_eq!(written, ''' + str(len(dll)) + ''', "engine payload size differs");
    file.flush()
}
''')
wasmer = sources / 'oliphaunt-wasmer'
(wasmer / 'prebuilt').mkdir()
bindings = control / 'engine/dependency/wasmer-7.5.0/prebuilt/embedded_bindings.rs'
binding_text = bindings.read_text()
sentinel = '    eprintln!("research_guest_compilation_reached=true");\n    std::process::abort();'
assert binding_text.count(sentinel) == 1
binding_text = binding_text.replace(sentinel, '')
(wasmer / 'prebuilt/embedded_bindings.rs').write_text(binding_text)
manifest = wasmer / 'Cargo.toml'
text = manifest.read_text()
for name in ('bindgen', 'which', 'ureq', 'tar', 'xz', 'tempfile'):
    text = re.sub(r'\n\[(?:[^\]\n]*\.)?build-dependencies\.' + name + r'\][\s\S]*?(?=\n\[|\Z)', '', text)
    text = re.sub(r'^\s*"dep:' + name + r'",\n', '', text, flags=re.M)
text, count = re.subn(r'(^v8 = \[)', r'\1\n    "dep:oliphaunt-wasmer-v8-windows-x64-msvc",', text, count=1, flags=re.M)
assert count == 1
text += f'''\n[build-dependencies.oliphaunt-wasmer-v8-windows-x64-msvc]
version = "={version}"
optional = true
'''
tomllib.loads(text)
manifest.write_text(text)
(wasmer / 'build.rs').write_text('''#[cfg(feature = "v8")]
fn main() {
    assert_eq!(std::env::var("TARGET").unwrap(), "x86_64-pc-windows-msvc");
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::copy(root.join("prebuilt/embedded_bindings.rs"), out.join("v8_bindings.rs")).unwrap();
    oliphaunt_wasmer_v8_windows_x64_msvc::write_dll(&out.join("oliphaunt_wee8.dll")).unwrap();
}
#[cfg(not(feature = "v8"))]
fn main() {}
''')
report = {
    'scope': 'local registry-family packaging control; not publication-ready engine notices',
    'family': {name: {'name': 'oliphaunt-' + name, 'version': package['version'],
                      'upstream_package_id': package['id']}
               for name, package in packages.items()},
    'dll_sha256': hashlib.sha256(dll).hexdigest(), 'dll_size': len(dll),
    'compressed_size': len(compressed), 'parts': parts,
    'bindings_sha256': hashlib.sha256((wasmer / 'prebuilt/embedded_bindings.rs').read_bytes()).hexdigest(),
    'diagnostic_compilation_sentinel_omitted': True,
}
root = pathlib.Path(__file__).resolve().parents[4]
archive_script = '''
import {readdirSync, statSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {packageGeneratedCargoSource} from ''' + json.dumps(
    (root / 'tools/packaging/cargo-source-package.mts').as_posix()) + ''';
const [sources, output] = process.argv.slice(-2);
const packages = readdirSync(sources).sort().map(name => {
  const archive = packageGeneratedCargoSource(`${sources}/${name}/Cargo.toml`, output);
  return {name, archive, bytes: statSync(archive).size,
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex')};
});
console.log(JSON.stringify(packages));
'''
report['archives'] = json.loads(subprocess.check_output(
    ['bun', '--eval', archive_script, str(sources), str(output / 'packages')],
    encoding='utf-8'))
(output / 'family-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
