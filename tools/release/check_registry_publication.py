#!/usr/bin/env python3
"""Check selected product versions across public package registries."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import NoReturn

import check_cratesio_publication
import product_metadata


NPM_REGISTRY = os.environ.get("NPM_REGISTRY", "https://registry.npmjs.org")
JSR_REGISTRY = os.environ.get("JSR_REGISTRY", "https://jsr.io")
MAVEN_CENTRAL_BASE = os.environ.get(
    "MAVEN_CENTRAL_BASE",
    "https://repo1.maven.org/maven2",
)
REQUEST_ATTEMPTS = int(os.environ.get("OLIPHAUNT_REGISTRY_QUERY_ATTEMPTS", "3"))
REQUEST_RETRY_DELAY_SECONDS = float(
    os.environ.get("OLIPHAUNT_REGISTRY_QUERY_RETRY_DELAY", "1.0")
)
REGISTRY_TARGETS = {
    "crates-io",
    "npm",
    "jsr",
    "maven-central",
}


@dataclass(frozen=True)
class RegistryPackage:
    kind: str
    name: str
    version: str

    @property
    def label(self) -> str:
        return f"{self.kind}:{self.name}@{self.version}"


def fail(message: str) -> NoReturn:
    print(f"check_registry_publication.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def request_attempts() -> int:
    return max(1, REQUEST_ATTEMPTS)


def sleep_before_retry(attempt: int) -> None:
    if attempt + 1 < request_attempts() and REQUEST_RETRY_DELAY_SECONDS > 0:
        time.sleep(REQUEST_RETRY_DELAY_SECONDS)


def retryable_http_error(error: urllib.error.HTTPError) -> bool:
    return error.code == 429 or error.code >= 500


def request_json(url: str) -> object:
    last_error: Exception | None = None
    for attempt in range(request_attempts()):
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "oliphaunt-release-check (https://github.com/f0rr0/oliphaunt)",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if not retryable_http_error(error):
                raise
            last_error = error
            sleep_before_retry(attempt)
        except urllib.error.URLError as error:
            last_error = error
            sleep_before_retry(attempt)
    assert last_error is not None
    raise last_error


def url_exists(url: str) -> bool:
    last_error: Exception | None = None
    for attempt in range(request_attempts()):
        request = urllib.request.Request(
            url,
            method="HEAD",
            headers={
                "Accept": "application/json",
                "User-Agent": "oliphaunt-release-check (https://github.com/f0rr0/oliphaunt)",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return 200 <= response.status < 300
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return False
            if error.code == 405:
                return url_exists_via_get(url)
            if not retryable_http_error(error):
                fail(f"registry returned HTTP {error.code} for {url}")
            last_error = error
            sleep_before_retry(attempt)
        except urllib.error.URLError as error:
            last_error = error
            sleep_before_retry(attempt)
    assert last_error is not None
    if isinstance(last_error, urllib.error.HTTPError):
        fail(f"registry returned HTTP {last_error.code} for {url}")
    fail(f"failed to query registry URL {url}: {last_error}")


def url_exists_via_get(url: str) -> bool:
    last_error: Exception | None = None
    for attempt in range(request_attempts()):
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "oliphaunt-release-check (https://github.com/f0rr0/oliphaunt)",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return 200 <= response.status < 300
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return False
            if not retryable_http_error(error):
                fail(f"registry returned HTTP {error.code} for {url}")
            last_error = error
            sleep_before_retry(attempt)
        except urllib.error.URLError as error:
            last_error = error
            sleep_before_retry(attempt)
    assert last_error is not None
    if isinstance(last_error, urllib.error.HTTPError):
        fail(f"registry returned HTTP {last_error.code} for {url}")
    fail(f"failed to query registry URL {url}: {last_error}")


def npm_version_exists(package: str, version: str) -> bool:
    package_path = urllib.parse.quote(package, safe="")
    url = f"{NPM_REGISTRY.rstrip('/')}/{package_path}"
    try:
        data = request_json(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        fail(f"npm registry returned HTTP {error.code} for {package}")
    except urllib.error.URLError as error:
        fail(f"failed to query npm registry for {package}: {error}")
    if not isinstance(data, dict):
        fail(f"npm registry returned malformed metadata for {package}")
    versions = data.get("versions")
    if not isinstance(versions, dict):
        return False
    return version in versions


def npm_package_exists(package: str) -> bool:
    package_path = urllib.parse.quote(package, safe="")
    url = f"{NPM_REGISTRY.rstrip('/')}/{package_path}"
    try:
        data = request_json(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        fail(f"npm registry returned HTTP {error.code} for {package}")
    except urllib.error.URLError as error:
        fail(f"failed to query npm registry for {package}: {error}")
    return isinstance(data, dict)


def maven_version_exists(coordinate: str, version: str) -> bool:
    parts = coordinate.split(":")
    if len(parts) != 2 or not all(parts):
        fail(f"invalid Maven coordinate {coordinate!r}; expected group:artifact")
    group, artifact = parts
    group_path = "/".join(urllib.parse.quote(part, safe="") for part in group.split("."))
    artifact_path = urllib.parse.quote(artifact, safe="")
    version_path = urllib.parse.quote(version, safe="")
    url = (
        f"{MAVEN_CENTRAL_BASE.rstrip('/')}/{group_path}/{artifact_path}/"
        f"{version_path}/{artifact_path}-{version_path}.pom"
    )
    return url_exists(url)


def maven_coordinate_exists(coordinate: str) -> bool:
    parts = coordinate.split(":")
    if len(parts) != 2 or not all(parts):
        fail(f"invalid Maven coordinate {coordinate!r}; expected group:artifact")
    group, artifact = parts
    group_path = "/".join(urllib.parse.quote(part, safe="") for part in group.split("."))
    artifact_path = urllib.parse.quote(artifact, safe="")
    metadata_url = (
        f"{MAVEN_CENTRAL_BASE.rstrip('/')}/{group_path}/{artifact_path}/maven-metadata.xml"
    )
    return url_exists(metadata_url)


def jsr_version_exists(package: str, version: str) -> bool:
    if not package.startswith("@") or "/" not in package:
        fail(f"invalid JSR package {package!r}; expected @scope/name")
    scope, name = package[1:].split("/", 1)
    scope_path = urllib.parse.quote(scope, safe="")
    name_path = urllib.parse.quote(name, safe="")
    url = f"{JSR_REGISTRY.rstrip('/')}/@{scope_path}/{name_path}/meta.json"
    try:
        data = request_json(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        fail(f"JSR registry returned HTTP {error.code} for {package}")
    except urllib.error.URLError as error:
        fail(f"failed to query JSR registry for {package}: {error}")
    if not isinstance(data, dict):
        fail(f"JSR registry returned malformed metadata for {package}")
    versions = data.get("versions")
    if not isinstance(versions, dict):
        return False
    return version in versions


def jsr_package_exists(package: str) -> bool:
    if not package.startswith("@") or "/" not in package:
        fail(f"invalid JSR package {package!r}; expected @scope/name")
    scope, name = package[1:].split("/", 1)
    scope_path = urllib.parse.quote(scope, safe="")
    name_path = urllib.parse.quote(name, safe="")
    url = f"{JSR_REGISTRY.rstrip('/')}/@{scope_path}/{name_path}/meta.json"
    try:
        data = request_json(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        fail(f"JSR registry returned HTTP {error.code} for {package}")
    except urllib.error.URLError as error:
        fail(f"failed to query JSR registry for {package}: {error}")
    return isinstance(data, dict)


def package_exists(package: RegistryPackage) -> bool:
    if package.kind == "crates":
        return check_cratesio_publication.crate_version_exists(package.name, package.version)
    if package.kind == "npm":
        return npm_version_exists(package.name, package.version)
    if package.kind == "jsr":
        return jsr_version_exists(package.name, package.version)
    if package.kind == "maven":
        return maven_version_exists(package.name, package.version)
    fail(f"unsupported registry package kind {package.kind!r}")


def package_identity_exists(package: RegistryPackage) -> bool:
    if package.kind == "crates":
        return check_cratesio_publication.crate_exists(package.name)
    if package.kind == "npm":
        return npm_package_exists(package.name)
    if package.kind == "jsr":
        return jsr_package_exists(package.name)
    if package.kind == "maven":
        return maven_coordinate_exists(package.name)
    fail(f"unsupported registry package kind {package.kind!r}")


def parse_registry_package(raw: str, product: str, version: str) -> RegistryPackage:
    kind, separator, name = raw.partition(":")
    if separator != ":" or not kind or not name:
        fail(f"{product}.registry_packages entry {raw!r} must use kind:name")
    if kind not in {"crates", "npm", "jsr", "maven"}:
        fail(f"{product}.registry_packages entry {raw!r} has unsupported kind {kind!r}")
    return RegistryPackage(kind=kind, name=name, version=version)


def graph_registry_packages(
    product: str,
    graph: dict | None = None,
    *,
    version_override: str | None = None,
) -> list[RegistryPackage]:
    data = graph if graph is not None else product_metadata.load_graph()
    config = product_metadata.product_config(product, data)
    version = version_override or product_metadata.read_current_version(product)
    raw_packages = product_metadata.string_list(config, "registry_packages", product)
    return [
        parse_registry_package(raw_package, product, version)
        for raw_package in raw_packages
    ]


def derived_crates_packages(product: str) -> list[RegistryPackage]:
    version, crates, _, _ = check_cratesio_publication.query_crates(product)
    return [
        RegistryPackage(kind="crates", name=crate, version=version)
        for crate in crates
    ]


def product_registry_packages(
    product: str,
    graph: dict | None = None,
    *,
    version_override: str | None = None,
    registry_kind: str | None = None,
) -> list[RegistryPackage]:
    data = graph if graph is not None else product_metadata.load_graph()
    config = product_metadata.product_config(product, data)
    publish_targets = set(product_metadata.string_list(config, "publish_targets", product))
    graph_packages = graph_registry_packages(product, data, version_override=version_override)
    packages = list(graph_packages)
    if "crates-io" in publish_targets:
        derived_crates = derived_crates_packages(product)
        if version_override is not None:
            derived_crates = [
                RegistryPackage(kind=package.kind, name=package.name, version=version_override)
                for package in derived_crates
            ]
        graph_crates = [package for package in packages if package.kind == "crates"]
        if graph_crates:
            derived_names = sorted(package.name for package in derived_crates)
            graph_names = sorted(package.name for package in graph_crates)
            if graph_names != derived_names:
                fail(
                    f"{product}.registry_packages crates entries {graph_names} "
                    f"do not match Cargo manifests {derived_names}"
                )
        else:
            packages.extend(derived_crates)
    missing_kinds = []
    expected_kinds = {
        "npm": "npm",
        "jsr": "jsr",
        "maven-central": "maven",
    }
    for target, kind in expected_kinds.items():
        if target in publish_targets and not any(package.kind == kind for package in packages):
            missing_kinds.append(kind)
    if missing_kinds:
        fail(
            f"{product} publishes to {sorted(publish_targets & REGISTRY_TARGETS)} "
            f"but is missing registry_packages entries for: {', '.join(missing_kinds)}"
        )
    if registry_kind is not None:
        packages = [package for package in packages if package.kind == registry_kind]
        if not packages:
            fail(f"{product} has no {registry_kind} registry packages to check")
    return packages


def query_product_publication(
    product: str,
    *,
    version_override: str | None = None,
    registry_kind: str | None = None,
    retries: int = 0,
    retry_delay: float = 0.0,
) -> tuple[list[RegistryPackage], list[RegistryPackage], list[RegistryPackage]]:
    packages = product_registry_packages(
        product,
        version_override=version_override,
        registry_kind=registry_kind,
    )
    if not packages:
        return [], [], []

    attempts = max(1, retries + 1)
    last_missing: list[RegistryPackage] = []
    last_published: list[RegistryPackage] = []
    for attempt in range(attempts):
        missing: list[RegistryPackage] = []
        published: list[RegistryPackage] = []
        for package in packages:
            if package_exists(package):
                published.append(package)
            else:
                missing.append(package)
        last_missing = missing
        last_published = published
        if not missing or attempt == attempts - 1:
            break
        if retry_delay > 0:
            time.sleep(retry_delay)
    return packages, last_missing, last_published


def assert_product_publication(
    product: str,
    *,
    require_published: bool,
    version_override: str | None = None,
    registry_kind: str | None = None,
    retries: int = 0,
    retry_delay: float = 0.0,
) -> None:
    packages, missing, published = query_product_publication(
        product,
        version_override=version_override,
        registry_kind=registry_kind,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not packages:
        print(f"{product} has no external registry packages to check")
        return
    if require_published and missing:
        fail(
            f"{product} registry publication is missing: "
            + ", ".join(package.label for package in missing)
        )
    if not require_published and published:
        fail(
            f"{product} version is already published in public registries: "
            + ", ".join(package.label for package in published)
        )
    state = "published" if require_published else "unpublished"
    print(
        f"{product} registry {state} check passed: "
        + ", ".join(package.label for package in packages)
    )


def report_product_publication(
    product: str,
    *,
    version_override: str | None = None,
    registry_kind: str | None = None,
) -> None:
    packages, missing, published = query_product_publication(
        product,
        version_override=version_override,
        registry_kind=registry_kind,
    )
    if not packages:
        print(f"{product} has no external registry packages to check")
        return
    if published:
        print(
            f"{product} registry versions already present: "
            + ", ".join(package.label for package in published)
        )
    if missing:
        print(
            f"{product} registry versions not yet present: "
            + ", ".join(package.label for package in missing)
        )


def product_identity_status(
    product: str,
    *,
    registry_kind: str | None = None,
) -> tuple[list[RegistryPackage], list[RegistryPackage], list[RegistryPackage]]:
    packages = product_registry_packages(product, registry_kind=registry_kind)
    present: list[RegistryPackage] = []
    missing: list[RegistryPackage] = []
    for package in packages:
        if package_identity_exists(package):
            present.append(package)
        else:
            missing.append(package)
    return packages, present, missing


def assert_product_identities(
    product: str,
    *,
    registry_kind: str | None = None,
) -> None:
    packages, _, missing = product_identity_status(product, registry_kind=registry_kind)
    if not packages:
        print(f"{product} has no external registry package identities to check")
        return
    if missing:
        fail(
            f"{product} registry package identities are missing: "
            + ", ".join(f"{package.kind}:{package.name}" for package in missing)
        )
    print(
        f"{product} registry identity check passed: "
        + ", ".join(f"{package.kind}:{package.name}" for package in packages)
    )


def report_product_identities(
    product: str,
    *,
    registry_kind: str | None = None,
) -> None:
    packages, present, missing = product_identity_status(product, registry_kind=registry_kind)
    if not packages:
        print(f"{product} has no external registry package identities to check")
        return
    if present:
        print(
            f"{product} registry identities present: "
            + ", ".join(f"{package.kind}:{package.name}" for package in present)
        )
    if missing:
        print(
            f"{product} registry identities missing: "
            + ", ".join(f"{package.kind}:{package.name}" for package in missing)
        )


def parse_products(raw: str | None, product: str | None) -> list[str]:
    if bool(raw) == bool(product):
        fail("pass exactly one of --product or --products-json")
    if product:
        return [product]
    value = json.loads(raw or "")
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail("--products-json must be a JSON string list")
    known = set(product_metadata.product_ids())
    unknown = sorted(set(value) - known)
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    return value


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", help="single release product id")
    parser.add_argument("--products-json", help="JSON list of release product ids")
    parser.add_argument(
        "--version",
        help="override the product version to check; valid only with --product",
    )
    parser.add_argument(
        "--registry-kind",
        choices=["crates", "npm", "jsr", "maven"],
        help="restrict checks to one registry package kind for the selected product",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--require-published", action="store_true")
    mode.add_argument("--require-unpublished", action="store_true")
    mode.add_argument("--report", action="store_true")
    mode.add_argument("--require-identities", action="store_true")
    mode.add_argument("--report-identities", action="store_true")
    parser.add_argument(
        "--retries",
        type=int,
        default=0,
        help="additional registry query attempts before failing",
    )
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=0.0,
        help="seconds to sleep between retry attempts",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.version and not args.product:
        fail("--version can only be used with --product")
    products = parse_products(args.products_json, args.product)
    if args.retries < 0:
        fail("--retries must be non-negative")
    if args.retry_delay < 0:
        fail("--retry-delay must be non-negative")
    if args.require_identities:
        missing_messages: list[str] = []
        for product in products:
            packages, _, missing = product_identity_status(product, registry_kind=args.registry_kind)
            if not packages:
                print(f"{product} has no external registry package identities to check")
                continue
            if missing:
                missing_messages.append(
                    f"{product}: "
                    + ", ".join(f"{package.kind}:{package.name}" for package in missing)
                )
            else:
                print(
                    f"{product} registry identity check passed: "
                    + ", ".join(f"{package.kind}:{package.name}" for package in packages)
                )
        if missing_messages:
            fail("registry package identities are missing:\n  - " + "\n  - ".join(missing_messages))
        return 0

    for product in products:
        if args.report_identities:
            report_product_identities(product, registry_kind=args.registry_kind)
        elif args.report:
            report_product_publication(
                product,
                version_override=args.version,
                registry_kind=args.registry_kind,
            )
        else:
            assert_product_publication(
                product,
                require_published=args.require_published,
                version_override=args.version,
                registry_kind=args.registry_kind,
                retries=args.retries,
                retry_delay=args.retry_delay,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
