#!/usr/bin/env python3

"""Receipt-bound deterministic-start analyzer fixture for carrier tests."""

import hashlib
import json
import os
import pathlib
import sys


POLICY = "llvm-shared-memory-init-restricted-effects.v1"


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if sys.argv[1:] == ["--policy-id"]:
        print(POLICY)
        return
    if len(sys.argv) != 2:
        raise SystemExit("usage: fake-start-proof.py MODULE | --policy-id")

    module = pathlib.Path(sys.argv[1])
    if not module.is_file() or module.is_symlink():
        raise SystemExit(f"not a regular module: {module}")
    module_sha256 = file_sha256(module)
    if os.environ.get("FAKE_START_PROOF_WRONG_MODULE") == "1":
        module_sha256 = "ff" * 32
    proof_seed = (
        POLICY.encode("ascii")
        + b"\0"
        + module_sha256.encode("ascii")
        + b"\0fake-restricted-start-closure"
    )
    proof = {
        "schema": "oliphaunt.wasix-postmaster.deterministic-start-proof.v1",
        "analyzer-policy": POLICY,
        "module-sha256": module_sha256,
        "proof-sha256": hashlib.sha256(proof_seed).hexdigest(),
        "start-function-index": 147,
        "start-function-export": "__wasm_init_memory",
        "transitive-function-indices": [147, 148],
        "imported-function-calls": 0,
        "memory-reads": "fresh-zero-atomic-guard-only",
        "memory-effects": "passive-data-init-zero-fill-atomic-guard-only",
        "global-effects": "local-numeric-relocations-only",
        "table-effects": "none",
        "requires-fresh-zeroed-memory": True,
        "ordinary-start-execution-per-instance": True,
        "first-instance-full-byte-validation": True,
    }
    if os.environ.get("FAKE_START_PROOF_INVALID") == "1":
        proof["imported-function-calls"] = 1
    json.dump(proof, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
