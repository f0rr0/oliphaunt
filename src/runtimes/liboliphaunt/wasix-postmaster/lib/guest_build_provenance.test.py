#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import contextlib
import io
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("guest_build_provenance.py")
SPEC = importlib.util.spec_from_file_location("guest_build_provenance", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PROVENANCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROVENANCE)


class GuestBuildProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for relative in PROVENANCE.REQUIRED_MODULES:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"module:{relative}\n".encode())
        share = self.root / "share/postgresql"
        (share / "nested").mkdir(parents=True)
        (share / "postgres.bki").write_bytes(b"bootstrap\n")
        (share / "nested/data.txt").write_bytes(b"nested\n")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_seal_identity_matches_read_only_identity_and_fsyncs_topology(self) -> None:
        expected = PROVENANCE.installed_closure_identity(self.root)
        with mock.patch.object(
            PROVENANCE.os, "fsync", wraps=os.fsync
        ) as synchronized:
            actual = PROVENANCE.seal_installed_closure(self.root)
        self.assertEqual(actual, expected)
        files = PROVENANCE.closure_files(self.root)
        directories = PROVENANCE.directory_closure(files)
        self.assertGreaterEqual(synchronized.call_count, len(files) + len(directories))

    def test_directory_closure_is_bottom_up_and_includes_root(self) -> None:
        directories = PROVENANCE.directory_closure(
            ["bin/postgres", "share/postgresql/nested/data.txt"]
        )
        self.assertEqual(directories[-1], ".")
        depths = [len(Path(relative).parts) for relative in directories]
        self.assertEqual(depths, sorted(depths, reverse=True))

    def test_seal_rejects_symlinked_intermediate_directory(self) -> None:
        postgresql = self.root / "lib/postgresql"
        actual = self.root / "lib/postgresql.actual"
        postgresql.rename(actual)
        postgresql.symlink_to(actual.name)
        with self.assertRaises(PROVENANCE.ProvenanceError):
            PROVENANCE.seal_installed_closure(self.root)

    def test_unsynchronized_replacement_after_directory_fsync_is_rejected(self) -> None:
        original = PROVENANCE.synchronize_directories

        def replace_after_sync(
            root: Path, directories: list[str]
        ) -> dict[str, PROVENANCE.FileIdentity]:
            identities = original(root, directories)
            postgres = root / "bin/postgres"
            replacement = root / "bin/.postgres.replacement"
            replacement.write_bytes(postgres.read_bytes())
            os.replace(replacement, postgres)
            return identities

        with mock.patch.object(
            PROVENANCE,
            "synchronize_directories",
            side_effect=replace_after_sync,
        ):
            with self.assertRaises(PROVENANCE.ProvenanceError):
                PROVENANCE.seal_installed_closure(self.root)

    def test_seal_cli_emits_canonical_sha256(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(
                PROVENANCE.main(["seal-identity", str(self.root)]),
                0,
            )
        self.assertIsNotNone(re.fullmatch(r"[0-9a-f]{64}\n", output.getvalue()))


if __name__ == "__main__":
    unittest.main()
