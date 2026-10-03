#ifndef _WIN32
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#ifndef _XOPEN_SOURCE
#define _XOPEN_SOURCE 700
#endif
#endif

#include "../include/oliphaunt.h"

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#ifdef _WIN32
#error "The retained cwd-boundary consumer probe currently targets Linux only."
#else
#include <unistd.h>
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#if defined(_MSC_VER)
#define OLIPHAUNT_SMOKE_THREAD_LOCAL __declspec(thread)
#else
#define OLIPHAUNT_SMOKE_THREAD_LOCAL _Thread_local
#endif

static OLIPHAUNT_SMOKE_THREAD_LOCAL char
    last_error_buffer[OLIPHAUNT_ERROR_CAPTURE_CAPACITY];

static const char *last_error_message(OliphauntHandle *handle) {
    (void)oliphaunt_copy_last_error(
        handle,
        last_error_buffer,
        sizeof(last_error_buffer));
    return last_error_buffer;
}

static const char direct_open_marker[] = "cwd-direct-open-relative.txt";
static const char direct_detach_marker[] = "cwd-direct-detach-relative.txt";
static const char fatal_marker[] = "cwd-startup-fatal-relative.txt";
static const char early_fatal_marker[] = "cwd-early-startup-fatal-relative.txt";
static const char unresolvable_close_marker[] = "cwd-unresolvable-close-relative.txt";
static const char renamed_close_marker[] = "cwd-renamed-close-relative.txt";
static const char missing_database[] = "oliphaunt_cwd_probe_missing_database";

static int fail(const char *context) {
    fprintf(stderr, "cwd boundary probe failed: %s\n", context);
    return 1;
}

static int fail_errno(const char *context) {
    fprintf(stderr, "cwd boundary probe failed: %s: %s\n", context, strerror(errno));
    return 1;
}

static int current_directory(char out[PATH_MAX]) {
    if (getcwd(out, PATH_MAX) == NULL) {
        return fail_errno("getcwd");
    }
    return 0;
}

static bool same_directory(const char *left, const char *right) {
    char resolved_left[PATH_MAX];
    char resolved_right[PATH_MAX];
    return realpath(left, resolved_left) != NULL &&
           realpath(right, resolved_right) != NULL &&
           strcmp(resolved_left, resolved_right) == 0;
}

static bool regular_file_exists(const char *path) {
    struct stat metadata;
    return stat(path, &metadata) == 0 && S_ISREG(metadata.st_mode);
}

static bool same_file_identity(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int joined_path(char out[PATH_MAX], const char *directory, const char *leaf) {
    int written = snprintf(out, PATH_MAX, "%s/%s", directory, leaf);
    if (written < 0 || written >= PATH_MAX) {
        return fail("joined path exceeds PATH_MAX");
    }
    return 0;
}

static int write_relative_marker(const char *leaf, const char *contents) {
    FILE *file = fopen(leaf, "wb");
    if (file == NULL) {
        return fail_errno("open relative host marker");
    }
    size_t length = strlen(contents);
    bool ok = fwrite(contents, 1, length, file) == length &&
              fflush(file) == 0 &&
              fsync(fileno(file)) == 0 &&
              fclose(file) == 0;
    if (!ok) {
        return fail_errno("write relative host marker");
    }
    return 0;
}

static void print_json_string(const char *value) {
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
        switch (*cursor) {
            case '"':
                fputs("\\\"", stdout);
                break;
            case '\\':
                fputs("\\\\", stdout);
                break;
            case '\b':
                fputs("\\b", stdout);
                break;
            case '\f':
                fputs("\\f", stdout);
                break;
            case '\n':
                fputs("\\n", stdout);
                break;
            case '\r':
                fputs("\\r", stdout);
                break;
            case '\t':
                fputs("\\t", stdout);
                break;
            default:
                if (*cursor < 0x20) {
                    fprintf(stdout, "\\u%04x", (unsigned int)*cursor);
                } else {
                    putchar((int)*cursor);
                }
                break;
        }
    }
    putchar('"');
}

