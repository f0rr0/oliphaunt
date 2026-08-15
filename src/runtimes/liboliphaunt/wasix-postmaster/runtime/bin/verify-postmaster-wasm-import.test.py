#!/usr/bin/env python3

import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("verify-postmaster-wasm-import.py")
SIGNATURE = (b"\x7f\x7e\x7e\x7f", b"\x7f")


def uleb(value):
    encoded = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        encoded.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(encoded)


def vector(*values):
    return uleb(len(values)) + b"".join(values)


def name(value):
    encoded = value.encode("utf-8")
    return uleb(len(encoded)) + encoded


def section(section_id, payload):
    return bytes([section_id]) + uleb(len(payload)) + payload


def module(imports=None):
    imports = imports or [("oliphaunt_postmaster_v1", "fd_sync_range", SIGNATURE)]
    function_types = []
    import_entries = []
    for type_index, (module_name, field, signature) in enumerate(imports):
        params, results = signature
        function_types.append(
            b"\x60"
            + vector(*(bytes([item]) for item in params))
            + vector(*(bytes([item]) for item in results))
        )
        import_entries.append(name(module_name) + name(field) + b"\x00" + uleb(type_index))
    return (
        b"\x00asm\x01\x00\x00\x00"
        + section(1, vector(*function_types))
        + section(2, vector(*import_entries))
    )


class VerifyPostmasterImportTests(unittest.TestCase):
    def run_verifier(self, contents):
        with tempfile.TemporaryDirectory() as directory:
            wasm = pathlib.Path(directory) / "postgres.wasm"
            wasm.write_bytes(contents)
            return subprocess.run(
                [sys.executable, str(SCRIPT), str(wasm)],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

    def test_accepts_exact_product_import_and_signature(self):
        result = self.run_verifier(module())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(i32,i64,i64,i32)->(i32)", result.stdout)

    def test_rejects_legacy_namespace_alias(self):
        result = self.run_verifier(module([("wasix_32v1", "fd_sync_range", SIGNATURE)]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden fd_sync_range import alias", result.stderr)

    def test_rejects_wrong_signature(self):
        result = self.run_verifier(
            module([("oliphaunt_postmaster_v1", "fd_sync_range", (b"\x7f", b"\x7f"))])
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fd_sync_range signature is", result.stderr)

    def test_rejects_missing_product_import(self):
        result = self.run_verifier(module([("wasi_snapshot_preview1", "fd_sync", (b"\x7f", b"\x7f"))]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "expected exactly one oliphaunt_postmaster_v1.fd_sync_range",
            result.stderr,
        )


if __name__ == "__main__":
    unittest.main()
