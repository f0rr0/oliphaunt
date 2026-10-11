"""Watch and enumerate SDK files without recursively expanding directory cycles."""

def apple_sdk_documentation_directories(component):
    """Manual pages are outside the configured compiler/sysroot input profile."""
    if component == "toolchain":
        return ["share/man"]
    if component.startswith("sdk_"):
        return ["usr/share/man"]
    return []

def _directory_graph(root):
    """Read each physical directory once, marking trees that contain cycles."""
    directories = {}
    states = {}
    complete_trees = {}
    pending = [(root.realpath, False)]
    for _ in range(2000000):
        if not pending:
            return directories, complete_trees
        source, finishing = pending.pop()
        physical = str(source)
        if finishing:
            complete_trees[physical] = complete_trees.get(physical, True) and all([complete_trees[child] for child in directories[physical][1]])
            states[physical] = 2
            continue
        state = states.get(physical, 0)
        if state:
            if state == 1:
                complete_trees[physical] = False
            continue
        states[physical] = 1
        entries = source.readdir(watch = "no")
        children = [child.realpath for child in entries if child.exists and child.is_dir]
        directories[physical] = ([child.basename for child in entries], [str(child) for child in children])
        pending.append((source, True))
        pending.extend([(child, False) for child in children])
    fail("The selected host SDK exceeds the bounded physical directory traversal; no partial SDK is declared.")

def watch_sdk_directory(ctx, root, excluded_directories = []):
    """Return finite relative file paths, retaining noncyclic SDK aliases.

    Complete acyclic subtrees use one recursive watch instead of a separate
    Skyframe dependency for every aliased file. Cyclic and documentation-excluded
    boundaries retain explicit membership, type, and content watches. A link back
    to an ancestor receives one finite watch pass without declaring cyclic inputs.

    The selected SDK installation's topology is fixed for an output base.
    Bazel 8.8 watches directory names, file types, and bytes, not a directory
    link's canonical identity; an identical-content cycle retarget can therefore
    leave observations unchanged. These watches do not qualify live SDK swaps.

    If a structurally replaced SDK removes a watched logical directory, Bazel
    8.8.1 may reject the old watch state before refetching. This fails closed;
    reacquire the selected SDK using a fresh output base.
    """
    files = []
    directory_graph, complete_trees = _directory_graph(root)
    watched_directories = {}
    watched_files = {}
    watched_trees = {}
    pending = [(root, "", [], True, False, str(root), False)]
    for _ in range(2000000):
        if not pending:
            return sorted(files)
        source, relative, ancestors, declare, aliased, expected_path, covered = pending.pop()
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
            if physical in ancestors:
                if not declare:
                    if not covered:
                        ctx.watch(source)
                    continue
                ancestors = []
                declare = False
                aliased = True
            contains_exclusion = any([excluded.startswith(relative + "/") if relative else True for excluded in excluded_directories])
            if not covered:
                if complete_trees[physical] and not contains_exclusion:
                    # watch_tree follows aliases and observes deep retarget changes.
                    for tree in [source, canonical]:
                        identity = str(tree)
                        if identity not in watched_trees:
                            ctx.watch_tree(tree)
                            watched_trees[identity] = True
                    covered = True
                else:
                    ctx.watch(source)
                    # Names alone do not identify a directory link's target.
                    watched = source if aliased else canonical
                    identity = str(watched)
                    if identity not in watched_directories:
                        watched.readdir(watch = "yes")
                        watched_directories[identity] = True
            for basename in directory_graph[physical][0]:
                child_relative = relative + "/" + basename if relative else basename
                pending.append((source.get_child(basename), child_relative, ancestors + [physical], declare, aliased, str(canonical.get_child(basename)), covered))
        else:
            if not covered and physical not in watched_files:
                ctx.watch(canonical)
                watched_files[physical] = True
            if not covered and aliased:
                ctx.watch(source)
            if declare:
                files.append(relative)
    fail("The selected host SDK exceeds the bounded directory traversal; no partial SDK is declared.")
