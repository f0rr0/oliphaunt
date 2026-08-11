#!/usr/bin/env python3

import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("verify-postmaster-wasm-import.py")


def uleb(value):
    encoded = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        encoded.append(byte)
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
    if imports is None:
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            ),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_offer",
                (b"\x7f\x7e\x7e\x7f\x7f", b"\x7f"),
            ),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_revoke",
                (b"\x7f\x7f\x7f", b"\x7f"),
            ),
        ]
    function_types = []
    import_entries = []
    for type_index, (module_name, field, signature) in enumerate(imports):
        params, results = signature
        function_type = b"\x60" + vector(*(bytes([item]) for item in params))
        function_type += vector(*(bytes([item]) for item in results))
        function_types.append(function_type)
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
        self.assertIn("(i32,i64,i64,i32,i32)->(i32)", result.stdout)
        self.assertIn("(i32,i32,i32)->(i32)", result.stdout)

    def test_rejects_legacy_namespace_alias(self):
        imports = [
            ("wasix_32v1", "fd_sync_range", (b"\x7f\x7e\x7e\x7f", b"\x7f")),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_offer",
                (b"\x7f\x7e\x7e\x7f\x7f", b"\x7f"),
            ),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_revoke",
                (b"\x7f\x7f\x7f", b"\x7f"),
            ),
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden fd_sync_range import alias", result.stderr)

    def test_rejects_wrong_signature(self):
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            ),
            ("oliphaunt_postmaster_v1", "fd_cache_offer", (b"\x7f\x7e", b"\x7f")),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_revoke",
                (b"\x7f\x7f\x7f", b"\x7f"),
            ),
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fd_cache_offer signature is", result.stderr)

    def test_rejects_missing_cache_offer_import(self):
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            )
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected exactly one oliphaunt_postmaster_v1.fd_cache_offer", result.stderr)

    def test_rejects_missing_cache_revoke_import(self):
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            ),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_offer",
                (b"\x7f\x7e\x7e\x7f\x7f", b"\x7f"),
            ),
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "expected exactly one oliphaunt_postmaster_v1.fd_cache_revoke",
            result.stderr,
        )

    def test_rejects_cache_offer_namespace_alias(self):
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            ),
            ("wasix_32v1", "fd_cache_offer", (b"\x7f\x7e\x7e\x7f\x7f", b"\x7f")),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_revoke",
                (b"\x7f\x7f\x7f", b"\x7f"),
            ),
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden fd_cache_offer import alias", result.stderr)

    def test_rejects_cache_revoke_namespace_alias(self):
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            ),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_offer",
                (b"\x7f\x7e\x7e\x7f\x7f", b"\x7f"),
            ),
            ("wasix_32v1", "fd_cache_revoke", (b"\x7f\x7f\x7f", b"\x7f")),
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden fd_cache_revoke import alias", result.stderr)

    def test_rejects_cache_revoke_wrong_signature(self):
        imports = [
            (
                "oliphaunt_postmaster_v1",
                "fd_sync_range",
                (b"\x7f\x7e\x7e\x7f", b"\x7f"),
            ),
            (
                "oliphaunt_postmaster_v1",
                "fd_cache_offer",
                (b"\x7f\x7e\x7e\x7f\x7f", b"\x7f"),
            ),
            ("oliphaunt_postmaster_v1", "fd_cache_revoke", (b"\x7f", b"\x7f")),
        ]
        result = self.run_verifier(module(imports))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fd_cache_revoke signature is", result.stderr)


if __name__ == "__main__":
    unittest.main()