static OliphauntConfig config_for(
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir,
    const char *database) {
    OliphauntConfig config = {
        .abi_version = OLIPHAUNT_ABI_VERSION,
        .pgdata = pgdata,
        .runtime_dir = runtime_dir,
        .module_dir = module_dir,
        .username = "postgres",
        .database = database,
        .flags = 0,
        .startup_args = NULL,
        .startup_arg_count = 0,
    };
    return config;
}

static int run_direct(const char *pgdata, const char *runtime_dir, const char *module_dir) {
    char original_cwd[PATH_MAX];
    char open_cwd[PATH_MAX];
    char detach_cwd[PATH_MAX];
    char close_cwd[PATH_MAX];
    char open_expected[PATH_MAX];
    char open_wrong[PATH_MAX];
    char detach_expected[PATH_MAX];
    char detach_wrong[PATH_MAX];
    OliphauntHandle *handle = NULL;

    if (current_directory(original_cwd) != 0 ||
        joined_path(open_expected, pgdata, direct_open_marker) != 0 ||
        joined_path(open_wrong, original_cwd, direct_open_marker) != 0 ||
        joined_path(detach_expected, pgdata, direct_detach_marker) != 0 ||
        joined_path(detach_wrong, original_cwd, direct_detach_marker) != 0) {
        return 1;
    }

    OliphauntConfig config = config_for(pgdata, runtime_dir, module_dir, "postgres");
    if (oliphaunt_init(&config, &handle) != 0 || handle == NULL) {
        fprintf(stderr, "oliphaunt_init failed: %s\n", last_error_message(handle));
        return 1;
    }
    if (current_directory(open_cwd) != 0 || !same_directory(open_cwd, pgdata)) {
        (void)oliphaunt_close(handle);
        return fail("Direct open did not leave the host process cwd at PGDATA");
    }
    if (regular_file_exists(open_wrong)) {
        (void)oliphaunt_close(handle);
        return fail("Direct-open marker already exists at the host sentinel");
    }
    if (write_relative_marker(direct_open_marker, "written after Direct open\n") != 0 ||
        !regular_file_exists(open_expected) ||
        regular_file_exists(open_wrong)) {
        (void)oliphaunt_close(handle);
        return fail("relative host I/O after Direct open did not resolve under PGDATA");
    }

    if (oliphaunt_detach(handle) != 0) {
        fprintf(stderr, "oliphaunt_detach failed: %s\n", last_error_message(handle));
        (void)oliphaunt_close(handle);
        return 1;
    }
    if (current_directory(detach_cwd) != 0 || !same_directory(detach_cwd, pgdata)) {
        (void)oliphaunt_close(handle);
        return fail("Direct detach unexpectedly restored the process cwd");
    }
    if (regular_file_exists(detach_wrong)) {
        (void)oliphaunt_close(handle);
        return fail("Direct-detach marker already exists at the host sentinel");
    }
    if (write_relative_marker(direct_detach_marker, "written after Direct detach\n") != 0 ||
        !regular_file_exists(detach_expected) ||
        regular_file_exists(detach_wrong)) {
        (void)oliphaunt_close(handle);
        return fail("relative host I/O after Direct detach did not resolve under PGDATA");
    }

    if (oliphaunt_close(handle) != 0) {
        return fail("terminal Direct close failed");
    }
    handle = NULL;
    if (current_directory(close_cwd) != 0 || !same_directory(close_cwd, original_cwd)) {
        return fail("terminal Direct close did not restore the original host cwd");
    }

    fputs("{\"schema\":\"oliphaunt-native-cwd-boundary-child-v1\",\"mode\":\"direct\",", stdout);
    fputs("\"originalCwd\":", stdout);
    print_json_string(original_cwd);
    fputs(",\"cwdAfterOpen\":", stdout);
    print_json_string(open_cwd);
    fputs(",\"openRelativePath\":", stdout);
    print_json_string(open_expected);
    fputs(",\"cwdAfterDetach\":", stdout);
    print_json_string(detach_cwd);
    fputs(",\"detachRelativePath\":", stdout);
    print_json_string(detach_expected);
    fputs(",\"cwdAfterTerminalClose\":", stdout);
    print_json_string(close_cwd);
    fputs(",\"openMutatesProcessCwd\":true,\"detachPreservesMutation\":true,", stdout);
    fputs("\"terminalCloseRestoresCwd\":true}\n", stdout);
    return 0;
}

