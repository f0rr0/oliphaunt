"""Actual configured supplier Files; construction data, never admission."""

load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@rules_rust//rust:defs.bzl", "rust_common")
load(":identity.bzl", "ReleaseIdentityInfo")

ShippingSupplierInfo = provider(fields = ["suppliers", "files"])

def _rust_supplier_impl(ctx):
    crate = ctx.attr.producer[rust_common.crate_info]
    # Registry source incorporation is separate from the core loaded at runtime.
    files = {file.path: file for file in crate.srcs.to_list()}
    manifests = [file for file in crate.compile_data.to_list() if file.basename == "Cargo.toml" and file.dirname == crate.root.dirname.removesuffix("/src")]
    if len(manifests) != 1:
        fail("registry Rust supplier requires its actual source Cargo.toml")
    files[manifests[0].path] = manifests[0]
    declarations = []
    for file in files.values():
        if file.is_directory or not file.short_path.startswith("../"):
            fail("held Rust supplier requires actual external source Files")
        declarations.append({"path": file.path, "member": "/".join(file.short_path.split("/")[2:])})
    suppliers = None
    if ctx.attr.origin:
        owner = ctx.attr.owner[ReleaseIdentityInfo]
        origin = json.decode(ctx.attr.origin)
        publication = origin.get("publication", {})
        if origin.get("kind") != "completed-publication" or publication.get("product") != owner.id:
            fail("held Rust supplier requires its exact completed release owner")
        suppliers = [{"product": owner.id, "version": publication["version"], "configuration": "portable",
                      "binding": "compiled-input", "origin": origin, "files": declarations}]
    info = ShippingSupplierInfo(suppliers = suppliers, files = depset(files.values()))
    return [DefaultInfo(files = info.files), info]

rust_shipping_supplier = rule(
    implementation = _rust_supplier_impl,
    attrs = {
        "producer": attr.label(providers = [rust_common.crate_info], mandatory = True),
        "owner": attr.label(providers = [ReleaseIdentityInfo], mandatory = True),
        "origin": attr.string(doc = "Completed registry carrier facts from the authenticated per-run snapshot; omission stays unknown."),
    },
)

def _cc_supplier_impl(ctx):
    producer = ctx.attr.producer
    files = {}
    for linker_input in producer[CcInfo].linking_context.linker_inputs.to_list():
        # Only this producer's library, not its transitive tool/dependency Files.
        if linker_input.owner != producer.label:
            continue
        for library in linker_input.libraries:
            dynamic = library.resolved_symlink_interface_library or library.interface_library or library.resolved_symlink_dynamic_library or library.dynamic_library
            static = library.pic_static_library or library.static_library
            if dynamic and static:
                fail("supplier requires an unambiguous dynamic or static library File: " + str(producer.label))
            file = dynamic or static
            if file:
                # An archive in CcInfo may merely forward transitive libraries.
                # Its final embedding action must prove incorporation separately.
                files[file.path] = struct(file = file, binding = "abi-contract" if dynamic else None)
    if len(files) != 1:
        fail("supplier requires one actual library File owned by its CcInfo producer: " + str(producer.label))
    selected = files.values()[0]
    file = selected.file
    if file.is_directory:
        fail("supplier must be a regular library File")
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    origin = {"kind": "current-source"}
    declaration = {"path": file.path}
    if ctx.attr.completed_publication:
        publication = ctx.attr.completed_publication
        if sorted(publication) != sorted(["product", "version", "tagName", "publicationSha", "publicationTree", "releaseSha"]):
            fail("held supplier requires exact existing completed publication fields")
        if publication["product"] != owner.id or publication["version"] != owner.version or publication["tagName"] != owner.id + "-v" + owner.version:
            fail("held supplier differs from its release identity")
        if not ctx.attr.artifact or not ctx.attr.member:
            fail("held supplier requires its canonical archive and exact member")
        origin = {"kind": "completed-publication", "publication": publication, "artifact": ctx.attr.artifact}
        declaration["member"] = ctx.attr.member
    elif ctx.attr.artifact or ctx.attr.member:
        fail("current supplier cannot assert a published archive member")
    info = ShippingSupplierInfo(
        suppliers = [{"product": owner.id, "version": owner.version, "configuration": ctx.attr.configuration, "binding": selected.binding, "origin": origin, "files": [declaration]}] if selected.binding else None,
        files = depset([file]),
    )
    # Consumers can use this target as the actual C dependency. No copying,
    # compilation, identity stamping, or replacement linking context is added.
    return [DefaultInfo(files = info.files), producer[CcInfo], info]

