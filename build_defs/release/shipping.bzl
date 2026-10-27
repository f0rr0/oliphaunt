"""Construction outputs and declared ownership, not publication admission evidence."""

load("//build_defs/apple:slices.bzl", "apple_slice_groups")
load(":identity.bzl", "ReleaseIdentityInfo")
load(":supplier.bzl", "ShippingSupplierInfo")

ShippingInfo = provider(fields = ["product", "version", "ecosystem", "name", "configuration", "role", "files", "supplier_inputs"])
ShippingExportInfo = provider(fields = ["packages", "qualification", "policies"])

def _package(info):
    return {
        "product": info.product,
        "version": info.version,
        "ecosystem": info.ecosystem,
        "name": info.name,
        "configuration": info.configuration,
        "role": info.role,
        "supplierInputs": info.supplier_inputs,
        "outputs": [{"path": file.path, "owner": str(file.owner)} for file in info.files.to_list()],
    }

def _shipping_package_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    suppliers = ctx.attr.suppliers[ShippingSupplierInfo]
    if suppliers.suppliers == None:
        fail("shipping package requires explicit known supplier coverage")
    files = depset(transitive = [artifact[DefaultInfo].files for artifact in ctx.attr.artifacts])
    if not files.to_list():
        fail("shipping package must contain actual output files")
    info = ShippingInfo(
        product = owner.id,
        version = owner.version,
        ecosystem = ctx.attr.ecosystem,
        name = ctx.attr.package_name,
        configuration = ctx.attr.configuration,
        role = ctx.attr.role,
        files = files,
        supplier_inputs = suppliers.suppliers,
    )
    manifest = ctx.actions.declare_file(ctx.label.name + ".shipping.json")
    ctx.actions.write(manifest, json.encode({"label": str(ctx.label), "package": _package(info)}) + "\n")
    observation_inputs = depset(
        ctx.files.observation_inputs,
        transitive = [suppliers.files] + [
            target[OutputGroupInfo].observation_inputs
            for target in ctx.attr.observation_inputs
            if OutputGroupInfo in target and hasattr(target[OutputGroupInfo], "observation_inputs")
        ],
    )
    return [
        DefaultInfo(files = files),
        info,
        OutputGroupInfo(shipping_manifest = depset([manifest]), observation_inputs = observation_inputs, **apple_slice_groups(ctx.attr.artifacts)),
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
        "suppliers": attr.label(providers = [ShippingSupplierInfo], mandatory = True, doc = "Actual configured supplier Files; use //build_defs/release:no_suppliers to explicitly declare none. Unknown coverage is not a complete shipping package."),
        "observation_inputs": attr.label_list(allow_files = True, doc = "Original constructor values required by evidence capture, materialized in this same invocation."),
    },
)

def _shipping_export_impl(ctx):
    targets = list(ctx.attr.packages)
    tests = {str(target.label): target for target in ctx.attr.qualification}
    policies = []
    if targets:
        policies.append({
            "owner": str(ctx.label),
            "roots": [str(target.label) for target in targets],
            "qualification": [str(target.label) for target in ctx.attr.qualification],
        })
    for child in ctx.attr.exports:
        export = child[ShippingExportInfo]
        targets.extend(export.packages)
        policies.extend(export.policies)
        for target in export.qualification:
            tests[str(target.label)] = target
    if not targets:
        fail("shipping export must contain actual shipping packages")
    if ctx.attr.qualification and not ctx.attr.packages:
        fail("composed shipping qualification belongs to the source owner of its packages")
    packages = []
    identities = {}
    versions = {}
    for target in targets:
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
        packages.append(_package(info))
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode({
        "schema": "oliphaunt-bazel-shipping-v1",
        "scope": "construction",
        "owner": str(ctx.label),
        "roots": [str(target.label) for target in targets],
        "packages": packages,
        "qualification": sorted(tests.keys()),
        "policies": policies,
    }) + "\n")
    return [
        DefaultInfo(files = depset([output])),
        OutputGroupInfo(shipping_policy = depset([output]), **apple_slice_groups(targets)),
        ShippingExportInfo(packages = targets, qualification = tests.values(), policies = policies),
    ]

shipping_export = rule(
    implementation = _shipping_export_impl,
    attrs = {
        "packages": attr.label_list(providers = [ShippingInfo]),
        "exports": attr.label_list(providers = [ShippingExportInfo], doc = "Source-owned exports; each child's own root-to-test policy is retained."),
        "qualification": attr.label_list(
            doc = "Mandatory configured actual tests, including final installed consumers; set testonly = True on the export. Source/host unit tests retain that scope and do not replace installed runtime proof. Declare actual tests, including manual tests, rather than test_suite targets. Incompatible mandatory tests make the export incompatible; use select() only when the owner explicitly has no policy for that configuration.",
        ),
    },
)
