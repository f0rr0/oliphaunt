"""Expose authenticated public archive Files for guest import and family checksums."""

_ARCHIVE_ENV = "OLIPHAUNT_POSTMASTER_GUEST_ARCHIVE"
_RELEASE_ARCHIVES_ENV = "OLIPHAUNT_POSTMASTER_RELEASE_ARCHIVES"
_FAMILY_ARCHIVES_ENV = "OLIPHAUNT_NATIVE_RELEASE_ARCHIVES"

# The reviewed controller authenticates these bytes before import; this rule
# only validates and watches the actual regular Files.
def _import_archive(ctx, file, destination, imported, names):
    if not file.exists or file.is_dir or file.realpath != file:
        fail("release archive transport must contain regular non-symlink Files")
    if file.basename in names:
        fail("release archive transport repeats a public archive name: " + file.basename)
    names[file.basename] = True
    ctx.watch(file)
    ctx.symlink(file, destination)
    imported.append(destination)

def _guest_repository_impl(ctx):
    modules = ["bin/initdb", "bin/postgres"]
    for line in ctx.read(ctx.attr.side_modules).splitlines():
        if line and not line.startswith("#"):
            fields = line.split("\t")
            if len(fields) != 3 or not fields[0].startswith("lib/") or fields[0] in modules:
                fail("Invalid canonical postmaster side-module policy")
            modules.append(fields[0])
    ctx.file("guest.bzl", "POSTMASTER_GUEST_MODULE_PATHS = " + repr(modules) + "\n")
    release_archives = ctx.os.environ.get(_RELEASE_ARCHIVES_ENV, "")
    imported = []
    names = {}
    if release_archives:
        directory = ctx.path(release_archives)
        if not directory.exists or not directory.is_dir:
            fail(_RELEASE_ARCHIVES_ENV + " must name the authenticated final archive directory")
        ctx.watch(directory)
        for file in directory.readdir():
            _import_archive(ctx, file, "release-archives/" + file.basename, imported, names)
    families = ctx.os.environ.get(_FAMILY_ARCHIVES_ENV, "")
    if families:
        directory = ctx.path(families)
        if not directory.exists or not directory.is_dir:
            fail(_FAMILY_ARCHIVES_ENV + " must name the authenticated public archive families")
        ctx.watch(directory)
        for family in directory.readdir():
            if not family.is_dir or family.realpath != family:
                fail("release archive families must be regular product directories")
            ctx.watch(family)
            for file in family.readdir():
                _import_archive(ctx, file, "release-archives/" + family.basename + "/" + file.basename, imported, names)
    archive = ctx.os.environ.get(_ARCHIVE_ENV, "")
    declarations = 'package(default_visibility = ["//visibility:public"])\nfilegroup(name = "release_archives", srcs = %s)\n' % repr(imported)
    if not archive:
        ctx.file("BUILD.bazel", declarations + 'filegroup(name = "archive", srcs = [])\n')
        return
    path = ctx.path(archive)
    if not path.exists:
        fail(_ARCHIVE_ENV + " must name the authenticated regular public archive File")
    ctx.watch(path)
    ctx.symlink(path, path.basename)
    ctx.file("BUILD.bazel", declarations + 'filegroup(name = "archive", srcs = [%s])\n' % repr(path.basename))

postmaster_guest_repository = repository_rule(
    implementation = _guest_repository_impl,
    environ = [_ARCHIVE_ENV, _RELEASE_ARCHIVES_ENV, _FAMILY_ARCHIVES_ENV],
    configure = True,
    attrs = {"side_modules": attr.label(default = Label("//src/wasix/postmaster:wasmer/policies/sealed-side-modules.v1.tsv"), allow_single_file = True)},
)
