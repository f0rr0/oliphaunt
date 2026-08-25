#!/usr/bin/env python3

"""Unit tests for the final-module PostgreSQL concurrency contract verifier."""

from __future__ import annotations

import importlib.util
import hashlib
import io
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout


SCRIPT = pathlib.Path(__file__).with_name("verify-postmaster-concurrency-contract.py")
SPEC = importlib.util.spec_from_file_location("concurrency_contract", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def uleb(value: int) -> bytes:
    output = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        output.append(byte)
        if not value:
            return bytes(output)


def name(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return uleb(len(encoded)) + encoded


def vector(items: list[bytes]) -> bytes:
    return uleb(len(items)) + b"".join(items)


def section(section_id: int, payload: bytes) -> bytes:
    return bytes((section_id,)) + uleb(len(payload)) + payload


def module_bytes(
    *, shared: bool = True, function_fences: dict[str, int] | None = None,
    extra_fences: int = 271, immediate_fence_lookalike: bool = False,
) -> bytes:
    counts = dict(MODULE.EXPECTED_FUNCTION_FENCES)
    if function_fences is not None:
        counts.update(function_fences)
    type_section = section(1, vector([b"\x60\x00\x00"]))
    limits = (b"\x03" if shared else b"\x01") + uleb(1) + uleb(2)
    memory_import = name("env") + name("memory") + b"\x02" + limits
    import_section = section(2, vector([memory_import]))

    function_names = list(MODULE.EXPECTED_FUNCTION_FENCES) + ["other"]
    function_section = section(3, vector([b"\x00" for _ in function_names]))
    exports = [
        name(function_name) + b"\x00" + uleb(index)
        for index, function_name in enumerate(function_names)
        if function_name != "other"
    ]
    export_section = section(7, vector(exports))

    bodies = []
    for function_name in function_names:
        fence_count = extra_fences if function_name == "other" else counts[function_name]
        instructions = MODULE.ATOMIC_FENCE_ENCODING * fence_count
        if function_name == "other" and immediate_fence_lookalike:
            # i32.const 510 followed by unreachable contains fe 03 00, but no fence.
            instructions += b"\x41\xfe\x03\x00"
        instructions += b"\x0b"
        body = b"\x00" + instructions  # zero local declaration groups
        bodies.append(uleb(len(body)) + body)
    code_section = section(10, uleb(len(bodies)) + b"".join(bodies))
    return b"\x00asm\x01\x00\x00\x00" + type_section + import_section + function_section + export_section + code_section


def packed_wat(*, wait_loads: int = 1, wait_ands: int = 2) -> list[str]:
    lines = [
        ' (export "ResetLatch" (func $20))\n',
        ' (export "SetLatch" (func $19))\n',
        ' (export "WaitEventSetWait" (func $21))\n',
        ' (data $0 (i32.const 0) "(atomic.fence) is data, not code")\n',
        ' (func $19 (param $0 i32)\n',
        '  (atomic.fence)\n',
        '  (i32.atomic.rmw.or\n',
        '   (local.get $0)\n',
        '   (i32.const 1)\n',
        '  )\n',
        '  (atomic.fence)\n',
        ' )\n',
        ' (func $20 (param $0 i32)\n',
        '  (i32.atomic.rmw.and\n',
        '   (local.get $0)\n',
        '   (i32.const -2)\n',
        '  )\n',
        '  (atomic.fence)\n',
        ' )\n',
        ' (func $21 (param $0 i32)\n',
        '  (i32.atomic.rmw.or\n',
        '   (local.get $0)\n',
        '   (i32.const 2)\n',
        '  )\n',
    ]
    lines.extend('  (i32.atomic.load (local.get $0))\n' for _ in range(wait_loads))
    lines.extend('  (i32.atomic.rmw.and (local.get $0) (i32.const -3))\n' for _ in range(wait_ands))
    lines.extend(['  (atomic.fence)\n', ' )\n'])
    return lines


class ConcurrencyContractTests(unittest.TestCase):
    def verify_bytes(self, contents: bytes):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "postgres.wasm"
            path.write_bytes(contents)
            return MODULE.verify(path)

    def test_exact_contract_passes(self) -> None:
        total, functions = self.verify_bytes(module_bytes())
        self.assertEqual(total, 275)
        self.assertEqual(functions, MODULE.EXPECTED_FUNCTION_FENCES)

    def test_missing_critical_fence_fails(self) -> None:
        with self.assertRaisesRegex(MODULE.DecodeError, "SetLatch contains 1"):
            self.verify_bytes(module_bytes(function_fences={"SetLatch": 1}))

    def test_total_fence_drift_fails(self) -> None:
        with self.assertRaisesRegex(MODULE.DecodeError, "module contains 274"):
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / "postgres.wasm"
                path.write_bytes(module_bytes(extra_fences=270))
                MODULE.verify(path, expected_total=275)

    def test_unshared_memory_fails(self) -> None:
        with self.assertRaisesRegex(MODULE.DecodeError, "not declared shared"):
            self.verify_bytes(module_bytes(shared=False))

    def test_truncated_module_fails(self) -> None:
        with self.assertRaisesRegex(MODULE.DecodeError, "truncated"):
            self.verify_bytes(module_bytes()[:-1])

    def test_packed_wat_contract_passes_and_ignores_data_text(self) -> None:
        totals, functions = MODULE.parse_wat_instruction_inventory(packed_wat())
        self.assertEqual(totals["atomic.fence"], 4)
        self.assertEqual(totals["i32.atomic.load"], 1)
        MODULE.verify_packed_atomic_contract(totals, functions)

    def test_packed_contract_ignores_fence_encoding_inside_immediate(self) -> None:
        contents = module_bytes(extra_fences=0, immediate_fence_lookalike=True)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            postgres = root / "postgres.wasm"
            wasm_dis = root / "wasm-dis"
            postgres.write_bytes(contents)
            wasm_dis.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "if '--version' in sys.argv:\n"
                "    print('wasm-dis version 130')\n"
                "else:\n"
                f"    print({''.join(packed_wat())!r}, end='')\n",
                encoding="utf-8",
            )
            wasm_dis.chmod(0o755)

            # The legacy byte substring inventory sees a false fifth fence.
            self.assertEqual(MODULE.verify(postgres)[0], 5)
            with redirect_stdout(io.StringIO()):
                status = MODULE.main(
                    [
                        str(SCRIPT),
                        "--expected-total",
                        "4",
                        "--latch-state-contract",
                        MODULE.PACKED_LATCH_CONTRACT,
                        "--wasm-dis",
                        str(wasm_dis),
                        str(postgres),
                    ]
                )
            self.assertEqual(status, 0)

    def test_packed_wat_missing_waiter_retraction_fails(self) -> None:
        totals, functions = MODULE.parse_wat_instruction_inventory(
            packed_wat(wait_ands=1)
        )
        with self.assertRaisesRegex(
            MODULE.DecodeError,
            "WaitEventSetWait contains 1 i32.atomic.rmw.and",
        ):
            MODULE.verify_packed_atomic_contract(totals, functions)

    def test_packed_wat_missing_atomic_load_fails(self) -> None:
        totals, functions = MODULE.parse_wat_instruction_inventory(
            packed_wat(wait_loads=0)
        )
        with self.assertRaisesRegex(MODULE.DecodeError, "expected at least 1"):
            MODULE.verify_packed_atomic_contract(totals, functions)

    def test_packed_wat_duplicate_critical_alias_fails(self) -> None:
        lines = packed_wat()
        lines[1] = ' (export "SetLatch" (func $20))\n'
        with self.assertRaisesRegex(MODULE.DecodeError, "share one function"):
            MODULE.parse_wat_instruction_inventory(lines)

    def test_final_contract_receipt_is_canonical(self) -> None:
        totals, functions = MODULE.parse_wat_instruction_inventory(packed_wat())
        receipt = MODULE.canonical_receipt(
            "1" * 64,
            4,
            totals,
            functions,
            "2" * 64,
            "wasm-dis version 130",
        )
        self.assertTrue(receipt.endswith("\n"))
        self.assertIn(
            "schema=oliphaunt.wasix-postmaster.final-wasm-concurrency.v1\n",
            receipt,
        )
        self.assertIn("i32_atomic_rmw_and_wait_event_set_wait=2\n", receipt)

    def test_final_contract_receipt_binds_module(self) -> None:
        contents = module_bytes()
        totals, functions = MODULE.parse_wat_instruction_inventory(packed_wat())
        receipt = MODULE.canonical_receipt(
            hashlib.sha256(contents).hexdigest(),
            275,
            totals,
            functions,
            "2" * 64,
            "wasm-dis version 130",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            postgres = root / "postgres.wasm"
            receipt_path = root / "contract.receipt"
            postgres.write_bytes(contents)
            receipt_path.write_text(receipt, encoding="utf-8")
            values = MODULE.verify_receipt(receipt_path, postgres, 275)
            self.assertEqual(values["postgres_sha256"], hashlib.sha256(contents).hexdigest())

            receipt_path.write_text(
                receipt.replace(
                    "i32_atomic_rmw_or_set_latch=1",
                    "i32_atomic_rmw_or_set_latch=0",
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(MODULE.DecodeError, "contract differs"):
                MODULE.verify_receipt(receipt_path, postgres, 275)


if __name__ == "__main__":
    unittest.main()
