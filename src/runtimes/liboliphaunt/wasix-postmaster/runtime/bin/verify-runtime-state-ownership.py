#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections import Counter
import os
from pathlib import Path
import re
import stat
import sys


SOURCE_ROOT = Path("lib/wasix/src")
REQUIRED_FILES = (
    Path("state/mod.rs"),
    Path("state/env.rs"),
    Path("state/builder.rs"),
    Path("os/command/builtins/cmd_wasmer.rs"),
    Path("syscalls/wasix/proc_spawn.rs"),
)
EXPECTED_FORK_WITH_CALLS = Counter(
    {
        Path("state/env.rs"): 1,
        Path("os/command/builtins/cmd_wasmer.rs"): 1,
        Path("syscalls/wasix/proc_spawn.rs"): 1,
    }
)
EXPECTED_RAW_FORK_CALLS = Counter(
    {
        (Path("state/mod.rs"), "self"): 1,
        (Path("state/mod.rs"), "self.fs"): 1,
    }
)
EXPECTED_STATE_LITERALS = Counter(
    {
        Path("state/mod.rs"): 1,
        Path("state/env.rs"): 1,
        Path("state/builder.rs"): 1,
    }
)
_MAX_SOURCE_BYTES = 16 * 1024 * 1024
_SOURCE_READ_CHUNK_BYTES = 1024 * 1024


class VerificationError(ValueError):
    pass


def _source_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def read_regular(path: Path) -> str:
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise VerificationError(f"runtime ownership source is not a regular file: {path}")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise VerificationError(
            f"runtime ownership source could not be opened safely: {path}: {error}"
        ) from error

    try:
        opened = os.fstat(descriptor)
        current_after_open = os.lstat(path)
        if not stat.S_ISREG(opened.st_mode):
            raise VerificationError(f"runtime ownership source is not a regular file: {path}")
        opened_identity = _source_identity(opened)
        if (
            _source_identity(before) != opened_identity
            or _source_identity(current_after_open) != opened_identity
        ):
            raise VerificationError(
                f"runtime ownership source changed before it was opened: {path}"
            )
        if opened.st_size > _MAX_SOURCE_BYTES:
            raise VerificationError(
                "runtime ownership source exceeds the "
                f"{_MAX_SOURCE_BYTES}-byte limit: {path}"
            )

        remaining = opened.st_size
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(descriptor, min(remaining, _SOURCE_READ_CHUNK_BYTES))
            if not chunk:
                raise VerificationError(
                    f"runtime ownership source changed while it was read: {path}"
                )
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise VerificationError(
                f"runtime ownership source changed while it was read: {path}"
            )
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)

    if _source_identity(after) != opened_identity:
        raise VerificationError(f"runtime ownership source changed while it was read: {path}")
    current = os.lstat(path)
    if _source_identity(current) != _source_identity(after):
        raise VerificationError(f"runtime ownership source path changed while it was read: {path}")
    try:
        return b"".join(chunks).decode(encoding="utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise VerificationError(
            f"runtime ownership source is not valid UTF-8: {path}: {error}"
        ) from error


def mask_rust_non_code(source: str) -> str:
    """Replace comments and literals with spaces while preserving newlines."""

    masked = list(source)
    length = len(source)
    index = 0
    block_depth = 0
    state = "code"
    raw_hashes = 0

    def blank(position: int) -> None:
        if masked[position] != "\n":
            masked[position] = " "

    while index < length:
        if state == "code":
            if source.startswith("//", index):
                blank(index)
                if index + 1 < length:
                    blank(index + 1)
                index += 2
                state = "line-comment"
                continue
            if source.startswith("/*", index):
                blank(index)
                if index + 1 < length:
                    blank(index + 1)
                index += 2
                block_depth = 1
                state = "block-comment"
                continue
            if source[index] == '"':
                blank(index)
                index += 1
                state = "string"
                continue
            if source[index] == "'":
                # Lifetimes are identifiers, not character literals.
                if (
                    index + 1 < length
                    and (source[index + 1].isalpha() or source[index + 1] == "_")
                    and not (index + 2 < length and source[index + 2] == "'")
                ):
                    index += 1
                    continue
                blank(index)
                index += 1
                state = "char"
                continue
            if source[index] == "r":
                cursor = index + 1
                while cursor < length and source[cursor] == "#":
                    cursor += 1
                if cursor < length and source[cursor] == '"':
                    raw_hashes = cursor - index - 1
                    for position in range(index, cursor + 1):
                        blank(position)
                    index = cursor + 1
                    state = "raw-string"
                    continue
            index += 1
            continue

        if state == "line-comment":
            blank(index)
            if source[index] == "\n":
                state = "code"
            index += 1
            continue

        if state == "block-comment":
            if source.startswith("/*", index):
                blank(index)
                if index + 1 < length:
                    blank(index + 1)
                block_depth += 1
                index += 2
                continue
            if source.startswith("*/", index):
                blank(index)
                if index + 1 < length:
                    blank(index + 1)
                block_depth -= 1
                index += 2
                if block_depth == 0:
                    state = "code"
                continue
            blank(index)
            index += 1
            continue

        if state in ("string", "char"):
            quote = '"' if state == "string" else "'"
            if source[index] == "\\":
                blank(index)
                if index + 1 < length:
                    blank(index + 1)
                index += 2
                continue
            blank(index)
            if source[index] == quote:
                state = "code"
            index += 1
            continue

        if state == "raw-string":
            terminator = '"' + ("#" * raw_hashes)
            if source.startswith(terminator, index):
                for position in range(index, index + len(terminator)):
                    blank(position)
                index += len(terminator)
                state = "code"
                continue
            blank(index)
            index += 1
            continue

    if state in ("block-comment", "string", "char", "raw-string"):
        raise VerificationError(f"unterminated Rust {state}")
    return "".join(masked)


