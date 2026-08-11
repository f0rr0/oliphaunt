#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("durable_publication.py")
SPEC = importlib.util.spec_from_file_location("durable_publication", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PUBLICATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLICATION)


class DurablePublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write(self, name: str, payload: bytes = b"receipt\n") -> Path:
        path = self.root / name
        path.write_bytes(payload)
        return path

    def test_publish_is_no_replace_and_removes_private_name(self) -> None:
        pending = self.write(".receipt.pending")
        os.chmod(pending, 0o444)
        destination = self.root / "receipt"
        PUBLICATION.publish(pending, destination)
        self.assertFalse(pending.exists())
        self.assertEqual(destination.read_bytes(), b"receipt\n")
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o444)
        self.assertEqual(destination.stat().st_nlink, 1)

    def test_existing_destination_is_never_replaced(self) -> None:
        pending = self.write(".receipt.pending", b"new\n")
        destination = self.write("receipt", b"old\n")
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.publish(pending, destination)
        self.assertEqual(pending.read_bytes(), b"new\n")
        self.assertEqual(destination.read_bytes(), b"old\n")

    def test_symlink_source_is_rejected(self) -> None:
        real = self.write("real")
        pending = self.root / ".receipt.pending"
        pending.symlink_to(real.name)
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.publish(pending, self.root / "receipt")

    def test_require_equal_rejects_mismatch_and_symlink(self) -> None:
        left = self.write("left", b"same\n")
        right = self.write("right", b"same\n")
        PUBLICATION.require_equal(left, right)
        right.write_bytes(b"different\n")
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.require_equal(left, right)
        right.unlink()
        right.symlink_to(left.name)
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.require_equal(left, right)

    def test_stable_read_and_digest_reject_mutation_during_open(self) -> None:
        for operation in (
            PUBLICATION.stable_regular_bytes,
            PUBLICATION.stable_regular_digest,
        ):
            with self.subTest(operation=operation.__name__):
                path = self.write(f"{operation.__name__}.input", b"trusted!")
                real_open = PUBLICATION.os.open
                injected = False

                def mutate_then_open(target, *args, **kwargs):
                    nonlocal injected
                    if not injected and Path(os.path.abspath(target)) == path:
                        injected = True
                        time.sleep(0.002)
                        with path.open("r+b") as handle:
                            handle.write(b"attack!!")
                    return real_open(target, *args, **kwargs)

                with mock.patch.object(
                    PUBLICATION.os, "open", side_effect=mutate_then_open
                ):
                    with self.assertRaisesRegex(
                        PUBLICATION.PublicationError,
                        "changed while opening",
                    ):
                        operation(path)

    def test_anchored_open_rejects_mutation_during_open(self) -> None:
        path = self.write("anchored.input", b"trusted!")
        real_open = PUBLICATION.os.open
        injected = False

        def mutate_then_open(target, *args, **kwargs):
            nonlocal injected
            if not injected and target == path.name and kwargs.get("dir_fd") is not None:
                injected = True
                time.sleep(0.002)
                with path.open("r+b") as handle:
                    handle.write(b"attack!!")
            return real_open(target, *args, **kwargs)

        with PUBLICATION.AnchoredDirectory(self.root) as directory:
            with mock.patch.object(PUBLICATION.os, "open", side_effect=mutate_then_open):
                with self.assertRaisesRegex(
                    PUBLICATION.PublicationError,
                    "changed while opening",
                ):
                    directory.open_regular(path.name)
    def test_discard_private_is_idempotent_and_rejects_symlink(self) -> None:
        pending = self.write(".receipt.pending")
        PUBLICATION.discard_private(pending)
        PUBLICATION.discard_private(pending)
        pending.symlink_to(self.write("real").name)
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.discard_private(pending)

    def test_write_stdin_creates_fsynced_publication_source(self) -> None:
        pending = self.root / ".receipt.pending"
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH), "write-stdin", str(pending)],
            input=b"captured receipt\n",
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(pending.read_bytes(), b"captured receipt\n")
        self.assertEqual(stat.S_IMODE(pending.stat().st_mode), 0o444)
        second = subprocess.run(
            [sys.executable, str(MODULE_PATH), "write-stdin", str(pending)],
            input=b"replacement\n",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(second.returncode, 2)
        self.assertEqual(pending.read_bytes(), b"captured receipt\n")

    def test_cli_identified_handoff_rejects_replaced_source(self) -> None:
        pending = self.root / ".receipt.pending"
        destination = self.root / "receipt"
        written = subprocess.run(
            [
                sys.executable,
                str(MODULE_PATH),
                "write-stdin-identified",
                str(pending),
            ],
            input=b"intended\n",
            stdout=subprocess.PIPE,
            check=True,
        )
        fields = written.stdout.decode("ascii").strip().split("\t")
        self.assertEqual(len(fields), 4)

        replacement = self.root / ".replacement"
        replacement.write_bytes(b"attacker\n")
        os.chmod(replacement, 0o444)
        os.replace(replacement, pending)
        rejected = subprocess.run(
            [
                sys.executable,
                str(MODULE_PATH),
                "publish-identified",
                str(pending),
                str(destination),
                *fields,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(rejected.returncode, 2)
        self.assertFalse(destination.exists())
        self.assertEqual(pending.read_bytes(), b"attacker\n")

    def test_cli_identified_handoff_publishes_exact_source(self) -> None:
        pending = self.root / ".receipt.pending"
        destination = self.root / "receipt"
        written = subprocess.run(
            [
                sys.executable,
                str(MODULE_PATH),
                "write-stdin-identified",
                str(pending),
            ],
            input=b"intended\n",
            stdout=subprocess.PIPE,
            check=True,
        )
        fields = written.stdout.decode("ascii").strip().split("\t")
        published = subprocess.run(
            [
                sys.executable,
                str(MODULE_PATH),
                "publish-identified",
                str(pending),
                str(destination),
                *fields,
            ],
            check=False,
        )
        self.assertEqual(published.returncode, 0)
        self.assertEqual(destination.read_bytes(), b"intended\n")
        self.assertFalse(pending.exists())

    def test_parent_symlink_is_rejected(self) -> None:
        actual = self.root / "actual"
        actual.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(actual.name)
        pending = actual / ".receipt.pending"
        pending.write_bytes(b"receipt\n")
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.publish(pending, alias / "receipt")

    def test_publish_set_recovers_an_identical_partial_admission(self) -> None:
        first_source = self.write(".first.pending", b"first\n")
        second_source = self.write(".second.pending", b"second\n")
        first_destination = self.root / "first"
        second_destination = self.root / "second"
        os.chmod(first_source, 0o444)
        os.chmod(second_source, 0o444)
        PUBLICATION.publish(first_source, first_destination)

        first_replay = self.write(".first.replay", b"first\n")
        os.chmod(first_replay, 0o444)
        PUBLICATION.publish_set(
            (first_replay, first_destination, second_source, second_destination)
        )
        self.assertFalse(first_replay.exists())
        self.assertFalse(second_source.exists())
        self.assertEqual(first_destination.read_bytes(), b"first\n")
        self.assertEqual(second_destination.read_bytes(), b"second\n")

    def test_publish_set_rejects_a_different_partial_admission(self) -> None:
        first_destination = self.write("first", b"other\n")
        os.chmod(first_destination, 0o444)
        first_source = self.write(".first.pending", b"first\n")
        second_source = self.write(".second.pending", b"second\n")
        os.chmod(first_source, 0o444)
        os.chmod(second_source, 0o444)
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.publish_set(
                (
                    first_source,
                    first_destination,
                    second_source,
                    self.root / "second",
                )
            )
        self.assertEqual(first_destination.read_bytes(), b"other\n")
        self.assertFalse((self.root / "second").exists())

    def test_publish_set_rejects_an_unsealed_partial_admission(self) -> None:
        first_destination = self.write("first", b"first\n")
        first_source = self.write(".first.pending", b"first\n")
        second_source = self.write(".second.pending", b"second\n")
        os.chmod(first_source, 0o444)
        os.chmod(second_source, 0o444)
        with self.assertRaises(PUBLICATION.PublicationError):
            PUBLICATION.publish_set(
                (
                    first_source,
                    first_destination,
                    second_source,
                    self.root / "second",
                )
            )
        self.assertFalse((self.root / "second").exists())

    def test_publish_set_preserves_a_replaced_private_generation(self) -> None:
        first_source = self.write(".first.pending", b"first\n")
        second_source = self.write(".second.pending", b"second\n")
        first_destination = self.root / "first"
        os.chmod(first_source, 0o444)
        os.chmod(second_source, 0o444)
        replacement_identity: tuple[int, int] | None = None

        def concurrent_identical_publish(
            source: Path,
            destination: Path,
            expected: object,
        ) -> None:
            nonlocal replacement_identity
            replacement = source.with_name(f"{source.name}.replacement")
            replacement.write_bytes(b"first\n")
            os.chmod(replacement, 0o444)
            os.replace(replacement, source)
            replacement_identity = (source.stat().st_dev, source.stat().st_ino)
            destination.write_bytes(b"first\n")
            os.chmod(destination, 0o444)
            raise PUBLICATION.PublicationError("concurrent identical publisher")

        with mock.patch.object(
            PUBLICATION, "publish_identified", concurrent_identical_publish
        ):
            with self.assertRaisesRegex(
                PUBLICATION.PublicationError,
                "private publication generation changed",
            ):
                PUBLICATION.publish_set(
                    (
                        first_source,
                        first_destination,
                        second_source,
                        self.root / "second",
                    )
                )

        self.assertEqual(
            replacement_identity,
            (first_source.stat().st_dev, first_source.stat().st_ino),
        )
        self.assertEqual(first_source.read_bytes(), b"first\n")
        self.assertFalse((self.root / "second").exists())

    def test_identified_publish_rejects_replaced_private_generation(self) -> None:
        source = self.root / ".receipt.pending"
        intended = PUBLICATION.write_bytes(source, b"intended\n")
        replacement = self.root / ".replacement"
        replacement.write_bytes(b"attacker\n")
        os.chmod(replacement, 0o444)
        os.replace(replacement, source)
        destination = self.root / "receipt"

        with self.assertRaisesRegex(
            PUBLICATION.PublicationError,
            "generation differs from intended source",
        ):
            PUBLICATION.publish_identified(source, destination, intended)

        self.assertFalse(destination.exists())
        self.assertEqual(source.read_bytes(), b"attacker\n")

    def test_publish_set_rejects_source_swap_without_admitting_swapped_bytes(self) -> None:
        first_source = self.root / ".first.pending"
        second_source = self.root / ".second.pending"
        PUBLICATION.write_bytes(first_source, b"first\n")
        PUBLICATION.write_bytes(second_source, b"second\n")
        first_destination = self.root / "first"
        second_destination = self.root / "second"
        real_publish = PUBLICATION.publish_identified
        injected = False

        def replace_before_publish(source, destination, expected):
            nonlocal injected
            if not injected:
                injected = True
                replacement = source.with_name(f"{source.name}.replacement")
                replacement.write_bytes(b"ATTACKER\n")
                os.chmod(replacement, 0o444)
                os.replace(replacement, source)
            return real_publish(source, destination, expected)

        with mock.patch.object(
            PUBLICATION, "publish_identified", replace_before_publish
        ):
            with self.assertRaises(PUBLICATION.PublicationError):
                PUBLICATION.publish_set(
                    (
                        first_source,
                        first_destination,
                        second_source,
                        second_destination,
                    )
                )

        self.assertFalse(first_destination.exists())
        self.assertFalse(second_destination.exists())
        self.assertEqual(first_source.read_bytes(), b"ATTACKER\n")

    def test_publish_set_preflights_later_conflict_before_any_admission(self) -> None:
        first_source = self.root / ".first.pending"
        second_source = self.root / ".second.pending"
        PUBLICATION.write_bytes(first_source, b"first\n")
        PUBLICATION.write_bytes(second_source, b"second\n")
        first_destination = self.root / "first"
        second_destination = self.write("second", b"conflict\n")
        os.chmod(second_destination, 0o444)

        with self.assertRaisesRegex(
            PUBLICATION.PublicationError,
            "publication set destination differs",
        ):
            PUBLICATION.publish_set(
                (
                    first_source,
                    first_destination,
                    second_source,
                    second_destination,
                )
            )

        self.assertFalse(first_destination.exists())
        self.assertEqual(second_destination.read_bytes(), b"conflict\n")

    def test_publish_set_streams_members_larger_than_the_comparison_limit(self) -> None:
        large_payload = b"x" * (PUBLICATION.MAX_COMPARISON_BYTES + 1)
        large_source = self.root / ".large.pending"
        small_source = self.root / ".small.pending"
        PUBLICATION.write_bytes(large_source, large_payload)
        PUBLICATION.write_bytes(small_source, b"small\n")
        large_destination = self.root / "large"
        small_destination = self.root / "small"

        PUBLICATION.publish_set(
            (
                large_source,
                large_destination,
                small_source,
                small_destination,
            )
        )

        self.assertEqual(large_destination.stat().st_size, len(large_payload))
        self.assertEqual(small_destination.read_bytes(), b"small\n")


if __name__ == "__main__":
    unittest.main()
