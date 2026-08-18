#!/usr/bin/env python3

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-sealed-carrier.py")
SPEC = importlib.util.spec_from_file_location("verify_sealed_carrier", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def valid_proof(module_sha256: str = "a" * 64) -> dict[str, object]:
    return {
        "schema": MODULE.DETERMINISTIC_START_PROOF_SCHEMA,
        "analyzer-policy": MODULE.DETERMINISTIC_START_ANALYZER_POLICY,
        "module-sha256": module_sha256,
        "proof-sha256": "b" * 64,
        "start-function-index": 147,
        "start-function-export": "__wasm_init_memory",
        "transitive-function-indices": [147, 148],
        "imported-function-calls": 0,
        "memory-reads": MODULE.DETERMINISTIC_START_MEMORY_READS,
        "memory-effects": MODULE.DETERMINISTIC_START_MEMORY_EFFECTS,
        "global-effects": MODULE.DETERMINISTIC_START_GLOBAL_EFFECTS,
        "table-effects": MODULE.DETERMINISTIC_START_TABLE_EFFECTS,
        "requires-fresh-zeroed-memory": True,
        "ordinary-start-execution-per-instance": True,
        "first-instance-full-byte-validation": True,
    }


def proof_output_sha256(proof: dict[str, object]) -> str:
    return sha256(
        json.dumps(
            proof,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def valid_executor_receipt_values() -> dict[str, str]:
    return {
        "schema": "oliphaunt.wasix-postmaster.postmaster-executor-build.v3",
        "build_recipe_sha256": "1" * 64,
        "wasmer_build_receipt_sha256": "2" * 64,
        "wasmer_source_commit": "3" * 40,
        "wasmer_patch_sha256": "4" * 64,
        "wasmer_prepared_signature_sha256": "5" * 64,
        "wasmer_cargo_lock_sha256": "6" * 64,
        "runtime_abi_id": "7" * 64,
        "artifact_abi_version": "21",
        "executor_package": "oliphaunt-wasix-postmaster-executor",
        "executor_binary": "oliphaunt-wasix-postmaster-executor",
        "executor_features": "product-executor",
        "executor_role": "postmaster-product",
        "runtime_policy_id": (
            "oliphaunt.wasix-postmaster.tokio.2-async."
            "embedded-postmaster-v1-budget96.v2"
        ),
        "cli_contract": "sealed-postmaster-run-v1",
        "executor_binary_sha256": "8" * 64,
        "start_proof_binary": "oliphaunt-wasix-start-proof",
        "start_proof_features": "start-proof-tool",
        "start_proof_policy": MODULE.DETERMINISTIC_START_ANALYZER_POLICY,
        "start_proof_binary_sha256": "9" * 64,
        "memory_profile_binary": "oliphaunt-wasix-memory-profile",
        "memory_profile_features": "memory-profile-tool",
        "linear_memory_profile_id": MODULE.LINEAR_MEMORY_PROFILE_ID,
        "memory_profile_binary_sha256": "a" * 64,
        "postmaster_compiler_binary": "oliphaunt-wasix-postmaster-compiler",
        "postmaster_compiler_features": "product-compiler",
        "compiler_cpu_policy": "generic-baseline",
        "compiler_cpu_features": "none",
        "postmaster_compiler_binary_sha256": "b" * 64,
        "host_platform": "x86_64-linux",
        "host_abi": "glibc-2.39",
        "rustc_host": "x86_64-unknown-linux-gnu",
        "rustc_version": "rustc 1.90.0",
    }


def render_executor_receipt(values: dict[str, str], keys: tuple[str, ...]) -> bytes:
    return "".join(f"{key}={values[key]}\n" for key in keys).encode("utf-8")


def valid_guest_build_receipt_values() -> dict[str, str]:
    return {
        "schema": "oliphaunt.wasix-postmaster.guest-build.v5",
        "core_profile": "release-o3",
        "guest_source_signature_sha256": "1" * 64,
        "docker_image_id": f"sha256:{'2' * 64}",
        "installed_closure_sha256": "3" * 64,
        "child_backend": "exec",
        "effective_cflags": "-O3",
        "effective_ldflags": "-Wl,--gc-sections",
        "effective_wasm_opt": "yes",
        "effective_wasm_opt_flags": "-O3",
        "effective_wasm_opt_suppress_default": "yes",
        "atomic_fence_total": "995",
        "atomic_fence_set_latch": "2",
        "atomic_fence_reset_latch": "1",
        "atomic_fence_wait_event_set_wait": "1",
        "latch_state_contract": "packed-atomic-v1",
        "final_wasm_concurrency_receipt_sha256": "4" * 64,
        "linear_memory_profile_id": MODULE.LINEAR_MEMORY_PROFILE_ID,
        "linear_memory_install_receipt_sha256": "5" * 64,
        "postgres_tag": "REL_18_1",
        "postgres_version": "18.1",
        "sysroot_variant": "upstream-patched",
    }


def render_guest_build_receipt(
    values: dict[str, str], keys: tuple[str, ...] = MODULE.GUEST_BUILD_RECEIPT_KEYS
) -> bytes:
    return "".join(f"{key}={values[key]}\n" for key in keys).encode("utf-8")


class DeterministicStartProofTests(unittest.TestCase):
    def test_accepts_exact_ordinary_start_preserving_contract(self) -> None:
        proof = valid_proof()
        MODULE.validate_deterministic_start_proof(
            proof, proof_output_sha256(proof), "a" * 64, "test proof"
        )

    def test_rejects_weakened_or_ambiguous_contracts(self) -> None:
        mutations = (
            lambda proof: proof.__setitem__("unknown", True),
            lambda proof: proof.__setitem__("schema", "wrong"),
            lambda proof: proof.__setitem__("module-sha256", "c" * 64),
            lambda proof: proof.__setitem__("proof-sha256", "B" * 64),
            lambda proof: proof.__setitem__("start-function-index", True),
            lambda proof: proof.__setitem__("start-function-index", 1 << 32),
            lambda proof: proof.__setitem__(
                "transitive-function-indices", [148, 147]
            ),
            lambda proof: proof.__setitem__("imported-function-calls", False),
            lambda proof: proof.__setitem__("memory-reads", "none"),
            lambda proof: proof.__setitem__("table-effects", "table.init"),
            lambda proof: proof.__setitem__(
                "ordinary-start-execution-per-instance", False
            ),
            lambda proof: proof.__setitem__(
                "first-instance-full-byte-validation", False
            ),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                proof = copy.deepcopy(valid_proof())
                mutate(proof)
                with self.assertRaises(MODULE.VerificationError):
                    MODULE.validate_deterministic_start_proof(
                        proof,
                        proof_output_sha256(proof),
                        "a" * 64,
                        "test proof",
                    )

    def test_rejects_proof_that_differs_from_bound_analyzer_output(self) -> None:
        proof = valid_proof()
        with self.assertRaises(MODULE.VerificationError):
            MODULE.validate_deterministic_start_proof(
                proof, "c" * 64, "a" * 64, "test proof"
            )


class GuestBuildReceiptV5Tests(unittest.TestCase):
    def parse(self, payload: bytes) -> dict[str, str]:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = root / "guest-build.receipt"
            receipt.write_bytes(payload)
            verified = {
                "guest-build.receipt": (receipt.stat().st_size, sha256(payload))
            }
            return MODULE.parse_guest_build_receipt(root, verified)

    def test_accepts_immutable_builder_identity(self) -> None:
        values = valid_guest_build_receipt_values()
        self.assertEqual(self.parse(render_guest_build_receipt(values)), values)

    def test_rejects_legacy_schema_and_invalid_builder_identities(self) -> None:
        for docker_image_id in (
            "2" * 64,
            f"sha256:{'A' * 64}",
            "sha256:short",
            "sha512:" + "2" * 64,
        ):
            with self.subTest(docker_image_id=docker_image_id):
                values = valid_guest_build_receipt_values()
                values["docker_image_id"] = docker_image_id
                with self.assertRaises(MODULE.VerificationError):
                    self.parse(render_guest_build_receipt(values))

        values = valid_guest_build_receipt_values()
        values["schema"] = "oliphaunt.wasix-postmaster.guest-build.v4"
        with self.assertRaises(MODULE.VerificationError):
            self.parse(render_guest_build_receipt(values))

    def test_rejects_missing_or_reordered_builder_identity(self) -> None:
        values = valid_guest_build_receipt_values()
        without_image_id = tuple(
            key for key in MODULE.GUEST_BUILD_RECEIPT_KEYS if key != "docker_image_id"
        )
        with self.assertRaises(MODULE.VerificationError):
            self.parse(render_guest_build_receipt(values, without_image_id))

        reordered = list(MODULE.GUEST_BUILD_RECEIPT_KEYS)
        image_index = reordered.index("docker_image_id")
        reordered[image_index - 1], reordered[image_index] = (
            reordered[image_index],
            reordered[image_index - 1],
        )
        with self.assertRaises(MODULE.VerificationError):
            self.parse(render_guest_build_receipt(values, tuple(reordered)))


class ExecutorReceiptV3Tests(unittest.TestCase):
    def verifier_fixture(
        self, root: Path, values: dict[str, str]
    ) -> tuple[dict[str, tuple[int, str]], dict[str, str]]:
        (root / "bin").mkdir()
        executor = root / "bin" / "wasmer-headless"
        executor.write_bytes(b"executor\n")
        values["executor_binary_sha256"] = sha256(executor.read_bytes())
        wasmer_build = root / "wasmer-build.receipt"
        wasmer_build.write_bytes(b"wasmer receipt\n")
        values["wasmer_build_receipt_sha256"] = sha256(wasmer_build.read_bytes())
        receipt_data = render_executor_receipt(
            values, MODULE.POSTMASTER_EXECUTOR_RECEIPT_KEYS
        )
        receipt = root / MODULE.POSTMASTER_EXECUTOR_RECEIPT_PATH
        receipt.write_bytes(receipt_data)
        verified = {
            "bin/wasmer-headless": (executor.stat().st_size, values["executor_binary_sha256"]),
            "wasmer-build.receipt": (
                wasmer_build.stat().st_size,
                values["wasmer_build_receipt_sha256"],
            ),
            MODULE.POSTMASTER_EXECUTOR_RECEIPT_PATH: (
                receipt.stat().st_size,
                sha256(receipt_data),
            ),
        }
        wasmer_receipt = {
            "build_recipe_sha256": values["build_recipe_sha256"],
            "wasmer_source_commit": values["wasmer_source_commit"],
            "wasmer_patch_sha256": values["wasmer_patch_sha256"],
            "wasmer_prepared_signature_sha256": values[
                "wasmer_prepared_signature_sha256"
            ],
            "wasmer_cargo_lock_sha256": values["wasmer_cargo_lock_sha256"],
            "runtime_abi_id": values["runtime_abi_id"],
            "artifact_abi_version": values["artifact_abi_version"],
            "host_platform": values["host_platform"],
            "host_abi": values["host_abi"],
            "rustc_host": values["rustc_host"],
            "rustc_version": values["rustc_version"],
        }
        return verified, wasmer_receipt

    def test_verifier_accepts_exact_analyzer_provenance(self) -> None:
        values = valid_executor_receipt_values()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verified, wasmer_receipt = self.verifier_fixture(root, values)
            self.assertEqual(
                MODULE.parse_postmaster_executor_receipt(
                    root, verified, wasmer_receipt
                ),
                values,
            )

    def test_verifier_rejects_legacy_v2_schema_and_weakened_tools(self) -> None:
        for field, value in (
            (
                "schema",
                "oliphaunt.wasix-postmaster.postmaster-executor-build.v2",
            ),
            ("start_proof_binary", "another-tool"),
            ("start_proof_features", ""),
            ("start_proof_policy", "unrestricted"),
            ("start_proof_binary_sha256", "not-a-digest"),
            ("memory_profile_binary", "another-tool"),
            ("memory_profile_features", ""),
            ("linear_memory_profile_id", "unbounded"),
            ("memory_profile_binary_sha256", "not-a-digest"),
            ("postmaster_compiler_binary", "another-tool"),
            ("postmaster_compiler_features", ""),
            ("compiler_cpu_policy", "host-native"),
            ("compiler_cpu_features", "avx2"),
            ("postmaster_compiler_binary_sha256", "not-a-digest"),
        ):
            with self.subTest(field=field):
                values = valid_executor_receipt_values()
                values[field] = value
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    verified, wasmer_receipt = self.verifier_fixture(root, values)
                    with self.assertRaises(MODULE.VerificationError):
                        MODULE.parse_postmaster_executor_receipt(
                            root, verified, wasmer_receipt
                        )


if __name__ == "__main__":
    unittest.main()
