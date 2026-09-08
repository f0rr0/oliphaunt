#!/usr/bin/env python3
"""Run source preparation/capability resolution without a compiler or checkout."""

import os
from pathlib import Path
import subprocess
import tempfile


project = Path(__file__).resolve().parents[2]
script = (project / "runtime/bin/build-runtime.sh").read_text()
# Execute the real entrypoint through the source inventory, stopping before any
# build/cache work. No test-only switch is introduced in the production script.
prefix = script.split('wasmer_cargo_lock="$WASMER_ROOT/Cargo.lock"', 1)[0]
assert prefix != script
inventory = (project / "runtime/capabilities.tsv").read_text()
assert "wasix-libc:" in inventory

with tempfile.TemporaryDirectory(prefix="wasix-capability-roots-") as temporary:
    root = Path(temporary)
    (root / "runtime/bin").mkdir(parents=True)
    (root / "lib").mkdir()
    (root / "runtime/bin/build-runtime.sh").write_text(prefix)
    (root / "runtime/capabilities.tsv").write_text(inventory)
    (root / "runtime/bin/verify-source-lock.py").write_text("")
    (root / "lib/common.sh").write_text('''
FRESH_WORK_ROOT="$FRESH_ROOT/work"
FRESH_WASMER_BUILD_RECEIPT="$FRESH_ROOT/wasmer-receipt"
FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="$FRESH_ROOT/executor-receipt"
FRESH_POSTMASTER_EXECUTOR_TARGET_DIR="$FRESH_ROOT/executor-target"
FRESH_POSTMASTER_COMPILER_TARGET_DIR="$FRESH_ROOT/compiler-target"
fresh_require_command() { :; }
fresh_validate_postmaster_task_budget_profile() { :; }
''')
    preparer = root / "runtime/bin/prepare-upstream-checkouts.sh"
    preparer.write_text('''#!/usr/bin/env python3
import os
assert os.environ["WASMER_ROOT"] == os.environ["EXPECTED_WASMER_ROOT"]
assert os.environ["WASIX_LIBC_ROOT"] == os.environ["EXPECTED_LIBC_ROOT"]
''')
    preparer.chmod(0o755)

    for custom in (False, True):
        env = os.environ.copy()
        for name in ("UPSTREAM_WORK_ROOT", "WASMER_ROOT", "WASIX_LIBC_ROOT",
                     "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET", "CARGO_INCREMENTAL",
                     "OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS"):
            env.pop(name, None)
        upstream = root / ("custom work" if custom else "work/runtime")
        wasmer = root / "custom wasmer" if custom else upstream / "wasmer"
        libc = root / "custom libc" if custom else upstream / "wasix-libc"
        if custom:
            env.update(UPSTREAM_WORK_ROOT=str(upstream), WASMER_ROOT=str(wasmer),
                       WASIX_LIBC_ROOT=str(libc))
        env.update(LLVM_SYS_221_PREFIX=str(root / "unused-llvm"),
                   EXPECTED_WASMER_ROOT=str(wasmer), EXPECTED_LIBC_ROOT=str(libc))
        roots = {"project": root, "wasmer": wasmer, "wasix-libc": libc}
        sources = [wasmer / "lib/cli/Cargo.toml"]
        for line in inventory.splitlines():
            if not line or line.startswith("#"):
                continue
            for reference in line.split("\t")[3].split(";"):
                owner, relative = reference.split(":", 1)
                sources.append(roots[owner] / relative)
        for source in sources:
            source.parent.mkdir(parents=True, exist_ok=True)
            source.touch(exist_ok=True)
        command = ["bash", str(root / "runtime/bin/build-runtime.sh"), "--build-only"]
        subprocess.run(command, env=env, check=True, capture_output=True, text=True)
        # A missing libc capability must still fail closed, not skip this owner.
        missing = next(source for source in sources if source.is_relative_to(libc))
        missing.unlink()
        failed = subprocess.run(command, env=env, capture_output=True, text=True)
        assert failed.returncode == 2 and "missing source for capability" in failed.stderr, failed

print("runtime capability roots: defaults/custom paths reach preparer and resolve all owners; missing libc fails closed")
