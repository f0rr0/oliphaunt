"""Construction outputs and declared ownership, not publication admission evidence."""

load(":identity.bzl", "ReleaseIdentityInfo")

ShippingInfo = provider(fields = ["product", "version", "ecosystem", "name", "configuration", "role", "files"])

def _shipping_package_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    files = depset(transitive = [artifact[DefaultInfo].files for artifact in ctx.attr.artifacts])
    if not files.to_list():
        fail("shipping package must contain actual output files")
    return [
        DefaultInfo(files = files),
        ShippingInfo(
            product = owner.id,
            version = owner.version,
            ecosystem = ctx.attr.ecosystem,
            name = ctx.attr.package_name,
            configuration = ctx.attr.configuration,
            role = ctx.attr.role,
            files = files,
        ),
    ]

shipping_package = rule(
    implementation = _shipping_package_impl,
    attrs = {
        "owner": attr.label(providers = [ReleaseIdentityInfo], mandatory = True),
        "artifacts": attr.label_list(allow_files = True, mandatory = True),
        "ecosystem": attr.string(values = ["cargo", "npm", "maven", "github", "swift", "internal"], mandatory = True),
        "package_name": attr.string(mandatory = True),
        "configuration": attr.string(mandatory = True),
        "role": attr.string(mandatory = True),
    },
)

def _shipping_export_impl(ctx):
    packages = []
    identities = {}
    versions = {}
    for target in ctx.attr.packages:
        info = target[ShippingInfo]
        key = info.ecosystem + ":" + info.name
        if info.ecosystem == "github":
            # Assets and candidate inputs belong to a component release;
            # registry carrier names remain global within their ecosystem.
            key = info.product + ":" + key
        if info.ecosystem == "internal":
            key += ":" + info.configuration
        if key in identities:
            fail("duplicate shipping identity " + key + " from " + identities[key] + " and " + str(target.label))
        identities[key] = str(target.label)
        if info.product in versions and versions[info.product] != info.version:
            fail("inconsistent shipping version for " + info.product)
        versions[info.product] = info.version
        packages.append({
            "product": info.product,
            "version": info.version,
            "ecosystem": info.ecosystem,
            "name": info.name,
            "configuration": info.configuration,
            "role": info.role,
            "outputs": [{"path": file.path, "owner": str(file.owner)} for file in info.files.to_list()],
        })
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode({"schema": "oliphaunt-bazel-shipping-v1", "scope": "construction", "packages": packages}) + "\n")
    return [DefaultInfo(files = depset([output]))]

shipping_export = rule(
    implementation = _shipping_export_impl,
    attrs = {"packages": attr.label_list(providers = [ShippingInfo], mandatory = True)},
)
