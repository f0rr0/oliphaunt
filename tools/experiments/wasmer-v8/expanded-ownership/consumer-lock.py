"""Check exact consumer resolution after declared producer-edge removal."""
import json
import tomllib


def check_lock(before, after, removed=(), added=()):
    before, after = [tomllib.loads(raw.decode())["package"] for raw in (before, after)]
    def key(package):
        return package["name"], package["version"]
    records = {key(package): package for package in before}
    assert len(records) == len(before), "ambiguous package source identities"
    wasmer = records["wasmer", "7.5.0"]
    def resolve(edge, graph=records):
        parts = edge.split()
        candidates = [identity for identity in graph if identity[0] == parts[0]
            and (len(parts) == 1 or identity[1] == parts[1])]
        assert len(candidates) == 1, edge
        return candidates[0]
    wasmer["dependencies"] = [edge for edge in wasmer["dependencies"]
        if edge.split()[0] not in removed]
    for name in added:
        identity = resolve(name)
        wasmer["dependencies"].append(name if sum(k[0] == name for k in records) == 1
                                      else " ".join(identity))
    wasmer["dependencies"].sort()
    # Cargo prunes tools that became unreachable. Workspace/path packages are
    # unchanged roots; all retained versions, checksums and edges must match.
    pending = [key(package) for package in before if "source" not in package]
    retained = set()
    while pending:
        identity = pending.pop()
        if identity in retained:
            continue
        retained.add(identity)
        pending.extend(resolve(edge) for edge in records[identity].get("dependencies", []))
    expected = [records[identity] for identity in retained]
    for packages in (expected, after):
        for package in packages:
            if key(package) == ("wasmer", "7.5.0"):
                package.pop("source", None)
                package.pop("checksum", None)
    def normalize(packages):
        graph = {key(package): package for package in packages}
        normalized = []
        for package in packages:
            record = dict(package)
            if "dependencies" in record:
                # Cargo omits a version when pruning leaves only one version.
                # Compare the resolved identities, not that display spelling.
                record["dependencies"] = sorted(resolve(edge, graph) for edge in record["dependencies"])
            normalized.append(json.dumps(record, sort_keys=True))
        return sorted(normalized)
    assert normalize(expected) == normalize(after), "unexpected dependency resolution change"
    return normalize(expected), normalize(after)