cc_shipping_supplier = rule(
    implementation = _cc_supplier_impl,
    attrs = {
        "producer": attr.label(providers = [CcInfo], mandatory = True),
        "owner": attr.label(providers = [ReleaseIdentityInfo], mandatory = True),
        "configuration": attr.string(mandatory = True),
        "completed_publication": attr.string_dict(),
        "artifact": attr.string(),
        "member": attr.string(),
    },
)

def merge_shipping_suppliers(inputs):
    """Shared member inputs may reference the same actual supplier repeatedly."""
    suppliers = {}
    for info in inputs:
        if info.suppliers == None:
            return ShippingSupplierInfo(suppliers = None, files = depset(transitive = [item.files for item in inputs]))
        for supplier in info.suppliers:
            suppliers[json.encode(supplier)] = supplier
    return ShippingSupplierInfo(suppliers = suppliers.values(), files = depset(transitive = [info.files for info in inputs]))

def _suppliers_impl(ctx):
    info = merge_shipping_suppliers([target[ShippingSupplierInfo] for target in ctx.attr.inputs])
    return [
        DefaultInfo(files = info.files),
        info,
    ]

shipping_suppliers = rule(
    implementation = _suppliers_impl,
    attrs = {"inputs": attr.label_list(providers = [ShippingSupplierInfo])},
)

def _file_supplier_impl(ctx):
    files = []
    declarations = []
    for target, member in ctx.attr.inputs.items():
        selected = target[DefaultInfo].files.to_list()
        if len(selected) != 1 or selected[0].is_directory:
            fail("supplier requires its exact declared regular File")
        file = selected[0]
        files.append(file)
        declaration = {"path": file.path}
        if member:
            declaration["member"] = member
        elif ctx.attr.binding != "abi-contract":
            fail("compiled imported supplier requires its exact archive member")
        declarations.append(declaration)
    if not files:
        fail("supplier requires nonempty actual File inputs")
    suppliers = None
    if ctx.attr.origin:
        owner = ctx.attr.owner[ReleaseIdentityInfo]
        origin = json.decode(ctx.attr.origin)
        version = owner.version
        if origin.get("kind") == "completed-publication":
            publication = origin.get("publication", {})
            if publication.get("product") != owner.id:
                fail("held supplier differs from its release owner")
            version = publication.get("version")
        suppliers = [{"product": owner.id, "version": version,
                      "configuration": ctx.attr.configuration, "binding": ctx.attr.binding,
                      "origin": origin, "files": declarations}]
    info = ShippingSupplierInfo(suppliers = suppliers, files = depset(files))
    return [DefaultInfo(files = info.files, runfiles = ctx.runfiles(files = files)), info]

file_shipping_supplier = rule(
    implementation = _file_supplier_impl,
    attrs = {
        "inputs": attr.label_keyed_string_dict(allow_files = True, mandatory = True,
            doc = "Actual single File targets mapped to original archive member paths; empty member means an ABI contract for the whole published archive."),
        "owner": attr.label(providers = [ReleaseIdentityInfo], mandatory = True),
        "configuration": attr.string(mandatory = True),
        "binding": attr.string(values = ["compiled-input", "abi-contract"], mandatory = True),
        "origin": attr.string(doc = "Typed original producer/completed publication facts; omission retains unknown supplier coverage."),
    },
)
