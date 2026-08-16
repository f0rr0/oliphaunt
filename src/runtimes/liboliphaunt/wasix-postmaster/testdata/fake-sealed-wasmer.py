#!/usr/bin/env python3

"""Behavioral fake for the sealed carrier shell test.

It validates the provisional/final manifest transition and emits deterministic
memory-image capture artifacts. It is not installed or used by product code.
"""

import hashlib
import json
import os
import pathlib
import sys



def fail(message):
    raise SystemExit(f"fake sealed Wasmer: {message}")


def parse_run(arguments):
    if not arguments or arguments[0] != "run":
        return {}, pathlib.Path(), [], []
    values = {}
    value_options = {
        "--stack-size",
        "--sealed-module-manifest",
        "--emit-preinitialized-memory-image",
        "--emit-preinitialized-memory-receipt",
    }
    flag_options = {
        "--disable-cache",
        "--enable-exceptions",
        "--enable-threads",
        "--net",
        "--quiet",
    }
    seen_flags = set()
    volumes = []
    guest_arguments = []
    index = 1
    input_path = None
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            guest_arguments = arguments[index + 1 :]
            break
        if argument == "--volume":
            index += 1
            if index >= len(arguments):
                fail(f"{argument} has no value")
            volumes.append(arguments[index])
        elif argument in value_options:
            if argument in values:
                fail(f"duplicate option: {argument}")
            index += 1
            if index >= len(arguments):
                fail(f"{argument} has no value")
            values[argument] = arguments[index]
        elif argument in flag_options:
            if argument in seen_flags:
                fail(f"duplicate option: {argument}")
            seen_flags.add(argument)
        elif argument.startswith("-"):
            fail(f"unknown option: {argument}")
        elif input_path is None:
            input_path = pathlib.Path(argument)
        index += 1
    if input_path is None:
        fail("run has no input module")
    required_flags = {
        "--disable-cache",
        "--enable-exceptions",
        "--enable-threads",
        "--net",
    }
    if not required_flags.issubset(seen_flags):
        fail(f"run lacks required flags: {sorted(required_flags - seen_flags)}")
    if not volumes:
        fail("run has no volume")
    return values, input_path, volumes, guest_arguments


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def volume_for_guest(volumes, guest):
    matches = []
    for volume in volumes:
        if ":" not in volume:
            continue
        host, mounted_at = volume.rsplit(":", 1)
        if mounted_at == guest:
            matches.append(pathlib.Path(host))
    if len(matches) != 1:
        fail(f"expected exactly one volume mounted at {guest}, got {len(matches)}")
    return matches[0]


def append_validation_log(program, guest_arguments, volumes):
    validation_log = os.environ.get("FAKE_WASMER_VALIDATION_LOG")
    if not validation_log:
        return
    record = {
        "program": program,
        "arguments": guest_arguments,
        "volumes": volumes,
    }
    with open(validation_log, "a", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, sort_keys=True)
        stream.write("\n")


