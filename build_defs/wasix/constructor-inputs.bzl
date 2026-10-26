"""Original constructor routing and source-owned internal transport roots."""

load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_CURRENT_ARTIFACTS")
load("//build_defs/release:shipping.bzl", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo")
load(":platform.bzl", "wasix_artifact")

_PHASE_ENV = "OLIPHAUNT_WASIX_CONSTRUCTOR_PHASE"

def _repository_impl(ctx):
    helper = ctx.path(ctx.attr.projector)
    ctx.read(helper)
    ctx.watch(ctx.path(ctx.attr.bun))
    ctx.file("current.json", json.encode(NATIVE_CURRENT_ARTIFACTS))
    phase = ctx.os.environ.get(_PHASE_ENV, "source")
    result = ctx.execute([
        str(ctx.path(ctx.attr.bun)), str(helper), phase,
        str(ctx.path("current.json")), str(ctx.path("inputs.json")),
    ], timeout = 30)
    if result.return_code:
        fail("WASIX constructor routing failed:\n" + result.stdout + result.stderr)
    inputs = json.decode(ctx.read("inputs.json"))
    ctx.file("inputs.bzl", "\n".join([
        "PHASE = " + repr(inputs["phase"]),
        "MODULES = " + repr(inputs["modules"]),
        "AOT_IMAGES = " + repr(inputs["aotImages"]),
        "",
    ]))
    ctx.file("BUILD.bazel", "exports_files([\"inputs.bzl\"])\n")

wasix_constructor_inputs_repository = repository_rule(
    implementation = _repository_impl,
    environ = [_PHASE_ENV],
    configure = True,
    attrs = {
        "bun": attr.label(allow_single_file = True, mandatory = True),
        "projector": attr.label(allow_single_file = True, default = Label("//build_defs/wasix:constructor-inputs.mts")),
    },
)

def constructor_source_label(value):
    """Resolve caller-relative source labels without resolving against this .bzl package."""
    value = str(value)
    if value.startswith("@@//"):
        value = value[2:]
    elif value.startswith("@//"):
        value = value[1:]
    if value.startswith(":"):
        value = "//" + native.package_name() + value
    elif not value.startswith("//"):
        fail("constructor requires a main-repository source label: " + value)
    if len(value.split(":")) != 2 or not value.split(":")[1]:
        fail("constructor requires an explicit source target: " + value)
    for char in value.elems():
        if char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:+-":
            fail("unsupported constructor source label: " + value)
    return value

def _constructor_name(kind, label):
    value = constructor_source_label(label)[2:]
    return "wasix-" + kind + "-" + value.replace("_", "_u").replace("/", "_s").replace(":", "_c").replace("+", "_p")

def imported_constructor_supplier(file, record):
    """Keep the authenticated original producer tuple on the File actually consumed."""
    if not file.is_source or file.is_directory or not file.short_path.startswith("../"):
        fail("constructor import requires an original external regular File")
    return ShippingSupplierInfo(
        suppliers = [{
            "product": record["product"], "version": record["version"],
            "configuration": record["configuration"], "binding": "compiled-input",
            "origin": {"kind": "current-source", "producer": record["file"]["producer"]},
            "files": [{"path": file.path}],
        }],
        files = depset([file]),
    )

def _missing_impl(ctx):
    fail("WASIX " + ctx.attr.phase + " phase is missing " + ctx.attr.kind + " constructor " + ctx.attr.source)

missing_constructor = rule(
    implementation = _missing_impl,
    attrs = {"phase": attr.string(), "kind": attr.string(), "source": attr.string()},
)

def _constructor_suppliers_impl(ctx):
    info = ctx.attr.artifact[ShippingSupplierInfo]
    return [DefaultInfo(files = info.files), info]

_constructor_suppliers = rule(
    implementation = _constructor_suppliers_impl,
    attrs = {"artifact": attr.label(providers = [ShippingSupplierInfo], mandatory = True)},
)

def _constructor(name, artifact, source, owner, kind, configuration, **kwargs):
    suppliers = name + "_suppliers"
    _constructor_suppliers(name = suppliers, artifact = artifact, tags = ["manual"])
    shipping_package(
        name = name,
        owner = owner,
        artifacts = [artifact],
        ecosystem = "internal",
        package_name = _constructor_name(kind, source),
        configuration = configuration,
        role = "constructor-input",
        suppliers = ":" + suppliers,
        **kwargs
    )

def wasix_module_constructor(name, module, owner, configuration = "portable", **kwargs):
    """Export the optimized portable File through the normal WASIX transition."""
    artifact = name + "_portable"
    wasix_artifact(name = artifact, artifact = module, tags = ["manual"])
    _constructor(name, ":" + artifact, module, owner, "module", configuration, **kwargs)

def wasix_aot_constructor(name, image, owner, configuration, **kwargs):
    """Export the actual serializer output; source/host compatibility stays on its rule."""
    _constructor(name, image, image, owner, "aot", configuration, **kwargs)
