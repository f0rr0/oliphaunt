"""Run terminal-entry and actual Windows loader/SDK failures in fresh processes."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys


def main():
    output = pathlib.Path(sys.argv[1]).resolve()
    root = pathlib.Path(__file__).resolve().parents[4]
    drivers = pathlib.Path(__file__).resolve().parent
    tests = root / "src/wasix/sdks/rust/tests"
    for name in ("terminal-entry", "terminal-contract", "terminal-copy", "dynamic-reference"):
        source = (drivers / (name + ".rs")).read_text()
        assert source.count("fn main() {") == 1
        source = source.replace("fn main() {", "#[test]\nfn terminal_regression() {")
        (tests / ("research_v8_" + name.replace("-", "_") + ".rs")).write_text(source)
    for fixture in drivers.glob("terminal-*.wasm"):
        (tests / fixture.name).write_bytes(fixture.read_bytes())
    (tests / "dynamic-reference.wasm").write_bytes((drivers / "dynamic-reference.wasm").read_bytes())

    bindings = output / "engine/dependency/wasmer-7.5.0/prebuilt/embedded_bindings.rs"
    generated = bindings.read_text()
    loader = generated.split("\nmod research_embedded_engine {\n", 1)[1].split(
        "\npub(crate) fn oliphaunt_v8_prepare()", 1)[0].rstrip()
    assert loader.endswith("}")
    loader = loader[:-1]
    dll = output / "engine/oliphaunt_wee8.dll"
    loader, count = re.subn(r'include_bytes!\(concat!\(env!\("OUT_DIR"\), "/oliphaunt_wee8.dll"\)\)',
        lambda _: "include_bytes!(" + json.dumps(dll.as_posix()) + ")", loader)
    assert count == 1
    (tests / "research_v8_delivery.rs").write_text(loader + (drivers / "loader-faults.rs").read_text())

    suites = {
        "terminal_entry": [("terminal_regression", "terminal_entry_review=PASS", 7)],
        "terminal_contract": [("terminal_regression", "terminal_contract_review=PASS", 1)],
        "terminal_copy": [("terminal_regression", "terminal_copy=PASS", 1)],
        "dynamic_reference": [("terminal_regression", "dynamic_reference=PASS", 1)],
        "delivery": [("faults::native_delivery_faults", "native_delivery_faults=PASS", 1),
                     ("faults::blocking_open_failure_then_retry", "blocking_loader_open=PASS", 1),
                     ("faults::async_open_failure_then_retry", "async_loader_open=PASS", 1)],
    }
    receipt = {"scope": "native Windows terminal contract and actual DLL/SDK delivery faults",
               "fixture_hashes": {}, "checks": []}
    for suite, cases in suites.items():
        name = "research_v8_" + suite
        fixture = tests / (name + ".rs")
        receipt["fixture_hashes"][name] = hashlib.sha256(fixture.read_bytes()).hexdigest()
        build = subprocess.run(["cargo", "test", "--locked", "-p", "oliphaunt-wasix",
            "--no-default-features", "--test", name, "--no-run", "--message-format=json"],
            capture_output=True, encoding="utf-8", timeout=1200)
        (output / (name + "-build.log")).write_text(build.stdout + build.stderr)
        if build.returncode:
            print(build.stderr[-16000:], flush=True)
            raise RuntimeError(f"{name} build failed: {build.returncode}")
        executables = [json.loads(line)["executable"] for line in build.stdout.splitlines()
            if line.startswith("{") and json.loads(line).get("reason") == "compiler-artifact"
            and json.loads(line).get("executable")]
        assert len(executables) == 1
        executable = pathlib.Path(executables[0])
        for case, marker, count in cases:
            # Each process owns fresh OnceLocks, testing failed open followed by
            # successful retry within that same process. No loader fault flags.
            result = subprocess.run([str(executable), "--exact", case, "--nocapture"],
                capture_output=True, encoding="utf-8", timeout=180)
            log = result.stdout + result.stderr
            (output / (case.replace("::", "-") + "-" + suite + ".log")).write_text(log)
            print(log, flush=True)
            assert result.returncode == 0, result.returncode
            assert log.count(marker) == count and "panicked at" not in log
            receipt["checks"].append({"suite": suite, "case": case, "exit_code": result.returncode,
                "pass_records": count, "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest()})
    (output / "delivery-control-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
