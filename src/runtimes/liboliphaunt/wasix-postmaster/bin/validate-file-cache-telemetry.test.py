#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("validate-file-cache-telemetry.py")
SPEC = importlib.util.spec_from_file_location("validate_file_cache_telemetry", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
ABI_ID = "12" * 32


def telemetry() -> dict:
    names = (
        "relation-read-normal",
        "relation-read-bulk",
        "relation-read-vacuum",
        "relation-sync-checkpoint",
        "relation-sync-immediate",
        "wal-inactive-durable",
    )
    classes = [
        {
            "class": index,
            "name": name,
            "disposition": "retain",
            "calls": 0,
            "finite-bytes": 0,
            "through-eof-calls": 0,
            "reclaim-eligible-calls": 0,
            "reclaim-eligible-finite-bytes": 0,
            "reclaim-eligible-through-eof-calls": 0,
        }
        for index, name in enumerate(names, 1)
    ]
    classes[0].update({"calls": 2, "finite-bytes": 12288})
    classes[5].update(
        {
            "calls": 2,
            "finite-bytes": 2 * 16 * 1024 * 1024,
            "reclaim-eligible-calls": 1,
            "reclaim-eligible-finite-bytes": 16 * 1024 * 1024,
        }
    )
    return {
        "schema": "oliphaunt.wasix-postmaster.file-cache-telemetry.v2",
        "policy-id": "oliphaunt.wasix-postmaster.file-cache.observe-only.v1",
        "policy-mode": "observe-only",
        "workload-id": "runtime:postgres",
        "runtime-abi-id": ABI_ID,
        "abi-module": "oliphaunt_postmaster_v1",
        "abi-function": "fd_cache_offer",
        "abi-signature": "(i32,i64,i64,i32,i32)->i32_errno",
        "classes": classes,
        "validation": {
            "valid": 4,
            "invalid-range": 0,
            "invalid-class": 0,
            "invalid-flags": 0,
            "bad-descriptor": 0,
            "missing-rights": 0,
            "non-regular": 0,
            "non-host-backed": 0,
            "state-fault": 0,
            "controller-error": 0,
        },
    }


class ValidateFileCacheTelemetryTests(unittest.TestCase):
    def run_validator(self, value: dict, *, manifest_abi: str = ABI_ID, raw: str | None = None):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        snapshot = root / "telemetry.json"
        manifest = root / "manifest.json"
        output = root / "validation.tsv"
        snapshot.write_text(raw if raw is not None else json.dumps(value) + "\n", encoding="utf-8")
        manifest.write_text(json.dumps({"runtime-abi-id": manifest_abi}) + "\n", encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--telemetry",
                str(snapshot),
                "--manifest",
                str(manifest),
                "--output",
                str(output),
                "--expected-workload",
                "runtime:postgres",
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        contents = output.read_text(encoding="utf-8") if output.exists() else ""
        temporary.cleanup()
        return result, contents

    def test_accepts_exact_observe_only_snapshot(self):
        result, output = self.run_validator(telemetry())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\t4\t33566720\t0\t1\t16777216\t0\t", output)

    def test_destination_appearing_at_commit_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = root / "telemetry.json"
            manifest = root / "manifest.json"
            output = root / "validation.tsv"
            snapshot.write_text(json.dumps(telemetry()) + "\n", encoding="utf-8")
            manifest.write_text(json.dumps({"runtime-abi-id": ABI_ID}) + "\n", encoding="utf-8")
            competitor = b"concurrent owner\n"
            real_publish = MODULE.publish_identified

            def publish_after_competitor(source, destination, identity) -> None:
                destination.write_bytes(competitor)
                real_publish(source, destination, identity)

            with mock.patch.object(MODULE, "publish_identified", publish_after_competitor):
                with self.assertRaises(MODULE.PublicationError):
                    MODULE.validate(snapshot, manifest, output, "runtime:postgres")
            self.assertEqual(output.read_bytes(), competitor)
            self.assertEqual(list(root.glob(".validation.tsv.pending.*")), [])

    def test_pending_replacement_is_never_unlinked_by_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = root / "telemetry.json"
            manifest = root / "manifest.json"
            output = root / "validation.tsv"
            snapshot.write_text(json.dumps(telemetry()) + "\n", encoding="utf-8")
            manifest.write_text(
                json.dumps({"runtime-abi-id": ABI_ID}) + "\n", encoding="utf-8"
            )
            held = root / "held-original-pending"
            attacker = b"different private generation\n"

            def replace_pending(source: Path, _destination: Path, _identity) -> None:
                source.rename(held)
                source.write_bytes(attacker)
                source.chmod(0o444)
                raise MODULE.PublicationError("injected publication failure")

            with mock.patch.object(MODULE, "publish_identified", replace_pending):
                with self.assertRaisesRegex(
                    MODULE.PublicationError, "private publication generation changed"
                ):
                    MODULE.validate(snapshot, manifest, output, "runtime:postgres")
            pending = list(root.glob(".validation.tsv.pending.*"))
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].read_bytes(), attacker)
            self.assertTrue(held.is_file())
            self.assertFalse(output.exists())

    def test_rejects_manifest_runtime_abi_mismatch(self):
        result, _ = self.run_validator(telemetry(), manifest_abi="34" * 32)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime-abi-id differs", result.stderr)

    def test_rejects_non_retain_disposition(self):
        value = telemetry()
        value["classes"][5]["disposition"] = "dont-need"
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not retain", result.stderr)

    def test_rejects_validation_error_and_count_mismatch(self):
        value = telemetry()
        value["validation"]["controller-error"] = 1
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("controller-error", result.stderr)
        value = telemetry()
        value["validation"]["valid"] = 5
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("counts differ", result.stderr)

    def test_rejects_reclaim_eligibility_on_non_wal_class(self):
        value = telemetry()
        value["classes"][0]["reclaim-eligible-calls"] = 1
        value["classes"][0]["reclaim-eligible-finite-bytes"] = 4096
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-WAL", result.stderr)

    def test_rejects_reclaim_eligibility_exceeding_wal_offers(self):
        value = telemetry()
        value["classes"][5]["reclaim-eligible-calls"] = 3
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exceed calls", result.stderr)

    def test_rejects_duplicate_json_field(self):
        value = telemetry()
        raw = json.dumps(value)[:-1] + ',"schema":"duplicate"}\n'
        result, _ = self.run_validator(value, raw=raw)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate JSON field", result.stderr)


if __name__ == "__main__":
    unittest.main()
