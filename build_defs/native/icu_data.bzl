"""Pinned ICU 76 little-endian data as an explicit runtime resource."""

def _manifest_strings(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not separator or not value.startswith("\"") or not value.endswith("\""):
            fail("ICU data source metadata must contain quoted strings: " + line)
        if key in values:
            fail("duplicate ICU data source metadata key: " + key)
        values[key] = value[1:-1]
    return values

def _icu_data_repository_impl(ctx):
    source = _manifest_strings(ctx.read(ctx.attr.source_manifest))
    for key in ["url", "sha256"]:
        if not source.get(key):
            fail("ICU data source metadata is missing " + key)
    if source.get("kind") != "archive":
        fail("ICU data source must be a checksum-pinned archive")
    prefix = source.get("strip_prefix", "")
    ctx.download_and_extract(
        url = source["url"],
        sha256 = source["sha256"],
        type = "zip",
        stripPrefix = "" if prefix == "." else prefix,
    )

    # This filename is the ICU 76 little-endian ABI resource consumed by the
    # existing portable packages and managed-runtime data directory.
    data = "icudt76l.dat"
    if not ctx.path(data).exists:
        fail("pinned ICU data archive is missing " + data)
    notices = [
        filename
        for filename in ["LICENSE", "icu4c-76_1-data-bin-l-README.md"]
        if ctx.path(filename).exists
    ]
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files({files})
filegroup(name = "data", srcs = {data})
filegroup(name = "notices", srcs = {notices})
""".format(files = repr([data] + notices), data = repr([data]), notices = repr(notices)))

icu_data_repository = repository_rule(
    implementation = _icu_data_repository_impl,
    attrs = {
        "source_manifest": attr.label(
            default = Label("//src/database-resources/icu:source.toml"),
            allow_single_file = True,
        ),
    },
)