static int run_startup_fatal(
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir) {
    char original_cwd[PATH_MAX];
    char failure_cwd[PATH_MAX];
    char expected_marker[PATH_MAX];
    char wrong_marker[PATH_MAX];
    char error[1024];
    OliphauntHandle *handle = NULL;

    if (current_directory(original_cwd) != 0 ||
        joined_path(expected_marker, original_cwd, fatal_marker) != 0 ||
        joined_path(wrong_marker, pgdata, fatal_marker) != 0) {
        return 1;
    }
    if (regular_file_exists(expected_marker) || regular_file_exists(wrong_marker)) {
        return fail("startup-FATAL marker already exists");
    }

    OliphauntConfig config = config_for(pgdata, runtime_dir, module_dir, missing_database);
    int32_t rc = oliphaunt_init(&config, &handle);
    if (rc == 0 || handle != NULL) {
        if (handle != NULL) {
            (void)oliphaunt_close(handle);
        }
        return fail("missing-database startup unexpectedly succeeded");
    }
    const char *last_error = last_error_message(NULL);
    snprintf(error, sizeof(error), "%s", last_error != NULL ? last_error : "(null)");
    if (strstr(error, "before ReadyForQuery") == NULL) {
        fprintf(stderr, "unexpected missing-database startup error: %s\n", error);
        return fail("startup failure was not terminal before ReadyForQuery");
    }
    if (current_directory(failure_cwd) != 0 || !same_directory(failure_cwd, original_cwd)) {
        return fail("startup FATAL did not restore the original host cwd");
    }
    if (write_relative_marker(fatal_marker, "written after startup FATAL\n") != 0 ||
        !regular_file_exists(expected_marker) ||
        regular_file_exists(wrong_marker)) {
        return fail("relative host I/O after startup FATAL did not resolve under the original cwd");
    }

    fputs("{\"schema\":\"oliphaunt-native-cwd-boundary-child-v1\",", stdout);
    fputs("\"mode\":\"startup-fatal\",\"database\":", stdout);
    print_json_string(missing_database);
    fputs(",\"originalCwd\":", stdout);
    print_json_string(original_cwd);
    fputs(",\"cwdAfterFailure\":", stdout);
    print_json_string(failure_cwd);
    fputs(",\"relativePathAfterFailure\":", stdout);
    print_json_string(expected_marker);
    fputs(",\"publicAbiError\":", stdout);
    print_json_string(error);
    fputs(",\"failedBeforeReadyForQuery\":true,\"startupFatalRestoresCwd\":true}\n", stdout);
    return 0;
}

