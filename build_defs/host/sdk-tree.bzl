"""Watch and enumerate SDK files without recursively expanding directory cycles."""

def apple_sdk_documentation_directories(component):
    """Manual pages are outside the configured compiler/sysroot input profile."""
    if component == "toolchain":
        return ["share/man"]
    if component.startswith("sdk_"):
        return ["usr/share/man"]
    return []

def watch_sdk_directory(ctx, root, excluded_directories = []):
    """Return finite relative file paths, retaining noncyclic SDK aliases.

    Canonical directory entries and files are reused across logical paths.
    Alias branches retain logical membership and type watches. A link back to
    an ancestor receives one finite watch pass without declaring cyclic inputs.

    The selected SDK installation's topology is fixed for an output base.
    Bazel 8.8 watches directory names, file types, and bytes, not a directory
    link's canonical identity; an identical-content cycle retarget can therefore
    leave observations unchanged. These watches do not qualify live SDK swaps.

    If a structurally replaced SDK removes a watched logical directory, Bazel
    8.8.1 may reject the old watch state before refetching. This fails closed;
    reacquire the selected SDK using a fresh output base.
    """
    files = []
    directory_entries = {}
    watched_files = {}
    pending = [(root, "", [], True, False, str(root))]
    for _ in range(2000000):
        if not pending:
            return sorted(files)
        source, relative, ancestors, declare, aliased, expected_path = pending.pop()
        # Exclude named documentation trees, never files based on characters:
        # usable headers/resources with invalid labels must still fail closed.
        if relative in excluded_directories:
            continue
        # Match glob's handling of dangling links while watching their creation.
        if not source.exists:
            ctx.watch(source)
            continue
        canonical = source.realpath
        physical = str(canonical)
        aliased = aliased or expected_path != physical
        if source.is_dir:
            ctx.watch(source)
            if physical in ancestors:
                if not declare:
                    continue
                ancestors = []
                declare = False
                aliased = True
            # Names alone do not identify a directory link's target in Bazel 8.
            # Preserve logical descendant observations throughout alias branches.
            if aliased:
                entries = [child.basename for child in source.readdir(watch = "yes")]
                if physical not in directory_entries:
                    directory_entries[physical] = entries
            elif physical not in directory_entries:
                directory_entries[physical] = [child.basename for child in canonical.readdir(watch = "yes")]
            for basename in directory_entries[physical]:
                child_relative = relative + "/" + basename if relative else basename
                pending.append((source.get_child(basename), child_relative, ancestors + [physical], declare, aliased, str(canonical.get_child(basename))))
        else:
            if physical not in watched_files:
                ctx.watch(canonical)
                watched_files[physical] = True
            if aliased:
                ctx.watch(source)
            if declare:
                files.append(relative)
    fail("The selected host SDK exceeds the bounded directory traversal; no partial SDK is declared.")
