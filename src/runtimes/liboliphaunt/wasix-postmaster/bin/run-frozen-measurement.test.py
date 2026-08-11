#!/usr/bin/env python3

"""Tests for content-addressed measurement-tool closures."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("run-frozen-measurement.py")
SPEC = importlib.util.spec_from_file_location("frozen_measurement", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def make_writable(root: Path) -> None:
    if not root.exists():
        return
    for current, directories, files in os.walk(root):
        os.chmod(current, 0o700)
        for name in directories:
            os.chmod(Path(current, name), 0o700)
        for name in files:
            os.chmod(Path(current, name), 0o600)


class FrozenMeasurementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.work = self.root / "work"
        (self.source / "bin").mkdir(parents=True)
        (self.source / "lib").mkdir()
        (self.source / "bin/tool.sh").write_text(
            "#!/usr/bin/env bash\necho frozen\n", encoding="utf-8"
        )
        os.chmod(self.source / "bin/tool.sh", 0o755)
        (self.source / "lib/data.txt").write_text("stable\n", encoding="utf-8")

    def tearDown(self) -> None:
        make_writable(self.root)
        self.temporary.cleanup()

    def test_freeze_is_content_addressed_and_verifiable(self) -> None:
        closure, identity, manifest_sha256 = MODULE.freeze(self.source, self.work)
        self.assertEqual(closure.name, identity)
        self.assertEqual(
            MODULE.verify_closure(
                closure,
                closure / MODULE.MANIFEST_NAME,
                identity,
                manifest_sha256,
            ),
            manifest_sha256,
        )
        self.assertEqual(os.lstat(closure).st_mode & 0o222, 0)
        self.assertEqual(os.lstat(closure / "bin/tool.sh").st_mode & 0o222, 0)
        repeated = MODULE.freeze(self.source, self.work)
        self.assertEqual(repeated, (closure, identity, manifest_sha256))

    def test_source_change_produces_new_identity(self) -> None:
        first = MODULE.freeze(self.source, self.work)
        (self.source / "lib/data.txt").write_text("changed\n", encoding="utf-8")
        second = MODULE.freeze(self.source, self.work)
        self.assertNotEqual(first[1], second[1])
        self.assertNotEqual(first[0], second[0])

    def test_closure_mutation_is_rejected(self) -> None:
        closure, identity, manifest_sha256 = MODULE.freeze(self.source, self.work)
        target = closure / "lib/data.txt"
        os.chmod(closure, 0o755)
        os.chmod(closure / "lib", 0o755)
        os.chmod(target, 0o644)
        target.write_text("tampered\n", encoding="utf-8")
        with self.assertRaisesRegex(MODULE.ClosureError, "bytes or modes differ"):
            MODULE.verify_closure(
                closure,
                closure / MODULE.MANIFEST_NAME,
                identity,
                manifest_sha256,
            )

    def test_source_symlink_is_rejected(self) -> None:
        (self.source / "lib/link").symlink_to("data.txt")
        with self.assertRaisesRegex(MODULE.ClosureError, "not a regular file"):
            MODULE.freeze(self.source, self.work)


if __name__ == "__main__":
    unittest.main()