static int run_early_startup_fatal(
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir) {
    /* Valid ABI syntax reaches PostgreSQL's early startup parser. */
    static const char *const startup_args[] = {"-c", "shared_buffers=not-a-size"};
    char original_cwd[PATH_MAX];
    char failure_cwd[PATH_MAX];
    char expected_marker[PATH_MAX];
    char wrong_marker[PATH_MAX];
    char error[1024];
    OliphauntHandle *handle = NULL;

    if (current_directory(original_cwd) != 0 ||
        joined_path(expected_marker, original_cwd, early_fatal_marker) != 0 ||
        joined_path(wrong_marker, pgdata, early_fatal_marker) != 0) {
        return 1;
    }
    if (regular_file_exists(expected_marker) || regular_file_exists(wrong_marker)) {
        return fail("early-startup-FATAL marker already exists");
    }

    OliphauntConfig config = config_for(pgdata, runtime_dir, module_dir, "postgres");
    config.startup_args = startup_args;
    config.startup_arg_count = sizeof(startup_args) / sizeof(startup_args[0]);
    int32_t rc = oliphaunt_init(&config, &handle);
    if (rc == 0 || handle != NULL) {
        if (handle != NULL) {
            (void)oliphaunt_close(handle);
        }
        return fail("invalid startup GUC value unexpectedly succeeded");
    }
    const char *last_error = last_error_message(NULL);
    snprintf(error, sizeof(error), "%s", last_error != NULL ? last_error : "(null)");
    if (strstr(error, "before ReadyForQuery") == NULL) {
        fprintf(stderr, "unexpected early startup error: %s\n", error);
        return fail("early startup failure was not terminal before ReadyForQuery");
    }
    if (current_directory(failure_cwd) != 0 || !same_directory(failure_cwd, original_cwd)) {
        return fail("early startup FATAL changed the original host cwd");
    }
    if (write_relative_marker(early_fatal_marker, "written after early startup FATAL\n") != 0 ||
        !regular_file_exists(expected_marker) ||
        regular_file_exists(wrong_marker)) {
        return fail("relative host I/O after early startup FATAL escaped the original cwd");
    }

    fputs("{\"schema\":\"oliphaunt-native-cwd-boundary-child-v1\",", stdout);
    fputs("\"mode\":\"early-startup-fatal\",\"injectedStartupGuc\":\"shared_buffers=not-a-size\",", stdout);
    fputs("\"configuredDatabase\":\"postgres\",\"originalCwd\":", stdout);
    print_json_string(original_cwd);
    fputs(",\"cwdAfterFailure\":", stdout);
    print_json_string(failure_cwd);
    fputs(",\"relativePathAfterFailure\":", stdout);
    print_json_string(expected_marker);
    fputs(",\"publicAbiError\":", stdout);
    print_json_string(error);
    fputs(",\"failedBeforeReadyForQuery\":true,\"earlyFatalCwdPreserved\":true}\n", stdout);
    return 0;
}

