#!/usr/bin/env python3

"""Verify the final PostgreSQL module's latch synchronization instructions.

The PostgreSQL latch fields are ordinary shared-memory fields ordered by
pg_memory_barrier().  In a Wasm build those barriers are encoded as
``atomic.fence``.  This verifier deliberately inspects the *final* linked and
post-processed module: checking C sources, LLVM objects, or an intermediate
module cannot detect a post-link optimizer that erased the barriers.

For the packed WASIX latch contract, the verifier also streams the final module
through the pinned Binaryen ``wasm-dis`` and checks that the three critical
exported functions contain real WebAssembly atomic loads and read/modify/write
operations.  Text decoding is delegated to Binaryen so instruction bytes in an
immediate cannot be mistaken for an opcode.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterable


EXPECTED_FUNCTION_FENCES = {
    "SetLatch": 2,
    "ResetLatch": 1,
    "WaitEventSetWait": 1,
}
ATOMIC_FENCE_ENCODING = b"\xfe\x03\x00"
PACKED_LATCH_CONTRACT = "packed-atomic-v1"
UPSTREAM_LATCH_CONTRACT = "upstream-sig-atomic-v1"
FINAL_CONTRACT_SCHEMA = "oliphaunt.wasix-postmaster.final-wasm-concurrency.v1"
FINAL_CONTRACT_RECEIPT = "share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt"
FINAL_CONTRACT_KEYS = (
    "schema",
    "postgres_sha256",
    "wasm_dis_sha256",
    "wasm_dis_version",
    "latch_state_contract",
    "atomic_fence_total",
    "atomic_fence_set_latch",
    "atomic_fence_reset_latch",
    "atomic_fence_wait_event_set_wait",
    "i32_atomic_load_total",
    "i32_atomic_load_wait_event_set_wait",
    "i32_atomic_rmw_and_total",
    "i32_atomic_rmw_and_reset_latch",
    "i32_atomic_rmw_and_wait_event_set_wait",
    "i32_atomic_rmw_or_total",
    "i32_atomic_rmw_or_set_latch",
    "i32_atomic_rmw_or_wait_event_set_wait",
)
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")

WAT_OPCODES = (
    "atomic.fence",
    "i32.atomic.load",
    "i32.atomic.rmw.and",
    "i32.atomic.rmw.or",
)
PACKED_FUNCTION_ATOMICS = {
    "SetLatch": {
        "atomic.fence": 2,
        "i32.atomic.rmw.or": 1,
    },
    "ResetLatch": {
        "atomic.fence": 1,
        "i32.atomic.rmw.and": 1,
    },
    "WaitEventSetWait": {
        "atomic.fence": 1,
        "i32.atomic.rmw.and": 2,
        "i32.atomic.rmw.or": 1,
    },
}
PACKED_FUNCTION_ATOMIC_MINIMUMS = {
    "WaitEventSetWait": {
        "i32.atomic.load": 1,
    },
}

EXPORT_RE = re.compile(r'^ \(export "([^"]+)" \(func (\$[^ ()]+)\)\)$')
FUNCTION_RE = re.compile(r"^ \(func (\$[^ ()]+)(?:[ ()]|$)")
OPCODE_RE = re.compile(
    r"^ +\((atomic\.fence|i32\.atomic\.load|i32\.atomic\.rmw\.and|"
    r"i32\.atomic\.rmw\.or)\b"
)


class DecodeError(ValueError):
    pass


def empty_opcode_counts() -> dict[str, int]:
    return {opcode: 0 for opcode in WAT_OPCODES}


def parse_wat_instruction_inventory(
    lines: Iterable[str],
) -> tuple[dict[str, int], dict[str, dict[str, int]]]:
    """Parse the stable, one-expression-per-line format emitted by wasm-dis."""

    target_exports: dict[str, str] = {}
    target_by_identifier: dict[str, str] = {}
    function_counts = {
        name: empty_opcode_counts() for name in EXPECTED_FUNCTION_FENCES
    }
    total_counts = empty_opcode_counts()
    seen_functions: set[str] = set()
    current_target: str | None = None

    for raw_line in lines:
        line = raw_line.rstrip("\n")
        if "\r" in line:
            raise DecodeError("wasm-dis emitted non-canonical CR text")

        export = EXPORT_RE.fullmatch(line)
        if export and export.group(1) in EXPECTED_FUNCTION_FENCES:
            name, identifier = export.groups()
            if name in target_exports:
                raise DecodeError(f"wasm-dis emitted duplicate export {name}")
            if identifier in target_by_identifier:
                raise DecodeError(
                    f"critical exports share one function identifier: {identifier}"
                )
            target_exports[name] = identifier
            target_by_identifier[identifier] = name

        function = FUNCTION_RE.match(line)
        if function:
            identifier = function.group(1)
            current_target = target_by_identifier.get(identifier)
            if current_target is not None:
                if current_target in seen_functions:
                    raise DecodeError(
                        f"wasm-dis emitted duplicate function body for {current_target}"
                    )
                seen_functions.add(current_target)

        for opcode in OPCODE_RE.findall(line):
            total_counts[opcode] += 1
            if current_target is not None:
                function_counts[current_target][opcode] += 1

        # Binaryen prints the function's closing parenthesis at indentation 1;
        # nested expressions are indented further.
        if line == " )":
            current_target = None

    missing_exports = set(EXPECTED_FUNCTION_FENCES) - set(target_exports)
    if missing_exports:
        raise DecodeError(
            "wasm-dis lacks critical exports: " + ", ".join(sorted(missing_exports))
        )
    missing_bodies = set(EXPECTED_FUNCTION_FENCES) - seen_functions
    if missing_bodies:
        raise DecodeError(
            "wasm-dis lacks critical function bodies: "
            + ", ".join(sorted(missing_bodies))
        )
    return total_counts, function_counts


def inspect_with_wasm_dis(
    path: pathlib.Path, wasm_dis: pathlib.Path
) -> tuple[dict[str, int], dict[str, dict[str, int]], str, str]:
    if not wasm_dis.is_file() or not os.access(wasm_dis, os.X_OK):
        raise DecodeError(f"wasm-dis is not an executable regular file: {wasm_dis}")

    wasm_dis_sha256 = hashlib.sha256(wasm_dis.read_bytes()).hexdigest()
    try:
        version_process = subprocess.run(
            [str(wasm_dis), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise DecodeError(f"could not identify wasm-dis: {error}") from error
    version = (version_process.stdout + version_process.stderr).strip()
    if version_process.returncode != 0 or not version or "\n" in version or "\r" in version:
        raise DecodeError("wasm-dis did not provide one canonical version line")

    try:
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as error_file:
            process = subprocess.Popen(
                [str(wasm_dis), str(path)],
                stdout=subprocess.PIPE,
                stderr=error_file,
                text=True,
                encoding="utf-8",
                errors="strict",
            )
            assert process.stdout is not None
            with process.stdout:
                try:
                    total_counts, function_counts = parse_wat_instruction_inventory(
                        process.stdout
                    )
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
            returncode = process.wait()
            if returncode != 0:
                error_file.seek(0)
                detail = error_file.read().strip()
                raise DecodeError(
                    f"wasm-dis failed with status {returncode}: {detail or 'no detail'}"
                )
    except (OSError, UnicodeError, subprocess.SubprocessError) as error:
        raise DecodeError(f"could not disassemble final PostgreSQL module: {error}") from error

    return total_counts, function_counts, wasm_dis_sha256, version


def verify_packed_atomic_contract(
    total_counts: dict[str, int],
    function_counts: dict[str, dict[str, int]],
) -> None:
    for name, expected_counts in PACKED_FUNCTION_ATOMICS.items():
        for opcode, expected in expected_counts.items():
            actual = function_counts[name][opcode]
            if actual != expected:
                raise DecodeError(
                    f"{name} contains {actual} {opcode} instructions, expected {expected}"
                )
    for name, minimum_counts in PACKED_FUNCTION_ATOMIC_MINIMUMS.items():
        for opcode, minimum in minimum_counts.items():
            actual = function_counts[name][opcode]
            if actual < minimum:
                raise DecodeError(
                    f"{name} contains {actual} {opcode} instructions, "
                    f"expected at least {minimum}"
                )


def canonical_receipt(
    postgres_sha256: str,
    binary_fence_total: int,
    total_counts: dict[str, int],
    function_counts: dict[str, dict[str, int]],
    wasm_dis_sha256: str,
    wasm_dis_version: str,
) -> str:
    fields = (
        ("schema", FINAL_CONTRACT_SCHEMA),
        ("postgres_sha256", postgres_sha256),
        ("wasm_dis_sha256", wasm_dis_sha256),
        ("wasm_dis_version", wasm_dis_version),
        ("latch_state_contract", PACKED_LATCH_CONTRACT),
        ("atomic_fence_total", str(binary_fence_total)),
        ("atomic_fence_set_latch", str(function_counts["SetLatch"]["atomic.fence"])),
        ("atomic_fence_reset_latch", str(function_counts["ResetLatch"]["atomic.fence"])),
        (
            "atomic_fence_wait_event_set_wait",
            str(function_counts["WaitEventSetWait"]["atomic.fence"]),
        ),
        ("i32_atomic_load_total", str(total_counts["i32.atomic.load"])),
        (
            "i32_atomic_load_wait_event_set_wait",
            str(function_counts["WaitEventSetWait"]["i32.atomic.load"]),
        ),
        ("i32_atomic_rmw_and_total", str(total_counts["i32.atomic.rmw.and"])),
        (
            "i32_atomic_rmw_and_reset_latch",
            str(function_counts["ResetLatch"]["i32.atomic.rmw.and"]),
        ),
        (
            "i32_atomic_rmw_and_wait_event_set_wait",
            str(function_counts["WaitEventSetWait"]["i32.atomic.rmw.and"]),
        ),
        ("i32_atomic_rmw_or_total", str(total_counts["i32.atomic.rmw.or"])),
        (
            "i32_atomic_rmw_or_set_latch",
            str(function_counts["SetLatch"]["i32.atomic.rmw.or"]),
        ),
        (
            "i32_atomic_rmw_or_wait_event_set_wait",
            str(function_counts["WaitEventSetWait"]["i32.atomic.rmw.or"]),
        ),
    )
    if tuple(key for key, _ in fields) != FINAL_CONTRACT_KEYS:
        raise DecodeError("internal final concurrency receipt field order differs")
    for key, value in fields:
        if not value or "\n" in value or "\r" in value or "=" in key:
            raise DecodeError(f"non-canonical final contract receipt field: {key}")
    return "".join(f"{key}={value}\n" for key, value in fields)


def read_receipt(path: pathlib.Path) -> dict[str, str]:
    contents = path.read_text(encoding="utf-8")
    if not contents.endswith("\n") or "\r" in contents:
        raise DecodeError("final concurrency receipt is not canonical newline text")
    lines = contents.splitlines()
    if len(lines) != len(FINAL_CONTRACT_KEYS):
        raise DecodeError("final concurrency receipt field count differs")
    values: dict[str, str] = {}
    for expected_key, line in zip(FINAL_CONTRACT_KEYS, lines, strict=True):
        if "=" not in line:
            raise DecodeError(
                f"final concurrency receipt field has no separator: {expected_key}"
            )
        key, value = line.split("=", 1)
        if key != expected_key or not value:
            raise DecodeError(
                f"non-canonical final concurrency receipt field: {expected_key}"
            )
        values[key] = value
    return values


def exact_receipt_integer(values: dict[str, str], key: str) -> int:
    value = values[key]
    if not value.isascii() or not value.isdecimal() or (len(value) > 1 and value[0] == "0"):
        raise DecodeError(f"final concurrency receipt {key} is not a canonical integer")
    return int(value)


def verify_receipt(
    receipt_path: pathlib.Path,
    postgres_path: pathlib.Path,
    expected_fence_total: int,
) -> dict[str, str]:
    values = read_receipt(receipt_path)
    if values["schema"] != FINAL_CONTRACT_SCHEMA:
        raise DecodeError("final concurrency receipt schema differs")
    if values["latch_state_contract"] != PACKED_LATCH_CONTRACT:
        raise DecodeError("final concurrency receipt latch-state contract differs")
    for key in ("postgres_sha256", "wasm_dis_sha256"):
        if SHA256_RE.fullmatch(values[key]) is None:
            raise DecodeError(f"final concurrency receipt {key} is not a SHA-256")
    actual_postgres_sha256 = hashlib.sha256(postgres_path.read_bytes()).hexdigest()
    if values["postgres_sha256"] != actual_postgres_sha256:
        raise DecodeError("final concurrency receipt does not identify PostgreSQL module")
    if "\n" in values["wasm_dis_version"] or "\r" in values["wasm_dis_version"]:
        raise DecodeError("final concurrency receipt wasm-dis version is not canonical")

    integers = {
        key: exact_receipt_integer(values, key)
        for key in FINAL_CONTRACT_KEYS
        if key.startswith("atomic_") or key.startswith("i32_atomic_")
    }
    if integers["atomic_fence_total"] != expected_fence_total:
        raise DecodeError("final concurrency receipt fence total differs from contract")
    expected_exact = {
        "atomic_fence_set_latch": 2,
        "atomic_fence_reset_latch": 1,
        "atomic_fence_wait_event_set_wait": 1,
        "i32_atomic_rmw_and_reset_latch": 1,
        "i32_atomic_rmw_and_wait_event_set_wait": 2,
        "i32_atomic_rmw_or_set_latch": 1,
        "i32_atomic_rmw_or_wait_event_set_wait": 1,
    }
    for key, expected in expected_exact.items():
        if integers[key] != expected:
            raise DecodeError(f"final concurrency receipt contract differs: {key}")
    if integers["i32_atomic_load_wait_event_set_wait"] < 1:
        raise DecodeError("final concurrency receipt waiter has no atomic load")
    if (
        integers["i32_atomic_load_total"]
        < integers["i32_atomic_load_wait_event_set_wait"]
    ):
        raise DecodeError("final concurrency receipt atomic load total is inconsistent")
    if integers["i32_atomic_rmw_and_total"] < 3:
        raise DecodeError("final concurrency receipt has too few atomic AND operations")
    if integers["i32_atomic_rmw_or_total"] < 2:
        raise DecodeError("final concurrency receipt has too few atomic OR operations")
    return values


def write_receipt(path: pathlib.Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o444)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


class Reader:
    def __init__(self, data: bytes, context: str) -> None:
        self.data = data
        self.offset = 0
        self.context = context

    def eof(self) -> bool:
        return self.offset == len(self.data)

    def byte(self) -> int:
        if self.offset >= len(self.data):
            raise DecodeError(f"truncated {self.context}")
        value = self.data[self.offset]
        self.offset += 1
        return value

    def uleb(self, bits: int = 32) -> int:
        value = 0
        shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            if byte & 0x80 == 0:
                if value >= 1 << bits:
                    raise DecodeError(
                        f"out-of-range unsigned LEB in {self.context}"
                    )
                return value
            shift += 7
            if shift >= bits + 7:
                raise DecodeError(f"oversized unsigned LEB in {self.context}")

    def take(self, size: int) -> bytes:
        end = self.offset + size
        if end > len(self.data):
            raise DecodeError(f"truncated {self.context}")
        value = self.data[self.offset:end]
        self.offset = end
        return value

    def name(self) -> str:
        raw = self.take(self.uleb())
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise DecodeError(f"invalid UTF-8 name in {self.context}") from error


def skip_limits(reader: Reader) -> bool:
    flags = reader.uleb()
    if flags & ~0x07:
        raise DecodeError(f"unsupported limits flags 0x{flags:x} in {reader.context}")
    reader.uleb(64 if flags & 0x04 else 32)
    if flags & 0x01:
        reader.uleb(64 if flags & 0x04 else 32)
    return bool(flags & 0x02)


def read_sections(data: bytes) -> dict[int, bytes]:
    if data[:8] != b"\x00asm\x01\x00\x00\x00":
        raise DecodeError("not a core WebAssembly version-1 module")

    reader = Reader(data[8:], "module")
    sections: dict[int, bytes] = {}
    while not reader.eof():
        section_id = reader.byte()
        payload = reader.take(reader.uleb())
        if section_id != 0:
            if section_id in sections:
                raise DecodeError(f"duplicate section {section_id}")
            sections[section_id] = payload
    return sections


def read_imported_function_count(payload: bytes) -> tuple[int, bool]:
    reader = Reader(payload, "import section")
    function_count = 0
    shared_memories = []
    for _ in range(reader.uleb()):
        module = reader.name()
        name = reader.name()
        kind = reader.byte()
        if kind == 0:  # function
            reader.uleb()
            function_count += 1
        elif kind == 1:  # table
            reader.byte()
            skip_limits(reader)
        elif kind == 2:  # memory
            shared_memories.append((module, name, skip_limits(reader)))
        elif kind == 3:  # global
            reader.byte()
            reader.byte()
        elif kind == 4:  # exception tag
            reader.byte()
            reader.uleb()
        else:
            raise DecodeError(f"unknown import kind {kind}")
    if not reader.eof():
        raise DecodeError("trailing bytes in import section")

    exact_memories = [
        shared for module, name, shared in shared_memories
        if module == "env" and name == "memory"
    ]
    if len(exact_memories) != 1:
        raise DecodeError(
            f"expected exactly one env.memory import, found {len(exact_memories)}"
        )
    return function_count, exact_memories[0]


def read_defined_function_count(payload: bytes) -> int:
    reader = Reader(payload, "function section")
    count = reader.uleb()
    for _ in range(count):
        reader.uleb()
    if not reader.eof():
        raise DecodeError("trailing bytes in function section")
    return count


def read_function_exports(payload: bytes) -> dict[str, int]:
    reader = Reader(payload, "export section")
    exports = {}
    for _ in range(reader.uleb()):
        name = reader.name()
        kind = reader.byte()
        index = reader.uleb()
        if kind == 0:
            if name in exports:
                raise DecodeError(f"duplicate function export {name}")
            exports[name] = index
    if not reader.eof():
        raise DecodeError("trailing bytes in export section")
    return exports


def read_code_bodies(payload: bytes) -> tuple[bytes, ...]:
    reader = Reader(payload, "code section")
    bodies = tuple(reader.take(reader.uleb()) for _ in range(reader.uleb()))
    if not reader.eof():
        raise DecodeError("trailing bytes in code section")
    return bodies


def verify_module_structure(
    path: pathlib.Path,
) -> tuple[int, dict[str, int], tuple[bytes, ...]]:
    sections = read_sections(path.read_bytes())
    for section_id, name in ((2, "import"), (3, "function"), (7, "export"), (10, "code")):
        if section_id not in sections:
            raise DecodeError(f"missing {name} section")

    imported_functions, memory_is_shared = read_imported_function_count(sections[2])
    if not memory_is_shared:
        raise DecodeError("env.memory is not declared shared")

    defined_functions = read_defined_function_count(sections[3])
    exports = read_function_exports(sections[7])
    bodies = read_code_bodies(sections[10])
    if len(bodies) != defined_functions:
        raise DecodeError(
            f"function/code count mismatch: {defined_functions} definitions, "
            f"{len(bodies)} bodies"
        )

    for name in EXPECTED_FUNCTION_FENCES:
        if name not in exports:
            raise DecodeError(f"missing required function export {name}")
        defined_index = exports[name] - imported_functions
        if defined_index < 0 or defined_index >= len(bodies):
            raise DecodeError(f"{name} does not refer to a defined function")
    return imported_functions, exports, bodies


def verify(
    path: pathlib.Path, *, expected_total: int | None = None
) -> tuple[int, dict[str, int]]:
    imported_functions, exports, bodies = verify_module_structure(path)

    function_counts = {}
    for name, expected in EXPECTED_FUNCTION_FENCES.items():
        defined_index = exports[name] - imported_functions
        actual = bodies[defined_index].count(ATOMIC_FENCE_ENCODING)
        function_counts[name] = actual
        if actual != expected:
            raise DecodeError(
                f"{name} contains {actual} atomic.fence instructions, expected {expected}"
            )

    total = sum(body.count(ATOMIC_FENCE_ENCODING) for body in bodies)
    if expected_total is not None and total != expected_total:
        raise DecodeError(
            f"module contains {total} atomic.fence instructions, "
            f"expected {expected_total}"
        )
    if total < sum(EXPECTED_FUNCTION_FENCES.values()):
        raise DecodeError(f"module contains implausibly few atomic.fence instructions: {total}")
    return total, function_counts


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-total", type=int)
    parser.add_argument(
        "--latch-state-contract",
        choices=(UPSTREAM_LATCH_CONTRACT, PACKED_LATCH_CONTRACT),
        default=UPSTREAM_LATCH_CONTRACT,
    )
    parser.add_argument(
        "--wasm-dis",
        type=pathlib.Path,
        help="exact Binaryen wasm-dis executable used to validate atomic opcodes",
    )
    parser.add_argument(
        "--receipt",
        type=pathlib.Path,
        help="write a sealed final-module instruction receipt",
    )
    parser.add_argument(
        "--verified-receipt",
        type=pathlib.Path,
        help="validate a build-time instruction receipt against the final module",
    )
    parser.add_argument(
        "--receipt-only",
        action="store_true",
        help="validate a sealed receipt and module identity without decoding Wasm",
    )
    parser.add_argument("postgres_wasm", type=pathlib.Path)
    options = parser.parse_args(argv[1:])
    if options.expected_total is not None and options.expected_total < 4:
        parser.error("--expected-total must be at least 4")
    if (
        options.latch_state_contract == PACKED_LATCH_CONTRACT
        and options.wasm_dis is None
        and options.verified_receipt is None
    ):
        parser.error("the packed latch contract requires --wasm-dis or --verified-receipt")
    if options.receipt is not None and options.latch_state_contract != PACKED_LATCH_CONTRACT:
        parser.error("--receipt requires the packed latch contract")
    if options.receipt is not None and options.wasm_dis is None:
        parser.error("--receipt requires --wasm-dis")
    if options.receipt is not None and options.verified_receipt is not None:
        parser.error("--receipt and --verified-receipt are mutually exclusive")
    if options.receipt_only and (
        options.verified_receipt is None
        or options.expected_total is None
        or options.latch_state_contract != PACKED_LATCH_CONTRACT
    ):
        parser.error(
            "--receipt-only requires --verified-receipt, --expected-total, and "
            "the packed latch contract"
        )
    if options.receipt_only and (options.wasm_dis is not None or options.receipt is not None):
        parser.error("--receipt-only cannot disassemble or create a receipt")
    try:
        atomic_summary = ""
        if options.receipt_only:
            assert options.expected_total is not None
            total = options.expected_total
            receipt_values = verify_receipt(
                options.verified_receipt,
                options.postgres_wasm,
                total,
            )
            counts = {
                "SetLatch": int(receipt_values["atomic_fence_set_latch"]),
                "ResetLatch": int(receipt_values["atomic_fence_reset_latch"]),
                "WaitEventSetWait": int(
                    receipt_values["atomic_fence_wait_event_set_wait"]
                ),
            }
            atomic_summary = (
                " atomics="
                f"SetLatch:or={receipt_values['i32_atomic_rmw_or_set_latch']} "
                f"ResetLatch:and={receipt_values['i32_atomic_rmw_and_reset_latch']} "
                "WaitEventSetWait:"
                f"load={receipt_values['i32_atomic_load_wait_event_set_wait']},"
                f"and={receipt_values['i32_atomic_rmw_and_wait_event_set_wait']},"
                f"or={receipt_values['i32_atomic_rmw_or_wait_event_set_wait']}"
            )
        elif options.wasm_dis is not None:
            verify_module_structure(options.postgres_wasm)
            (
                total_opcodes,
                function_opcodes,
                wasm_dis_sha256,
                wasm_dis_version,
            ) = inspect_with_wasm_dis(options.postgres_wasm, options.wasm_dis)
            total = total_opcodes["atomic.fence"]
            counts = {
                name: function_opcodes[name]["atomic.fence"]
                for name in EXPECTED_FUNCTION_FENCES
            }
            if options.expected_total is not None and total != options.expected_total:
                raise DecodeError(
                    f"module contains {total} atomic.fence instructions, "
                    f"expected {options.expected_total}"
                )
            if options.latch_state_contract == PACKED_LATCH_CONTRACT:
                verify_packed_atomic_contract(total_opcodes, function_opcodes)
                atomic_summary = (
                    " atomics="
                    f"SetLatch:or={function_opcodes['SetLatch']['i32.atomic.rmw.or']} "
                    f"ResetLatch:and={function_opcodes['ResetLatch']['i32.atomic.rmw.and']} "
                    "WaitEventSetWait:"
                    f"load={function_opcodes['WaitEventSetWait']['i32.atomic.load']},"
                    f"and={function_opcodes['WaitEventSetWait']['i32.atomic.rmw.and']},"
                    f"or={function_opcodes['WaitEventSetWait']['i32.atomic.rmw.or']}"
                )
                if options.receipt is not None:
                    postgres_sha256 = hashlib.sha256(
                        options.postgres_wasm.read_bytes()
                    ).hexdigest()
                    receipt = canonical_receipt(
                        postgres_sha256,
                        total,
                        total_opcodes,
                        function_opcodes,
                        wasm_dis_sha256,
                        wasm_dis_version,
                    )
                    write_receipt(options.receipt, receipt)
        elif options.verified_receipt is not None:
            verify_module_structure(options.postgres_wasm)
            receipt_values = read_receipt(options.verified_receipt)
            receipt_total = exact_receipt_integer(
                receipt_values, "atomic_fence_total"
            )
            total = options.expected_total or receipt_total
            receipt_values = verify_receipt(
                options.verified_receipt,
                options.postgres_wasm,
                total,
            )
            counts = {
                name: int(receipt_values[f"atomic_fence_{key}"])
                for name, key in (
                    ("SetLatch", "set_latch"),
                    ("ResetLatch", "reset_latch"),
                    ("WaitEventSetWait", "wait_event_set_wait"),
                )
            }
            atomic_summary = (
                " atomics="
                f"SetLatch:or={receipt_values['i32_atomic_rmw_or_set_latch']} "
                f"ResetLatch:and={receipt_values['i32_atomic_rmw_and_reset_latch']} "
                "WaitEventSetWait:"
                f"load={receipt_values['i32_atomic_load_wait_event_set_wait']},"
                f"and={receipt_values['i32_atomic_rmw_and_wait_event_set_wait']},"
                f"or={receipt_values['i32_atomic_rmw_or_wait_event_set_wait']}"
            )
        else:
            total, counts = verify(
                options.postgres_wasm, expected_total=options.expected_total
            )
    except (DecodeError, OSError, UnicodeError) as error:
        print(f"verify-postmaster-concurrency-contract: {error}", file=sys.stderr)
        return 1
    rendered = " ".join(f"{name}={counts[name]}" for name in EXPECTED_FUNCTION_FENCES)
    print(
        f"verified PostgreSQL Wasm concurrency contract: total={total} "
        f"{rendered}{atomic_summary}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
