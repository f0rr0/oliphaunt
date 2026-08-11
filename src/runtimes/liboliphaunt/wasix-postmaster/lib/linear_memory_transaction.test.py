#!/usr/bin/env python3

"""Crash-boundary tests for durable linear-memory publication."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from linear_memory_transaction import (
    AGGREGATE_RELATIVE,
    init_transaction,
    prepare_transaction,
    publish_transaction,
    recover_transaction,
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_fixture(root: Path, suffix: str) -> tuple[Path, Path, dict[str, bytes]]:
    install = root / suffix / "install"
    stage = install / ".oliphaunt-linear-memory.pending"
    originals = {"bin/a.wasm": b"original-a", "lib/b.wasm": b"original-b"}
    sealed = {"bin/a.wasm": b"sealed-a", "lib/b.wasm": b"sealed-b"}
    for relative, data in originals.items():
        path = install / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (install / "share/postgresql").mkdir(parents=True)
    init_transaction(install, stage)
    modules = []
    for relative in sorted(originals):
        path = stage / "modules" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(sealed[relative])
        modules.append(
            {
                "path": relative,
                "source-module-sha256": digest(originals[relative]),
                "module-sha256": digest(sealed[relative]),
            }
        )
    aggregate = {
        "schema": "oliphaunt.wasix-postmaster.linear-memory-install.v1",
        "module-count": len(modules),
        "modules": modules,
    }
    aggregate_path = stage / "wasix-postmaster.linear-memory-profile.receipt.json"
    aggregate_path.write_text(
        json.dumps(aggregate, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    prepare_transaction(install, stage, aggregate_path)
    return install, stage, originals


def assert_originals(install: Path, originals: dict[str, bytes]) -> None:
    for relative, data in originals.items():
        assert (install / relative).read_bytes() == data


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="linear-memory-transaction-test."))
    try:
        install, stage, originals = write_fixture(root, "interrupted-modules")
        os.replace(stage / "modules/bin/a.wasm", install / "bin/a.wasm")
        assert recover_transaction(install, stage) == "rolled-back"
        assert_originals(install, originals)
        assert not stage.exists()

        install, stage, originals = write_fixture(root, "premature-receipt")
        os.replace(stage / "modules/bin/a.wasm", install / "bin/a.wasm")
        os.link(
            stage / "wasix-postmaster.linear-memory-profile.receipt.json",
            install / AGGREGATE_RELATIVE,
        )
        assert recover_transaction(install, stage) == "rolled-back"
        assert_originals(install, originals)
        assert not (install / AGGREGATE_RELATIVE).exists()

        install, stage, _ = write_fixture(root, "commit")
        publish_transaction(install, stage)
        assert not stage.exists()
        assert (install / AGGREGATE_RELATIVE).is_file()
        assert recover_transaction(install, stage) == "none"

        install = root / "abandoned-staging" / "install"
        install.mkdir(parents=True)
        stage = install / ".oliphaunt-linear-memory.pending"
        init_transaction(install, stage)
        (stage / "modules" / "partial").write_bytes(b"partial")
        assert recover_transaction(install, stage) == "discarded-staging"
        assert not stage.exists()
    finally:
        shutil.rmtree(root)
    print("linear-memory transaction tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