def main():
    values, module_path, volumes, guest_arguments = parse_run(sys.argv[1:])
    if not values:
        return
    manifest_path = pathlib.Path(values.get("--sealed-module-manifest", ""))
    if not manifest_path.is_file():
        fail("run did not receive a sealed manifest")
    carrier_root = manifest_path.resolve().parent
    expected_lib_volume = f"{carrier_root / 'lib'}:/lib"
    if volumes.count(expected_lib_volume) != 1:
        fail(
            "run did not mount the exact staged library closure at /lib: "
            f"expected {expected_lib_volume!r}, got {volumes!r}"
        )
    volume_for_guest(volumes, "/lib")
    with manifest_path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    image_value = values.get("--emit-preinitialized-memory-image")
    receipt_value = values.get("--emit-preinitialized-memory-receipt")
    if bool(image_value) != bool(receipt_value):
        fail("capture image and receipt were not paired")

    if image_value:
        if guest_arguments != ["--version"]:
            fail("memory capture did not use a side-effect-free version probe")
        if manifest.get("format-version") != 4:
            fail("capture did not use manifest format 4")
        if manifest.get("schema") != "oliphaunt.wasix-postmaster.sealed-aot.v3":
            fail("capture did not use sealed-aot.v3")
        if any("preinitialized-memory" in artifact for artifact in manifest["artifacts"]):
            fail("capture manifest already contains a memory image")

        module_sha256 = file_sha256(module_path)
        image_path = pathlib.Path(image_value)
        receipt_path = pathlib.Path(receipt_value)
        image_size = 65536
        seed = bytes.fromhex(module_sha256)
        image = bytearray((seed * (image_size // len(seed) + 1))[:image_size])
        if os.environ.get("FAKE_WASMER_NONDETERMINISTIC") == "1" and image_path.parent.name == "2":
            image[-1] ^= 0xFF
        image_path.write_bytes(image)

        receipt = {
            "schema": "oliphaunt.wasix-postmaster.memory-image.v1",
            "module-sha256": module_sha256,
            "runtime-abi-id": manifest["runtime-abi-id"],
            "phase": "post-module-start-pre-link-relocations-v1",
            "mapping-alignment": 65536,
            "mapped-size": image_size,
            "memory-minimum-pages": 1,
            "memory-maximum-pages": 4096,
            "memory-shared": True,
            "memory-base": 4096,
            "dylink-memory-size": 61440,
            "dylink-memory-alignment": 12,
            "stack-low": 65536,
        }
        if os.environ.get("FAKE_WASMER_RECEIPT_MISMATCH") == "1" and receipt_path.parent.name == "2":
            receipt["phase"] = "different-phase"
        if os.environ.get("FAKE_WASMER_INVALID_RECEIPT") == "1":
            receipt["mapped-size"] = image_size + 1
        with receipt_path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(receipt, stream, indent=2)
            stream.write("\n")

        capture_log = os.environ.get("FAKE_WASMER_CAPTURE_LOG")
        if capture_log:
            with open(capture_log, "a", encoding="utf-8", newline="\n") as stream:
                stream.write(f"{module_path.name}\t{module_sha256}\n")
        return

    if manifest.get("format-version") != 6:
        fail("validation did not use manifest format 6")
    if manifest.get("schema") != "oliphaunt.wasix-postmaster.sealed-aot.v5":
        fail("validation did not use sealed-aot.v5")
    for artifact in manifest["artifacts"]:
        if "preinitialized-memory" in artifact:
            fail(f"final artifact {artifact['name']} has a preinitialized memory image")
    expected_carrier_volume = f"{carrier_root}:{carrier_root}"
    expected_share_volume = f"{carrier_root / 'share'}:/share"
    if volumes.count(expected_carrier_volume) != 1:
        fail("final validation did not mount the exact staged carrier path")
    if volumes.count(expected_share_volume) != 1:
        fail("final validation did not mount the exact staged share tree at /share")
    volume_for_guest(volumes, str(carrier_root))
    volume_for_guest(volumes, "/share")

    expected_module = carrier_root / "bin" / module_path.name
    if module_path.resolve() != expected_module:
        fail("final validation did not execute the module from the staged carrier")
    append_validation_log(module_path.name, guest_arguments, volumes)

    if module_path.name == "postgres":
        if guest_arguments != ["--version"]:
            fail("final postgres validation was not a version probe")
        return
    if module_path.name != "initdb":
        fail(f"unexpected final executable validation: {module_path.name}")

    expected_initdb_arguments = [
        "-D",
        "/pgdata",
        "-A",
        "trust",
        "--no-locale",
        "--encoding=UTF8",
        "--no-instructions",
    ]
    if guest_arguments != expected_initdb_arguments:
        fail(
            "final initdb validation did not run the real bootstrap lifecycle: "
            f"got {guest_arguments!r}"
        )
    pgdata = volume_for_guest(volumes, "/pgdata").resolve()
    dev_shm = volume_for_guest(volumes, "/dev/shm").resolve()
    if not pgdata.is_dir() or not os.access(pgdata, os.W_OK):
        fail("final initdb validation PGDATA is not a writable host directory")
    if not dev_shm.is_dir() or not os.access(dev_shm, os.W_OK):
        fail("final initdb validation /dev/shm is not a writable host directory")
    if pgdata == carrier_root or carrier_root in pgdata.parents:
        fail("final initdb validation PGDATA overlaps the staged carrier")
    if dev_shm == carrier_root or carrier_root in dev_shm.parents:
        fail("final initdb validation /dev/shm overlaps the staged carrier")
    if os.environ.get("FAKE_WASMER_FAIL_FINAL_INITDB") == "1":
        fail("requested final initdb lifecycle failure")
    if os.environ.get("FAKE_WASMER_SKIP_INITDB_OUTPUT") != "1":
        (pgdata / "global").mkdir()
        (pgdata / "PG_VERSION").write_text("18\n", encoding="utf-8")
        (pgdata / "global" / "pg_control").write_bytes(b"fake-pg-control\n")


if __name__ == "__main__":
    main()
