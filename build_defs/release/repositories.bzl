"""One-way tracked import of existing product/extension policy before analysis."""

_PUBLICATION_INPUTS_ENV = "OLIPHAUNT_NATIVE_PUBLICATION_INPUTS"

def _domain_metadata_impl(ctx):
    root = ctx.path(ctx.attr.config).dirname
    converter = ctx.path(ctx.attr.converter)
    # Repository reads track source changes. The converter's receipt covers its
    # discovered descriptors, including new products and external source pins.
    ctx.read(converter)
    ctx.read(ctx.path(ctx.attr.config))
    ctx.watch(ctx.path(ctx.attr.bun))
    command = [
        str(ctx.path(ctx.attr.bun)),
        str(converter),
        "--root",
        str(root),
        "--output-dir",
        str(ctx.path(".")),
        "--identity-rule",
        str(ctx.attr.identity_rule),
    ]
    publication_inputs = ctx.os.environ.get(_PUBLICATION_INPUTS_ENV, "")
    snapshot_path = ctx.path(publication_inputs) if publication_inputs else None
    snapshot = None
    if snapshot_path:
        if not snapshot_path.exists:
            fail(_PUBLICATION_INPUTS_ENV + " must name the immutable controller input snapshot")
        ctx.watch(snapshot_path)
        snapshot = ctx.read(snapshot_path)
        command.extend(["--native-publication-inputs", str(snapshot_path)])
    result = ctx.execute(command, timeout = 120)
    if result.return_code:
        fail("release metadata import failed:\n" + result.stdout + result.stderr)
    receipt = json.decode(ctx.read(".metadata-inputs.json"))
    inputs = receipt["sourceInputs"]
    for relative, observed in inputs.items():
        source = root.get_child(relative)
        ctx.watch(source)
        current = ctx.read(source) if source.exists else None
        if current != observed:
            fail("release metadata changed during import: " + relative)
    for file in receipt["nativePublicationFiles"]:
        source = ctx.path(file["source"])
        ctx.watch(source)
        ctx.symlink(source, file["path"])
    if snapshot_path and ctx.read(snapshot_path) != snapshot:
        fail("controller publication inputs changed during import")
    directories = json.decode(ctx.read(".metadata-directories.json"))
    for relative, observed in directories.items():
        source = root.get_child(relative)
        ctx.watch(source)
        # The authored metadata owner remains when its optional dependency
        # directory is removed. Watching the removable directory's listing or
        # tree in Bazel 8 can retain an input rooted at a now-missing directory.
        ctx.watch_tree(source.dirname)
        current = sorted([entry.basename for entry in source.readdir(watch = "no")]) if source.exists else None
        if current != observed:
            fail("release metadata directory changed during import: " + relative)

domain_metadata = repository_rule(
    implementation = _domain_metadata_impl,
    environ = [_PUBLICATION_INPUTS_ENV],
    configure = True,
    attrs = {
        "bun": attr.label(allow_single_file = True, mandatory = True),
        "config": attr.label(allow_single_file = True, default = Label("//:release-please-config.json")),
        "converter": attr.label(allow_single_file = True, default = Label("//tools/release:bazel-release-metadata.mts")),
        "identity_rule": attr.label(allow_single_file = True, default = Label("//build_defs/release:identity.bzl")),
    },
)
