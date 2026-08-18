#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("immutable-carrier.py")
SPEC = importlib.util.spec_from_file_location("immutable_carrier", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeOps:
    def __init__(self, *, fail_set_number: int | None = None) -> None:
        self.flags: dict[tuple[int, int], int] = {}
        self.set_count = 0
        self.fail_set_number = fail_set_number

    @staticmethod
    def key(descriptor: int) -> tuple[int, int]:
        info = os.fstat(descriptor)
        return info.st_dev, info.st_ino

    def filesystem_magic(self, descriptor: int) -> int:
        del descriptor
        return MODULE.EXT_SUPER_MAGIC

    def get_flags(self, descriptor: int) -> int:
        return self.flags.setdefault(self.key(descriptor), 0x00080000)

    def set_flags(self, descriptor: int, flags: int) -> None:
        self.set_count += 1
        if self.fail_set_number == self.set_count:
            raise OSError("injected flag transition failure")
        self.flags[self.key(descriptor)] = flags


def make_carrier(parent: Path) -> tuple[Path, dict[str, str]]:
    root = parent / "carrier"
    for directory in ("aot", "bin"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    artifacts = []
    for index in range(MODULE.EXPECTED_AOT_COUNT):
        module_digest = f"{index + 1:064X}"
        artifact_path = f"aot/{module_digest}.bin"
        artifact_data = f"artifact-{index}\n".encode()
        (root / artifact_path).write_bytes(artifact_data)
        artifact: dict[str, object] = {
            "path": artifact_path,
            "sha256": digest(artifact_data),
        }
        artifacts.append(artifact)
    manifest_data = (
        json.dumps(
            {
                "artifacts": artifacts,
                "core-profile": "release-o3",
                "format-version": 6,
                "guest-build-recipe-sha256": "9" * 64,
                "schema": MODULE.MANIFEST_SCHEMA,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode()
    identity_data: dict[str, bytes] = {
        "manifest.json": manifest_data,
        "wasmer-build.receipt": b"schema=fake\n",
        "bin/wasmer-headless": b"fake-headless\n",
    }
    for relative, data in identity_data.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    inventory_lines = [f"schema={MODULE.PAYLOAD_SCHEMA}"]
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        relative = path.relative_to(root).as_posix()
        data = path.read_bytes()
        inventory_lines.append(f"{digest(data)}\t{len(data)}\t{relative}")
    payload_data = ("\n".join(inventory_lines) + "\n").encode()
    (root / "payload.files").write_bytes(payload_data)
    identity_data["payload.files"] = payload_data
    for path in root.rglob("*"):
        if path.is_file():
            path.chmod(0o444)
    for path in sorted((path for path in root.rglob("*") if path.is_dir()), reverse=True):
        path.chmod(0o555)
    root.chmod(0o555)
    expected = {relative: digest(data) for relative, data in identity_data.items()}
    return root.resolve(), expected


class ImmutableCarrierPlatformTests(unittest.TestCase):
    def test_non_linux_platform_is_rejected(self) -> None:
        with mock.patch.object(sys, "platform", "darwin"):
            with self.assertRaisesRegex(
                MODULE.DeploymentError, "immutable deployment requires Linux"
            ):
                MODULE.require_linux()


class ImmutableCarrierTests(unittest.TestCase):
    def setUp(self) -> None:
        if not sys.platform.startswith("linux"):
            linux_guard = mock.patch.object(MODULE, "require_linux", return_value=None)
            linux_guard.start()
            self.addCleanup(linux_guard.stop)

    def test_deploy_verify_and_exact_remove_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            carrier, expected = make_carrier(parent)
            receipt = (parent / "deployment.json").resolve()
            ops = FakeOps()
            result = MODULE.deploy(
                carrier,
                receipt,
                expected,
                ops,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            self.assertEqual(result["schema"], MODULE.SCHEMA)
            self.assertEqual(result["core_profile"], "release-o3")
            self.assertEqual(result["guest_build_recipe_sha256"], "9" * 64)
            self.assertGreater(len(result["entries"]), 7)
            self.assertEqual(
                len(result["direct-loader-paths"]), MODULE.EXPECTED_AOT_COUNT
            )
            self.assertTrue(
                all(
                    entry["uid"] == os.geteuid() and entry["gid"] == os.getegid()
                    for entry in result["entries"]
                )
            )
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o444)
            self.assertEqual(receipt.read_bytes(), MODULE.canonical_json(result))
            for entry in result["entries"]:
                key = (entry["device"], entry["inode"])
                self.assertTrue(ops.flags[key] & MODULE.FS_IMMUTABLE_FL)

            verified = MODULE.verify_or_remove(
                carrier,
                receipt,
                expected,
                ops,
                remove=False,
                receipt_owner_uid=os.geteuid(),
            )
            self.assertEqual(verified, result)
            with mock.patch.object(
                MODULE,
                "open_exact_carrier_closure",
                side_effect=AssertionError("fast verification read the payload closure"),
            ):
                fast_verified = MODULE.verify_fast(
                    carrier,
                    receipt,
                    ops,
                    receipt_owner_uid=os.geteuid(),
                )
            self.assertEqual(fast_verified, result)
            MODULE.verify_or_remove(
                carrier,
                receipt,
                expected,
                ops,
                remove=True,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            self.assertFalse(receipt.exists())
            for entry in result["entries"]:
                key = (entry["device"], entry["inode"])
                self.assertEqual(ops.flags[key], int(entry["pre-flags"], 16))

    def test_fast_verification_rejects_ownership_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            carrier, expected = make_carrier(parent)
            receipt = (parent / "deployment.json").resolve()
            ops = FakeOps()
            result = MODULE.deploy(
                carrier,
                receipt,
                expected,
                ops,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            result["entries"][0]["uid"] += 1
            receipt.chmod(0o644)
            receipt.write_bytes(MODULE.canonical_json(result))
            receipt.chmod(0o444)
            with self.assertRaisesRegex(
                MODULE.DeploymentError, "entry ownership differs"
            ):
                MODULE.verify_fast(
                    carrier,
                    receipt,
                    ops,
                    receipt_owner_uid=os.geteuid(),
                )

    def test_remove_accepts_pre_ownership_binding_recovery_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            carrier, expected = make_carrier(parent)
            receipt = (parent / "deployment.json").resolve()
            ops = FakeOps()
            result = MODULE.deploy(
                carrier,
                receipt,
                expected,
                ops,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            for entry in result["entries"]:
                del entry["uid"]
                del entry["gid"]
            receipt.chmod(0o644)
            receipt.write_bytes(MODULE.canonical_json(result))
            receipt.chmod(0o444)
            MODULE.verify_or_remove(
                carrier,
                receipt,
                expected,
                ops,
                remove=True,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            self.assertFalse(receipt.exists())

    def test_failed_deployment_rolls_back_and_removes_journal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            carrier, expected = make_carrier(parent)
            receipt = (parent / "deployment.json").resolve()
            ops = FakeOps(fail_set_number=4)
            with self.assertRaises(MODULE.DeploymentError):
                MODULE.deploy(
                    carrier,
                    receipt,
                    expected,
                    ops,
                    check_capability=lambda: None,
                    receipt_owner_uid=os.geteuid(),
                )
            self.assertFalse(receipt.exists())
            self.assertTrue(ops.flags)
            self.assertEqual(set(ops.flags.values()), {0x00080000})

    def test_remove_repairs_receipt_bound_partial_transition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            carrier, expected = make_carrier(parent)
            receipt = (parent / "deployment.json").resolve()
            ops = FakeOps()
            result = MODULE.deploy(
                carrier,
                receipt,
                expected,
                ops,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            first = result["entries"][0]
            ops.flags[(first["device"], first["inode"])] = int(first["pre-flags"], 16)
            receipt_info = receipt.stat()
            receipt_key = (receipt_info.st_dev, receipt_info.st_ino)
            ops.flags[receipt_key] &= ~MODULE.FS_IMMUTABLE_FL
            MODULE.verify_or_remove(
                carrier,
                receipt,
                expected,
                ops,
                remove=True,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            self.assertFalse(receipt.exists())
            self.assertEqual(set(ops.flags.values()), {0x00080000})

    def test_replaced_inode_is_rejected_even_with_identical_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            carrier, expected = make_carrier(parent)
            receipt = (parent / "deployment.json").resolve()
            ops = FakeOps()
            result = MODULE.deploy(
                carrier,
                receipt,
                expected,
                ops,
                check_capability=lambda: None,
                receipt_owner_uid=os.geteuid(),
            )
            entry = next(
                candidate
                for candidate in result["entries"]
                if candidate["entry-type"] == "file"
            )
            path = carrier / entry["path"]
            data = path.read_bytes()
            path.parent.chmod(0o755)
            replacement = path.with_name(path.name + ".replacement")
            replacement.write_bytes(data)
            os.replace(replacement, path)
            path.chmod(0o444)
            path.parent.chmod(0o555)
            with self.assertRaisesRegex(MODULE.DeploymentError, "inode identity differs"):
                MODULE.verify_or_remove(
                    carrier,
                    receipt,
                    expected,
                    ops,
                    remove=False,
                    receipt_owner_uid=os.geteuid(),
                )

    def test_root_and_effective_capability_are_both_required(self) -> None:
        with mock.patch.object(os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(MODULE.DeploymentError, "effective UID 0"):
                MODULE.require_root_immutable_capability()
        with mock.patch.object(os, "geteuid", return_value=0), mock.patch.object(
            MODULE, "effective_capabilities", return_value=0
        ):
            with self.assertRaisesRegex(MODULE.DeploymentError, "CAP_LINUX_IMMUTABLE"):
                MODULE.require_root_immutable_capability()

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux ioctl contract")
    def test_real_filesystem_flag_query_is_read_only(self) -> None:
        with tempfile.NamedTemporaryFile() as candidate:
            ops = MODULE.KernelOps()
            self.assertEqual(ops.filesystem_magic(candidate.fileno()), MODULE.EXT_SUPER_MAGIC)
            flags = ops.get_flags(candidate.fileno())
            self.assertIsInstance(flags, int)


if __name__ == "__main__":
    unittest.main()
