#!/usr/bin/env python3

"""Focused adversarial tests for the sealed-export predecessor verifier."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "lib"))

from sealed_export_chain import (  # noqa: E402
    ExportChainError,
    LINEAR_PROFILE_ID,
    LINEAR_RECEIPT_RELATIVE,
    RECEIPT_RELATIVE,
    SEED_PROOF_RELATIVE,
    linear_closure_hash,
    read_regular,
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_chain(install: Path, *, descendant: bool = False, succeeds: bool = True) -> None:
    command = [
        sys.executable,
        str(PROJECT_ROOT / "lib" / "sealed_export_chain.py"),
        "--install-root",
        str(install),
        "--project-root",
        str(PROJECT_ROOT),
    ]
    if descendant:
        command.append("--allow-linear-memory-descendant")
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if (result.returncode == 0) != succeeds:
        raise AssertionError(
            f"sealed-export verifier outcome differs: command={command!r}\n{result.stderr}"
        )


def write_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.test.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def make_linear_receipt(install: Path) -> dict[str, object]:
    modules: list[dict[str, object]] = []
    for subtree in (install / "bin", install / "lib"):
        for path in sorted(item for item in subtree.rglob("*") if item.is_file()):
            if path.read_bytes()[:4] != b"\0asm":
                continue
            relative = path.relative_to(install).as_posix()
            digest = sha256(path)
            modules.append(
                {
                    "import-module": "env",
                    "import-name": "memory",
                    "initial-pages": 1,
                    "maximum-bytes": 268435456,
                    "maximum-pages": 4096,
                    "module-sha256": digest,
                    "path": relative,
                    "shared": True,
                    "source-module-sha256": digest,
                    "transformation": "pinned-wasixcc-65536-to-embedded-4096-reversible-v1",
                }
            )
    modules.sort(key=lambda module: str(module["path"]))
    return {
        "address-width": "wasm32",
        "excludes-wasm32-end-wrap": True,
        "maximum-bytes": 268435456,
        "maximum-pages": 4096,
        "module-closure-sha256": linear_closure_hash(modules, "module-sha256"),
        "module-count": len(modules),
        "modules": modules,
        "predecessor-export-closure-receipt": RECEIPT_RELATIVE,
        "predecessor-export-closure-receipt-sha256": sha256(install / RECEIPT_RELATIVE),
        "profile-id": LINEAR_PROFILE_ID,
        "requires-import": "env.memory",
        "requires-shared": True,
        "schema": "oliphaunt.wasix-postmaster.linear-memory-install.v1",
        "source-module-closure-sha256": linear_closure_hash(modules, "source-module-sha256"),
        "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
        "static-bound-pages": 65536,
        "static-offset-guard-bytes": 2147483648,
        "supported-host-pointer-width": "u64",
    }


def main() -> int:
    target = PROJECT_ROOT.parents[3] / "target" / "oliphaunt-wasix-postmaster"
    target.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="sealed-export-chain-test.", dir=target))
    try:
        install = root / "install"
        module = bytes.fromhex(
            "0061736d01000000"
            "0212"
            "01"
            "03656e76"
            "066d656d6f7279"
            "02"
            "03"
            "01"
            "808004"
        )
        for relative in (
            "bin/initdb",
            "bin/postgres",
            "lib/libpq.so.5.18",
            "lib/postgresql/dict_snowball.so",
            "lib/postgresql/plpgsql.so",
        ):
            path = install / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(module)
        subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "testdata" / "make-sealed-export-fixture.py"),
                "--install-root",
                str(install),
                "--project-root",
                str(PROJECT_ROOT),
            ],
            check=True,
        )
        run_chain(install)

        linear_receipt = make_linear_receipt(install)
        linear_path = install / LINEAR_RECEIPT_RELATIVE
        write_json(linear_path, linear_receipt)
        run_chain(install, descendant=True)

        linear_receipt["modules"][0]["initial-pages"] = True  # type: ignore[index]
        write_json(linear_path, linear_receipt)
        run_chain(install, descendant=True, succeeds=False)
        linear_receipt["modules"][0]["initial-pages"] = 4097  # type: ignore[index]
        write_json(linear_path, linear_receipt)
        run_chain(install, descendant=True, succeeds=False)
        linear_path.unlink()

        seed_path = install / SEED_PROOF_RELATIVE
        seed = json.loads(seed_path.read_text(encoding="utf-8"))
        seed["analyzer-version"] = "mismatched-analyzer"
        write_json(seed_path, seed)
        structural_path = install / RECEIPT_RELATIVE
        structural = json.loads(structural_path.read_text(encoding="utf-8"))
        structural["seed-proof-sha256"] = sha256(seed_path)
        write_json(structural_path, structural)
        run_chain(install, succeeds=False)

        regular = install / "regular"
        regular.write_bytes(b"bounded")
        symlink = install / "symlink"
        symlink.symlink_to(regular.name)
        try:
            read_regular(install, "symlink", None)
        except (ExportChainError, OSError):
            pass
        else:
            raise AssertionError("sealed-export verifier followed a final-component symlink")
        try:
            read_regular(install, "regular", {"regular": (1, "0" * 64)})
        except ExportChainError:
            pass
        else:
            raise AssertionError("sealed-export verifier ignored inventoried size precheck")
    finally:
        shutil.rmtree(root)
    print("sealed export chain tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
