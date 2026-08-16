#!/usr/bin/env python3

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PROJECT_ROOT.parents[3]
VERIFIER = PROJECT_ROOT / "runtime/bin/verify-source-lock.py"


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def fixture(root: Path) -> tuple[Path, Path]:
    repo = root / "repo"
    project = repo / "src/runtimes/liboliphaunt/wasix-postmaster"
    copy_file(PROJECT_ROOT / "sources.lock.toml", project / "sources.lock.toml")
    copy_file(PROJECT_ROOT / "lib/common.sh", project / "lib/common.sh")
    for patch in (
        "postgres/patches/series",
        "postgres/product-patch-provenance.toml",
        "postgres/patches/0001-wasix-use-posix-dsm-not-sysv.patch",
        "postgres/patches/0003-wasix-libpq-static-encoding-shim.patch",
        "postgres/patches/0004-wasix-core-execbackend-initdb-runtime.patch",
        "postgres/patches/0006-wasix-retry-proc-join-on-eintr.patch",
        "postgres/patches/0008-wasix-packed-atomic-latch-state.patch",
        "runtime/patches/wasmer/0001-postgres-wasix-blockers.patch",
        "runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch",
    ):
        copy_file(PROJECT_ROOT / patch, project / patch)
    shutil.copytree(
        REPO_ROOT / "src/sources/third-party/wasix-postmaster",
        repo / "src/sources/third-party/wasix-postmaster",
    )
    copy_file(
        REPO_ROOT / "src/postgres/versions/18/source.toml",
        repo / "src/postgres/versions/18/source.toml",
    )
    return project, repo


def run(project: Path, repo: Path, *, succeeds: bool, marker: str = "") -> None:
    result = subprocess.run(
        [
            "python3",
            str(VERIFIER),
            "--project-root",
            str(project),
            "--repo-root",
            str(repo),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if (result.returncode == 0) != succeeds:
        raise AssertionError(
            f"unexpected verifier status {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    combined = result.stdout + result.stderr
    if marker and marker not in combined:
        raise AssertionError(f"missing {marker!r} in verifier output: {combined}")


def replace(path: Path, old: str, new: str) -> None:
    contents = path.read_text(encoding="utf-8")
    if old not in contents:
        raise AssertionError(f"fixture marker missing from {path}: {old}")
    path.write_text(contents.replace(old, new, 1), encoding="utf-8")


def main() -> None:
    run(PROJECT_ROOT, REPO_ROOT, succeeds=True, marker="source lock verified")

    with tempfile.TemporaryDirectory(prefix="wasix-source-lock-test-") as temporary:
        project, repo = fixture(Path(temporary))
        run(project, repo, succeeds=True)
        manifest = repo / "src/sources/third-party/wasix-postmaster/wasmer-test-files.toml"
        replace(
            manifest,
            "7f27e84c69af3b772f751d6c4a733d9f448b2c70",
            "0000000000000000000000000000000000000000",
        )
        run(project, repo, succeeds=False, marker="wasmer_test_files source commit")

    with tempfile.TemporaryDirectory(prefix="wasix-source-lock-test-") as temporary:
        project, repo = fixture(Path(temporary))
        patch = project / "postgres/patches/0008-wasix-packed-atomic-latch-state.patch"
        with patch.open("ab") as handle:
            handle.write(b"\n")
        run(
            project,
            repo,
            succeeds=False,
            marker="current_postgresql_product_inputs.file",
        )

    with tempfile.TemporaryDirectory(prefix="wasix-source-lock-test-") as temporary:
        project, repo = fixture(Path(temporary))
        lock = project / "sources.lock.toml"
        replace(
            lock,
            'feature_macro = "PG_WASIX_ATOMIC_LATCH_STATE"',
            'feature_macro = "PG_WASIX_UNSAFE_LATCH_STATE"',
        )
        run(
            project,
            repo,
            succeeds=False,
            marker="current_postgresql_patches.packed_atomic_latch_state.feature_macro",
        )

    with tempfile.TemporaryDirectory(prefix="wasix-source-lock-test-") as temporary:
        project, repo = fixture(Path(temporary))
        patch = project / "runtime/patches/wasmer/0001-postgres-wasix-blockers.patch"
        with patch.open("ab") as handle:
            handle.write(b"\n")
        run(project, repo, succeeds=False, marker="current_runtime_patches.wasmer.bytes")

    with tempfile.TemporaryDirectory(prefix="wasix-source-lock-test-") as temporary:
        project, repo = fixture(Path(temporary))
        patch = project / "runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch"
        with patch.open("ab") as handle:
            handle.write(b"\n")
        run(
            project,
            repo,
            succeeds=False,
            marker="current_runtime_patches.wasix_libc.bytes",
        )

    with tempfile.TemporaryDirectory(prefix="wasix-source-lock-test-") as temporary:
        project, repo = fixture(Path(temporary))
        patch = project / "postgres/patches/0001-wasix-use-posix-dsm-not-sysv.patch"
        with patch.open("ab") as handle:
            handle.write(b"\n")
        run(
            project,
            repo,
            succeeds=False,
            marker="current_postgresql_product_inputs.file",
        )

    print("source lock verifier tests passed")


if __name__ == "__main__":
    main()
