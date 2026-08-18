#!/usr/bin/env python3

"""Crash-recoverable publication for the installed WASIX memory ABI seal.

The transaction keeps durable copies of every predecessor before replacing a
live module.  The aggregate receipt is linked into place only after every
module replacement and containing directory have reached stable storage.  A
restart either recognizes that receipt as a complete commit or restores every
predecessor from the still-durable copies.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
from typing import Any


SCHEMA = "oliphaunt.wasix-postmaster.linear-memory-transaction.v1"
AGGREGATE_SCHEMA = "oliphaunt.wasix-postmaster.linear-memory-install.v1"
AGGREGATE_RELATIVE = (
    "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
)
STATE_NAME = "transaction.json"
SHA256_LENGTH = 64


class TransactionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise TransactionError(message)


def digest_path(path: Path) -> str:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode), f"transaction input is not regular: {path}")
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
        after = os.fstat(descriptor)
        require(
            (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            == (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ),
            f"transaction input changed while hashing: {path}",
        )
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def safe_relative(value: Any) -> str:
    require(isinstance(value, str) and value, "transaction module path is empty")
    pure = PurePosixPath(value)
    require(
        not pure.is_absolute()
        and all(part not in ("", ".", "..") for part in pure.parts)
        and not any(character in value for character in ("\0", "\n", "\r", "\t")),
        f"unsafe transaction module path: {value!r}",
    )
    return value


def resolve(root: Path, relative: str) -> Path:
    return root.joinpath(*PurePosixPath(safe_relative(relative)).parts)


def fsync_file(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), f"not a regular file: {path}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_tree(root: Path) -> None:
    directories: list[Path] = []
    for current, names, files in os.walk(root, topdown=True, followlinks=False):
        names.sort()
        files.sort()
        current_path = Path(current)
        directories.append(current_path)
        for name in files:
            path = current_path / name
            info = os.lstat(path)
            require(stat.S_ISREG(info.st_mode), f"transaction stage contains a special file: {path}")
            fsync_file(path)
    for directory in reversed(directories):
        fsync_directory(directory)


def exact_json(path: Path, label: str) -> dict[str, Any]:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode), f"{label} is not regular")
        require(info.st_size <= 16 * 1024 * 1024, f"{label} is unexpectedly large")
        data = bytearray()
        while len(data) <= info.st_size:
            chunk = os.read(descriptor, min(1024 * 1024, info.st_size + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        require(len(data) == info.st_size, f"{label} changed while reading")
        after = os.fstat(descriptor)
        require(
            (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            == (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ),
            f"{label} changed while reading",
        )
    finally:
        os.close(descriptor)
    try:
        value = json.loads(bytes(data), object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TransactionError(f"invalid {label}: {error}") from error
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        require(key not in value, f"duplicate transaction JSON field: {key}")
        value[key] = item
    return value


def atomic_json(path: Path, value: dict[str, Any], *, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.tmp.", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            os.link(temporary, path, follow_symlinks=False)
            temporary.unlink()
        else:
            os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def remove_stage(stage: Path, install: Path) -> None:
    if stage.exists():
        require(stage.is_dir() and not stage.is_symlink(), "transaction stage is not a directory")
        shutil.rmtree(stage)
        fsync_directory(install)


def state_path(stage: Path) -> Path:
    return stage / STATE_NAME


def initial_state() -> dict[str, Any]:
    return {"phase": "staging", "schema": SCHEMA}


def load_state(stage: Path) -> dict[str, Any] | None:
    path = state_path(stage)
    if not path.exists():
        return None
    state = exact_json(path, "linear-memory transaction state")
    require(state.get("schema") == SCHEMA, "linear-memory transaction schema differs")
    return state


def parse_aggregate(path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    aggregate = exact_json(path, "linear-memory aggregate receipt")
    require(aggregate.get("schema") == AGGREGATE_SCHEMA, "linear-memory aggregate schema differs")
    modules = aggregate.get("modules")
    require(isinstance(modules, list) and modules, "linear-memory aggregate has no modules")
    records: list[dict[str, str]] = []
    seen: set[str] = set()
    for module in modules:
        require(isinstance(module, dict), "linear-memory aggregate module is not an object")
        relative = safe_relative(module.get("path"))
        source = module.get("source-module-sha256")
        sealed = module.get("module-sha256")
        require(
            isinstance(source, str)
            and len(source) == SHA256_LENGTH
            and all(character in "0123456789abcdef" for character in source)
            and isinstance(sealed, str)
            and len(sealed) == SHA256_LENGTH
            and all(character in "0123456789abcdef" for character in sealed),
            f"linear-memory aggregate module digest differs: {relative}",
        )
        require(relative not in seen, f"duplicate linear-memory aggregate path: {relative}")
        seen.add(relative)
        records.append({"path": relative, "sealed-sha256": sealed, "source-sha256": source})
    require(
        [record["path"] for record in records]
        == sorted(record["path"] for record in records),
        "linear-memory aggregate modules are not sorted",
    )
    require(aggregate.get("module-count") == len(records), "linear-memory aggregate count differs")
    return aggregate, records


def validate_prepared_state(state: dict[str, Any]) -> tuple[str, str, list[dict[str, str]]]:
    require(
        set(state) == {"aggregate-path", "aggregate-sha256", "modules", "phase", "schema"},
        "prepared linear-memory transaction fields differ",
    )
    require(state["phase"] == "prepared", "linear-memory transaction is not prepared")
    aggregate_relative = safe_relative(state["aggregate-path"])
    require(aggregate_relative == AGGREGATE_RELATIVE, "transaction aggregate path differs")
    aggregate_sha = state["aggregate-sha256"]
    require(
        isinstance(aggregate_sha, str)
        and len(aggregate_sha) == SHA256_LENGTH
        and all(character in "0123456789abcdef" for character in aggregate_sha),
        "transaction aggregate digest differs",
    )
    modules = state["modules"]
    require(isinstance(modules, list) and modules, "prepared transaction has no modules")
    expected_keys = {"path", "sealed-sha256", "source-sha256"}
    for module in modules:
        require(isinstance(module, dict) and set(module) == expected_keys, "transaction module fields differ")
        safe_relative(module["path"])
    require(
        [module["path"] for module in modules] == sorted(module["path"] for module in modules),
        "transaction modules are not sorted",
    )
    return aggregate_relative, aggregate_sha, modules


def copy_durable(source: Path, destination: Path) -> None:
    info = os.lstat(source)
    require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode), f"source is not regular: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.copy.", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with source.open("rb", buffering=0) as input_stream, os.fdopen(
            descriptor, "wb", buffering=0
        ) as output_stream:
            shutil.copyfileobj(input_stream, output_stream, 1024 * 1024)
            os.fchmod(output_stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fsync(output_stream.fileno())
        os.utime(temporary, ns=(info.st_atime_ns, info.st_mtime_ns), follow_symlinks=False)
        os.replace(temporary, destination)
        fsync_directory(destination.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def init_transaction(install: Path, stage: Path) -> None:
    require(not stage.exists() and not stage.is_symlink(), f"transaction stage already exists: {stage}")
    stage.mkdir(mode=0o700)
    (stage / "modules").mkdir()
    (stage / "receipts").mkdir()
    atomic_json(state_path(stage), initial_state(), exclusive=True)
    fsync_tree(stage)
    fsync_directory(install)


def prepare_transaction(install: Path, stage: Path, aggregate_path: Path) -> None:
    state = load_state(stage)
    require(state == initial_state(), "transaction stage is not in its initial state")
    _, records = parse_aggregate(aggregate_path)
    originals = stage / "originals"
    originals.mkdir()
    for record in records:
        relative = record["path"]
        live = resolve(install, relative)
        staged = resolve(stage / "modules", relative)
        require(digest_path(live) == record["source-sha256"], f"live predecessor differs: {relative}")
        require(digest_path(staged) == record["sealed-sha256"], f"staged sealed module differs: {relative}")
        backup = resolve(originals, relative)
        copy_durable(live, backup)
        require(digest_path(backup) == record["source-sha256"], f"durable backup differs: {relative}")
    fsync_tree(stage)
    prepared = {
        "aggregate-path": AGGREGATE_RELATIVE,
        "aggregate-sha256": digest_path(aggregate_path),
        "modules": records,
        "phase": "prepared",
        "schema": SCHEMA,
    }
    atomic_json(state_path(stage), prepared)
    fsync_tree(stage)
    fsync_directory(install)


def committed(install: Path, aggregate_relative: str, aggregate_sha: str, modules: list[dict[str, str]]) -> bool:
    destination = resolve(install, aggregate_relative)
    try:
        if digest_path(destination) != aggregate_sha:
            return False
        return all(
            digest_path(resolve(install, module["path"])) == module["sealed-sha256"]
            for module in modules
        )
    except (FileNotFoundError, OSError, TransactionError):
        return False


def restore_prepared(install: Path, stage: Path, state: dict[str, Any]) -> str:
    aggregate_relative, aggregate_sha, modules = validate_prepared_state(state)
    if committed(install, aggregate_relative, aggregate_sha, modules):
        remove_stage(stage, install)
        return "committed"
    destination = resolve(install, aggregate_relative)
    if destination.exists() or destination.is_symlink():
        info = os.lstat(destination)
        require(stat.S_ISREG(info.st_mode), "incomplete transaction aggregate is not regular")
        destination.unlink()
        fsync_directory(destination.parent)
    for module in modules:
        relative = module["path"]
        backup = resolve(stage / "originals", relative)
        require(digest_path(backup) == module["source-sha256"], f"transaction backup differs: {relative}")
        live = resolve(install, relative)
        if digest_path(live) != module["source-sha256"]:
            copy_durable(backup, live)
    for module in modules:
        require(
            digest_path(resolve(install, module["path"])) == module["source-sha256"],
            f"transaction rollback verification failed: {module['path']}",
        )
    remove_stage(stage, install)
    return "rolled-back"


def recover_transaction(install: Path, stage: Path) -> str:
    if not stage.exists() and not stage.is_symlink():
        return "none"
    require(stage.is_dir() and not stage.is_symlink(), "linear-memory transaction stage is unsafe")
    state = load_state(stage)
    if state is None or state == initial_state():
        # The protocol performs no live mutation until the prepared state is
        # durable, so an interrupted construction stage is safe to discard.
        remove_stage(stage, install)
        return "discarded-staging"
    return restore_prepared(install, stage, state)


def publish_transaction(install: Path, stage: Path) -> None:
    state = load_state(stage)
    require(state is not None, "linear-memory transaction state is missing")
    aggregate_relative, aggregate_sha, modules = validate_prepared_state(state)
    aggregate_source = stage / "wasix-postmaster.linear-memory-profile.receipt.json"
    require(digest_path(aggregate_source) == aggregate_sha, "staged aggregate receipt differs")
    aggregate_destination = resolve(install, aggregate_relative)
    require(
        not aggregate_destination.exists() and not aggregate_destination.is_symlink(),
        f"aggregate receipt destination already exists: {aggregate_destination}",
    )
    for module in modules:
        relative = module["path"]
        live = resolve(install, relative)
        staged = resolve(stage / "modules", relative)
        require(digest_path(live) == module["source-sha256"], f"live module changed before publication: {relative}")
        require(digest_path(staged) == module["sealed-sha256"], f"staged module changed before publication: {relative}")
        os.replace(staged, live)
        fsync_directory(live.parent)
        require(digest_path(live) == module["sealed-sha256"], f"published module differs: {relative}")
    require(
        all(digest_path(resolve(install, module["path"])) == module["sealed-sha256"] for module in modules),
        "published linear-memory closure differs before receipt commit",
    )
    # Hard-link publication is atomic and fails rather than replacing a
    # concurrently created receipt.  The staged inode remains available to
    # recovery until the parent directory has also been flushed.
    os.link(aggregate_source, aggregate_destination, follow_symlinks=False)
    fsync_directory(aggregate_destination.parent)
    require(committed(install, aggregate_relative, aggregate_sha, modules), "committed transaction verification failed")
    remove_stage(stage, install)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("init", "prepare", "publish", "recover"))
    parser.add_argument("--install-root", type=Path, required=True)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--aggregate", type=Path)
    arguments = parser.parse_args()
    install = arguments.install_root.resolve(strict=True)
    stage = arguments.stage
    require(stage.parent.resolve(strict=True) == install, "transaction stage is not directly below install root")
    if arguments.command == "init":
        init_transaction(install, stage)
    elif arguments.command == "prepare":
        require(arguments.aggregate is not None, "prepare requires --aggregate")
        prepare_transaction(install, stage, arguments.aggregate)
    elif arguments.command == "publish":
        publish_transaction(install, stage)
    else:
        print(recover_transaction(install, stage))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, TransactionError) as error:
        raise SystemExit(f"linear-memory transaction: {error}") from error