TEST_MODULE = re.compile(
    r"(?m)^\s*#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*\n\s*mod\s+tests\s*\{"
)


def production_code(source: str) -> str:
    masked = mask_rust_non_code(source)
    production = list(masked)
    cursor = 0
    while match := TEST_MODULE.search(masked, cursor):
        opening = masked.find("{", match.start(), match.end())
        depth = 0
        closing = -1
        for index in range(opening, len(masked)):
            if masked[index] == "{":
                depth += 1
            elif masked[index] == "}":
                depth -= 1
                if depth == 0:
                    closing = index
                    break
        if closing < 0:
            raise VerificationError("unterminated #[cfg(test)] mod tests block")
        for index in range(match.start(), closing + 1):
            if production[index] != "\n":
                production[index] = " "
        cursor = closing + 1
    return "".join(production)


def extract_function(code: str, signature: re.Pattern[str], description: str) -> str:
    matches = list(signature.finditer(code))
    if len(matches) != 1:
        raise VerificationError(f"expected exactly one {description}; found {len(matches)}")
    opening = code.find("{", matches[0].start(), matches[0].end() + 1)
    if opening < 0:
        raise VerificationError(f"{description} has no body")
    depth = 0
    for index in range(opening, len(code)):
        if code[index] == "{":
            depth += 1
        elif code[index] == "}":
            depth -= 1
            if depth == 0:
                return code[opening + 1 : index]
    raise VerificationError(f"{description} body is unterminated")


def require_ordered(body: str, fragments: tuple[str, ...], description: str) -> None:
    cursor = 0
    compact = re.sub(r"\s+", " ", body)
    for fragment in fragments:
        position = compact.find(fragment, cursor)
        if position < 0:
            raise VerificationError(f"{description} is missing ordered boundary `{fragment}`")
        cursor = position + len(fragment)


def state_literal_count(code: str) -> int:
    count = 0
    for match in re.finditer(r"\bWasiState\s*\{", code):
        prefix = code[: match.start()].rstrip()
        previous = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", prefix)
        if previous is not None and previous.group(1) in ("struct", "impl"):
            continue
        if prefix.endswith("&"):
            # A function returning `&WasiState` is followed by its body brace;
            # it is a type use, not a struct literal.
            continue
        count += 1
    return count


