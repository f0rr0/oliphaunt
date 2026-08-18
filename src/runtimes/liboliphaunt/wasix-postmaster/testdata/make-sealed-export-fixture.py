#!/usr/bin/env python3

"""Create a strict synthetic sealed-export predecessor for product tests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def module_summary(path: str, sha256: str, size: int) -> dict[str, object]:
    return {
        "path": path,
        "sha256": sha256,
        "bytes": size,
        "non-export-sections-sha256": digest(f"sections:{path}".encode()),
        "dylink-needed": [],
        "imported-functions": 0,
        "local-functions": 1,
        "imported-globals": 0,
        "local-globals": 0,
        "imported-tables": 0,
        "local-tables": 1,
        "element-function-entries": 1,
        "element-unique-function-indices": 1,
        "element-max-function-index": 0,
        "start-function-index": 0,
        "imports": [],
        "export-counts": {},
        "exported-global-type-counts": {},
        "exported-immutable-i32-globals": 0,
        "exported-local-functions": 0,
        "exported-imported-functions": 0,
    }


def proof(main: dict[str, object], sides: list[dict[str, object]], mandatory: str, dlsym: str) -> dict[str, object]:
    return {
        "schema": "oliphaunt.wasix-postmaster.sealed-export-closure-proof.v2",
        "policy-id": "oliphaunt.wasix-postmaster.sealed-export-closure.v1",
        "analyzer-version": "fixture",
        "mandatory-policy-sha256": mandatory,
        "declared-main-dlsym-policy-sha256": dlsym,
        "main": main,
        "sides": sides,
        "mandatory-runtime-exports": [],
        "declared-main-dlsym-exports": [],
        "side-dynamic-imports": [],
        "retained-main-exports": [],
        "retained-main-export-descriptors": [],
        "removed-main-export-count": 1,
        "removed-main-export-names-sha256": digest(b"fixture-removed"),
        "unresolved-main-requirements": [],
        "mismatched-main-requirements": [],
        "unresolved-side-dependencies": [],
        "retained-counts": {},
        "removed-counts": {"function": 1},
    }


def snapshot(module_sha256: str, size: int) -> dict[str, object]:
    return {
        "sha256": module_sha256,
        "bytes": size,
        "exports": 0,
        "local-functions": 1,
        "local-globals": 0,
        "element-function-entries": 1,
        "element-unique-function-indices": 1,
        "start-function-index": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--install-root", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, required=True)
    arguments = parser.parse_args()
    root = arguments.install_root
    policy_root = arguments.project_root / "runtime" / "policies"
    side_manifest = policy_root / "sealed-side-modules.v1.tsv"
    side_paths = [
        line.split("\t", 1)[0]
        for line in side_manifest.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    ]
    assert len(side_paths) == 27
    template = (root / "lib/libpq.so.5.18").read_bytes()
    for relative in side_paths:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            # Keep fixture modules distinct so the carrier test also exercises
            # one AOT identity per declared side module.
            path.write_bytes(template + b"\nfixture:" + relative.encode())

    mandatory_hash = digest((policy_root / "sealed-main-runtime-exports.v1.txt").read_bytes())
    dlsym_hash = digest((policy_root / "sealed-main-dlsym-exports.v1.txt").read_bytes())
    sides = [
        module_summary(relative, digest((root / relative).read_bytes()), (root / relative).stat().st_size)
        for relative in side_paths
    ]
    postgres = (root / "bin/postgres").read_bytes()
    final_main = module_summary("bin/postgres", digest(postgres), len(postgres))
    seed_sha = digest(b"pre-dce-fixture\0" + postgres)
    seed_main = module_summary("bin/postgres", seed_sha, len(postgres) + 16)
    seed_proof_data = json_bytes(proof(seed_main, sides, mandatory_hash, dlsym_hash))
    final_proof_data = json_bytes(proof(final_main, sides, mandatory_hash, dlsym_hash))
    share = root / "share/postgresql"
    share.mkdir(parents=True, exist_ok=True)
    seed_path = share / "wasix-postmaster.sealed-export.seed-proof.json"
    final_path = share / "wasix-postmaster.sealed-export.final-proof.json"
    allowlist_path = share / "wasix-postmaster.sealed-export.allowlist"
    seed_path.write_bytes(seed_proof_data)
    final_path.write_bytes(final_proof_data)
    allowlist_path.write_bytes(b"fixture-export\n")
    receipt = {
        "schema": "oliphaunt.wasix-postmaster.sealed-export-structure.v1",
        "policy-id": "oliphaunt.wasix-postmaster.sealed-export-closure.v1",
        "analyzer-version": "fixture",
        "analyzer-binary-sha256": "0" * 64,
        "dce-tool-sha256": "1" * 64,
        "dce-tool-version": "fixture-wasm-opt",
        "dce-passes": ["--remove-unused-module-elements"],
        "mandatory-policy-sha256": mandatory_hash,
        "declared-main-dlsym-policy-sha256": dlsym_hash,
        "side-manifest-sha256": digest(side_manifest.read_bytes()),
        "allowlist-sha256": digest(allowlist_path.read_bytes()),
        "seed-proof-sha256": digest(seed_proof_data),
        "final-proof-sha256": digest(final_proof_data),
        "seed": snapshot(seed_sha, len(postgres) + 16),
        "final-module": snapshot(digest(postgres), len(postgres)),
        "sides": [{"path": side["path"], "sha256": side["sha256"]} for side in sides],
    }
    (share / "wasix-postmaster.sealed-export.structure.receipt").write_bytes(json_bytes(receipt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
