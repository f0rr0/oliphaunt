"""Stage or qualify clean WASIX attachment errors during terminal shutdown."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tomllib


def fixture_source(source):
    source = source.replace('panic::AssertUnwindSafe, ', '')
    source = source.replace('use wasmer::{Function,', 'use wasmer::{AsStoreMut, Function,')
    source = source.replace('use wasmer_wasix::{WasiEnv,',
        'use wasmer_wasix::runtime::task_manager::{SpawnType, VirtualTaskManager, tokio::TokioTaskManager};\nuse wasmer_wasix::{WasiEnv,')
    old = '''    let late = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut late_store = Store::new(engine.clone());
        shared.clone().attach(&mut late_store);
    }));
    assert!(late.is_err(), "disabled shared memory accepted a new attachment");'''
    new = '''    let mut late_store = Store::new(engine.clone());
    let late = shared.clone().try_attach(&mut late_store);
    assert!(late.is_err(), "disabled shared memory accepted a new attachment");
    let tasks = TokioTaskManager::new(tokio::runtime::Handle::current());
    let task_late = tasks.build_memory(&mut late_store.as_store_mut(), SpawnType::AttachMemory(shared.clone()));
    assert!(task_late.is_err(), "WASIX accepted attachment after shutdown");
    drop(late_store);'''
    assert source.count(old) == 1
    source = source.replace(old, new).replace('late_attach=REJECTED', 'late_attach=ERROR task_attach=ERROR')
    race = '''fn attachment_race(engine: &wasmer::Engine, index: usize) {
    let mut owner = Store::new(engine.clone());
    let memory = Memory::new(&mut owner, MemoryType::new(1, Some(1), true)).unwrap();
    let shared = memory.as_shared(&owner).unwrap();
    let barrier = Arc::new(Barrier::new(9));
    let handles: Vec<_> = (0..8).map(|_| {
        let barrier = barrier.clone();
        let engine = engine.clone();
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut store = Store::new(engine);
            barrier.wait();
            let rejected = shared.try_attach(&mut store).is_err();
            drop(store);
            rejected
        })
    }).collect();
    barrier.wait();
    shared.disable_atomics().unwrap();
    let rejected = handles.into_iter().map(|handle| handle.join().unwrap()).filter(|rejected| *rejected).count();
    shared.disable_atomics().unwrap();
    drop(memory); drop(owner);
    shared.disable_atomics().unwrap();
    println!("attachment_teardown_race={index} attempts=8 rejected={rejected} result=PASS");
}

'''
    source = source.replace('fn main() {', race + 'fn main() {')
    source = source.replace('    for index in 1..=32 { teardown_race(&engine, index); }',
        '    for index in 1..=32 { teardown_race(&engine, index); attachment_race(&engine, index); }')
    return source.replace('teardown_races=32 race_stores=288"',
        'teardown_races=32 race_stores=288 late_attach_errors=25 task_attach_errors=25 attachment_races=32 race_attachments=256"')


def main():
    output = pathlib.Path(sys.argv[1]).resolve()
    if len(sys.argv) == 3 and sys.argv[2] == '--check':
        subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('automatic-interrupt-check.py')),
                        str(output)], check=True)
        log = (output / 'automatic-interrupt.log').read_text()
        assert log.count('late_attach=ERROR task_attach=ERROR') == 25
        assert 'late_attach_errors=25 task_attach_errors=25' in log
        assert log.count('attachment_teardown_race=') == 32
        receipt = json.loads((output / 'automatic-interrupt-receipt.json').read_text())
        receipt.update({'late_attach_errors': 25, 'wasix_task_attachment_errors': 25,
                        'expected_attachment_panics': 0, 'attachment_races': 32,
                        'race_attachments': 256})
        (output / 'fallible-attachment-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        return
    root = pathlib.Path(__file__).resolve().parents[4]
    wasmer = output / 'engine/dependency/wasmer-7.5.0'
    wasix = output / 'cache-only-dependency/wasmer-wasix-0.705.0'
    if not wasix.exists():
        metadata = json.loads(subprocess.check_output(
            ['cargo', 'metadata', '--locked', '--format-version=1'], encoding='utf-8'))
        packages = [package for package in metadata['packages'] if package['name'] == 'wasmer-wasix']
        assert len(packages) == 1 and packages[0]['version'] == '0.705.0'
        wasix = output / 'interrupt-dependency/wasmer-wasix-0.705.0'
        shutil.copytree(pathlib.Path(packages[0]['manifest_path']).parent, wasix)
        config = root / '.cargo/config.toml'
        assert 'wasmer-wasix' not in config.read_text()
        config.write_text(config.read_text() + '\n[patch.crates-io.wasmer-wasix]\npath = ' + json.dumps(wasix.as_posix()) + '\n')
        before = tomllib.loads((root / 'Cargo.lock').read_text())['package']
        subprocess.run(['cargo', 'metadata', '--offline', '--format-version=1'], check=True,
                       stdout=subprocess.DEVNULL)
        after = tomllib.loads((root / 'Cargo.lock').read_text())['package']
        for packages in (before, after):
            for package in packages:
                if package['name'] == 'wasmer-wasix' and package['version'] == '0.705.0':
                    package.pop('source', None)
                    package.pop('checksum', None)
        assert sorted(json.dumps(p, sort_keys=True) for p in before) == sorted(json.dumps(p, sort_keys=True) for p in after)
    patches = {}
    for dependency, name in (
        (wasmer, '0006-fallible-shared-memory-attachment'),
        (wasix, '0007-wasix-fallible-shared-memory-attachment'),
    ):
        patch = root / 'src/wasix/runtime/engine/patches' / (name + '.patch')
        inputs = json.loads(patch.with_suffix('.inputs.json').read_text())
        for path, digest in inputs.items():
            assert hashlib.sha256((dependency / path).read_bytes()).hexdigest() == digest, path
        subprocess.run(['git', 'apply', '--unsafe-paths', '--directory=' + dependency.as_posix(),
                        str(patch)], check=True)
        patches[name] = {'patch_sha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
                         'inputs': inputs, 'outputs': {path: hashlib.sha256((dependency / path).read_bytes()).hexdigest()
                                                      for path in inputs}}
    fixture = root / 'src/wasix/sdks/rust/tests/research_v8_automatic_interrupt.rs'
    source = fixture_source(pathlib.Path(__file__).with_name('automatic-interrupt.rs').read_text())
    fixture.write_text(source.replace('fn main() {', '#[test]\nfn automatic_store_interrupt() {'))
    (output / 'fallible-attachment-source-receipt.json').write_text(json.dumps(
        {'patches': patches, 'test_sha256': hashlib.sha256(fixture.read_bytes()).hexdigest()}, indent=2) + '\n')


if __name__ == '__main__':
    main()
