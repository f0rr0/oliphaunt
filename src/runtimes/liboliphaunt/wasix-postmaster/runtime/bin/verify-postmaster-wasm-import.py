#!/usr/bin/env python3

"""Fail closed unless a postmaster module has every exact product import."""

from __future__ import annotations

import pathlib
import sys


EXPECTED_MODULE = "oliphaunt_postmaster_v1"
EXPECTED_IMPORTS = {
    "fd_sync_range": (
        (0x7F, 0x7E, 0x7E, 0x7F),  # i32, i64, i64, i32
        (0x7F,),  # i32 errno
    ),
}
VALUE_TYPE_NAMES = {
    0x7F: "i32",
    0x7E: "i64",
    0x7D: "f32",
    0x7C: "f64",
    0x7B: "v128",
    0x70: "funcref",
    0x6F: "externref",
    0x69: "exnref",
}


class DecodeError(ValueError):
    pass


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
                    raise DecodeError(f"out-of-range unsigned LEB in {self.context}")
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


def read_vector(reader: Reader, item) -> tuple:
    return tuple(item(reader) for _ in range(reader.uleb()))


def read_value_type(reader: Reader) -> int:
    value = reader.byte()
    if value not in VALUE_TYPE_NAMES:
        raise DecodeError(f"unsupported value type 0x{value:02x} in {reader.context}")
    return value


def read_types(payload: bytes) -> tuple[tuple[tuple[int, ...], tuple[int, ...]], ...]:
    reader = Reader(payload, "type section")
    types = []
    for _ in range(reader.uleb()):
        if reader.byte() != 0x60:
            raise DecodeError("non-function type in the postmaster core Wasm module")
        params = read_vector(reader, read_value_type)
        results = read_vector(reader, read_value_type)
        types.append((params, results))
    if not reader.eof():
        raise DecodeError("trailing bytes in type section")
    return tuple(types)


def skip_limits(reader: Reader) -> None:
    flags = reader.uleb()
    if flags & ~0x07:
        raise DecodeError(f"unsupported limits flags 0x{flags:x} in import section")
    reader.uleb(64 if flags & 0x04 else 32)
    if flags & 0x01:
        reader.uleb(64 if flags & 0x04 else 32)


def read_imports(payload: bytes) -> tuple[tuple[str, str, int | None], ...]:
    reader = Reader(payload, "import section")
    imports = []
    for _ in range(reader.uleb()):
        module = reader.name()
        name = reader.name()
        kind = reader.byte()
        type_index = None
        if kind == 0:  # function
            type_index = reader.uleb()
        elif kind == 1:  # table
            read_value_type(reader)
            skip_limits(reader)
        elif kind == 2:  # memory
            skip_limits(reader)
        elif kind == 3:  # global
            read_value_type(reader)
            reader.byte()
        elif kind == 4:  # exception tag
            reader.byte()
            reader.uleb()
        else:
            raise DecodeError(f"unknown import kind {kind}")
        imports.append((module, name, type_index))
    if not reader.eof():
        raise DecodeError("trailing bytes in import section")
    return tuple(imports)


def decode_module(data: bytes):
    if data[:8] != b"\x00asm\x01\x00\x00\x00":
        raise DecodeError("not a core WebAssembly version-1 module")
    reader = Reader(data[8:], "module")
    types = ()
    imports = ()
    seen = set()
    while not reader.eof():
        section_id = reader.byte()
        payload = reader.take(reader.uleb())
        if section_id in (1, 2):
            if section_id in seen:
                raise DecodeError(f"duplicate section {section_id}")
            seen.add(section_id)
        if section_id == 1:
            types = read_types(payload)
        elif section_id == 2:
            imports = read_imports(payload)
    return types, imports


def signature_text(signature) -> str:
    params, results = signature
    left = ",".join(VALUE_TYPE_NAMES[value] for value in params)
    right = ",".join(VALUE_TYPE_NAMES[value] for value in results)
    return f"({left})->({right})"


def verify(path: pathlib.Path) -> None:
    types, imports = decode_module(path.read_bytes())
    for expected_name, expected_signature in EXPECTED_IMPORTS.items():
        named = [entry for entry in imports if entry[1] == expected_name]
        exact = [entry for entry in named if entry[0] == EXPECTED_MODULE]
        aliases = [entry for entry in named if entry[0] != EXPECTED_MODULE]
        if aliases:
            rendered = ", ".join(f"{module}.{name}" for module, name, _ in aliases)
            raise DecodeError(f"forbidden {expected_name} import alias(es): {rendered}")
        if len(exact) != 1:
            raise DecodeError(
                f"expected exactly one {EXPECTED_MODULE}.{expected_name} import, "
                f"found {len(exact)}"
            )
        type_index = exact[0][2]
        if type_index is None or type_index >= len(types):
            raise DecodeError(f"{expected_name} import has an invalid function type index")
        signature = types[type_index]
        if signature != expected_signature:
            raise DecodeError(
                f"{expected_name} signature is {signature_text(signature)}, "
                f"expected {signature_text(expected_signature)}"
            )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} POSTGRES_WASM", file=sys.stderr)
        return 2
    path = pathlib.Path(argv[1])
    try:
        verify(path)
    except (DecodeError, OSError) as error:
        print(f"verify-postmaster-wasm-import: {error}", file=sys.stderr)
        return 1
    rendered = ", ".join(
        f"{EXPECTED_MODULE}.{name}{signature_text(signature)}"
        for name, signature in EXPECTED_IMPORTS.items()
    )
    print(f"verified required postmaster imports: {rendered}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
