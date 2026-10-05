"""Compile and run the unpublished family from frozen .crate contents.

Private-name overrides simulate packages not yet on a registry. This does not
qualify publication, complete engine notices, or an installed SDK carrier.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

control = pathlib.Path(sys.argv[1]).resolve()
output = control / 'family'
receipt = json.loads((output / 'family-receipt.json').read_text())
extracted = output / 'extracted'
extracted.mkdir(exist_ok=False)
patches = []
for package in receipt['archives']:
    archive = pathlib.Path(package['archive'])
    assert archive.stat().st_size == package['bytes'] <= 10 * 1024 * 1024
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == package['sha256']
    with tarfile.open(archive) as bundle:
        bundle.extractall(extracted, filter='data')
    version = '7.5.0' if package['name'].startswith('oliphaunt-wasmer-v8-') or package['name'] == 'oliphaunt-wasmer' else '0.705.0'
    path = extracted / (package['name'] + '-' + version)
    assert path.is_dir(), path
    patches.append(package['name'] + ' = { path = ' + json.dumps(path.as_posix()) + ' }')

consumer = output / 'consumer-from-archives'
(consumer / 'src').mkdir(parents=True)
(consumer / '.cargo').mkdir()
(consumer / '.cargo/config.toml').write_text('[patch.crates-io]\n' + '\n'.join(patches) + '\n')
features = ['v8'] if sys.platform == 'win32' else ['sys', 'headless']
wasix_features = ['v8', 'sys-poll', 'host-vnet', 'time'] if sys.platform == 'win32' else ['sys-minimal', 'sys-poll', 'host-vnet', 'time']
(consumer / 'Cargo.toml').write_text('''[package]
name = "family-consumer-control"
version = "0.0.0"
edition = "2024"
publish = false
[workspace]
[dependencies]
wasmer = { package = "oliphaunt-wasmer", version = "=7.5.0", default-features = false, features = ''' + json.dumps(features) + ''' }
wasmer-wasix = { package = "oliphaunt-wasmer-wasix", version = "=0.705.0", default-features = false, features = ''' + json.dumps(wasix_features) + ''' }
wasmer-wasix-types = { package = "oliphaunt-wasmer-wasix-types", version = "=0.705.0", default-features = false }
wasmer-journal = { package = "oliphaunt-wasmer-journal", version = "=0.705.0", default-features = false }
engine = { package = "oliphaunt-wasmer-v8-windows-x64-msvc", version = "=7.5.0" }
tokio = { version = "1", features = ["rt-multi-thread"] }
''')
shutil.copy2(pathlib.Path(__file__).with_name('family-consumer.rs'), consumer / 'src/main.rs')
env = os.environ.copy()
env.pop('RUSTFLAGS', None)
env['LIBCLANG_PATH'] = str(output / 'absent-libclang')
if sys.platform == 'win32':
    env['PATH'] = os.pathsep.join(part for part in env['PATH'].split(os.pathsep)
        if not any((pathlib.Path(part) / name).is_file() for name in (
            'oliphaunt_wee8.dll', 'llvm-objcopy.exe', 'objcopy.exe', 'libclang.dll', 'clang.exe')))
cargo = ['cargo', '+1.96.0']
subprocess.run([*cargo, 'generate-lockfile', '--offline'], cwd=consumer, env=env, check=True)
metadata = json.loads(subprocess.check_output(
    [*cargo, 'metadata', '--locked', '--offline', '--format-version=1'], cwd=consumer, env=env,
    encoding='utf-8'))
names = {package['name'] for package in metadata['packages']}
assert not names.intersection(receipt['family']), names.intersection(receipt['family'])
assert all(package['name'] in names for package in receipt['archives'])
(output / 'consumer-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
with (output / 'consumer-from-archives.log').open('w') as log:
    result = subprocess.run([*cargo, 'run', '--locked', '--offline'], cwd=consumer, env=env,
                            stdout=log, stderr=subprocess.STDOUT, timeout=1200)
text = (output / 'consumer-from-archives.log').read_text(errors='replace')
print(text[-16000:], flush=True)
assert result.returncode == 0, result.returncode
assert 'aligned_family_consumer=PASS' in text
dll = consumer / 'reconstructed.dll'
assert dll.stat().st_size == receipt['dll_size']
assert hashlib.sha256(dll.read_bytes()).hexdigest() == receipt['dll_sha256']
receipt.update({'consumer_from_frozen_archives': True, 'consumer_exit_code': 0,
                'upstream_api_family_in_graph': False,
                'platform': sys.platform, 'consumer_overrides': 'unpublished private names only',
                'native_v8_host_call_and_retired_memory': sys.platform == 'win32'})
(output / 'family-consumer-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('frozen_family_consumer=PASS', flush=True)
