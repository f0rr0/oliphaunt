#!/usr/bin/env python3
"""Publish or verify the semver source tag SwiftPM needs for the Apple SDK."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$"
)


def fail(message: str) -> NoReturn:
    print(f"publish_swiftpm_source_tag.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def git_output(args: list[str]) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def git_run(args: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(["git", *args], cwd=ROOT, env=env, check=True)


def commit_for_ref(ref: str) -> str:
    return git_output(["rev-parse", f"{ref}^{{commit}}"])


def tag_ref(tag: str) -> str:
    return f"refs/tags/{tag}"


def tag_commit(tag: str) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{tag_ref(tag)}^{{commit}}"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return None


def swiftpm_tag() -> str:
    version = product_metadata.read_current_version("oliphaunt-swift")
    if SEMVER_RE.fullmatch(version) is None:
        fail(f"SwiftPM requires a semantic version tag; oliphaunt-swift version is {version!r}")
    return version


def commit_parents(commit: str) -> list[str]:
    parts = git_output(["rev-list", "--parents", "-n", "1", commit]).split()
    return parts[1:]


def file_at_ref(ref: str, path: str) -> str | None:
    result = subprocess.run(
        ["git", "show", f"{ref}:{path}"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return result.stdout if result.returncode == 0 else None


def tree_for_commit(commit: str) -> str:
    return git_output(["rev-parse", f"{commit}^{{tree}}"])


def synthetic_commit_matches(commit: str, parent: str, expected_tree: str) -> bool:
    return commit_parents(commit) == [parent] and tree_for_commit(commit) == expected_tree


def iter_tree_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            files.append(path)
        elif not path.is_dir():
            fail(f"SwiftPM generated release tree contains unsupported file type: {path}")
    return files


def add_blob_to_index(env: dict[str, str], path: str, data: str | bytes) -> None:
    binary = isinstance(data, bytes)
    blob_output = subprocess.run(
        ["git", "hash-object", "-w", "--stdin"],
        cwd=ROOT,
        env=env,
        check=True,
        text=not binary,
        input=data,
        stdout=subprocess.PIPE,
    ).stdout
    blob = blob_output.decode("utf-8").strip() if binary else blob_output.strip()
    git_run(["update-index", "--add", "--cacheinfo", f"100644,{blob},{path}"], env=env)


def create_swiftpm_release_tree(
    target_commit: str,
    manifest: str,
    include_trees: list[Path],
) -> str:
    base_tree = git_output(["rev-parse", f"{target_commit}^{{tree}}"])
    with tempfile.TemporaryDirectory(prefix="oliphaunt-swiftpm-index.") as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        git_run(["read-tree", base_tree], env=env)
        add_blob_to_index(env, "Package.swift", manifest)
        for include_tree in include_trees:
            root = include_tree.resolve()
            if not root.is_dir():
                fail(f"SwiftPM generated release tree does not exist: {include_tree}")
            for file in iter_tree_files(root):
                relative = file.relative_to(root).as_posix()
                if relative == "Package.swift" or relative.startswith(".git/") or "/.git/" in relative:
                    fail(f"SwiftPM generated release tree contains forbidden path: {relative}")
                add_blob_to_index(env, relative, file.read_bytes())
        return subprocess.run(
            ["git", "write-tree"],
            cwd=ROOT,
            env=env,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()


def create_swiftpm_manifest_commit(target_commit: str, tree: str, version: str) -> str:
    return subprocess.run(
        [
            "git",
            "commit-tree",
            tree,
            "-p",
            target_commit,
            "-m",
            f"Release Oliphaunt Swift {version} SwiftPM manifest",
        ],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout.strip()


def ensure_tag(target: str, *, manifest_path: str | None, include_trees: list[str], push: bool) -> str:
    tag = swiftpm_tag()
    version = product_metadata.read_current_version("oliphaunt-swift")
    target_commit = commit_for_ref(target)
    manifest = None
    tag_target = target_commit
    expected_tree = tree_for_commit(target_commit)

    if manifest_path is not None:
        manifest = (ROOT / manifest_path).read_text(encoding="utf-8")
        if "binaryTarget(" not in manifest or "liboliphaunt-native-v" not in manifest:
            fail("SwiftPM release manifest must contain a checksum-pinned liboliphaunt binaryTarget")
        expected_tree = create_swiftpm_release_tree(
            target_commit,
            manifest,
            [(ROOT / include_tree) for include_tree in include_trees],
        )
        tag_target = create_swiftpm_manifest_commit(target_commit, expected_tree, version)

    existing = tag_commit(tag)
    if existing is not None:
        if manifest is not None and synthetic_commit_matches(existing, target_commit, expected_tree):
            print(f"SwiftPM version tag {tag} already points at a release manifest commit for {target_commit}")
            tag_target = existing
        elif existing != tag_target:
            fail(
                f"SwiftPM version tag {tag} already points at {existing}, "
                f"not expected SwiftPM release commit {tag_target}"
            )
        else:
            print(f"SwiftPM version tag {tag} already points at {tag_target}")
    else:
        git_run(["tag", tag, tag_target])
        print(f"created SwiftPM version tag {tag} at {tag_target}")

    if push:
        git_run(["push", "origin", tag_ref(tag)])
        print(f"pushed SwiftPM version tag {tag} to origin")
    return tag


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        default=os.environ.get("GITHUB_SHA", "HEAD"),
        help="commitish that the SwiftPM version tag must derive from",
    )
    parser.add_argument(
        "--manifest",
        help=(
            "generated public SwiftPM Package.swift to place in a release-only "
            "tag commit; when omitted, the semver tag points directly at --target"
        ),
    )
    parser.add_argument(
        "--include-tree",
        action="append",
        default=[],
        help=(
            "generated repository-relative file tree to include in the release-only "
            "SwiftPM tag commit; may be passed multiple times"
        ),
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="push the tag to origin after creating or verifying it locally",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    ensure_tag(args.target, manifest_path=args.manifest, include_trees=args.include_tree, push=args.push)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
