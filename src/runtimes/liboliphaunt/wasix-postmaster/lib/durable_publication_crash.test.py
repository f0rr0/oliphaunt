#!/usr/bin/env python3

"""Fault-model tests for receipt admission and recovery.

These tests deliberately stop a forked publisher immediately after each
namespace/durability operation.  The child uses ``os._exit`` so Python
``finally`` blocks do not turn the simulated crash into an orderly rollback.
"""

from __future__ import annotations

import importlib.util
import io
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("durable_publication.py")
SPEC = importlib.util.spec_from_file_location("durable_publication", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PUBLICATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLICATION)

PAYLOAD = b"schema=receipt.v1\nidentity=exact\n"


class _BinaryStdin:
    def __init__(self, payload: bytes) -> None:
        self.buffer = io.BytesIO(payload)


class DurablePublicationCrashTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.pending = self.root / ".receipt.pending"
        self.destination = self.root / "receipt"
        self.expected = self.root / "expected"
        self.expected.write_bytes(PAYLOAD)
        os.chmod(self.expected, 0o444)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def create_pending(self) -> None:
        self.assertFalse(self.pending.exists())
        with mock.patch.object(PUBLICATION.sys, "stdin", _BinaryStdin(PAYLOAD)):
            PUBLICATION.write_stdin(self.pending)

    def assert_exact_admission(self) -> None:
        self.assertTrue(self.destination.is_file())
        self.assertFalse(self.destination.is_symlink())
        self.assertEqual(self.destination.read_bytes(), PAYLOAD)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o444)

    def recover(self) -> None:
        # This is the caller protocol in build-wasix-core.sh: discard a stale
        # private name first, replay an admitted generation, or regenerate and
        # publish when no admission name survived.
        if self.pending.exists() or self.pending.is_symlink():
            PUBLICATION.discard_private(self.pending)
        if self.destination.exists() or self.destination.is_symlink():
            PUBLICATION.require_equal(self.expected, self.destination)
        else:
            self.create_pending()
            PUBLICATION.publish(self.pending, self.destination)

    def crash_publish(self, point: str) -> None:
        self.create_pending()
        pid = os.fork()
        if pid == 0:
            real_fsync = PUBLICATION.os.fsync
            real_link = PUBLICATION.os.link
            real_unlink = PUBLICATION.os.unlink
            fsync_calls = 0
            unlink_calls = 0

            def crash_after_fsync(descriptor: int) -> None:
                nonlocal fsync_calls
                real_fsync(descriptor)
                fsync_calls += 1
                fsync_points = {
                    1: "source-fsync",
                    2: "destination-fsync",
                    3: "commit-directory-fsync",
                    4: "cleanup-directory-fsync",
                }
                if fsync_points.get(fsync_calls) == point:
                    os._exit(91)

            def crash_after_link(*args: object, **kwargs: object) -> None:
                real_link(*args, **kwargs)
                if point == "link":
                    os._exit(92)

            def crash_after_unlink(*args: object, **kwargs: object) -> None:
                nonlocal unlink_calls
                real_unlink(*args, **kwargs)
                unlink_calls += 1
                if point == "source-unlink" and unlink_calls == 1:
                    os._exit(93)

            try:
                with (
                    mock.patch.object(PUBLICATION.os, "fsync", crash_after_fsync),
                    mock.patch.object(PUBLICATION.os, "link", crash_after_link),
                    mock.patch.object(PUBLICATION.os, "unlink", crash_after_unlink),
                ):
                    PUBLICATION.publish(self.pending, self.destination)
            except BaseException:
                os._exit(94)
            os._exit(95)

        waited, wait_status = os.waitpid(pid, 0)
        self.assertEqual(waited, pid)
        self.assertTrue(os.WIFEXITED(wait_status))
        self.assertIn(os.WEXITSTATUS(wait_status), {91, 92, 93})

    @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX fork semantics")
    def test_each_publish_crash_boundary_recovers_exactly_and_idempotently(self) -> None:
        points = (
            "source-fsync",
            "link",
            "destination-fsync",
            "commit-directory-fsync",
            "source-unlink",
            "cleanup-directory-fsync",
        )
        for point in points:
            with self.subTest(point=point):
                if self.pending.exists() or self.pending.is_symlink():
                    self.pending.unlink()
                if self.destination.exists() or self.destination.is_symlink():
                    self.destination.unlink()

                self.crash_publish(point)
                if self.destination.exists():
                    self.assert_exact_admission()

                self.recover()
                self.assert_exact_admission()
                self.assertFalse(self.pending.exists())

                # A second replay must preserve the admitted inode and bytes.
                admitted_identity = (
                    self.destination.stat().st_dev,
                    self.destination.stat().st_ino,
                )
                self.recover()
                self.assertEqual(
                    admitted_identity,
                    (self.destination.stat().st_dev, self.destination.stat().st_ino),
                )
                self.assert_exact_admission()

    def test_post_link_identity_failure_rolls_back_created_destination(self) -> None:
        self.create_pending()
        real_link = PUBLICATION.os.link
        real_unlink = PUBLICATION.os.unlink

        def replace_source_then_link(*args: object, **kwargs: object) -> None:
            real_unlink(self.pending)
            self.pending.write_bytes(b"wrong generation\n")
            os.chmod(self.pending, 0o444)
            real_link(*args, **kwargs)

        with mock.patch.object(PUBLICATION.os, "link", replace_source_then_link):
            with self.assertRaises(PUBLICATION.PublicationError):
                PUBLICATION.publish(self.pending, self.destination)

        self.assertFalse(
            self.destination.exists(),
            "a helper-created destination survived pre-commit identity failure",
        )

    def test_post_link_fsync_failure_rolls_back_exact_destination(self) -> None:
        self.create_pending()
        real_fsync = PUBLICATION.os.fsync
        calls = 0

        def fail_destination_fsync(descriptor: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected destination fsync failure")
            real_fsync(descriptor)

        with mock.patch.object(PUBLICATION.os, "fsync", fail_destination_fsync):
            with self.assertRaises(OSError):
                PUBLICATION.publish(self.pending, self.destination)

        self.assertFalse(self.destination.exists())
        self.assertEqual(self.pending.read_bytes(), PAYLOAD)
        self.recover()
        self.assert_exact_admission()

    def test_rollback_does_not_remove_concurrent_destination(self) -> None:
        self.create_pending()
        real_fsync = PUBLICATION.os.fsync
        real_unlink = PUBLICATION.os.unlink
        calls = 0
        competitor = b"concurrent owner\n"

        def replace_destination_then_fail(descriptor: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                real_unlink(self.destination)
                self.destination.write_bytes(competitor)
                raise OSError("injected destination replacement")
            real_fsync(descriptor)

        with mock.patch.object(PUBLICATION.os, "fsync", replace_destination_then_fail):
            with self.assertRaises(OSError):
                PUBLICATION.publish(self.pending, self.destination)

        self.assertEqual(self.destination.read_bytes(), competitor)

    def test_write_stdin_rejects_symlink_without_touching_target(self) -> None:
        target = self.root / "unrelated"
        target.write_bytes(b"do not touch\n")
        self.pending.symlink_to(target.name)
        with mock.patch.object(PUBLICATION.sys, "stdin", _BinaryStdin(PAYLOAD)):
            with self.assertRaises(PUBLICATION.PublicationError):
                PUBLICATION.write_stdin(self.pending)
        self.assertTrue(self.pending.is_symlink())
        self.assertEqual(target.read_bytes(), b"do not touch\n")


if __name__ == "__main__":
    unittest.main()