static int run_unresolvable_cwd(
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir,
    const char *expected_cwd) {
    char original_cwd[PATH_MAX];
    char open_cwd[PATH_MAX];
    char close_cwd[PATH_MAX];
    char relative_path[PATH_MAX];
    char error[1024];
    OliphauntHandle *handle = NULL;

    if (current_directory(original_cwd) != 0 || !same_directory(original_cwd, expected_cwd)) {
        return fail("unresolvable-cwd child did not start in its exact owned sentinel");
    }
    if (strcmp(original_cwd, "/") == 0 || strlen(original_cwd) < 16) {
        return fail("refusing to remove an unsafe cwd sentinel");
    }
    if (rmdir(expected_cwd) != 0) {
        return fail_errno("remove exact owned cwd sentinel");
    }
    errno = 0;
    char unavailable[PATH_MAX];
    if (getcwd(unavailable, sizeof(unavailable)) != NULL || errno != ENOENT) {
        return fail("deleted cwd did not make getcwd fail with ENOENT");
    }

    OliphauntConfig config = config_for(pgdata, runtime_dir, module_dir, "postgres");
    int32_t rc = oliphaunt_init(&config, &handle);
    if (rc != 0 || handle == NULL) {
        const char *last_error = last_error_message(NULL);
        snprintf(error, sizeof(error), "%s", last_error != NULL ? last_error : "(null)");
        fputs("{\"schema\":\"oliphaunt-native-cwd-boundary-child-v1\",", stdout);
        fputs("\"mode\":\"unresolvable-cwd\",\"deletedOriginalCwd\":", stdout);
        print_json_string(original_cwd);
        fputs(",\"publicAbiError\":", stdout);
        print_json_string(error);
        fputs(",\"getcwdFailedBeforeOpen\":true,\"initRejectedUnrestorableCwd\":true,", stdout);
        fputs("\"contractSatisfied\":true}\n", stdout);
        return 0;
    }

    if (current_directory(open_cwd) != 0 || !same_directory(open_cwd, pgdata)) {
        (void)oliphaunt_close(handle);
        return fail("Direct open from an unresolvable cwd did not reach PGDATA");
    }
    if (oliphaunt_close(handle) != 0) {
        return fail("terminal close after unresolvable-cwd Direct open failed");
    }
    handle = NULL;
    if (current_directory(close_cwd) != 0 || !same_directory(close_cwd, pgdata)) {
        return fail("unexpected cwd after terminal close from an unresolvable cwd");
    }
    if (write_relative_marker(unresolvable_close_marker, "written after unrestorable Direct close\n") != 0 ||
        joined_path(relative_path, pgdata, unresolvable_close_marker) != 0 ||
        !regular_file_exists(relative_path)) {
        return fail("relative I/O after unrestorable Direct close did not remain under PGDATA");
    }

    fputs("{\"schema\":\"oliphaunt-native-cwd-boundary-child-v1\",", stdout);
    fputs("\"mode\":\"unresolvable-cwd\",\"deletedOriginalCwd\":", stdout);
    print_json_string(original_cwd);
    fputs(",\"cwdAfterOpen\":", stdout);
    print_json_string(open_cwd);
    fputs(",\"cwdAfterTerminalClose\":", stdout);
    print_json_string(close_cwd);
    fputs(",\"relativePathAfterClose\":", stdout);
    print_json_string(relative_path);
    fputs(",\"getcwdFailedBeforeOpen\":true,\"initAcceptedUnrestorableCwd\":true,", stdout);
    fputs("\"terminalCloseRestoredCwd\":false,\"contractSatisfied\":false}\n", stdout);
    return 0;
}

