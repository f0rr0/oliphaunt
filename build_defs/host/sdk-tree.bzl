"""Watch and enumerate SDK files without recursively expanding directory cycles."""

def watch_sdk_directory(ctx, root):
    """Return finite relative file paths, retaining noncyclic SDK aliases.

    Directory entries and logical file paths are watched separately: this also
    observes an ordinary directory alias being retargeted to different contents.
    A link back to an ancestor does not create another set of physical inputs.

    If a structurally replaced SDK removes a watched logical directory, Bazel
    8.8.1 may reject the old watch state before refetching. This fails closed;
    reacquire the selected SDK using a fresh output base.
    """
    files = []
    pending = [(root, "", [], True)]
    for _ in range(2000000):
        if not pending:
            return sorted(files)
        source, relative, ancestors, declare = pending.pop()
        ctx.watch(source)
        # Match glob's handling of dangling links while watching their creation.
        if not source.exists:
            continue
        if source.is_dir:
            entries = source.readdir(watch = "yes")
            physical = str(source.realpath)
            if physical in ancestors:
                if not declare:
                    continue
                # Watch the cycle alias's finite contents once too. Retargeting
                # it to another directory with the same names but new bytes
                # must invalidate the repository rather than hide new inputs.
                ancestors = []
                declare = False
            for child in entries:
                child_relative = relative + "/" + child.basename if relative else child.basename
                pending.append((child, child_relative, ancestors + [physical], declare))
        elif declare:
            files.append(relative)
    fail("The selected host SDK exceeds the bounded directory traversal; no partial SDK is declared.")
