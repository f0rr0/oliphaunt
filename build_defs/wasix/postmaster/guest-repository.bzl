"""Expose only the authenticated canonical Linux public archive as a declared File."""

_ARCHIVE_ENV = "OLIPHAUNT_POSTMASTER_GUEST_ARCHIVE"
_RELEASE_ARCHIVES_ENV = "OLIPHAUNT_POSTMASTER_RELEASE_ARCHIVES"

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
    if release_archives:
        directory = ctx.path(release_archives)
        if not directory.exists:
            fail(_RELEASE_ARCHIVES_ENV + " must name the authenticated final archive directory")
        ctx.watch(directory)
        for file in directory.readdir():
            ctx.watch(file)
            destination = "release-archives/" + file.basename
            ctx.symlink(file, destination)
            imported.append(destination)
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
    environ = [_ARCHIVE_ENV, _RELEASE_ARCHIVES_ENV],
    configure = True,
    attrs = {"side_modules": attr.label(default = Label("//src/wasix/postmaster:wasmer/policies/sealed-side-modules.v1.tsv"), allow_single_file = True)},
)
