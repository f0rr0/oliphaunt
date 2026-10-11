"""Print actual configured ShippingInfo roots as JSON lines for coverage checks.

Use with cquery --output=starlark --starlark:file=tools/bazel/shipping.cquery.bzl.
Query complete roots in one configured cohort, then aquery deps(the same roots)
with --include_artifacts --include_commandline --output=jsonproto.
"""

def format(target):
    info = providers(target).get("//build_defs/release:shipping.bzl%ShippingInfo")
    if info == None:
        return ""
    return json.encode({
        "label": str(target.label),
        "package": {
            "product": info.product,
            "version": info.version,
            "ecosystem": info.ecosystem,
            "name": info.name,
            "configuration": info.configuration,
            "role": info.role,
            "outputs": [{"path": file.path, "owner": str(file.owner)} for file in info.files.to_list()],
        },
    })
