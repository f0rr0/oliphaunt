"""One-way tracked import of existing product/extension policy before analysis."""

def _domain_metadata_impl(ctx):
    root = ctx.path(ctx.attr.config).dirname
    converter = ctx.path(ctx.attr.converter)
    # Repository reads track source changes. The converter's receipt covers its
    # discovered descriptors, including new products and external source pins.
    ctx.read(converter)
    ctx.read(ctx.path(ctx.attr.config))
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([
        str(ctx.path(ctx.attr.bun)),
        str(converter),
        "--root",
        str(root),
        "--output-dir",
        str(ctx.path(".")),
        "--identity-rule",
        str(ctx.attr.identity_rule),
    ], timeout = 120)
    if result.return_code:
        fail("release metadata import failed:\n" + result.stdout + result.stderr)
    inputs = json.decode(ctx.read(".metadata-inputs.json"))
    for relative, observed in inputs.items():
        source = root.get_child(relative)
        ctx.watch(source)
        current = ctx.read(source) if source.exists else None
        if current != observed:
            fail("release metadata changed during import: " + relative)
    directories = json.decode(ctx.read(".metadata-directories.json"))
    for relative, observed in directories.items():
        source = root.get_child(relative)
        ctx.watch(source)
        current = sorted([entry.basename for entry in source.readdir(watch = "yes")]) if source.exists else None
        if current != observed:
            fail("release metadata directory changed during import: " + relative)

domain_metadata = repository_rule(
    implementation = _domain_metadata_impl,
    attrs = {
        "bun": attr.label(allow_single_file = True, mandatory = True),
        "config": attr.label(allow_single_file = True, default = Label("//:release-please-config.json")),
        "converter": attr.label(allow_single_file = True, default = Label("//tools/release:bazel-release-metadata.mts")),
        "identity_rule": attr.label(allow_single_file = True, default = Label("//build_defs/release:identity.bzl")),
    },
)
