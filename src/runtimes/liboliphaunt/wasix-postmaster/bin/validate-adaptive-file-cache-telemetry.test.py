#!/usr/bin/env python3

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("validate-adaptive-file-cache-telemetry.py")
SPEC = importlib.util.spec_from_file_location(
    "validate_adaptive_file_cache_telemetry", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
ABI_ID = "12" * 32
VALIDATOR_CONSTANTS = runpy.run_path(str(SCRIPT))
CONFIG_SHA256 = VALIDATOR_CONSTANTS["CONFIG_SHA256"]
POLICY_ID = VALIDATOR_CONSTANTS["POLICY_ID"]
POLICY_MODE = VALIDATOR_CONSTANTS["POLICY_MODE"]
CONFIG_ID = VALIDATOR_CONSTANTS["CONFIG_ID"]
FALLBACK_POLICY_ID = VALIDATOR_CONSTANTS["FALLBACK_POLICY_ID"]
FALLBACK_POLICY_MODE = VALIDATOR_CONSTANTS["FALLBACK_POLICY_MODE"]
ACTIVE_SCHEMA = VALIDATOR_CONSTANTS["ACTIVE_SCHEMA"]
RESULT_SCHEMA = VALIDATOR_CONSTANTS["RESULT_SCHEMA"]
PORTABLE_POLICY = VALIDATOR_CONSTANTS["PORTABLE_ACCEPTANCE_POLICY"]
CONSTRAINED_POLICY = VALIDATOR_CONSTANTS["CONSTRAINED_ACCEPTANCE_POLICY"]
DEFAULT_SAMPLE_CONTRACT = {
    "cgroup-identity": "31:41",
    "cgroup-memory-max-bytes": 256 * 1024 * 1024,
    "cgroup-memory-high-bytes": 224 * 1024 * 1024,
    "cgroup-swap-max-bytes": 0,
    "sample-window-start-monotonic-ns": 9_000_000_000,
    "sample-window-end-monotonic-ns": 11_000_000_000,
    "measurement-id": "sample-b01-p2-wasix",
    "target": "wasix",
}


def config() -> dict:
    return {
        "page-alignment": "host-page",
        "sample-interval-ns": 250_000_000,
        "warmup-samples": 3,
        "enter-level1-per-mille": 780,
        "exit-level1-per-mille": 720,
        "enter-level2-per-mille": 850,
        "exit-level2-per-mille": 800,
        "enter-level3-per-mille": 920,
        "exit-level3-per-mille": 870,
        "emergency-headroom-bytes": 24 * 1024 * 1024,
        "cooldown-ns": 2_000_000_000,
        "circuit-breaker-cooldown-ns": 5_000_000_000,
        "healthy-samples-to-recover": 3,
        "max-dirty-bytes": 16 * 1024 * 1024,
        "max-dirty-per-mille": 80,
        "immediate-wal-cache-drop-safe": False,
        "relation-pressure-relief": False,
        "allow-wal-cache-drop-safe-dirty-bypass": True,
        "wal-emergency-max-bytes": 16 * 1024 * 1024,
        "deferred-wal-max-entries": 4,
        "deferred-wal-max-bytes": 64 * 1024 * 1024,
        "deferred-wal-max-fds": 4,
        "deferred-wal-ttl-ns": 4_000_000_000,
        "deferred-wal-drain-per-trigger": 1,
        "deferred-wal-busy-retries": 0,
        "bytes-per-second": 32 * 1024 * 1024,
        "burst-bytes": 32 * 1024 * 1024,
        "max-bytes-per-offer": 16 * 1024 * 1024,
        "min-bytes-per-offer": 4096,
        "psi-some-breaker-per-mille": 250,
        "psi-full-breaker-per-mille": 100,
        "refault-min-pages": 256,
        "refault-breaker-per-mille": 500,
    }


def manifest() -> dict:
    return {
        "runtime-abi-id": ABI_ID,
        "file-cache-policy": {
            "requested-policy-id": POLICY_ID,
            "approved-config-id": CONFIG_ID,
            "config-sha256": CONFIG_SHA256,
            "portable-fallback-mode": "observe-only",
        },
    }


def active() -> dict:
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
            "offers": 0,
            "offered-finite-bytes": 0,
            "through-eof-offers": 0,
            "advice-calls": 0,
            "advised-bytes": 0,
            "partial-advice-calls": 0,
            "advice-errors": 0,
        }
        for index, name in enumerate(names, 1)
    ]
    classes[0].update({"offers": 1, "offered-finite-bytes": 8192})
    classes[1].update(
        {
            "offers": 1,
            "offered-finite-bytes": 8192,
        }
    )
    retain_names = (
        "unsupported-class",
        "through-eof",
        "non-host-backed",
        "pressure-state",
        "dirty-veto",
        "empty-after-inward-alignment",
        "rate-limited",
        "sampler-unavailable",
        "circuit-breaker",
        "wal-cache-drop-proof-required",
        "wal-whole-segment-required",
        "workload-finalized",
    )
    retain = [{"reason": name, "calls": 0} for name in retain_names]
    retain[0]["calls"] = 1
    retain[3]["calls"] = 1
    value = {field: 0 for field in VALIDATOR_CONSTANTS["ACTIVE_FIELDS"]}
    value.update({
        "schema": ACTIVE_SCHEMA,
        "policy-id": POLICY_ID,
        "policy-mode": POLICY_MODE,
        "workload-id": "runtime:postgres",
        "runtime-abi-id": ABI_ID,
        "fallback-policy-id": FALLBACK_POLICY_ID,
        "fallback-policy-mode": FALLBACK_POLICY_MODE,
        "config": config(),
        "resolved-page-bytes": 4096,
        "state": "warmup",
        "sample-count": 0,
        "state-transitions": 0,
        "sample-errors": 0,
        "clock-errors": 0,
        "psi-breaker-trips": 0,
        "refault-breaker-trips": 0,
        "dirty-vetoes": 0,
        "wal-dirty-veto-bypasses": 0,
        "wal-dirty-veto-bypass-bytes": 0,
        "range-offered-bytes": 16384,
        "range-aligned-bytes": 0,
        "range-advised-bytes": 0,
        "token-bytes": 32 * 1024 * 1024,
        "state-deadline-ns": 0,
        "advised-bytes-since-sample": 0,
        "advice-errors": 0,
        "last-advice-raw-os-error": None,
        "max-current-bytes": 0,
        "max-used-per-mille": 0,
        "max-file-context-bytes": 0,
        "max-file-dirty-bytes": 0,
        "last-psi-some-delta-us": 0,
        "last-psi-full-delta-us": 0,
        "last-psi-some-per-mille": 0,
        "last-psi-full-per-mille": 0,
        "psi-no-advice-baseline-some-per-mille": None,
        "psi-no-advice-baseline-full-per-mille": None,
        "last-refault-delta": 0,
        "last-local-high-event-delta": 0,
        "last-local-max-event-delta": 0,
        "last-local-oom-event-delta": 0,
        "workload-finalized": True,
        "deferred-wal-maintenance-constructed": True,
        "deferred-wal-maintenance-active": False,
        "deferred-wal-conservation-entries-ok": True,
        "deferred-wal-conservation-bytes-ok": True,
        "last-sample": None,
        "classes": classes,
        "retain-reasons": retain,
        "validation": [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    })
    return value


def fallback() -> dict:
    return {
        "schema": "oliphaunt.wasix-postmaster.file-cache-admission-fallback.v1",
        "admission": "denied",
        "requested-policy-id": POLICY_ID,
        "requested-policy-mode": POLICY_MODE,
        "workload-id": "runtime:postgres",
        "runtime-abi-id": ABI_ID,
        "fallback-policy-id": FALLBACK_POLICY_ID,
        "fallback-policy-mode": FALLBACK_POLICY_MODE,
        "reason": "unsupported",
        "config": config(),
    }


def active_wal_action() -> dict:
    value = active()
    wal_bytes = 1024 * 1024
    value["classes"][1].update(
        {
            "offers": 0,
            "offered-finite-bytes": 0,
            "advice-calls": 0,
            "advised-bytes": 0,
        }
    )
    value["classes"][5].update(
        {
            "offers": 1,
            "offered-finite-bytes": wal_bytes,
            "advice-calls": 1,
            "advised-bytes": wal_bytes,
        }
    )
    value["retain-reasons"][3]["calls"] = 0
    value.update(
        {
            "state": "relief-level3",
            "sample-count": 3,
            "max-current-bytes": 245 * 1024 * 1024,
            "max-used-per-mille": 1000,
            "max-file-context-bytes": 180 * 1024 * 1024,
            "max-file-dirty-bytes": 1024 * 1024,
            "last-sample": {
                "monotonic-ns": 10_000_000_000,
                "current-bytes": 245 * 1024 * 1024,
                "effective-limit-bytes": 224 * 1024 * 1024,
                "file-context-bytes": 180 * 1024 * 1024,
                "file-dirty-bytes": 1024 * 1024,
                "workingset-refault-file": 40,
                "psi-some-total-us": 100,
                "psi-full-total-us": 0,
                "local-high-events": 1,
                "local-max-events": 0,
                "local-oom-events": 0,
                "local-events-available": True,
                "membership-leaf-device": 31,
                "membership-leaf-inode": 41,
                "pressure-source-device": 31,
                "pressure-source-inode": 41,
                "pressure-source-depth": 1,
            },
        }
    )
    value["range-offered-bytes"] = 8192 + wal_bytes
    value["range-aligned-bytes"] = wal_bytes
    value["range-advised-bytes"] = wal_bytes
    value["advised-bytes-since-sample"] = wal_bytes
    value["token-bytes"] = config()["burst-bytes"]
    value.update(
        {
            "deferred-wal-high-entries": 1,
            "deferred-wal-high-bytes": wal_bytes,
            "deferred-wal-enqueued": 1,
            "deferred-wal-enqueued-bytes": wal_bytes,
            "deferred-wal-attempts": 1,
            "deferred-wal-attempted-bytes": wal_bytes,
            "deferred-wal-successes": 1,
            "deferred-wal-success-bytes": wal_bytes,
            "deferred-wal-pressure-samples": 1,
            "deferred-wal-actionable-samples": 1,
            "deferred-wal-terminal-entries": 1,
            "deferred-wal-terminal-bytes": wal_bytes,
            "wal-emergency-attempts": 1,
            "wal-emergency-attempted-bytes": wal_bytes,
            "wal-emergency-successes": 1,
            "wal-emergency-success-bytes": wal_bytes,
            "wal-emergency-max-actions-per-trigger": 1,
            "wal-emergency-max-bytes-per-trigger": wal_bytes,
        }
    )
    return value


def active_deferred_wal_success() -> dict:
    value = active_wal_action()
    wal_bytes = 1024 * 1024
    value["classes"][5].update(
        {
            "offers": 2,
            "offered-finite-bytes": 2 * wal_bytes,
            "advice-calls": 2,
            "advised-bytes": 2 * wal_bytes,
        }
    )
    value["validation"][0] = 3
    value["range-offered-bytes"] = 8192 + 2 * wal_bytes
    value["range-aligned-bytes"] = 2 * wal_bytes
    value["range-advised-bytes"] = 2 * wal_bytes
    value["advised-bytes-since-sample"] = 2 * wal_bytes
    value.update(
        {
            "deferred-wal-high-entries": 2,
            "deferred-wal-high-bytes": 2 * wal_bytes,
            "deferred-wal-enqueued": 2,
            "deferred-wal-enqueued-bytes": 2 * wal_bytes,
            "deferred-wal-attempts": 2,
            "deferred-wal-attempted-bytes": 2 * wal_bytes,
            "deferred-wal-successes": 2,
            "deferred-wal-success-bytes": 2 * wal_bytes,
            "deferred-wal-pressure-samples": 2,
            "deferred-wal-actionable-samples": 2,
            "deferred-wal-terminal-entries": 2,
            "deferred-wal-terminal-bytes": 2 * wal_bytes,
            "wal-emergency-attempts": 2,
            "wal-emergency-attempted-bytes": 2 * wal_bytes,
            "wal-emergency-successes": 2,
            "wal-emergency-success-bytes": 2 * wal_bytes,
            "wal-emergency-max-actions-per-trigger": 1,
            "wal-emergency-max-bytes-per-trigger": wal_bytes,
        }
    )
    return value


def active_deferred_wal_finalization_flush() -> dict:
    value = active_deferred_wal_success()
    wal_bytes = 1024 * 1024
    value["classes"][5].update(
        {
            "advice-calls": 1,
            "advised-bytes": wal_bytes,
        }
    )
    value["range-advised-bytes"] = wal_bytes
    value["advised-bytes-since-sample"] = wal_bytes
    value.update(
        {
            "deferred-wal-attempts": 1,
            "deferred-wal-attempted-bytes": wal_bytes,
            "deferred-wal-successes": 1,
            "deferred-wal-success-bytes": wal_bytes,
            "deferred-wal-flushes": 1,
            "deferred-wal-flushed-entries": 1,
            "deferred-wal-flushed-bytes": wal_bytes,
            "deferred-wal-finalization-flushes": 1,
            "deferred-wal-pressure-samples": 1,
            "deferred-wal-actionable-samples": 1,
            "deferred-wal-terminal-entries": 2,
            "deferred-wal-terminal-bytes": 2 * wal_bytes,
            "wal-emergency-attempts": 1,
            "wal-emergency-attempted-bytes": wal_bytes,
            "wal-emergency-successes": 1,
            "wal-emergency-success-bytes": wal_bytes,
            "wal-emergency-max-actions-per-trigger": 1,
            "wal-emergency-max-bytes-per-trigger": wal_bytes,
        }
    )
    return value


def active_deferred_wal_revoke() -> dict:
    value = active()
    wal_bytes = 1024 * 1024
    value["classes"][1].update(
        {
            "offers": 0,
            "offered-finite-bytes": 0,
        }
    )
    value["classes"][5].update(
        {
            "offers": 1,
            "offered-finite-bytes": wal_bytes,
        }
    )
    value["retain-reasons"][3]["calls"] = 0
    value["validation"][0] = 2
    value["range-offered-bytes"] = 8192 + wal_bytes
    value["range-aligned-bytes"] = wal_bytes
    value.update(
        {
            "deferred-wal-high-entries": 1,
            "deferred-wal-high-bytes": wal_bytes,
            "deferred-wal-enqueued": 1,
            "deferred-wal-enqueued-bytes": wal_bytes,
            "deferred-wal-revoked": 1,
            "deferred-wal-revoked-bytes": wal_bytes,
            "deferred-wal-revoke-calls": 1,
            "deferred-wal-revoke-sequence": 2,
            "deferred-wal-terminal-entries": 1,
            "deferred-wal-terminal-bytes": wal_bytes,
        }
    )
    return value


def active_deferred_wal_invalidated() -> dict:
    value = active_wal_action()
    wal_bytes = 1024 * 1024
    value["classes"][5]["advice-calls"] = 0
    value["classes"][5]["advised-bytes"] = 0
    value["range-advised-bytes"] = 0
    value["advised-bytes-since-sample"] = 0
    value["advice-errors"] = 1
    value["deferred-wal-successes"] = 0
    value["deferred-wal-success-bytes"] = 0
    value["deferred-wal-invalidated"] = 1
    value["deferred-wal-invalidated-bytes"] = wal_bytes
    value["wal-emergency-successes"] = 0
    value["wal-emergency-success-bytes"] = 0
    return value


def active_deferred_wal_success_with_invalidation() -> dict:
    value = active_deferred_wal_success()
    wal_bytes = 1024 * 1024
    value["classes"][5]["offers"] = 3
    value["classes"][5]["offered-finite-bytes"] = 3 * wal_bytes
    value["validation"][0] = 4
    value["range-offered-bytes"] = 8192 + 3 * wal_bytes
    value["range-aligned-bytes"] = 3 * wal_bytes
    value["advice-errors"] = 1
    value.update(
        {
            "deferred-wal-high-entries": 3,
            "deferred-wal-high-bytes": 3 * wal_bytes,
            "deferred-wal-enqueued": 3,
            "deferred-wal-enqueued-bytes": 3 * wal_bytes,
            "deferred-wal-attempts": 3,
            "deferred-wal-attempted-bytes": 3 * wal_bytes,
            "deferred-wal-invalidated": 1,
            "deferred-wal-invalidated-bytes": wal_bytes,
            "deferred-wal-pressure-samples": 3,
            "deferred-wal-actionable-samples": 3,
            "deferred-wal-terminal-entries": 3,
            "deferred-wal-terminal-bytes": 3 * wal_bytes,
            "wal-emergency-attempts": 3,
            "wal-emergency-attempted-bytes": 3 * wal_bytes,
        }
    )
    return value


class ValidateAdaptiveFileCacheTelemetryTests(unittest.TestCase):
    def run_validator(
        self,
        value: dict,
        *,
        manifest_value: dict | None = None,
        raw: str | None = None,
        acceptance_policy: str | None = None,
        sample_contract: dict[str, str | int] | None = None,
    ):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        snapshot = root / "adaptive.json"
        manifest_path = root / "manifest.json"
        output = root / "validation.tsv"
        snapshot.write_text(raw if raw is not None else json.dumps(value) + "\n", encoding="utf-8")
        manifest_path.write_text(json.dumps(manifest_value or manifest()) + "\n", encoding="utf-8")
        command = [
            sys.executable,
            str(SCRIPT),
            "--telemetry",
            str(snapshot),
            "--manifest",
            str(manifest_path),
            "--output",
            str(output),
        ]
        if acceptance_policy is not None:
            command.extend(("--acceptance-policy", acceptance_policy))
        if acceptance_policy == CONSTRAINED_POLICY:
            contract = DEFAULT_SAMPLE_CONTRACT | (sample_contract or {})
            for option, option_value in contract.items():
                command.extend((f"--{option}", str(option_value)))
        result = subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        contents = output.read_text(encoding="utf-8") if output.exists() else ""
        temporary.cleanup()
        return result, contents

    def test_accepts_exact_active_snapshot(self):
        result, output = self.run_validator(active())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\tadaptive-active\tnone\truntime:postgres\t", output)
        self.assertIn(f"\t{PORTABLE_POLICY}\t{ABI_ID}\twarmup\t", output)

    def test_destination_appearing_at_commit_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = root / "adaptive.json"
            manifest_path = root / "manifest.json"
            output = root / "validation.tsv"
            snapshot.write_text(json.dumps(active()) + "\n", encoding="utf-8")
            manifest_path.write_text(json.dumps(manifest()) + "\n", encoding="utf-8")
            competitor = b"concurrent owner\n"
            real_publish = MODULE.publish_identified

            def publish_after_competitor(source, destination, identity) -> None:
                destination.write_bytes(competitor)
                real_publish(source, destination, identity)

            with mock.patch.object(MODULE, "publish_identified", publish_after_competitor):
                with self.assertRaises(MODULE.PublicationError):
                    MODULE.validate(
                        snapshot,
                        manifest_path,
                        output,
                        PORTABLE_POLICY,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
            self.assertEqual(output.read_bytes(), competitor)
            self.assertEqual(list(root.glob(".validation.tsv.pending.*")), [])

    def test_pending_replacement_is_never_unlinked_by_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = root / "adaptive.json"
            manifest_path = root / "manifest.json"
            output = root / "validation.tsv"
            snapshot.write_text(json.dumps(active()) + "\n", encoding="utf-8")
            manifest_path.write_text(json.dumps(manifest()) + "\n", encoding="utf-8")
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
                    MODULE.validate(
                        snapshot,
                        manifest_path,
                        output,
                        PORTABLE_POLICY,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
            pending = list(root.glob(".validation.tsv.pending.*"))
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].read_bytes(), attacker)
            self.assertTrue(held.is_file())
            self.assertFalse(output.exists())

    def test_accepts_each_exact_fallback_reason(self):
        for reason in ("unsupported", "invalid-evidence", "unavailable-io"):
            with self.subTest(reason=reason):
                value = fallback()
                value["reason"] = reason
                result, output = self.run_validator(value)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"\tobserve-only-fallback\t{reason}\t", output)

    def test_constrained_policy_accepts_exact_active_wal_action(self):
        result, output = self.run_validator(
            active_wal_action(), acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        header, row = output.splitlines()
        fields = dict(zip(header.split("\t"), row.split("\t"), strict=True))
        self.assertEqual(fields["schema_version"], RESULT_SCHEMA)
        self.assertEqual(fields["acceptance_policy"], CONSTRAINED_POLICY)
        self.assertEqual(fields["outcome"], "adaptive-active")
        self.assertEqual(fields["class6_offers"], "1")
        self.assertEqual(fields["class6_advice_calls"], "1")
        self.assertEqual(fields["class6_advised_bytes"], str(1024 * 1024))
        self.assertEqual(fields["class6_advice_errors"], "0")
        self.assertEqual(fields["cgroup_identity"], "31:41")
        self.assertEqual(fields["membership_leaf_identity"], "31:41")
        self.assertEqual(fields["pressure_source_identity"], "31:41")
        self.assertEqual(fields["last_sample_monotonic_ns"], "10000000000")
        self.assertEqual(fields["measurement_id"], "sample-b01-p2-wasix")
        self.assertEqual(fields["target"], "wasix")
        self.assertEqual(
            fields["last_sample_effective_limit_bytes"], str(224 * 1024 * 1024)
        )

    def test_constrained_policy_rejects_fallback_or_zero_wal_action(self):
        result, output = self.run_validator(
            fallback(), acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("requires adaptive-active admission", result.stderr)

        result, output = self.run_validator(
            active(), acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("requires class 6 offers", result.stderr)

        value = active_wal_action()
        value["classes"][5]["advice-calls"] = 0
        value["classes"][5]["advised-bytes"] = 0
        value["range-advised-bytes"] = 0
        value["advised-bytes-since-sample"] = 0
        value["retain-reasons"][0]["calls"] += 1
        for field in (
            "deferred-wal-high-entries",
            "deferred-wal-high-bytes",
            "deferred-wal-enqueued",
            "deferred-wal-enqueued-bytes",
            "deferred-wal-attempts",
            "deferred-wal-attempted-bytes",
            "deferred-wal-successes",
            "deferred-wal-success-bytes",
            "deferred-wal-pressure-samples",
            "deferred-wal-actionable-samples",
            "deferred-wal-terminal-entries",
            "deferred-wal-terminal-bytes",
            "wal-emergency-attempts",
            "wal-emergency-attempted-bytes",
            "wal-emergency-successes",
            "wal-emergency-success-bytes",
            "wal-emergency-current-attempts",
            "wal-emergency-current-attempted-bytes",
            "wal-emergency-current-successes",
            "wal-emergency-current-success-bytes",
            "wal-emergency-max-actions-per-trigger",
            "wal-emergency-max-bytes-per-trigger",
        ):
            value[field] = 0
        result, output = self.run_validator(
            value, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("requires class 6 advice calls", result.stderr)

        value = active_wal_action()
        value["classes"][5]["advised-bytes"] = 0
        value["range-advised-bytes"] = 0
        value["advised-bytes-since-sample"] = 0
        result, output = self.run_validator(
            value, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("advice call/byte presence differs", result.stderr)

    def test_constrained_policy_rejects_sampler_or_clock_errors(self):
        for field in ("sample-errors", "clock-errors"):
            with self.subTest(field=field):
                value = active_wal_action()
                value[field] = 1
                result, output = self.run_validator(
                    value, acceptance_policy=CONSTRAINED_POLICY
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output)
                self.assertIn("contains telemetry, advice, or WAL pin errors", result.stderr)

    def test_constrained_policy_requires_current_pressure_sample_not_completed_warmup(self):
        value = active_wal_action()
        value["sample-count"] = 0
        value["last-sample"] = None
        value["state"] = "warmup"
        result, output = self.run_validator(
            value, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("trigger high-water action count differs", result.stderr)

        value = active_wal_action()
        value["sample-count"] = config()["warmup-samples"] - 1
        value["state"] = "warmup"
        result, output = self.run_validator(
            value, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("trigger high-water action count differs", result.stderr)

        value = active_wal_action()
        value["sample-count"] = 0
        value["last-sample"] = None
        value["state"] = "warmup"
        result, output = self.run_validator(
            value, acceptance_policy=PORTABLE_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("trigger high-water action count differs", result.stderr)

    def test_constrained_policy_rejects_cgroup_identity_time_or_limit_mismatch(self):
        cases = (
            (
                {"cgroup-identity": "31:42"},
                "membership leaf differs from the measured cgroup identity",
            ),
            (
                {"sample-window-start-monotonic-ns": 10_000_000_001},
                "last sample falls outside the measured target lifetime",
            ),
            (
                {"cgroup-memory-high-bytes": 223 * 1024 * 1024},
                "effective limit differs from min(leaf MemoryMax, leaf MemoryHigh)",
            ),
        )
        for contract, message in cases:
            with self.subTest(contract=contract):
                result, output = self.run_validator(
                    active_wal_action(),
                    acceptance_policy=CONSTRAINED_POLICY,
                    sample_contract=contract,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output)
                self.assertIn(message, result.stderr)

        value = active_wal_action()
        value["last-sample"]["effective-limit-bytes"] = 256 * 1024 * 1024
        result, output = self.run_validator(
            value, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn(
            "effective limit differs from min(leaf MemoryMax, leaf MemoryHigh)",
            result.stderr,
        )

    def test_rejects_unknown_acceptance_policy(self):
        result, output = self.run_validator(
            active_wal_action(), acceptance_policy="almost-constrained"
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(output)
        self.assertIn("invalid choice", result.stderr)

    def test_rejects_unknown_or_duplicate_fields(self):
        value = fallback()
        value["activation"] = "environment"
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fields differ", result.stderr)
        raw = json.dumps(fallback())[:-1] + ',"schema":"duplicate"}\n'
        result, _ = self.run_validator(fallback(), raw=raw)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate JSON field", result.stderr)

    def test_rejects_manifest_policy_or_runtime_abi_drift(self):
        bad_manifest = manifest()
        bad_manifest["file-cache-policy"]["config-sha256"] = "34" * 32
        result, _ = self.run_validator(active(), manifest_value=bad_manifest)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("file-cache-policy differs", result.stderr)
        value = active()
        value["runtime-abi-id"] = "56" * 32
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime-abi-id differs", result.stderr)

    def test_rejects_tuning_or_accounting_drift(self):
        value = active()
        value["config"]["warmup-samples"] = 4
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("config warmup-samples differs", result.stderr)
        value = active()
        value["validation"][0] = 3
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("class offers differ", result.stderr)

    def test_rejects_json_type_aliases_in_exact_config(self):
        value = fallback()
        value["config"]["allow-wal-cache-drop-safe-dirty-bypass"] = 1
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("allow-wal-cache-drop-safe-dirty-bypass differs", result.stderr)
        value = fallback()
        value["config"]["page-alignment"] = 1
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("page-alignment differs", result.stderr)

        value = fallback()
        value["config"]["immediate-wal-cache-drop-safe"] = True
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("immediate-wal-cache-drop-safe differs", result.stderr)

        value = fallback()
        value["config"]["relation-pressure-relief"] = True
        result, _ = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("relation-pressure-relief differs", result.stderr)

    def test_rejects_relation_advice_forged_into_observe_only_embedded_profile(self):
        value = active()
        value["classes"][1]["advice-calls"] = 1
        value["classes"][1]["advised-bytes"] = 8192
        value["retain-reasons"][3]["calls"] = 0
        value["range-aligned-bytes"] = 8192
        value["range-advised-bytes"] = 8192
        value["advised-bytes-since-sample"] = 8192
        value["token-bytes"] -= 8192
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("non-acting class 2 reported advice activity", result.stderr)

    def test_portable_accepts_structurally_conserved_advice_errors_but_constrained_rejects(self):
        value = active_wal_action()
        value["classes"][5]["advice-calls"] = 0
        value["classes"][5]["advised-bytes"] = 0
        value["classes"][5]["advice-errors"] = 1
        value["range-advised-bytes"] = 0
        value["advised-bytes-since-sample"] = 0
        value["advice-errors"] = 1
        value["last-advice-raw-os-error"] = 22
        value["state"] = "degraded"
        value["wal-emergency-successes"] = 0
        value["wal-emergency-success-bytes"] = 0
        value["deferred-wal-successes"] = 0
        value["deferred-wal-success-bytes"] = 0
        value["deferred-wal-errors"] = 1
        value["deferred-wal-error-bytes"] = 1024 * 1024
        result, output = self.run_validator(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\tadaptive-active\t", output)

        strict = value
        result, output = self.run_validator(
            strict, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("requires class 6 advice calls", result.stderr)

    def test_active_receipts_are_terminal_under_both_acceptance_policies(self):
        cases = (
            ("workload-finalized", False, "not workload-finalized"),
            (
                "deferred-wal-maintenance-constructed",
                False,
                "did not construct bounded WAL maintenance",
            ),
            (
                "deferred-wal-maintenance-active",
                True,
                "retained live WAL maintenance",
            ),
            ("deferred-wal-queued-entries", 1, "nonzero deferred-wal-queued-entries"),
            ("deferred-wal-inflight-bytes", 1024 * 1024, "nonzero deferred-wal-inflight-bytes"),
            ("deferred-wal-oldest-age-ns", 1, "nonzero deferred-wal-oldest-age-ns"),
            ("deferred-wal-open-fds", 1, "nonzero deferred-wal-open-fds"),
            (
                "deferred-wal-mutation-epoch-identities",
                1,
                "nonzero deferred-wal-mutation-epoch-identities",
            ),
            (
                "deferred-wal-conservation-entries-ok",
                False,
                "failed deferred WAL conservation",
            ),
        )
        for policy in (PORTABLE_POLICY, CONSTRAINED_POLICY):
            for field, replacement, message in cases:
                with self.subTest(policy=policy, field=field):
                    value = active_wal_action()
                    value[field] = replacement
                    result, output = self.run_validator(value, acceptance_policy=policy)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(output)
                    self.assertIn(message, result.stderr)

    def test_accepts_exact_deferred_success_and_finalization_flush_accounting(self):
        for value in (
            active_deferred_wal_success(),
            active_deferred_wal_finalization_flush(),
            active_deferred_wal_revoke(),
            active_deferred_wal_invalidated(),
        ):
            with self.subTest(flushes=value["deferred-wal-flushes"]):
                result, output = self.run_validator(value)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("\tadaptive-active\t", output)

    def test_constrained_accepts_safe_generation_cancellation_after_real_action(self):
        result, output = self.run_validator(
            active_deferred_wal_success_with_invalidation(),
            acceptance_policy=CONSTRAINED_POLICY,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\tadaptive-active\t", output)

    def test_rejects_revoke_sequence_or_terminal_conservation_drift(self):
        cases = []

        value = active_deferred_wal_revoke()
        value["deferred-wal-revoke-sequence"] = 1
        cases.append((value, "synchronous deferred WAL revoke accounting differs"))

        value = active_deferred_wal_revoke()
        value["deferred-wal-terminal-bytes"] = 2 * 1024 * 1024
        cases.append((value, "terminal deferred WAL conservation fields differ"))

        value = active_deferred_wal_revoke()
        value["deferred-wal-revoke-errors"] = 2
        cases.append((value, "synchronous deferred WAL revoke accounting differs"))

        for value, message in cases:
            with self.subTest(message=message):
                result, output = self.run_validator(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output)
                self.assertIn(message, result.stderr)

    def test_rejects_deferred_wal_conservation_and_bound_drift(self):
        cases: list[tuple[dict, str]] = []

        value = active_deferred_wal_success()
        value["deferred-wal-enqueued"] = 3
        value["deferred-wal-enqueued-bytes"] = 3 * 1024 * 1024
        cases.append((value, "entry dispositions do not conserve enqueues"))

        value = active_deferred_wal_success()
        value["deferred-wal-high-entries"] = 0
        value["deferred-wal-high-bytes"] = 0
        cases.append((value, "high-water mark does not reconcile with enqueues"))

        value = active_wal_action()
        wal_bytes = 1024 * 1024
        value["deferred-wal-sequence-rejected"] = 1
        value["deferred-wal-sequence-rejected-bytes"] = wal_bytes
        cases.append((value, "counters exceed their owning offer dispositions"))

        value = active_deferred_wal_success()
        value["deferred-wal-attempts"] = 3
        value["deferred-wal-attempted-bytes"] = 3 * 1024 * 1024
        value["wal-emergency-attempts"] = 3
        value["wal-emergency-attempted-bytes"] = 3 * 1024 * 1024
        cases.append((value, "attempt dispositions do not conserve attempts"))

        value = active_deferred_wal_finalization_flush()
        value["deferred-wal-finalization-flushes"] = 0
        cases.append((value, "flush reasons do not conserve flushes"))

        value = active_deferred_wal_finalization_flush()
        value["deferred-wal-finalization-flushes"] = 0
        value["deferred-wal-advice-error-flushes"] = 1
        cases.append((value, "error flush lacks its owning sampler/clock/advice error"))

        value = active_deferred_wal_success()
        value["wal-emergency-max-actions-per-trigger"] = 3
        value["wal-emergency-max-bytes-per-trigger"] = 3 * 1024 * 1024
        cases.append((value, "WAL trigger work exceeds the sealed bound"))

        value = active_deferred_wal_success()
        value["action-gate-contended-calls"] = 1
        cases.append((value, "contended action-gate dispositions do not conserve calls"))

        value = active_deferred_wal_success()
        value["finalization-quiescence-notifications"] = 2
        cases.append((value, "more than one terminal quiescence notification"))

        for value, message in cases:
            with self.subTest(message=message):
                result, output = self.run_validator(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output)
                self.assertIn(message, result.stderr)

    def test_rejects_deferred_busy_retry(self):
        value = active_deferred_wal_success()
        wal_bytes = 1024 * 1024
        value.update(
            {
                "deferred-wal-attempts": 3,
                "deferred-wal-attempted-bytes": 3 * wal_bytes,
                "deferred-wal-busy": 1,
                "deferred-wal-busy-requeued": 1,
                "wal-emergency-attempts": 3,
                "wal-emergency-attempted-bytes": 3 * wal_bytes,
                "deferred-wal-pressure-samples": 3,
                "deferred-wal-actionable-samples": 3,
            }
        )
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn(
            "deferred WAL work exceeds the no-retry, one-fresh-sample contract",
            result.stderr,
        )

    def test_rejects_cross_class_byte_shift_into_unsupported_class(self):
        value = active_wal_action()
        wal_bytes = 1024 * 1024
        forged_bytes = 16 * wal_bytes
        value["classes"][0]["offered-finite-bytes"] += 15 * wal_bytes
        value["classes"][5]["advised-bytes"] = forged_bytes
        value["range-offered-bytes"] = 8192 + forged_bytes
        value["range-aligned-bytes"] = forged_bytes
        value["range-advised-bytes"] = forged_bytes
        value["advised-bytes-since-sample"] = forged_bytes
        for field in (
            "wal-emergency-attempted-bytes",
            "wal-emergency-success-bytes",
            "wal-emergency-current-attempted-bytes",
            "wal-emergency-current-success-bytes",
            "wal-emergency-max-bytes-per-trigger",
        ):
            value[field] = forged_bytes
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn(
            "adaptive class 6 advised bytes exceed finite offered bytes",
            result.stderr,
        )

    def test_rejects_forbidden_immediate_wal_action(self):
        value = active_wal_action()
        wal_bytes = 1024 * 1024
        value["wal-emergency-current-attempts"] = 1
        value["wal-emergency-current-attempted-bytes"] = wal_bytes
        value["wal-emergency-current-successes"] = 1
        value["wal-emergency-current-success-bytes"] = wal_bytes
        value["wal-emergency-attempts"] = 2
        value["wal-emergency-attempted-bytes"] = 2 * wal_bytes
        value["wal-emergency-successes"] = 2
        value["wal-emergency-success-bytes"] = 2 * wal_bytes
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn(
            "forbidden immediate WAL action",
            result.stderr,
        )

    def test_rejects_two_actions_from_one_fresh_pressure_sample(self):
        value = active_deferred_wal_success()
        value["deferred-wal-pressure-samples"] = 1
        value["deferred-wal-actionable-samples"] = 1
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn(
            "no-retry, one-fresh-sample contract",
            result.stderr,
        )

    def test_rejects_noncanonical_single_wal_action_even_when_mib_aligned(self):
        value = active_wal_action()
        forged_bytes = 3 * 1024 * 1024
        value["classes"][5]["offered-finite-bytes"] = forged_bytes
        value["classes"][5]["advised-bytes"] = forged_bytes
        value["range-offered-bytes"] = 8192 + forged_bytes
        value["range-aligned-bytes"] = forged_bytes
        value["range-advised-bytes"] = forged_bytes
        value["advised-bytes-since-sample"] = forged_bytes
        for field in (
            "wal-emergency-attempted-bytes",
            "wal-emergency-success-bytes",
            "wal-emergency-current-attempted-bytes",
            "wal-emergency-current-success-bytes",
            "wal-emergency-max-bytes-per-trigger",
        ):
            value[field] = forged_bytes
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("not a sum of canonical 1/2/4/8/16 MiB", result.stderr)

        value = active_wal_action()
        value["classes"][5]["partial-advice-calls"] = 1
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("class-6 WAL action reported partial advice", result.stderr)

        value = active_wal_action()
        value["classes"][5]["through-eof-offers"] = 1
        result, output = self.run_validator(value)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("finite offer count/byte presence differs", result.stderr)

    def test_accepts_64k_resolved_host_pages(self):
        value = active_wal_action()
        value["resolved-page-bytes"] = 64 * 1024
        result, output = self.run_validator(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\tadaptive-active\t", output)

    def test_constrained_rejects_breakers_and_contended_pin_failures(self):
        breaker = active_wal_action()
        breaker["psi-breaker-trips"] = 1
        portable, _ = self.run_validator(breaker)
        self.assertEqual(portable.returncode, 0, portable.stderr)
        result, output = self.run_validator(
            breaker, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("degradation or breaker trips", result.stderr)

        pin = active_wal_action()
        wal_bytes = 1024 * 1024
        pin["classes"][5]["offers"] += 1
        pin["classes"][5]["offered-finite-bytes"] += wal_bytes
        pin["validation"][0] += 1
        pin["range-offered-bytes"] += wal_bytes
        pin["range-aligned-bytes"] += wal_bytes
        pin["retain-reasons"][3]["calls"] += 1
        pin["action-gate-contended-calls"] = 1
        pin["action-gate-contended-retained"] = 1
        pin["action-gate-contended-wal-pin-failures"] = 1
        portable, _ = self.run_validator(pin)
        self.assertEqual(portable.returncode, 0, portable.stderr)
        result, output = self.run_validator(pin, acceptance_policy=CONSTRAINED_POLICY)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("WAL pin errors", result.stderr)

        hidden_breaker = active_deferred_wal_finalization_flush()
        hidden_breaker["deferred-wal-finalization-flushes"] = 0
        hidden_breaker["deferred-wal-breaker-flushes"] = 1
        portable, _ = self.run_validator(hidden_breaker)
        self.assertEqual(portable.returncode, 0, portable.stderr)
        result, output = self.run_validator(
            hidden_breaker, acceptance_policy=CONSTRAINED_POLICY
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output)
        self.assertIn("WAL pin errors", result.stderr)

    def test_portable_accepts_degraded_receipt_with_cleared_last_sample(self):
        value = active()
        value["sample-errors"] = 1
        value["state"] = "degraded"
        value["last-sample"] = None
        result, output = self.run_validator(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\tadaptive-active\t", output)

    def test_rejects_retain_reasons_without_runtime_causes(self):
        cases = []
        value = active()
        value["retain-reasons"][0]["calls"] = 0
        value["retain-reasons"][7]["calls"] = 1
        cases.append((value, "sampler-unavailable retains lack"))

        value = active()
        value["retain-reasons"][0]["calls"] = 0
        value["retain-reasons"][8]["calls"] = 1
        cases.append((value, "circuit-breaker retains lack"))

        value = active()
        value["dirty-vetoes"] = 1
        cases.append((value, "dirty-veto retains differ"))

        value = active()
        value["retain-reasons"][0]["calls"] = 0
        value["retain-reasons"][11]["calls"] = 1
        cases.append((value, "post-finalization offer"))

        for value, message in cases:
            with self.subTest(message=message):
                result, output = self.run_validator(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output)
                self.assertIn(message, result.stderr)

    def test_rejects_impossible_sample_deltas_and_wal_temporal_ownership(self):
        cases = []

        value = active_wal_action()
        value["last-psi-full-delta-us"] = 1
        cases.append((value, "delta exceeds its cumulative source counter"))

        value = active_wal_action()
        value["last-psi-some-per-mille"] = 1
        cases.append((value, "zero PSI-some delta has a nonzero rate"))

        value = active_wal_action()
        value["last-sample"]["local-events-available"] = False
        cases.append((value, "unavailable local events have nonzero counters"))

        value = active_wal_action()
        value["last-sample"]["file-dirty-bytes"] = 181 * 1024 * 1024
        value["max-file-dirty-bytes"] = 181 * 1024 * 1024
        cases.append((value, "file-dirty bytes exceed file-context bytes"))

        value = active_wal_action()
        value["wal-emergency-oversize-rejects"] = 1
        cases.append((value, "counters exceed their owning offer dispositions"))

        value = active_wal_action()
        value["wal-emergency-forced-samples"] = 1
        cases.append((value, "forbidden immediate WAL action"))

        for value, message in cases:
            with self.subTest(message=message):
                result, output = self.run_validator(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()
