"""Release identity data, independent of all payload construction."""

ReleaseIdentityInfo = provider(fields = ["id", "version"])

def _release_identity_impl(ctx):
    if not ctx.attr.product_id or not ctx.attr.version:
        fail("release identity requires a product id and selected version")
    return [ReleaseIdentityInfo(id = ctx.attr.product_id, version = ctx.attr.version)]

release_identity = rule(
    implementation = _release_identity_impl,
    attrs = {
        "product_id": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
    },
)