static int run_renamed_cwd(
    const char *pgdata,
    const char *runtime_dir,
    const char *module_dir,
    const char *expected_cwd,
    const char *renamed_cwd) {
    char open_cwd[PATH_MAX];
    char close_cwd[PATH_MAX];
    char restored_marker[PATH_MAX];
    char replacement_marker[PATH_MAX];
    struct stat original_identity;
    struct stat renamed_identity;
    struct stat replacement_identity;
    struct stat restored_identity;
    OliphauntHandle *handle = NULL;

    if (!same_directory(".", expected_cwd)) {
        return fail("renamed-cwd child did not start in its exact owned sentinel");
    }
    if (strcmp(expected_cwd, "/") == 0 || strlen(expected_cwd) < 16 ||
        strcmp(renamed_cwd, "/") == 0 || strlen(renamed_cwd) < 16) {
        return fail("refusing unsafe renamed-cwd sentinel paths");
    }
    if (stat(".", &original_identity) != 0) {
        return fail_errno("stat original cwd identity");
    }

    OliphauntConfig config = config_for(pgdata, runtime_dir, module_dir, "postgres");
    if (oliphaunt_init(&config, &handle) != 0 || handle == NULL) {
        fprintf(stderr, "oliphaunt_init failed: %s\n", last_error_message(handle));
        return 1;
    }
    if (current_directory(open_cwd) != 0 || !same_directory(open_cwd, pgdata)) {
        (void)oliphaunt_close(handle);
        return fail("renamed-cwd Direct open did not leave process cwd at PGDATA");
    }

    if (rename(expected_cwd, renamed_cwd) != 0) {
        (void)oliphaunt_close(handle);
        return fail_errno("rename exact owned cwd sentinel");
    }
    if (mkdir(expected_cwd, 0700) != 0) {
        (void)oliphaunt_close(handle);
        return fail_errno("create replacement at original cwd pathname");
    }
    if (stat(renamed_cwd, &renamed_identity) != 0 ||
        stat(expected_cwd, &replacement_identity) != 0) {
        (void)oliphaunt_close(handle);
        return fail_errno("stat renamed and replacement cwd identities");
    }
    if (!same_file_identity(&original_identity, &renamed_identity) ||
        same_file_identity(&original_identity, &replacement_identity)) {
        (void)oliphaunt_close(handle);
        return fail("cwd rename/replacement did not create the intended identity discriminator");
    }

    if (oliphaunt_close(handle) != 0) {
        return fail("terminal close after cwd rename/replacement failed");
    }
    handle = NULL;
    if (stat(".", &restored_identity) != 0 ||
        !same_file_identity(&restored_identity, &original_identity)) {
        return fail("terminal close restored a pathname replacement instead of cwd identity");
    }
    if (current_directory(close_cwd) != 0 || !same_directory(close_cwd, renamed_cwd)) {
        return fail("terminal close did not resolve to the renamed original cwd");
    }
    if (joined_path(restored_marker, renamed_cwd, renamed_close_marker) != 0 ||
        joined_path(replacement_marker, expected_cwd, renamed_close_marker) != 0 ||
        write_relative_marker(renamed_close_marker, "written after identity-safe Direct close\n") != 0 ||
        !regular_file_exists(restored_marker) || regular_file_exists(replacement_marker)) {
        return fail("relative I/O after terminal close targeted the pathname replacement");
    }

    fputs("{\"schema\":\"oliphaunt-native-cwd-boundary-child-v1\",", stdout);
    fputs("\"mode\":\"renamed-cwd\",\"originalPath\":", stdout);
    print_json_string(expected_cwd);
    fputs(",\"renamedOriginalPath\":", stdout);
    print_json_string(renamed_cwd);
    fputs(",\"cwdAfterOpen\":", stdout);
    print_json_string(open_cwd);
    fputs(",\"cwdAfterTerminalClose\":", stdout);
    print_json_string(close_cwd);
    fputs(",\"relativePathAfterClose\":", stdout);
    print_json_string(restored_marker);
    fprintf(stdout,
            ",\"originalDevice\":\"%" PRIuMAX "\",\"originalInode\":\"%" PRIuMAX "\",",
            (uintmax_t)original_identity.st_dev,
            (uintmax_t)original_identity.st_ino);
    fputs("\"pathWasReplaced\":true,\"terminalCloseRestoredIdentity\":true,", stdout);
    fputs("\"relativeIoUsedRenamedOriginal\":true,\"contractSatisfied\":true}\n", stdout);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 5 || argc > 7) {
        fprintf(stderr, "usage: %s <direct|startup-fatal|early-startup-fatal|unresolvable-cwd|renamed-cwd> <pgdata> <runtime-dir> <module-dir> [owned-cwd [renamed-cwd]]\n", argv[0]);
        return 2;
    }
    if (strcmp(argv[1], "unresolvable-cwd") == 0) {
        if (argc != 6) {
            return fail("unresolvable-cwd mode requires its exact owned cwd sentinel");
        }
        return run_unresolvable_cwd(argv[2], argv[3], argv[4], argv[5]);
    }
    if (strcmp(argv[1], "renamed-cwd") == 0) {
        if (argc != 7) {
            return fail("renamed-cwd mode requires exact original and renamed cwd sentinels");
        }
        return run_renamed_cwd(argv[2], argv[3], argv[4], argv[5], argv[6]);
    }
    if (argc != 5) {
        return fail("unexpected exact-owned-cwd argument for this probe mode");
    }
    if (strcmp(argv[1], "direct") == 0) {
        return run_direct(argv[2], argv[3], argv[4]);
    }
    if (strcmp(argv[1], "startup-fatal") == 0) {
        return run_startup_fatal(argv[2], argv[3], argv[4]);
    }
    if (strcmp(argv[1], "early-startup-fatal") == 0) {
        return run_early_startup_fatal(argv[2], argv[3], argv[4]);
    }
    return fail("unknown probe mode");
}