def verify(wasmer_root: Path) -> None:
    root_metadata = os.lstat(wasmer_root)
    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        raise VerificationError(f"Wasmer root is not a non-symlink directory: {wasmer_root}")
    source_root = wasmer_root / SOURCE_ROOT
    if not source_root.is_dir() or source_root.is_symlink():
        raise VerificationError(f"missing non-symlink Wasmer WASIX source root: {source_root}")

    for relative in REQUIRED_FILES:
        read_regular(source_root / relative)

    sources: dict[Path, str] = {}
    for path in sorted(source_root.rglob("*.rs")):
        relative = path.relative_to(source_root)
        sources[relative] = production_code(read_regular(path))

    state = sources[Path("state/mod.rs")]
    if len(re.findall(r"\bpub\s*\(\s*crate\s*\)\s+struct\s+WasiState\b", state)) != 1:
        raise VerificationError("WasiState must remain an exactly-once crate-private type")
    retired_registry = re.compile(
        r"\b(?:runtime_state_registration|register_runtime_state|runtime_states|WasiRuntimeStateRegistration)\b"
    )
    retired_locations = [
        str(relative) for relative, code in sources.items() if retired_registry.search(code)
    ]
    if retired_locations:
        raise VerificationError(
            "retired runtime-state diagnostic registry remains in: "
            + ", ".join(retired_locations)
        )
    if re.search(r"\bpub(?:\s*\([^)]*\))?\s+(?:unsafe\s+)?fn\s+fork\s*\(", state):
        raise VerificationError("raw WasiState fork must remain private")

    raw_fork = extract_function(
        state,
        re.compile(
            r"(?m)^\s*fn\s+fork\s*\(\s*&self\s*\)\s*->\s*Result\s*<\s*Self\s*,\s*Errno\s*>\s*\{"
        ),
        "private raw WasiState fork",
    )
    require_ordered(
        raw_fork,
        ("Ok(WasiState {", "fs: self.fs.fork(),"),
        "private raw WasiState fork",
    )

    owned_fork = extract_function(
        state,
        re.compile(
            r"(?ms)^\s*pub\s*\(\s*crate\s*\)\s+fn\s+fork_with\s*\([^{}]*?\)\s*->\s*Result\s*<\s*Arc\s*<\s*Self\s*>\s*,\s*Errno\s*>\s*\{"
        ),
        "owned WasiState fork",
    )
    require_ordered(
        owned_fork,
        (
            "let mut state = self.fork()?;",
            "prepare(&mut state);",
            "Ok(Arc::new(state))",
        ),
        "owned WasiState fork",
    )
    owned_fork_definitions = sum(
        len(re.findall(r"\bfn\s+fork_with\s*\(", code)) for code in sources.values()
    )
    if owned_fork_definitions != 1:
        raise VerificationError(
            "WasiState must expose exactly one owned fork boundary; "
            f"found {owned_fork_definitions}"
        )

    env = sources[Path("state/env.rs")]
    guarded_fork = extract_function(
        env,
        re.compile(
            r"(?ms)^\s*pub\s*\(\s*crate\s*\)\s+fn\s+fork_guarded\s*\(\s*&self\s*,?\s*\)\s*->\s*Result\s*<\s*\(\s*Self\s*,\s*WasiThreadHandle\s*,\s*WasiProcessRegistrationGuard\s*\)\s*,\s*ControlPlaneError\s*>\s*\{"
        ),
        "guarded WasiEnv fork",
    )
    if not re.search(
        r"\bself\s*\.\s*state\s*\.\s*fork_with\s*"
        r"\(\s*\|_\|\s*\{\s*\}\s*\)",
        guarded_fork,
    ):
        raise VerificationError(
            "guarded WasiEnv fork must directly cross the owned state boundary"
        )

    unfreeze = extract_function(
        state,
        re.compile(
            r"(?ms)^\s*pub\s+fn\s+unfreeze\s*\(\s*bytes\s*:\s*&\[u8\]\s*,?\s*\)\s*->\s*Option\s*<\s*Self\s*>\s*\{"
        ),
        "WasiState unfreeze",
    )
    if len(re.findall(r"\bfn\s+unfreeze\s*\(", state)) != 1:
        raise VerificationError("WasiState must expose exactly one unfreeze boundary")
    if "bincode::deserialize(bytes).ok()" not in re.sub(r"\s+", " ", unfreeze):
        raise VerificationError("WasiState unfreeze must deserialize one owned value")

    owned_fork_calls: Counter[Path] = Counter()
    raw_calls: Counter[tuple[Path, str]] = Counter()
    literals: Counter[Path] = Counter()
    for relative, code in sources.items():
        owned_fork_calls[relative] += len(re.findall(r"\.fork_with\s*\(", code))
        for match in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_.]*)\s*\.fork\s*\(\s*\)", code):
            raw_calls[(relative, match.group(1))] += 1
        count = state_literal_count(code)
        if count:
            literals[relative] = count

    owned_fork_calls += Counter()
    raw_calls += Counter()
    literals += Counter()
    if owned_fork_calls != EXPECTED_FORK_WITH_CALLS:
        raise VerificationError(
            f"owned WasiState fork call-site inventory changed: {dict(owned_fork_calls)}"
        )
    if raw_calls != EXPECTED_RAW_FORK_CALLS:
        raise VerificationError(f"raw production fork inventory changed: {dict(raw_calls)}")
    if literals != EXPECTED_STATE_LITERALS:
        raise VerificationError(f"WasiState literal inventory changed: {dict(literals)}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify every production WasiState ownership boundary"
    )
    parser.add_argument("--wasmer-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        verify(args.wasmer_root)
    except (OSError, UnicodeError, VerificationError) as error:
        print(f"runtime-state ownership verification failed: {error}", file=sys.stderr)
        return 1
    print("verified WASIX process-local runtime-state ownership boundaries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
