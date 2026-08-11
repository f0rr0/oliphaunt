#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("shared_memory_provider.py")
SPEC = importlib.util.spec_from_file_location("shared_memory_provider", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
provider = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SharedMemoryProviderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="oliphaunt-shared-memory-provider-test."
        )
        self.root = Path(self.temporary.name)
        self.run = self.root / "run"
        self.report = self.root / "report"
        self.run.mkdir()
        self.report.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def prepare_portable(self) -> tuple[Path, Path, str]:
        evidence = self.report / "provider.json"
        root = provider.prepare(
            provider.PORTABLE_FILE_PROVIDER,
            evidence,
            measurement_id="test-portable",
            target="wasix",
            portable_root=self.run / "dev-shm",
        )
        return root, evidence, digest(evidence)

    def test_portable_receipt_and_empty_only_cleanup(self) -> None:
        root, evidence, evidence_sha256 = self.prepare_portable()
        receipt = json.loads(evidence.read_text(encoding="utf-8"))
        self.assertEqual(receipt["schema"], provider.PROVIDER_SCHEMA)
        self.assertEqual(receipt["provider"], provider.PORTABLE_FILE_PROVIDER)
        self.assertEqual(receipt["directory"]["mode"], "0700")
        self.assertEqual(receipt["directory"]["ownership_status"], "passed")
        self.assertEqual(receipt["contract"]["expected_filesystem"], "any")
        self.assertEqual(evidence.stat().st_mode & 0o777, 0o444)
        self.assertEqual(
            provider.identify(evidence),
            (provider.PORTABLE_FILE_PROVIDER, root, evidence_sha256),
        )
        provider.verify(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
        )

        sentinel = self.root / "outside-sentinel"
        sentinel.write_text("must survive\n", encoding="ascii")
        (root / "nested").mkdir()
        (root / "nested" / "owned").write_text("remove\n", encoding="ascii")
        (root / "outside-link").symlink_to(sentinel)
        cleanup_evidence = self.report / "cleanup.json"
        with self.assertRaisesRegex(provider.ProviderError, "nonempty provider root"):
            provider.cleanup(
                evidence,
                evidence_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
                cleanup_evidence,
                "test-cleanup",
            )
        self.assertTrue(root.is_dir())
        self.assertEqual(sentinel.read_text(encoding="ascii"), "must survive\n")
        (root / "outside-link").unlink()
        (root / "nested" / "owned").unlink()
        (root / "nested").rmdir()
        provider.cleanup(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            cleanup_evidence,
            "test-cleanup",
        )
        self.assertFalse(root.exists())
        self.assertEqual(sentinel.read_text(encoding="ascii"), "must survive\n")
        cleanup_receipt = json.loads(cleanup_evidence.read_text(encoding="utf-8"))
        self.assertEqual(cleanup_receipt["schema"], provider.CLEANUP_SCHEMA)
        self.assertEqual(cleanup_receipt["result"], "removed")
        self.assertEqual(cleanup_receipt["reason"], "test-cleanup")
        self.assertEqual(
            cleanup_receipt["provider_evidence_sha256"], evidence_sha256
        )

    def test_receipt_hash_mode_and_inode_drift_fail_closed(self) -> None:
        root, evidence, evidence_sha256 = self.prepare_portable()
        with self.assertRaisesRegex(provider.ProviderError, "SHA-256 differs"):
            provider.verify(
                evidence,
                "0" * 64,
                provider.PORTABLE_FILE_PROVIDER,
                root,
            )

        malformed = self.report / "malformed-provider.json"
        malformed_value = json.loads(evidence.read_text(encoding="utf-8"))
        malformed_value["directory"]["parent_path"] = 7
        malformed.write_text(
            json.dumps(malformed_value, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(provider.ProviderError, "parent path is invalid"):
            provider.verify(
                malformed,
                digest(malformed),
                provider.PORTABLE_FILE_PROVIDER,
                root,
            )

        root.chmod(0o755)
        with self.assertRaisesRegex(provider.ProviderError, "mode differs"):
            provider.cleanup(
                evidence,
                evidence_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
                self.report / "should-not-exist.json",
                "mode-drift",
            )
        self.assertTrue(root.is_dir())
        root.chmod(0o700)

        held = self.run / "held-original"
        root.rename(held)
        root.mkdir(mode=0o700)
        replacement_inode = root.stat().st_ino
        with self.assertRaisesRegex(provider.ProviderError, "inode differs"):
            provider.cleanup(
                evidence,
                evidence_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
                self.report / "still-should-not-exist.json",
                "inode-drift",
            )
        self.assertEqual(root.stat().st_ino, replacement_inode)
        self.assertTrue(held.is_dir())

    def test_catchable_prepare_interrupt_rolls_back_created_root(self) -> None:
        root = self.run / "dev-shm"
        evidence = self.report / "interrupted-provider.json"

        def terminate_after_allocation(_root: Path) -> None:
            os.kill(os.getpid(), signal.SIGTERM)

        with mock.patch.object(
            provider,
            "_validate_created_root",
            side_effect=terminate_after_allocation,
        ):
            with self.assertRaises(provider.ProviderSignal):
                provider.prepare_with_signal_rollback(
                    provider.PORTABLE_FILE_PROVIDER,
                    evidence,
                    measurement_id="test-interrupted-prepare",
                    target="wasix",
                    portable_root=root,
                )
        self.assertFalse(root.exists())
        self.assertFalse(evidence.exists())

    def test_interrupt_after_receipt_commit_preserves_recoverable_root(self) -> None:
        root = self.run / "dev-shm"
        evidence = self.report / "committed-provider.json"
        real_publish = provider.publish_identified

        def terminate_after_publication(source, destination, identity) -> None:
            real_publish(source, destination, identity)
            self.assertEqual(destination, evidence)
            os.kill(os.getpid(), signal.SIGTERM)

        with mock.patch.object(
            provider,
            "publish_identified",
            side_effect=terminate_after_publication,
        ):
            with self.assertRaises(provider.ProviderSignal):
                provider.prepare_with_signal_rollback(
                    provider.PORTABLE_FILE_PROVIDER,
                    evidence,
                    measurement_id="test-committed-interrupt",
                    target="wasix",
                    portable_root=root,
                )

        self.assertTrue(root.is_dir())
        self.assertTrue(evidence.is_file())
        evidence_sha256 = digest(evidence)
        provider.verify(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
        )
        provider.cleanup(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            self.report / "committed-interrupt-cleanup.json",
            "committed-interrupt-recovery",
        )
        self.assertFalse(root.exists())

    def test_post_commit_verification_failure_preserves_root_and_receipt(self) -> None:
        root = self.run / "dev-shm"
        evidence = self.report / "verification-failed-provider.json"

        with mock.patch.object(
            provider,
            "verify",
            side_effect=provider.ProviderError("injected verification failure"),
        ):
            with self.assertRaisesRegex(
                provider.ProviderError, "injected verification failure"
            ):
                provider.prepare(
                    provider.PORTABLE_FILE_PROVIDER,
                    evidence,
                    measurement_id="test-post-commit-verification-failure",
                    target="wasix",
                    portable_root=root,
                )

        self.assertTrue(root.is_dir())
        self.assertTrue(evidence.is_file())
        evidence_sha256 = digest(evidence)
        provider.verify(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
        )
        provider.cleanup(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            self.report / "verification-failed-cleanup.json",
            "post-commit-verification-recovery",
        )
        self.assertFalse(root.exists())

    def test_portable_mkdir_race_never_rolls_back_another_creator(self) -> None:
        root = self.run / "dev-shm"
        evidence = self.report / "raced-provider.json"
        real_mkdir = os.mkdir

        def competing_mkdir(path: os.PathLike[str] | str, mode: int = 0o777) -> None:
            self.assertEqual(Path(path), root)
            real_mkdir(path, mode)
            raise FileExistsError(f"simulated competing creator: {path}")

        with mock.patch.object(provider.os, "mkdir", side_effect=competing_mkdir):
            with self.assertRaises(FileExistsError):
                provider.prepare(
                    provider.PORTABLE_FILE_PROVIDER,
                    evidence,
                    measurement_id="test-raced-prepare",
                    target="wasix",
                    portable_root=root,
                )
        self.assertTrue(root.is_dir())
        self.assertFalse(evidence.exists())

    def test_prepare_rollback_never_removes_replacement_inode(self) -> None:
        root = self.run / "dev-shm"
        held = self.run / "held-provider-root"
        evidence = self.report / "replaced-provider.json"

        def replace_then_interrupt(_root: Path) -> None:
            root.rename(held)
            root.mkdir(mode=0o700)
            raise provider.ProviderSignal(signal.SIGTERM)

        with mock.patch.object(
            provider,
            "_validate_created_root",
            side_effect=replace_then_interrupt,
        ):
            with self.assertRaises(provider.ProviderSignal):
                provider.prepare(
                    provider.PORTABLE_FILE_PROVIDER,
                    evidence,
                    measurement_id="test-replaced-rollback",
                    target="wasix",
                    portable_root=root,
                )
        self.assertTrue(root.is_dir())
        self.assertTrue(held.is_dir())
        self.assertFalse(evidence.exists())

    def test_live_object_and_empty_release_evidence(self) -> None:
        root, evidence, evidence_sha256 = self.prepare_portable()
        main = root / "postgresql-wasix-00000001-00000002"
        other = root / "PostgreSQL.12345"
        main.write_bytes(b"main-segment")
        other.write_bytes(b"dynamic-segment")
        objects_path = self.report / "objects.json"
        provider.capture_objects(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            objects_path,
            require_main=True,
            cgroup_identity="fixture:1:2",
        )
        objects = json.loads(objects_path.read_text(encoding="utf-8"))
        self.assertEqual(objects["schema"], provider.OBJECTS_SCHEMA)
        self.assertEqual(objects["main_object_count"], 1)
        self.assertEqual(objects["object_count"], 2)
        self.assertTrue(
            all(item["device"] == root.stat().st_dev for item in objects["objects"])
        )
        with self.assertRaisesRegex(provider.ProviderError, "survived shutdown"):
            provider.assert_empty(
                evidence,
                evidence_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
                self.report / "premature-release.json",
                release_kind=provider.PROCESS_DRAIN_RELEASE,
            )
        main.unlink()
        other.unlink()
        release_path = self.report / "release.json"
        provider.assert_empty(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            release_path,
            release_kind=provider.PROCESS_DRAIN_RELEASE,
        )
        release = json.loads(release_path.read_text(encoding="utf-8"))
        self.assertEqual(release["schema"], provider.RELEASE_SCHEMA)
        self.assertEqual(release["status"], "empty-after-owned-process-drain")
        self.assertEqual(release["release_kind"], provider.PROCESS_DRAIN_RELEASE)
        self.assertIsNone(release["lifecycle_evidence"])
        release_sha256 = digest(release_path)
        provider.assert_empty(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            release_path,
            release_kind=provider.PROCESS_DRAIN_RELEASE,
        )
        self.assertEqual(digest(release_path), release_sha256)

        lifecycle_path = self.report / "shutdown.txt"
        lifecycle_path.write_text(
            "pid=123\n"
            "pgid=123\n"
            "birth_identity=123:456\n"
            "wait_status=0\n"
            "forced=none\n"
            "clean_shutdown_marker=1\n"
            "process_group_residue=0\n"
            "cgroup_residue=0\n"
            "port_residue=0\n"
            "status=passed\n",
            encoding="ascii",
        )
        clean_release_path = self.report / "clean-release.json"
        provider.assert_empty(
            evidence,
            evidence_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            clean_release_path,
            release_kind=provider.CLEAN_RELEASE,
            lifecycle_evidence_path=lifecycle_path,
            lifecycle_evidence_sha256=digest(lifecycle_path),
        )
        clean_release = json.loads(clean_release_path.read_text(encoding="utf-8"))
        self.assertEqual(
            clean_release["status"], "empty-after-clean-postgresql-shutdown"
        )
        self.assertEqual(clean_release["lifecycle_evidence"]["pid"], "123")

        failed_lifecycle_path = self.report / "forced-shutdown.txt"
        failed_lifecycle_path.write_text(
            lifecycle_path.read_text(encoding="ascii").replace(
                "forced=none", "forced=term"
            ),
            encoding="ascii",
        )
        failed_release_path = self.report / "failed-release.json"
        with self.assertRaisesRegex(provider.ProviderError, "not clean: forced"):
            provider.assert_empty(
                evidence,
                evidence_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
                failed_release_path,
                release_kind=provider.CLEAN_RELEASE,
                lifecycle_evidence_path=failed_lifecycle_path,
                lifecycle_evidence_sha256=digest(failed_lifecycle_path),
            )
        self.assertFalse(failed_release_path.exists())

    def test_replacement_between_receipt_verification_and_open_is_rejected(self) -> None:
        root, evidence, evidence_sha256 = self.prepare_portable()
        held = self.run / "held-provider-root"
        open_directory = provider._open_directory
        replaced = False

        def replace_before_open(path: Path) -> int:
            nonlocal replaced
            if path == root and not replaced:
                replaced = True
                root.rename(held)
                root.mkdir(mode=0o700)
            return open_directory(path)

        with mock.patch.object(
            provider, "_open_directory", side_effect=replace_before_open
        ):
            with self.assertRaisesRegex(
                provider.ProviderError, "device/inode differs from receipt"
            ):
                provider.assert_empty(
                    evidence,
                    evidence_sha256,
                    provider.PORTABLE_FILE_PROVIDER,
                    root,
                    self.report / "replacement-release.json",
                    release_kind=provider.PROCESS_DRAIN_RELEASE,
                )
        self.assertTrue(held.is_dir())
        self.assertTrue(root.is_dir())

    def test_parent_replacement_before_cleanup_is_rejected(self) -> None:
        root, evidence, evidence_sha256 = self.prepare_portable()
        held_parent = self.root / "held-run"
        open_directory = provider._open_directory
        replaced = False

        def replace_parent_before_open(path: Path) -> int:
            nonlocal replaced
            if path == self.run and not replaced:
                replaced = True
                self.run.rename(held_parent)
                self.run.mkdir()
                (self.run / "dev-shm").mkdir(mode=0o700)
            return open_directory(path)

        with mock.patch.object(
            provider, "_open_directory", side_effect=replace_parent_before_open
        ):
            with self.assertRaisesRegex(
                provider.ProviderError,
                "cleanup parent device/inode differs from receipt",
            ):
                provider.cleanup(
                    evidence,
                    evidence_sha256,
                    provider.PORTABLE_FILE_PROVIDER,
                    root,
                    self.report / "replacement-cleanup.json",
                    "parent-replacement",
                )
        self.assertTrue((held_parent / "dev-shm").is_dir())
        self.assertTrue((self.run / "dev-shm").is_dir())

    @unittest.skipUnless(platform.system() == "Linux", "Linux provider contract")
    def test_linux_tmpfs_provider_on_real_dev_shm(self) -> None:
        tmpfs_parent = Path("/dev/shm")
        if not tmpfs_parent.is_dir() or not os.access(tmpfs_parent, os.W_OK):
            self.skipTest("/dev/shm is not a writable directory")
        filesystem = provider._filesystem_evidence(tmpfs_parent)
        if filesystem["filesystem_type"] != "tmpfs":
            self.skipTest("/dev/shm is not a tmpfs mount")

        evidence = self.report / "tmpfs-provider.json"
        cleanup_evidence = self.report / "tmpfs-cleanup.json"
        root: Path | None = None
        try:
            root = provider.prepare(
                provider.LINUX_TMPFS_PROVIDER,
                evidence,
                measurement_id="test-linux-tmpfs",
                target="wasix",
            )
            evidence_sha256 = digest(evidence)
            receipt = json.loads(evidence.read_text(encoding="utf-8"))
            self.assertEqual(receipt["filesystem"]["filesystem_type"], "tmpfs")
            self.assertEqual(
                receipt["filesystem"]["filesystem_magic"],
                f"0x{provider.TMPFS_MAGIC:08x}",
            )
            self.assertEqual(root.parent, tmpfs_parent.resolve())
            provider.verify(
                evidence,
                evidence_sha256,
                provider.LINUX_TMPFS_PROVIDER,
                root,
            )
            provider.cleanup(
                evidence,
                evidence_sha256,
                provider.LINUX_TMPFS_PROVIDER,
                root,
                cleanup_evidence,
                "integration-test",
            )
            self.assertFalse(root.exists())
        finally:
            if root is not None and root.exists():
                # This fallback is test-only and remains constrained to the
                # helper-owned random prefix below the verified tmpfs parent.
                self.assertEqual(root.parent, tmpfs_parent.resolve())
                self.assertTrue(
                    root.name.startswith(
                        f"{provider.TMPFS_PREFIX}.{os.geteuid()}."
                    )
                )
                shutil.rmtree(root)

    @unittest.skipUnless(platform.system() == "Linux", "Linux provider contract")
    def test_linux_tmpfs_provider_rejects_non_tmpfs_parent(self) -> None:
        if provider._filesystem_evidence(self.run)["filesystem_type"] == "tmpfs":
            self.skipTest("test temporary directory is itself tmpfs")
        with self.assertRaisesRegex(provider.ProviderError, "parent is not tmpfs"):
            provider.prepare(
                provider.LINUX_TMPFS_PROVIDER,
                self.report / "rejected.json",
                measurement_id="test-linux-non-tmpfs",
                target="wasix",
                linux_tmpfs_parent=self.run,
            )
        self.assertEqual(list(self.run.iterdir()), [])

    def test_mountinfo_escape_decoder(self) -> None:
        self.assertEqual(
            provider._decode_mountinfo(r"/path\040with\011space\134slash"),
            "/path with\tspace\\slash",
        )

    @unittest.skipUnless(platform.system() == "Linux", "Linux fallback contract")
    def test_portable_filesystem_evidence_survives_missing_mountinfo(self) -> None:
        root, receipt, receipt_sha256 = self.prepare_portable()
        with mock.patch.object(
            provider,
            "_linux_mount_for",
            side_effect=provider.ProviderError("mountinfo unavailable"),
        ):
            evidence = provider._filesystem_evidence(self.run)
            self.assertEqual(evidence["mount_proof_status"], "unavailable")
            self.assertIsNone(evidence["mount"])
            provider.verify(
                receipt,
                receipt_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
            )
            with self.assertRaisesRegex(provider.ProviderError, "mountinfo unavailable"):
                provider._filesystem_evidence(self.run, require_linux_mount=True)
        with mock.patch.object(
            provider,
            "_linux_statfs_magic",
            side_effect=provider.ProviderError("statfs unavailable"),
        ):
            evidence = provider._filesystem_evidence(self.run)
            self.assertEqual(evidence["statfs_proof_status"], "unavailable")
            provider.verify(
                receipt,
                receipt_sha256,
                provider.PORTABLE_FILE_PROVIDER,
                root,
            )
            with self.assertRaisesRegex(provider.ProviderError, "statfs unavailable"):
                provider._filesystem_evidence(self.run, require_linux_mount=True)
        provider.cleanup(
            receipt,
            receipt_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            root,
            self.report / "portable-fallback-cleanup.json",
            "portable-fallback-test",
        )

        fallback_receipt = self.report / "portable-unavailable-provider.json"
        fallback_root = self.run / "dev-shm"
        with mock.patch.object(
            provider,
            "_linux_mount_for",
            side_effect=provider.ProviderError("mountinfo unavailable"),
        ), mock.patch.object(
            provider,
            "_linux_statfs_magic",
            side_effect=provider.ProviderError("statfs unavailable"),
        ):
            provider.prepare(
                provider.PORTABLE_FILE_PROVIDER,
                fallback_receipt,
                measurement_id="test-portable-unavailable-probes",
                target="wasix",
                portable_root=fallback_root,
            )
        fallback_sha256 = digest(fallback_receipt)
        provider.verify(
            fallback_receipt,
            fallback_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            fallback_root,
        )
        provider.cleanup(
            fallback_receipt,
            fallback_sha256,
            provider.PORTABLE_FILE_PROVIDER,
            fallback_root,
            self.report / "portable-unavailable-cleanup.json",
            "portable-unavailable-test",
        )


if __name__ == "__main__":
    unittest.main()
