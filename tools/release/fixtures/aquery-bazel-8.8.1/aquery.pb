-'//src/query/ts:node_modules/@types/node82@@aspect_rules_ts++typescript+npm_typescript//:tsc
//src/query/ts:moduleLF@@aspect_rules_ts++typescript+npm_typescript//:node_modules/typescript?9@@aspect_rules_ts++typescript+npm_typescript//:tsc_worker:_write_file:	_bun_test:query_envelope//src/query/ts:npm//src/query/ts:unit_testA;@@aspect_rules_ts++typescript+npm_typescript//:package_json:npm_link_package_store.(//src/query/ts:node_modules/undici-types:	sh_binary0*@@bazel_tools//tools/test:collect_coverage:	js_binary:shipping_package%//src/query/ts:shipping_package:	npm_package_store>8//src/query/ts:.aspect_rules_js/node_modules/@types/node	>8@@aspect_rules_ts++typescript+npm_typescript//:validator:

_copy_fileKE@@aspect_rules_ts++typescript+npm_typescript//:copy_ts_project_worker
:
ts_project	//src/query/ts:commonjs*gk8-opt-exec-ST-d57f47055a04k8"@ed5797a767b96f3a1479df6c05824854fc306bea605a92620af0492ebf871581(*Vk8-fastbuildk8"@0db2b318338ce09df9dbfeda423511d29dd37e81a4519b8ba56a33ac4076bea9*Vk8-fastbuildk8"@f55cd0755219b272bb7b1eeb31dd83dd10bc8c00329f25764eb9ea725eeff190B	bazel-outBexternalB node_modulesBaspect_rules_js+Bnode_modulesB)#unit_test.sources__main_config.jsonB!+languages+query_types_nodeB!#k8-opt-exec-ST-d57f47055a04B
typescript BjsB$tsc_worker_Bpackage.tgzB&bazel_toolsBk8-fastbuildB
tsc_worker$B%tools&Bundici-typesB
test%BprivateB1"+bazel_lib++toolchains+coreutils_linux_amd64B	js_binary.sh.tplB'@typesB
node'

B*aspect_rules_ts+B)ts*
B	coreutils"B(private)
	Bts_project_worker.js(
	
B/src≤@4d9f7a6fa4b2d6886c15eff907d69edd61b690860173627ee16c1e9beb1cf1ab"UnresolvedSymlink(Jhr@@platforms//host:hostí9.aspect_rules_js/typescript@6.0.3/node_modules/typescript
n@1b76ff913898d2090b4b9aad252df73f4f29c85df9eec6f34421575c00cf6810"	FileWrite(Jhr@@platforms//host:hostB802tar.bzl++toolchains+bsd_tar_toolchains_linux_amd64B	,tar0
,"
B5.aspect_rules_jsB4@types+node@24.12.45B3node_modules4B2@types3B
1node2"
1π@54822de1b9155ce110e6c1afbc6d7402098b56f37a78e23f5a1062d5442543f6"UnresolvedSymlink(J	h	r@@platforms//host:hostí@../.aspect_rules_js/@types+node@24.12.4/node_modules/@types/nodeB6ts_project_worker.js
6®@e196a0eb8ceb7641c504d13dfd062102e125ba5c01264de885de0e8516275a32"NpmPackageExtract(:
LC_ALLC.UTF-8BJZ
supports-path-mapping1hr@@platforms//host:hosto@7a39b61d5744a8903119e17b3ddc7e56e330f240d2bead98c3ba081a81b5c9ac"Symlink(BJhr@@platforms//host:hostB$shipping_package.shipping.json
n@3272d1fc1376fba8926b3f5deec5f9ce1bd682b6c45d38252fc7f5b545daae63"	FileWrite(Jhr@@platforms//host:hostC=@@aspect_rules_ts++typescript+npm_typescript//:copy_worker_js
B
8test-B7protocol.test.ts8
7Bpackage.jsonB9query.ts+
9B:query.test.ts8C=@@aspect_rules_ts++typescript+npm_typescript//:copy_validator

:
B;protocol-fixtures.mts8
;]W@@aspect_rules_ts++typescript+npm_typescript//:.aspect_rules_js/node_modules/typescript	B>test-fixtures/B=protocol>B<query-response-cases.json=
<BBstructured-sql-cases.json=
B"
B9D3bazel_lib++toolchains+copy_to_directory_linux_amd64BCcopy_to_directoryD
C"BFunit_test.sourcesBE_mainF∑@b60fb21ac7bb21678ef821a956e2508ff691213cd659ba78f5414cd91258a278"UnresolvedSymlink(Jhr@@platforms//host:hostí>.aspect_rules_js/undici-types@7.16.0/node_modules/undici-typesn@c24bdb15c475ca888636662e24d9a20c43e6a0b85f35e1b0503dc6bc95ef5351"	FileWrite(Jhr@@platforms//host:hostB0H*aspect_rules_ts++typescript+npm_typescriptBGpackageH
GB6J0bazel_lib++toolchains+copy_directory_linux_amd64BIcopy_directoryJB@workerB?	worker.js@
?"	"BK	worker.js
Ko@7a39b61d5744a8903119e17b3ddc7e56e330f240d2bead98c3ba081a81b5c9ac"Symlink(B	Jhr@@platforms//host:hostB&A ts_project_options_validator.cjs(
A"
BM
validator_BL	validatorM
 LB&N ts_project_options_validator.cjs∑õ@afe568d62434aab01c6f4fce627ca6120f1c42ad4c2f2a2fbc22a2d702ca14c4"TemplateExpand(BJhr@@platforms//host:hostz°q#!/usr/bin/env bash

# This bash script is a wrapper around the NodeJS JavaScript file
# entry point with the following bazel label:
#     {{entry_point_label}}
#
# The script's was generated to execute the js_binary target
#     {{target_label}}
#
# The template used to generate this script is
#     {{template_label}}

set -o pipefail -o errexit -o nounset

{{envs}}

# If PATH was not provided, then it is important to export it here so that child
# processes get the default value generated by bash.
export PATH

# ==============================================================================
# Handle --bazel-bindir flag
# ==============================================================================

# If a --bazel-bindir <path> flag is passed it must be the first two
# arguments. It is consumed by this launcher script and used to set
# BAZEL_BINDIR, overriding any value already set in the environment.
if [ $# -gt 0 ] && [ "$1" = "--bazel-bindir" ]; then
    if [ $# -lt 2 ]; then
        echo "ERROR: --bazel-bindir flag requires a value" >&2
        exit 1
    fi
    BAZEL_BINDIR="$2"
    export BAZEL_BINDIR
    shift 2
fi

# ==============================================================================
# Prepare stdout capture, stderr capture && logging
# ==============================================================================

# Convert stdout, stderr and exit_code capture outputs paths to absolute paths.
# A path not starting with "bazel-out/" is relative to the bin directory; joining
# it with BAZEL_BINDIR here (rather than baking in bazel-out/<config>/bin at
# analysis time) keeps it correct when path mapping is active. This must happen
# before any directory changes below since it resolves against $PWD.
function resolve_capture_path {
    case "$1" in
    bazel-out/*) echo "$PWD/$1" ;;
    *) echo "$PWD/$BAZEL_BINDIR/$1" ;;
    esac
}

# TODO(4.0): remove support for capturing stderr, stdout, and exit code. The
# js_run_binary macro now handles this in a way that does not require help from
# the launcher.
if [ "${JS_BINARY__STDOUT_OUTPUT_FILE:-}" ]; then
    JS_BINARY__STDOUT_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__STDOUT_OUTPUT_FILE")"
fi
if [ "${JS_BINARY__STDERR_OUTPUT_FILE:-}" ]; then
    JS_BINARY__STDERR_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__STDERR_OUTPUT_FILE")"
fi
if [ "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ]; then
    JS_BINARY__EXIT_CODE_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__EXIT_CODE_OUTPUT_FILE")"
fi

# A stream with a declared output file is written straight to that file so that
# nothing has to run after node exits and this shell can exec node.
#
# A stream that is only subject to silent_on_success has no final destination, so
# it is buffered in a temp file and replayed on failure.
if [ "${JS_BINARY__STDOUT_OUTPUT_FILE:-}" ]; then
    STDOUT_CAPTURE="$JS_BINARY__STDOUT_OUTPUT_FILE"
elif [ "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
    STDOUT_CAPTURE=$(mktemp)
    STDOUT_CAPTURE_IS_TEMP=1
fi

if [ "${JS_BINARY__STDERR_OUTPUT_FILE:-}" ]; then
    STDERR_CAPTURE="$JS_BINARY__STDERR_OUTPUT_FILE"
elif [ "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
    STDERR_CAPTURE=$(mktemp)
    STDERR_CAPTURE_IS_TEMP=1
fi

# FATAL and ERROR diagnostics from this launcher only go into the stderr capture
# if that capture is a temp file that will get replayed on failure. Otherwise,
# we write these straight to stderr so that they do not get lost if the action
# fails.
LOG_ERROR_CAPTURE="${STDERR_CAPTURE_IS_TEMP:+$STDERR_CAPTURE}"

export JS_BINARY__LOG_PREFIX="{{log_prefix_rule_set}}[{{log_prefix_rule}}]"

# Emit a log line to $1, or to the real stderr when $1 is empty.
function log_to {
    local capture="$1"
    local level="$2"
    local message="$3"
    if [ "$capture" ]; then
        printf "%s: %s: %s\n" "$level" "$JS_BINARY__LOG_PREFIX" "$message" >>"$capture"
    else
        printf "%s: %s: %s\n" "$level" "$JS_BINARY__LOG_PREFIX" "$message" >&2
    fi
}

function log_fatal {
    if [ "${JS_BINARY__LOG_FATAL:-}" ]; then
        log_to "${LOG_ERROR_CAPTURE:-}" FATAL "$1"
    fi
}

function log_error {
    if [ "${JS_BINARY__LOG_ERROR:-}" ]; then
        log_to "${LOG_ERROR_CAPTURE:-}" ERROR "$1"
    fi
}

function log_info {
    if [ "${JS_BINARY__LOG_INFO:-}" ]; then
        log_to "${STDERR_CAPTURE:-}" INFO "$1"
    fi
}

function log_debug {
    if [ "${JS_BINARY__LOG_DEBUG:-}" ]; then
        log_to "${STDERR_CAPTURE:-}" DEBUG "$1"
    fi
}

_exit() {
    EXIT_CODE=$?

    # Streams captured to a declared output file were written there directly and
    # need no mop up. Only the temp files that back silent_on_success do.
    if [ "${STDERR_CAPTURE_IS_TEMP:-}" ]; then
        if [ "$EXIT_CODE" != 0 ] || [ -z "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
            cat "$STDERR_CAPTURE" >&2
        fi
        rm "$STDERR_CAPTURE"
    fi

    if [ "${STDOUT_CAPTURE_IS_TEMP:-}" ]; then
        if [ "$EXIT_CODE" != 0 ] || [ -z "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
            cat "$STDOUT_CAPTURE"
        fi
        rm "$STDOUT_CAPTURE"
    fi

    log_debug "exit code: $EXIT_CODE"

    exit "$EXIT_CODE"
}

trap _exit EXIT

# ==============================================================================
# Initialize RUNFILES environment variable
# ==============================================================================
{{initialize_runfiles}}
JS_BINARY__RUNFILES="$RUNFILES"
export JS_BINARY__RUNFILES

# ==============================================================================
# Prepare to run main program
# ==============================================================================

# The execroot the entry point is resolved against below. A parent js_binary process hands its
# own down when it asks for an execroot entry point, because the entry point it resolved is in
# that tree; otherwise this script was started in it. Nothing else here needs an execroot: the
# launcher preload works out JS_BINARY__EXECROOT for the program and everything it spawns.
if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] && [ "${JS_BINARY__EXECROOT:-}" ]; then
    execroot="$JS_BINARY__EXECROOT"
else
    execroot="$PWD"
fi

# Build actions are started in the execroot, so change into the root of the Bazel output tree,
# which is where js_binary programs run. See
# https://github.com/aspect-build/rules_js/tree/dbb5af0d2a9a2bb50e4cf4a96dbc582b27567155#running-nodejs-programs
# for more context on why we do this. It cannot wait for the preload: node resolves the bare
# specifier of a --require in node_options against the directory it was started in.
#
# The bindir is only there to change into when this really is an execroot; in a runfiles tree,
# or in a nested js_binary already running in the bindir, there is nothing to do. The preload
# tells those apart from the broken case by JS_BINARY__CHANGED_TO_BINDIR.
if [ -z "${JS_BINARY__NO_CD_BINDIR:-}" ] && [ "${BAZEL_BINDIR:-}" ] && [ -d "$PWD/$BAZEL_BINDIR" ]; then
    log_debug "changing directory to BAZEL_BINDIR (root of Bazel output tree) $BAZEL_BINDIR"
    export JS_BINARY__CHANGED_TO_BINDIR=1
    cd "$BAZEL_BINDIR"
fi

if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] && [ -z "${BAZEL_BINDIR:-}" ]; then
    log_fatal "Expected BAZEL_BINDIR to be set when JS_BINARY__USE_EXECROOT_ENTRY_POINT is set"
    exit 1
fi

function resolve_execroot_bin_path {
    local short_path="$1"
    if [[ "$short_path" == ../* ]]; then
        echo "$execroot/$BAZEL_BINDIR/external/${short_path:3}"
    else
        echo "$execroot/$BAZEL_BINDIR/$short_path"
    fi
}

function resolve_execroot_src_path {
    local short_path="$1"
    if [[ "$short_path" == ../* ]]; then
        echo "$execroot/external/${short_path:3}"
    else
        echo "$execroot/$short_path"
    fi
}

# Resolve a toolchain file that is a file of this workspace or another repository
# in the runfiles tree, or an absolute path a user set in node_toolchain.
function resolve_toolchain_path {
    local file
    file="$(_normalize_path "$1")"
    if [ "${file:0:1}" = "/" ]; then
        echo "$file"
    elif [ "${JS_BINARY__NO_RUNFILES:-}" ]; then
        resolve_execroot_src_path "$file"
    else
        echo "$JS_BINARY__RUNFILES/{{workspace_name}}/$file"
    fi
}

# Everything below is resolved here only because node needs it on its command line
# or bash needs it to start node at all. The checks that can wait, and the rest of
# the environment the program sees, are done by the launcher preload once node is up.

if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] || [ "${JS_BINARY__NO_RUNFILES:-}" ]; then
    entry_point=$(resolve_execroot_bin_path "{{entry_point_path}}")
else
    entry_point="$JS_BINARY__RUNFILES/{{workspace_name}}/{{entry_point_path}}"
fi

export JS_BINARY__NODE_BINARY
JS_BINARY__NODE_BINARY=$(resolve_toolchain_path "{{node}}")
if [ ! -f "$JS_BINARY__NODE_BINARY" ]; then
    log_fatal "node binary '$JS_BINARY__NODE_BINARY' not found"
    exit 1
fi
if [ "$_IS_WINDOWS" -ne "1" ] && [ ! -x "$JS_BINARY__NODE_BINARY" ]; then
    log_fatal "node binary '$JS_BINARY__NODE_BINARY' is not executable"
    exit 1
fi

npm="{{npm}}"
if [ "$npm" ]; then
    export JS_BINARY__NPM_BINARY
    JS_BINARY__NPM_BINARY=$(resolve_toolchain_path "$npm")
fi

launcher=$(resolve_toolchain_path "{{launcher}}")
if [ ! -f "$launcher" ]; then
    log_fatal "launcher '$launcher' not found"
    exit 1
fi

# Gather node options
JS_BINARY__NODE_OPTIONS=()
{{node_options}}

ARGS=()
ALL_ARGS=({{fixed_args}} "$@")
for ARG in ${ALL_ARGS[@]+"${ALL_ARGS[@]}"}; do
    case "$ARG" in
    # Let users pass through arguments to node itself
    --node_options=*) JS_BINARY__NODE_OPTIONS+=("${ARG#--node_options=}") ;;
    # Remaining argv is collected to pass to the program
    *) ARGS+=("$ARG") ;;
    esac
done

# ==============================================================================
# Run the main program
# ==============================================================================

# Invoke node directly rather than through $JS_BINARY__NODE_WRAPPER. This way
# we avoid spawning an extra bash process on every launch. The wrapper is
# still put on the PATH as `node` so that child processes get the patched
# runtime.
node_cmd=("$JS_BINARY__NODE_BINARY" --require "$launcher")

if [ "${JS_BINARY__LOG_INFO:-}" ]; then
    log_info "$(echo -n "running" "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"})"
fi

# De-export capture-related vars so child processes (e.g. a nested js_binary)
# do not inherit them. The bash script has already consumed them above to set up
# STDOUT_CAPTURE / STDERR_CAPTURE; leaking them would cause a nested js_binary
# to silently swallow its own stdout or write to the wrong output file.
# export -n keeps the value accessible to the _exit trap while removing it from
# the environment seen by node and any processes it spawns.
export -n JS_BINARY__STDOUT_OUTPUT_FILE JS_BINARY__STDERR_OUTPUT_FILE JS_BINARY__EXIT_CODE_OUTPUT_FILE JS_BINARY__SILENT_ON_SUCCESS

set +e

if [ -z "${JS_BINARY__EXPECTED_EXIT_CODE:-}" ] && [ -z "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ] &&
    [ -z "${STDOUT_CAPTURE_IS_TEMP:-}" ] && [ -z "${STDERR_CAPTURE_IS_TEMP:-}" ]; then
    # Nothing must run after node exits, so replace this shell with node. Signals
    # and terminal control are then delivered directly to node instead of being
    # proxied through a backgrounded child.
    if [ "${STDOUT_CAPTURE:-}" ]; then
        exec 1>>"$STDOUT_CAPTURE"
    fi
    if [ "${STDERR_CAPTURE:-}" ]; then
        exec 2>>"$STDERR_CAPTURE"
    fi
    exec "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"}
    exit 127
fi

if [ "${STDOUT_CAPTURE:-}" ] && [ "${STDERR_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 >>"$STDOUT_CAPTURE" 2>>"$STDERR_CAPTURE" &
elif [ "${STDOUT_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 >>"$STDOUT_CAPTURE" &
elif [ "${STDERR_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 2>>"$STDERR_CAPTURE" &
else
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 &
fi

# ==============================================================================
# Wait for program to finish
# ==============================================================================

readonly child=$!
# Bash does not forward termination signals to any child process when
# running in docker, so we need to manually trap and forward the signals.
#
# Each trap is reset as it fires, so that a repeat of that signal terminates this
# script rather than being swallowed.
_term() { trap - SIGTERM; kill -TERM "${child}" 2>/dev/null; }
_int() { trap - SIGINT; kill -INT "${child}" 2>/dev/null; }
trap _term SIGTERM
trap _int SIGINT

# A wait returns as soon as a trapped signal has been handled, whether or not the
# child has exited, so keep waiting until it has.
wait "$child"
RESULT="$?"
while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    RESULT="$?"
done

# Remove traps now that the child process has exited
trap - SIGTERM SIGINT
set -e

# ==============================================================================
# Mop up after main program
# ==============================================================================

if [ "${JS_BINARY__EXPECTED_EXIT_CODE:-}" ]; then
    if [ "$RESULT" != "$JS_BINARY__EXPECTED_EXIT_CODE" ]; then
        log_error "expected exit code to be '$JS_BINARY__EXPECTED_EXIT_CODE', but got '$RESULT'"
        if [ $RESULT -eq 0 ]; then
            # This exit code is handled specially by Bazel:
            # https://github.com/bazelbuild/bazel/blob/486206012a664ecb20bdb196a681efc9a9825049/src/main/java/com/google/devtools/build/lib/util/ExitCode.java#L44
            readonly BAZEL_EXIT_TESTS_FAILED=3
            exit $BAZEL_EXIT_TESTS_FAILED
        fi
        exit $RESULT
    else
        exit 0
    fi
fi

if [ "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ]; then
    # Exit zero if the exit code was captured
    echo -n "$RESULT" >"$JS_BINARY__EXIT_CODE_OUTPUT_FILE"
    exit 0
else
    exit $RESULT
fi
ÇM
{{target_label}}9@@aspect_rules_ts++typescript+npm_typescript//:tsc_workerÇE
{{template_label}}/@@aspect_rules_js+//js/private:js_binary.sh.tplÇ^
{{entry_point_label}}E@@aspect_rules_ts++typescript+npm_typescript//:copy_ts_project_workerÇZ
{{entry_point_path}}B../aspect_rules_ts++typescript+npm_typescript/ts_project_worker.jsÇ±
{{envs}}§export JS_BINARY__BINDIR="bazel-out/k8-opt-exec-ST-d57f47055a04/bin"
export JS_BINARY__COMPILATION_MODE="opt"
export JS_BINARY__TARGET_CPU="k8"
export JS_BINARY__BUILD_FILE_PATH="BUILD.bazel"
export JS_BINARY__PACKAGE=""
export JS_BINARY__TARGET_NAME="tsc_worker"
export JS_BINARY__TARGET="@aspect_rules_ts++typescript+npm_typescript//:tsc_worker"
export JS_BINARY__WORKSPACE="_main"
if [[ -z "${JS_BINARY__PATCH_NODE_FS:-}" ]]; then export JS_BINARY__PATCH_NODE_FS="1"; fi
export JS_BINARY__COPY_DATA_TO_BIN="1"
if [[ -z "${JS_BINARY__LOG_FATAL:-}" ]]; then export JS_BINARY__LOG_FATAL="1"; fi
if [[ -z "${JS_BINARY__LOG_ERROR:-}" ]]; then export JS_BINARY__LOG_ERROR="1"; fiÇ
{{fixed_args}}Çù
{{initialize_runfiles}}Å
# It helps to determine if we are running on a Windows environment (excludes WSL as it acts like Unix)
case "$(uname -s)" in
CYGWIN*) _IS_WINDOWS=1 ;;
MINGW*) _IS_WINDOWS=1 ;;
MSYS_NT*) _IS_WINDOWS=1 ;;
*) _IS_WINDOWS=0 ;;
esac

# It helps to normalizes paths when running on Windows.
#
# Example:
# C:/Users/XUser/_bazel_XUser/7q7kkv32/execroot/A/b/C -> /c/Users/XUser/_bazel_XUser/7q7kkv32/execroot/A/b/C
function _normalize_path {
    if [ "$_IS_WINDOWS" -eq "1" ]; then
        # Apply the followings paths transformations to normalize paths on Windows
        # -process driver letter
        # -convert path separator
        sed -e 's#^\(.\):#/\L\1#' -e 's#\\#/#g' <<<"$1"
    else
        echo "$1"
    fi
    return
}

# Set a RUNFILES environment variable to the root of the runfiles tree
# since RUNFILES_DIR is not set by Bazel in all contexts.
# For example, `RUNFILES=/path/to/my_js_binary.sh.runfiles`.
#
# Call this program X. X was generated by a genrule and may be invoked
# in many ways:
#   1a) directly by a user, with $0 in the output tree
#   1b) via 'bazel run' (similar to case 1a)
#   2) directly by a user, with $0 in X's runfiles
#   3) by another program Y which has a data dependency on X, with $0 in Y's
#      runfiles
#   4a) via 'bazel test'
#   4b) case 3 in the context of a test
#   5a) by a genrule cmd, with $0 in the output tree
#   6a) case 3 in the context of a genrule
#
# For case 1, $0 will be a regular file, and the runfiles will be
# at $0.runfiles.
# For case 2 or 3, $0 will be a symlink to the file seen in case 1.
# For case 4, $TEST_SRCDIR should already be set to the runfiles by
# blaze.
# Case 5a is handled like case 1.
# Case 6a is handled like case 3.
if [ "${TEST_SRCDIR:-}" ]; then
    # Case 4, bazel has identified runfiles for us.
    RUNFILES=$(_normalize_path "$TEST_SRCDIR")
elif [ "${RUNFILES_MANIFEST_FILE:-}" ]; then
    RUNFILES=$(_normalize_path "$RUNFILES_MANIFEST_FILE")
    if [[ "${RUNFILES}" == *.runfiles_manifest ]]; then
        # Bazel puts the manifest besides the runfiles with the suffix .runfiles_manifest.
        # For example, the runfiles directory is named my_binary.runfiles then the manifest is beside the
        # runfiles directory and named my_binary.runfiles_manifest
        RUNFILES=${RUNFILES%_manifest}
    elif [[ "${RUNFILES}" == */MANIFEST ]]; then
        # Bazel for windows puts the manifest file named MANIFEST in the runfiles directory
        RUNFILES=${RUNFILES%/MANIFEST}
    else
        log_fatal "Unexpected RUNFILES_MANIFEST_FILE value $RUNFILES_MANIFEST_FILE"
        exit 1
    fi
else
    case "$0" in
    /*) self="$0" ;;
    *) self="$PWD/$0" ;;
    esac
    while true; do
        if [ -e "$self.runfiles" ]; then
            RUNFILES="$self.runfiles"
            break
        fi

        if [[ "$self" == *.runfiles/* ]]; then
            RUNFILES="${self%%.runfiles/*}.runfiles"
            # don't break; this is a last resort for case 6b
        fi

        if [ ! -L "$self" ]; then
            break
        fi

        readlink="$(readlink "$self")"
        if [[ "$readlink" == /* ]]; then
            self="$readlink"
        else
            # resolve relative symlink
            self="${self%%/*}/$readlink"
        fi
    done

    if [ -z "${RUNFILES:-}" ]; then
        log_fatal "RUNFILES environment variable is not set"
        exit 1
    fi

    RUNFILES=$(_normalize_path "$RUNFILES")
fi
if [ "${RUNFILES:0:1}" != "/" ]; then
    # Ensure RUNFILES set above is an absolute path. It may be a path relative
    # to the PWD in case where RUNFILES_MANIFEST_FILE is used above.
    RUNFILES="$PWD/$RUNFILES"
fi
# Set RUNFILES_DIR if not already set so that tools such as @bazel/runfiles
# can locate runfiles without requiring RUNFILES to be exported.
export RUNFILES_DIR="${RUNFILES_DIR:-$RUNFILES}"
Ç*
{{log_prefix_rule_set}}aspect_rules_jsÇ 
{{log_prefix_rule}}	js_binaryÇJ
{{launcher}}:../aspect_rules_js+/js/private/node-bootstrap/launcher.cjsÇI
{{node_options}}5JS_BINARY__NODE_OPTIONS+=("--preserve-symlinks-main")ÇH
{{node}}<../rules_nodejs++node+nodejs_linux_amd64/bin/nodejs/bin/nodeÇ	
{{npm}}Ç
{{workspace_name}}_main
!No@7a39b61d5744a8903119e17b3ddc7e56e330f240d2bead98c3ba081a81b5c9ac"Symlink(B
J!h!r@@platforms//host:host∏õ@6d7045aec817638b04b2220a69243df1247acb88114594fb908a74248160dcc8"TemplateExpand(BJ h r@@platforms//host:hostz°q#!/usr/bin/env bash

# This bash script is a wrapper around the NodeJS JavaScript file
# entry point with the following bazel label:
#     {{entry_point_label}}
#
# The script's was generated to execute the js_binary target
#     {{target_label}}
#
# The template used to generate this script is
#     {{template_label}}

set -o pipefail -o errexit -o nounset

{{envs}}

# If PATH was not provided, then it is important to export it here so that child
# processes get the default value generated by bash.
export PATH

# ==============================================================================
# Handle --bazel-bindir flag
# ==============================================================================

# If a --bazel-bindir <path> flag is passed it must be the first two
# arguments. It is consumed by this launcher script and used to set
# BAZEL_BINDIR, overriding any value already set in the environment.
if [ $# -gt 0 ] && [ "$1" = "--bazel-bindir" ]; then
    if [ $# -lt 2 ]; then
        echo "ERROR: --bazel-bindir flag requires a value" >&2
        exit 1
    fi
    BAZEL_BINDIR="$2"
    export BAZEL_BINDIR
    shift 2
fi

# ==============================================================================
# Prepare stdout capture, stderr capture && logging
# ==============================================================================

# Convert stdout, stderr and exit_code capture outputs paths to absolute paths.
# A path not starting with "bazel-out/" is relative to the bin directory; joining
# it with BAZEL_BINDIR here (rather than baking in bazel-out/<config>/bin at
# analysis time) keeps it correct when path mapping is active. This must happen
# before any directory changes below since it resolves against $PWD.
function resolve_capture_path {
    case "$1" in
    bazel-out/*) echo "$PWD/$1" ;;
    *) echo "$PWD/$BAZEL_BINDIR/$1" ;;
    esac
}

# TODO(4.0): remove support for capturing stderr, stdout, and exit code. The
# js_run_binary macro now handles this in a way that does not require help from
# the launcher.
if [ "${JS_BINARY__STDOUT_OUTPUT_FILE:-}" ]; then
    JS_BINARY__STDOUT_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__STDOUT_OUTPUT_FILE")"
fi
if [ "${JS_BINARY__STDERR_OUTPUT_FILE:-}" ]; then
    JS_BINARY__STDERR_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__STDERR_OUTPUT_FILE")"
fi
if [ "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ]; then
    JS_BINARY__EXIT_CODE_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__EXIT_CODE_OUTPUT_FILE")"
fi

# A stream with a declared output file is written straight to that file so that
# nothing has to run after node exits and this shell can exec node.
#
# A stream that is only subject to silent_on_success has no final destination, so
# it is buffered in a temp file and replayed on failure.
if [ "${JS_BINARY__STDOUT_OUTPUT_FILE:-}" ]; then
    STDOUT_CAPTURE="$JS_BINARY__STDOUT_OUTPUT_FILE"
elif [ "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
    STDOUT_CAPTURE=$(mktemp)
    STDOUT_CAPTURE_IS_TEMP=1
fi

if [ "${JS_BINARY__STDERR_OUTPUT_FILE:-}" ]; then
    STDERR_CAPTURE="$JS_BINARY__STDERR_OUTPUT_FILE"
elif [ "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
    STDERR_CAPTURE=$(mktemp)
    STDERR_CAPTURE_IS_TEMP=1
fi

# FATAL and ERROR diagnostics from this launcher only go into the stderr capture
# if that capture is a temp file that will get replayed on failure. Otherwise,
# we write these straight to stderr so that they do not get lost if the action
# fails.
LOG_ERROR_CAPTURE="${STDERR_CAPTURE_IS_TEMP:+$STDERR_CAPTURE}"

export JS_BINARY__LOG_PREFIX="{{log_prefix_rule_set}}[{{log_prefix_rule}}]"

# Emit a log line to $1, or to the real stderr when $1 is empty.
function log_to {
    local capture="$1"
    local level="$2"
    local message="$3"
    if [ "$capture" ]; then
        printf "%s: %s: %s\n" "$level" "$JS_BINARY__LOG_PREFIX" "$message" >>"$capture"
    else
        printf "%s: %s: %s\n" "$level" "$JS_BINARY__LOG_PREFIX" "$message" >&2
    fi
}

function log_fatal {
    if [ "${JS_BINARY__LOG_FATAL:-}" ]; then
        log_to "${LOG_ERROR_CAPTURE:-}" FATAL "$1"
    fi
}

function log_error {
    if [ "${JS_BINARY__LOG_ERROR:-}" ]; then
        log_to "${LOG_ERROR_CAPTURE:-}" ERROR "$1"
    fi
}

function log_info {
    if [ "${JS_BINARY__LOG_INFO:-}" ]; then
        log_to "${STDERR_CAPTURE:-}" INFO "$1"
    fi
}

function log_debug {
    if [ "${JS_BINARY__LOG_DEBUG:-}" ]; then
        log_to "${STDERR_CAPTURE:-}" DEBUG "$1"
    fi
}

_exit() {
    EXIT_CODE=$?

    # Streams captured to a declared output file were written there directly and
    # need no mop up. Only the temp files that back silent_on_success do.
    if [ "${STDERR_CAPTURE_IS_TEMP:-}" ]; then
        if [ "$EXIT_CODE" != 0 ] || [ -z "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
            cat "$STDERR_CAPTURE" >&2
        fi
        rm "$STDERR_CAPTURE"
    fi

    if [ "${STDOUT_CAPTURE_IS_TEMP:-}" ]; then
        if [ "$EXIT_CODE" != 0 ] || [ -z "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
            cat "$STDOUT_CAPTURE"
        fi
        rm "$STDOUT_CAPTURE"
    fi

    log_debug "exit code: $EXIT_CODE"

    exit "$EXIT_CODE"
}

trap _exit EXIT

# ==============================================================================
# Initialize RUNFILES environment variable
# ==============================================================================
{{initialize_runfiles}}
JS_BINARY__RUNFILES="$RUNFILES"
export JS_BINARY__RUNFILES

# ==============================================================================
# Prepare to run main program
# ==============================================================================

# The execroot the entry point is resolved against below. A parent js_binary process hands its
# own down when it asks for an execroot entry point, because the entry point it resolved is in
# that tree; otherwise this script was started in it. Nothing else here needs an execroot: the
# launcher preload works out JS_BINARY__EXECROOT for the program and everything it spawns.
if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] && [ "${JS_BINARY__EXECROOT:-}" ]; then
    execroot="$JS_BINARY__EXECROOT"
else
    execroot="$PWD"
fi

# Build actions are started in the execroot, so change into the root of the Bazel output tree,
# which is where js_binary programs run. See
# https://github.com/aspect-build/rules_js/tree/dbb5af0d2a9a2bb50e4cf4a96dbc582b27567155#running-nodejs-programs
# for more context on why we do this. It cannot wait for the preload: node resolves the bare
# specifier of a --require in node_options against the directory it was started in.
#
# The bindir is only there to change into when this really is an execroot; in a runfiles tree,
# or in a nested js_binary already running in the bindir, there is nothing to do. The preload
# tells those apart from the broken case by JS_BINARY__CHANGED_TO_BINDIR.
if [ -z "${JS_BINARY__NO_CD_BINDIR:-}" ] && [ "${BAZEL_BINDIR:-}" ] && [ -d "$PWD/$BAZEL_BINDIR" ]; then
    log_debug "changing directory to BAZEL_BINDIR (root of Bazel output tree) $BAZEL_BINDIR"
    export JS_BINARY__CHANGED_TO_BINDIR=1
    cd "$BAZEL_BINDIR"
fi

if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] && [ -z "${BAZEL_BINDIR:-}" ]; then
    log_fatal "Expected BAZEL_BINDIR to be set when JS_BINARY__USE_EXECROOT_ENTRY_POINT is set"
    exit 1
fi

function resolve_execroot_bin_path {
    local short_path="$1"
    if [[ "$short_path" == ../* ]]; then
        echo "$execroot/$BAZEL_BINDIR/external/${short_path:3}"
    else
        echo "$execroot/$BAZEL_BINDIR/$short_path"
    fi
}

function resolve_execroot_src_path {
    local short_path="$1"
    if [[ "$short_path" == ../* ]]; then
        echo "$execroot/external/${short_path:3}"
    else
        echo "$execroot/$short_path"
    fi
}

# Resolve a toolchain file that is a file of this workspace or another repository
# in the runfiles tree, or an absolute path a user set in node_toolchain.
function resolve_toolchain_path {
    local file
    file="$(_normalize_path "$1")"
    if [ "${file:0:1}" = "/" ]; then
        echo "$file"
    elif [ "${JS_BINARY__NO_RUNFILES:-}" ]; then
        resolve_execroot_src_path "$file"
    else
        echo "$JS_BINARY__RUNFILES/{{workspace_name}}/$file"
    fi
}

# Everything below is resolved here only because node needs it on its command line
# or bash needs it to start node at all. The checks that can wait, and the rest of
# the environment the program sees, are done by the launcher preload once node is up.

if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] || [ "${JS_BINARY__NO_RUNFILES:-}" ]; then
    entry_point=$(resolve_execroot_bin_path "{{entry_point_path}}")
else
    entry_point="$JS_BINARY__RUNFILES/{{workspace_name}}/{{entry_point_path}}"
fi

export JS_BINARY__NODE_BINARY
JS_BINARY__NODE_BINARY=$(resolve_toolchain_path "{{node}}")
if [ ! -f "$JS_BINARY__NODE_BINARY" ]; then
    log_fatal "node binary '$JS_BINARY__NODE_BINARY' not found"
    exit 1
fi
if [ "$_IS_WINDOWS" -ne "1" ] && [ ! -x "$JS_BINARY__NODE_BINARY" ]; then
    log_fatal "node binary '$JS_BINARY__NODE_BINARY' is not executable"
    exit 1
fi

npm="{{npm}}"
if [ "$npm" ]; then
    export JS_BINARY__NPM_BINARY
    JS_BINARY__NPM_BINARY=$(resolve_toolchain_path "$npm")
fi

launcher=$(resolve_toolchain_path "{{launcher}}")
if [ ! -f "$launcher" ]; then
    log_fatal "launcher '$launcher' not found"
    exit 1
fi

# Gather node options
JS_BINARY__NODE_OPTIONS=()
{{node_options}}

ARGS=()
ALL_ARGS=({{fixed_args}} "$@")
for ARG in ${ALL_ARGS[@]+"${ALL_ARGS[@]}"}; do
    case "$ARG" in
    # Let users pass through arguments to node itself
    --node_options=*) JS_BINARY__NODE_OPTIONS+=("${ARG#--node_options=}") ;;
    # Remaining argv is collected to pass to the program
    *) ARGS+=("$ARG") ;;
    esac
done

# ==============================================================================
# Run the main program
# ==============================================================================

# Invoke node directly rather than through $JS_BINARY__NODE_WRAPPER. This way
# we avoid spawning an extra bash process on every launch. The wrapper is
# still put on the PATH as `node` so that child processes get the patched
# runtime.
node_cmd=("$JS_BINARY__NODE_BINARY" --require "$launcher")

if [ "${JS_BINARY__LOG_INFO:-}" ]; then
    log_info "$(echo -n "running" "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"})"
fi

# De-export capture-related vars so child processes (e.g. a nested js_binary)
# do not inherit them. The bash script has already consumed them above to set up
# STDOUT_CAPTURE / STDERR_CAPTURE; leaking them would cause a nested js_binary
# to silently swallow its own stdout or write to the wrong output file.
# export -n keeps the value accessible to the _exit trap while removing it from
# the environment seen by node and any processes it spawns.
export -n JS_BINARY__STDOUT_OUTPUT_FILE JS_BINARY__STDERR_OUTPUT_FILE JS_BINARY__EXIT_CODE_OUTPUT_FILE JS_BINARY__SILENT_ON_SUCCESS

set +e

if [ -z "${JS_BINARY__EXPECTED_EXIT_CODE:-}" ] && [ -z "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ] &&
    [ -z "${STDOUT_CAPTURE_IS_TEMP:-}" ] && [ -z "${STDERR_CAPTURE_IS_TEMP:-}" ]; then
    # Nothing must run after node exits, so replace this shell with node. Signals
    # and terminal control are then delivered directly to node instead of being
    # proxied through a backgrounded child.
    if [ "${STDOUT_CAPTURE:-}" ]; then
        exec 1>>"$STDOUT_CAPTURE"
    fi
    if [ "${STDERR_CAPTURE:-}" ]; then
        exec 2>>"$STDERR_CAPTURE"
    fi
    exec "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"}
    exit 127
fi

if [ "${STDOUT_CAPTURE:-}" ] && [ "${STDERR_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 >>"$STDOUT_CAPTURE" 2>>"$STDERR_CAPTURE" &
elif [ "${STDOUT_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 >>"$STDOUT_CAPTURE" &
elif [ "${STDERR_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 2>>"$STDERR_CAPTURE" &
else
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 &
fi

# ==============================================================================
# Wait for program to finish
# ==============================================================================

readonly child=$!
# Bash does not forward termination signals to any child process when
# running in docker, so we need to manually trap and forward the signals.
#
# Each trap is reset as it fires, so that a repeat of that signal terminates this
# script rather than being swallowed.
_term() { trap - SIGTERM; kill -TERM "${child}" 2>/dev/null; }
_int() { trap - SIGINT; kill -INT "${child}" 2>/dev/null; }
trap _term SIGTERM
trap _int SIGINT

# A wait returns as soon as a trapped signal has been handled, whether or not the
# child has exited, so keep waiting until it has.
wait "$child"
RESULT="$?"
while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    RESULT="$?"
done

# Remove traps now that the child process has exited
trap - SIGTERM SIGINT
set -e

# ==============================================================================
# Mop up after main program
# ==============================================================================

if [ "${JS_BINARY__EXPECTED_EXIT_CODE:-}" ]; then
    if [ "$RESULT" != "$JS_BINARY__EXPECTED_EXIT_CODE" ]; then
        log_error "expected exit code to be '$JS_BINARY__EXPECTED_EXIT_CODE', but got '$RESULT'"
        if [ $RESULT -eq 0 ]; then
            # This exit code is handled specially by Bazel:
            # https://github.com/bazelbuild/bazel/blob/486206012a664ecb20bdb196a681efc9a9825049/src/main/java/com/google/devtools/build/lib/util/ExitCode.java#L44
            readonly BAZEL_EXIT_TESTS_FAILED=3
            exit $BAZEL_EXIT_TESTS_FAILED
        fi
        exit $RESULT
    else
        exit 0
    fi
fi

if [ "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ]; then
    # Exit zero if the exit code was captured
    echo -n "$RESULT" >"$JS_BINARY__EXIT_CODE_OUTPUT_FILE"
    exit 0
else
    exit $RESULT
fi
ÇL
{{target_label}}8@@aspect_rules_ts++typescript+npm_typescript//:validatorÇE
{{template_label}}/@@aspect_rules_js+//js/private:js_binary.sh.tplÇV
{{entry_point_label}}=@@aspect_rules_ts++typescript+npm_typescript//:copy_validatorÇf
{{entry_point_path}}N../aspect_rules_ts++typescript+npm_typescript/ts_project_options_validator.cjsÇØ
{{envs}}¢export JS_BINARY__BINDIR="bazel-out/k8-opt-exec-ST-d57f47055a04/bin"
export JS_BINARY__COMPILATION_MODE="opt"
export JS_BINARY__TARGET_CPU="k8"
export JS_BINARY__BUILD_FILE_PATH="BUILD.bazel"
export JS_BINARY__PACKAGE=""
export JS_BINARY__TARGET_NAME="validator"
export JS_BINARY__TARGET="@aspect_rules_ts++typescript+npm_typescript//:validator"
export JS_BINARY__WORKSPACE="_main"
if [[ -z "${JS_BINARY__PATCH_NODE_FS:-}" ]]; then export JS_BINARY__PATCH_NODE_FS="1"; fi
export JS_BINARY__COPY_DATA_TO_BIN="1"
if [[ -z "${JS_BINARY__LOG_FATAL:-}" ]]; then export JS_BINARY__LOG_FATAL="1"; fi
if [[ -z "${JS_BINARY__LOG_ERROR:-}" ]]; then export JS_BINARY__LOG_ERROR="1"; fiÇ
{{fixed_args}}Çù
{{initialize_runfiles}}Å
# It helps to determine if we are running on a Windows environment (excludes WSL as it acts like Unix)
case "$(uname -s)" in
CYGWIN*) _IS_WINDOWS=1 ;;
MINGW*) _IS_WINDOWS=1 ;;
MSYS_NT*) _IS_WINDOWS=1 ;;
*) _IS_WINDOWS=0 ;;
esac

# It helps to normalizes paths when running on Windows.
#
# Example:
# C:/Users/XUser/_bazel_XUser/7q7kkv32/execroot/A/b/C -> /c/Users/XUser/_bazel_XUser/7q7kkv32/execroot/A/b/C
function _normalize_path {
    if [ "$_IS_WINDOWS" -eq "1" ]; then
        # Apply the followings paths transformations to normalize paths on Windows
        # -process driver letter
        # -convert path separator
        sed -e 's#^\(.\):#/\L\1#' -e 's#\\#/#g' <<<"$1"
    else
        echo "$1"
    fi
    return
}

# Set a RUNFILES environment variable to the root of the runfiles tree
# since RUNFILES_DIR is not set by Bazel in all contexts.
# For example, `RUNFILES=/path/to/my_js_binary.sh.runfiles`.
#
# Call this program X. X was generated by a genrule and may be invoked
# in many ways:
#   1a) directly by a user, with $0 in the output tree
#   1b) via 'bazel run' (similar to case 1a)
#   2) directly by a user, with $0 in X's runfiles
#   3) by another program Y which has a data dependency on X, with $0 in Y's
#      runfiles
#   4a) via 'bazel test'
#   4b) case 3 in the context of a test
#   5a) by a genrule cmd, with $0 in the output tree
#   6a) case 3 in the context of a genrule
#
# For case 1, $0 will be a regular file, and the runfiles will be
# at $0.runfiles.
# For case 2 or 3, $0 will be a symlink to the file seen in case 1.
# For case 4, $TEST_SRCDIR should already be set to the runfiles by
# blaze.
# Case 5a is handled like case 1.
# Case 6a is handled like case 3.
if [ "${TEST_SRCDIR:-}" ]; then
    # Case 4, bazel has identified runfiles for us.
    RUNFILES=$(_normalize_path "$TEST_SRCDIR")
elif [ "${RUNFILES_MANIFEST_FILE:-}" ]; then
    RUNFILES=$(_normalize_path "$RUNFILES_MANIFEST_FILE")
    if [[ "${RUNFILES}" == *.runfiles_manifest ]]; then
        # Bazel puts the manifest besides the runfiles with the suffix .runfiles_manifest.
        # For example, the runfiles directory is named my_binary.runfiles then the manifest is beside the
        # runfiles directory and named my_binary.runfiles_manifest
        RUNFILES=${RUNFILES%_manifest}
    elif [[ "${RUNFILES}" == */MANIFEST ]]; then
        # Bazel for windows puts the manifest file named MANIFEST in the runfiles directory
        RUNFILES=${RUNFILES%/MANIFEST}
    else
        log_fatal "Unexpected RUNFILES_MANIFEST_FILE value $RUNFILES_MANIFEST_FILE"
        exit 1
    fi
else
    case "$0" in
    /*) self="$0" ;;
    *) self="$PWD/$0" ;;
    esac
    while true; do
        if [ -e "$self.runfiles" ]; then
            RUNFILES="$self.runfiles"
            break
        fi

        if [[ "$self" == *.runfiles/* ]]; then
            RUNFILES="${self%%.runfiles/*}.runfiles"
            # don't break; this is a last resort for case 6b
        fi

        if [ ! -L "$self" ]; then
            break
        fi

        readlink="$(readlink "$self")"
        if [[ "$readlink" == /* ]]; then
            self="$readlink"
        else
            # resolve relative symlink
            self="${self%%/*}/$readlink"
        fi
    done

    if [ -z "${RUNFILES:-}" ]; then
        log_fatal "RUNFILES environment variable is not set"
        exit 1
    fi

    RUNFILES=$(_normalize_path "$RUNFILES")
fi
if [ "${RUNFILES:0:1}" != "/" ]; then
    # Ensure RUNFILES set above is an absolute path. It may be a path relative
    # to the PWD in case where RUNFILES_MANIFEST_FILE is used above.
    RUNFILES="$PWD/$RUNFILES"
fi
# Set RUNFILES_DIR if not already set so that tools such as @bazel/runfiles
# can locate runfiles without requiring RUNFILES to be exported.
export RUNFILES_DIR="${RUNFILES_DIR:-$RUNFILES}"
Ç*
{{log_prefix_rule_set}}aspect_rules_jsÇ 
{{log_prefix_rule}}	js_binaryÇJ
{{launcher}}:../aspect_rules_js+/js/private/node-bootstrap/launcher.cjsÇI
{{node_options}}5JS_BINARY__NODE_OPTIONS+=("--preserve-symlinks-main")ÇH
{{node}}<../rules_nodejs++node+nodejs_linux_amd64/bin/nodejs/bin/nodeÇ	
{{npm}}Ç
{{workspace_name}}_main"B	binB	srcBqueryBtsBnpm.entries.json
n@05bd55fdbfdd933c77df990c9c0acd1c0da0963dece377b17e3e1dc87e54a33e"	FileWrite(Jhr@@platforms//host:hostB	PsrcBOprotocol.tsP
"Oå	@355c71261c2901fdb9a8b691e5b3994c2c7877c4e84cc840900585e5c25b3681"CopyFile(BJ"Z
supports-path-mapping1h"r@@platforms//host:hostB	!bin#
IBexternal!B0*aspect_rules_ts++typescript+npm_typescriptB
tsc_"B	tsc
BU.aspect_rules_js BTtypescript@6.0.3UBSnode_modulesTBR
typescriptS
$R™@606062ce50521444fff34c66f30bc4178f53beb23bab023ae9d916101714c3f9"CopyDirectory(:
GODEBUGwinsymlink=0BJ$Z
supports-path-mapping1h$r@@platforms//host:hostBcollect_coverage.sh

"
"’õ@fb5c7b1c9a26625c8867bbd46f6c4f5127737e5707afa60793261903642e0c81"TemplateExpand(BJhr@@platforms//host:hostz°q#!/usr/bin/env bash

# This bash script is a wrapper around the NodeJS JavaScript file
# entry point with the following bazel label:
#     {{entry_point_label}}
#
# The script's was generated to execute the js_binary target
#     {{target_label}}
#
# The template used to generate this script is
#     {{template_label}}

set -o pipefail -o errexit -o nounset

{{envs}}

# If PATH was not provided, then it is important to export it here so that child
# processes get the default value generated by bash.
export PATH

# ==============================================================================
# Handle --bazel-bindir flag
# ==============================================================================

# If a --bazel-bindir <path> flag is passed it must be the first two
# arguments. It is consumed by this launcher script and used to set
# BAZEL_BINDIR, overriding any value already set in the environment.
if [ $# -gt 0 ] && [ "$1" = "--bazel-bindir" ]; then
    if [ $# -lt 2 ]; then
        echo "ERROR: --bazel-bindir flag requires a value" >&2
        exit 1
    fi
    BAZEL_BINDIR="$2"
    export BAZEL_BINDIR
    shift 2
fi

# ==============================================================================
# Prepare stdout capture, stderr capture && logging
# ==============================================================================

# Convert stdout, stderr and exit_code capture outputs paths to absolute paths.
# A path not starting with "bazel-out/" is relative to the bin directory; joining
# it with BAZEL_BINDIR here (rather than baking in bazel-out/<config>/bin at
# analysis time) keeps it correct when path mapping is active. This must happen
# before any directory changes below since it resolves against $PWD.
function resolve_capture_path {
    case "$1" in
    bazel-out/*) echo "$PWD/$1" ;;
    *) echo "$PWD/$BAZEL_BINDIR/$1" ;;
    esac
}

# TODO(4.0): remove support for capturing stderr, stdout, and exit code. The
# js_run_binary macro now handles this in a way that does not require help from
# the launcher.
if [ "${JS_BINARY__STDOUT_OUTPUT_FILE:-}" ]; then
    JS_BINARY__STDOUT_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__STDOUT_OUTPUT_FILE")"
fi
if [ "${JS_BINARY__STDERR_OUTPUT_FILE:-}" ]; then
    JS_BINARY__STDERR_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__STDERR_OUTPUT_FILE")"
fi
if [ "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ]; then
    JS_BINARY__EXIT_CODE_OUTPUT_FILE="$(resolve_capture_path "$JS_BINARY__EXIT_CODE_OUTPUT_FILE")"
fi

# A stream with a declared output file is written straight to that file so that
# nothing has to run after node exits and this shell can exec node.
#
# A stream that is only subject to silent_on_success has no final destination, so
# it is buffered in a temp file and replayed on failure.
if [ "${JS_BINARY__STDOUT_OUTPUT_FILE:-}" ]; then
    STDOUT_CAPTURE="$JS_BINARY__STDOUT_OUTPUT_FILE"
elif [ "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
    STDOUT_CAPTURE=$(mktemp)
    STDOUT_CAPTURE_IS_TEMP=1
fi

if [ "${JS_BINARY__STDERR_OUTPUT_FILE:-}" ]; then
    STDERR_CAPTURE="$JS_BINARY__STDERR_OUTPUT_FILE"
elif [ "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
    STDERR_CAPTURE=$(mktemp)
    STDERR_CAPTURE_IS_TEMP=1
fi

# FATAL and ERROR diagnostics from this launcher only go into the stderr capture
# if that capture is a temp file that will get replayed on failure. Otherwise,
# we write these straight to stderr so that they do not get lost if the action
# fails.
LOG_ERROR_CAPTURE="${STDERR_CAPTURE_IS_TEMP:+$STDERR_CAPTURE}"

export JS_BINARY__LOG_PREFIX="{{log_prefix_rule_set}}[{{log_prefix_rule}}]"

# Emit a log line to $1, or to the real stderr when $1 is empty.
function log_to {
    local capture="$1"
    local level="$2"
    local message="$3"
    if [ "$capture" ]; then
        printf "%s: %s: %s\n" "$level" "$JS_BINARY__LOG_PREFIX" "$message" >>"$capture"
    else
        printf "%s: %s: %s\n" "$level" "$JS_BINARY__LOG_PREFIX" "$message" >&2
    fi
}

function log_fatal {
    if [ "${JS_BINARY__LOG_FATAL:-}" ]; then
        log_to "${LOG_ERROR_CAPTURE:-}" FATAL "$1"
    fi
}

function log_error {
    if [ "${JS_BINARY__LOG_ERROR:-}" ]; then
        log_to "${LOG_ERROR_CAPTURE:-}" ERROR "$1"
    fi
}

function log_info {
    if [ "${JS_BINARY__LOG_INFO:-}" ]; then
        log_to "${STDERR_CAPTURE:-}" INFO "$1"
    fi
}

function log_debug {
    if [ "${JS_BINARY__LOG_DEBUG:-}" ]; then
        log_to "${STDERR_CAPTURE:-}" DEBUG "$1"
    fi
}

_exit() {
    EXIT_CODE=$?

    # Streams captured to a declared output file were written there directly and
    # need no mop up. Only the temp files that back silent_on_success do.
    if [ "${STDERR_CAPTURE_IS_TEMP:-}" ]; then
        if [ "$EXIT_CODE" != 0 ] || [ -z "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
            cat "$STDERR_CAPTURE" >&2
        fi
        rm "$STDERR_CAPTURE"
    fi

    if [ "${STDOUT_CAPTURE_IS_TEMP:-}" ]; then
        if [ "$EXIT_CODE" != 0 ] || [ -z "${JS_BINARY__SILENT_ON_SUCCESS:-}" ]; then
            cat "$STDOUT_CAPTURE"
        fi
        rm "$STDOUT_CAPTURE"
    fi

    log_debug "exit code: $EXIT_CODE"

    exit "$EXIT_CODE"
}

trap _exit EXIT

# ==============================================================================
# Initialize RUNFILES environment variable
# ==============================================================================
{{initialize_runfiles}}
JS_BINARY__RUNFILES="$RUNFILES"
export JS_BINARY__RUNFILES

# ==============================================================================
# Prepare to run main program
# ==============================================================================

# The execroot the entry point is resolved against below. A parent js_binary process hands its
# own down when it asks for an execroot entry point, because the entry point it resolved is in
# that tree; otherwise this script was started in it. Nothing else here needs an execroot: the
# launcher preload works out JS_BINARY__EXECROOT for the program and everything it spawns.
if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] && [ "${JS_BINARY__EXECROOT:-}" ]; then
    execroot="$JS_BINARY__EXECROOT"
else
    execroot="$PWD"
fi

# Build actions are started in the execroot, so change into the root of the Bazel output tree,
# which is where js_binary programs run. See
# https://github.com/aspect-build/rules_js/tree/dbb5af0d2a9a2bb50e4cf4a96dbc582b27567155#running-nodejs-programs
# for more context on why we do this. It cannot wait for the preload: node resolves the bare
# specifier of a --require in node_options against the directory it was started in.
#
# The bindir is only there to change into when this really is an execroot; in a runfiles tree,
# or in a nested js_binary already running in the bindir, there is nothing to do. The preload
# tells those apart from the broken case by JS_BINARY__CHANGED_TO_BINDIR.
if [ -z "${JS_BINARY__NO_CD_BINDIR:-}" ] && [ "${BAZEL_BINDIR:-}" ] && [ -d "$PWD/$BAZEL_BINDIR" ]; then
    log_debug "changing directory to BAZEL_BINDIR (root of Bazel output tree) $BAZEL_BINDIR"
    export JS_BINARY__CHANGED_TO_BINDIR=1
    cd "$BAZEL_BINDIR"
fi

if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] && [ -z "${BAZEL_BINDIR:-}" ]; then
    log_fatal "Expected BAZEL_BINDIR to be set when JS_BINARY__USE_EXECROOT_ENTRY_POINT is set"
    exit 1
fi

function resolve_execroot_bin_path {
    local short_path="$1"
    if [[ "$short_path" == ../* ]]; then
        echo "$execroot/$BAZEL_BINDIR/external/${short_path:3}"
    else
        echo "$execroot/$BAZEL_BINDIR/$short_path"
    fi
}

function resolve_execroot_src_path {
    local short_path="$1"
    if [[ "$short_path" == ../* ]]; then
        echo "$execroot/external/${short_path:3}"
    else
        echo "$execroot/$short_path"
    fi
}

# Resolve a toolchain file that is a file of this workspace or another repository
# in the runfiles tree, or an absolute path a user set in node_toolchain.
function resolve_toolchain_path {
    local file
    file="$(_normalize_path "$1")"
    if [ "${file:0:1}" = "/" ]; then
        echo "$file"
    elif [ "${JS_BINARY__NO_RUNFILES:-}" ]; then
        resolve_execroot_src_path "$file"
    else
        echo "$JS_BINARY__RUNFILES/{{workspace_name}}/$file"
    fi
}

# Everything below is resolved here only because node needs it on its command line
# or bash needs it to start node at all. The checks that can wait, and the rest of
# the environment the program sees, are done by the launcher preload once node is up.

if [ "${JS_BINARY__USE_EXECROOT_ENTRY_POINT:-}" ] || [ "${JS_BINARY__NO_RUNFILES:-}" ]; then
    entry_point=$(resolve_execroot_bin_path "{{entry_point_path}}")
else
    entry_point="$JS_BINARY__RUNFILES/{{workspace_name}}/{{entry_point_path}}"
fi

export JS_BINARY__NODE_BINARY
JS_BINARY__NODE_BINARY=$(resolve_toolchain_path "{{node}}")
if [ ! -f "$JS_BINARY__NODE_BINARY" ]; then
    log_fatal "node binary '$JS_BINARY__NODE_BINARY' not found"
    exit 1
fi
if [ "$_IS_WINDOWS" -ne "1" ] && [ ! -x "$JS_BINARY__NODE_BINARY" ]; then
    log_fatal "node binary '$JS_BINARY__NODE_BINARY' is not executable"
    exit 1
fi

npm="{{npm}}"
if [ "$npm" ]; then
    export JS_BINARY__NPM_BINARY
    JS_BINARY__NPM_BINARY=$(resolve_toolchain_path "$npm")
fi

launcher=$(resolve_toolchain_path "{{launcher}}")
if [ ! -f "$launcher" ]; then
    log_fatal "launcher '$launcher' not found"
    exit 1
fi

# Gather node options
JS_BINARY__NODE_OPTIONS=()
{{node_options}}

ARGS=()
ALL_ARGS=({{fixed_args}} "$@")
for ARG in ${ALL_ARGS[@]+"${ALL_ARGS[@]}"}; do
    case "$ARG" in
    # Let users pass through arguments to node itself
    --node_options=*) JS_BINARY__NODE_OPTIONS+=("${ARG#--node_options=}") ;;
    # Remaining argv is collected to pass to the program
    *) ARGS+=("$ARG") ;;
    esac
done

# ==============================================================================
# Run the main program
# ==============================================================================

# Invoke node directly rather than through $JS_BINARY__NODE_WRAPPER. This way
# we avoid spawning an extra bash process on every launch. The wrapper is
# still put on the PATH as `node` so that child processes get the patched
# runtime.
node_cmd=("$JS_BINARY__NODE_BINARY" --require "$launcher")

if [ "${JS_BINARY__LOG_INFO:-}" ]; then
    log_info "$(echo -n "running" "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"})"
fi

# De-export capture-related vars so child processes (e.g. a nested js_binary)
# do not inherit them. The bash script has already consumed them above to set up
# STDOUT_CAPTURE / STDERR_CAPTURE; leaking them would cause a nested js_binary
# to silently swallow its own stdout or write to the wrong output file.
# export -n keeps the value accessible to the _exit trap while removing it from
# the environment seen by node and any processes it spawns.
export -n JS_BINARY__STDOUT_OUTPUT_FILE JS_BINARY__STDERR_OUTPUT_FILE JS_BINARY__EXIT_CODE_OUTPUT_FILE JS_BINARY__SILENT_ON_SUCCESS

set +e

if [ -z "${JS_BINARY__EXPECTED_EXIT_CODE:-}" ] && [ -z "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ] &&
    [ -z "${STDOUT_CAPTURE_IS_TEMP:-}" ] && [ -z "${STDERR_CAPTURE_IS_TEMP:-}" ]; then
    # Nothing must run after node exits, so replace this shell with node. Signals
    # and terminal control are then delivered directly to node instead of being
    # proxied through a backgrounded child.
    if [ "${STDOUT_CAPTURE:-}" ]; then
        exec 1>>"$STDOUT_CAPTURE"
    fi
    if [ "${STDERR_CAPTURE:-}" ]; then
        exec 2>>"$STDERR_CAPTURE"
    fi
    exec "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"}
    exit 127
fi

if [ "${STDOUT_CAPTURE:-}" ] && [ "${STDERR_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 >>"$STDOUT_CAPTURE" 2>>"$STDERR_CAPTURE" &
elif [ "${STDOUT_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 >>"$STDOUT_CAPTURE" &
elif [ "${STDERR_CAPTURE:-}" ]; then
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 2>>"$STDERR_CAPTURE" &
else
    "${node_cmd[@]}" ${JS_BINARY__NODE_OPTIONS[@]+"${JS_BINARY__NODE_OPTIONS[@]}"} -- "$entry_point" ${ARGS[@]+"${ARGS[@]}"} <&0 &
fi

# ==============================================================================
# Wait for program to finish
# ==============================================================================

readonly child=$!
# Bash does not forward termination signals to any child process when
# running in docker, so we need to manually trap and forward the signals.
#
# Each trap is reset as it fires, so that a repeat of that signal terminates this
# script rather than being swallowed.
_term() { trap - SIGTERM; kill -TERM "${child}" 2>/dev/null; }
_int() { trap - SIGINT; kill -INT "${child}" 2>/dev/null; }
trap _term SIGTERM
trap _int SIGINT

# A wait returns as soon as a trapped signal has been handled, whether or not the
# child has exited, so keep waiting until it has.
wait "$child"
RESULT="$?"
while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    RESULT="$?"
done

# Remove traps now that the child process has exited
trap - SIGTERM SIGINT
set -e

# ==============================================================================
# Mop up after main program
# ==============================================================================

if [ "${JS_BINARY__EXPECTED_EXIT_CODE:-}" ]; then
    if [ "$RESULT" != "$JS_BINARY__EXPECTED_EXIT_CODE" ]; then
        log_error "expected exit code to be '$JS_BINARY__EXPECTED_EXIT_CODE', but got '$RESULT'"
        if [ $RESULT -eq 0 ]; then
            # This exit code is handled specially by Bazel:
            # https://github.com/bazelbuild/bazel/blob/486206012a664ecb20bdb196a681efc9a9825049/src/main/java/com/google/devtools/build/lib/util/ExitCode.java#L44
            readonly BAZEL_EXIT_TESTS_FAILED=3
            exit $BAZEL_EXIT_TESTS_FAILED
        fi
        exit $RESULT
    else
        exit 0
    fi
fi

if [ "${JS_BINARY__EXIT_CODE_OUTPUT_FILE:-}" ]; then
    # Exit zero if the exit code was captured
    echo -n "$RESULT" >"$JS_BINARY__EXIT_CODE_OUTPUT_FILE"
    exit 0
else
    exit $RESULT
fi
ÇF
{{target_label}}2@@aspect_rules_ts++typescript+npm_typescript//:tscÇE
{{template_label}}/@@aspect_rules_js+//js/private:js_binary.sh.tplÇV
{{entry_point_label}}=@@aspect_rules_ts++typescript+npm_typescript//:tsc_entrypointÇî
{{entry_point_path}}|../aspect_rules_ts++typescript+npm_typescript/node_modules/.aspect_rules_js/typescript@6.0.3/node_modules/typescript/bin/tscÇ£
{{envs}}ñexport JS_BINARY__BINDIR="bazel-out/k8-opt-exec-ST-d57f47055a04/bin"
export JS_BINARY__COMPILATION_MODE="opt"
export JS_BINARY__TARGET_CPU="k8"
export JS_BINARY__BUILD_FILE_PATH="BUILD.bazel"
export JS_BINARY__PACKAGE=""
export JS_BINARY__TARGET_NAME="tsc"
export JS_BINARY__TARGET="@aspect_rules_ts++typescript+npm_typescript//:tsc"
export JS_BINARY__WORKSPACE="_main"
if [[ -z "${JS_BINARY__PATCH_NODE_FS:-}" ]]; then export JS_BINARY__PATCH_NODE_FS="1"; fi
export JS_BINARY__COPY_DATA_TO_BIN="1"
if [[ -z "${JS_BINARY__LOG_FATAL:-}" ]]; then export JS_BINARY__LOG_FATAL="1"; fi
if [[ -z "${JS_BINARY__LOG_ERROR:-}" ]]; then export JS_BINARY__LOG_ERROR="1"; fiÇ
{{fixed_args}}Çù
{{initialize_runfiles}}Å
# It helps to determine if we are running on a Windows environment (excludes WSL as it acts like Unix)
case "$(uname -s)" in
CYGWIN*) _IS_WINDOWS=1 ;;
MINGW*) _IS_WINDOWS=1 ;;
MSYS_NT*) _IS_WINDOWS=1 ;;
*) _IS_WINDOWS=0 ;;
esac

# It helps to normalizes paths when running on Windows.
#
# Example:
# C:/Users/XUser/_bazel_XUser/7q7kkv32/execroot/A/b/C -> /c/Users/XUser/_bazel_XUser/7q7kkv32/execroot/A/b/C
function _normalize_path {
    if [ "$_IS_WINDOWS" -eq "1" ]; then
        # Apply the followings paths transformations to normalize paths on Windows
        # -process driver letter
        # -convert path separator
        sed -e 's#^\(.\):#/\L\1#' -e 's#\\#/#g' <<<"$1"
    else
        echo "$1"
    fi
    return
}

# Set a RUNFILES environment variable to the root of the runfiles tree
# since RUNFILES_DIR is not set by Bazel in all contexts.
# For example, `RUNFILES=/path/to/my_js_binary.sh.runfiles`.
#
# Call this program X. X was generated by a genrule and may be invoked
# in many ways:
#   1a) directly by a user, with $0 in the output tree
#   1b) via 'bazel run' (similar to case 1a)
#   2) directly by a user, with $0 in X's runfiles
#   3) by another program Y which has a data dependency on X, with $0 in Y's
#      runfiles
#   4a) via 'bazel test'
#   4b) case 3 in the context of a test
#   5a) by a genrule cmd, with $0 in the output tree
#   6a) case 3 in the context of a genrule
#
# For case 1, $0 will be a regular file, and the runfiles will be
# at $0.runfiles.
# For case 2 or 3, $0 will be a symlink to the file seen in case 1.
# For case 4, $TEST_SRCDIR should already be set to the runfiles by
# blaze.
# Case 5a is handled like case 1.
# Case 6a is handled like case 3.
if [ "${TEST_SRCDIR:-}" ]; then
    # Case 4, bazel has identified runfiles for us.
    RUNFILES=$(_normalize_path "$TEST_SRCDIR")
elif [ "${RUNFILES_MANIFEST_FILE:-}" ]; then
    RUNFILES=$(_normalize_path "$RUNFILES_MANIFEST_FILE")
    if [[ "${RUNFILES}" == *.runfiles_manifest ]]; then
        # Bazel puts the manifest besides the runfiles with the suffix .runfiles_manifest.
        # For example, the runfiles directory is named my_binary.runfiles then the manifest is beside the
        # runfiles directory and named my_binary.runfiles_manifest
        RUNFILES=${RUNFILES%_manifest}
    elif [[ "${RUNFILES}" == */MANIFEST ]]; then
        # Bazel for windows puts the manifest file named MANIFEST in the runfiles directory
        RUNFILES=${RUNFILES%/MANIFEST}
    else
        log_fatal "Unexpected RUNFILES_MANIFEST_FILE value $RUNFILES_MANIFEST_FILE"
        exit 1
    fi
else
    case "$0" in
    /*) self="$0" ;;
    *) self="$PWD/$0" ;;
    esac
    while true; do
        if [ -e "$self.runfiles" ]; then
            RUNFILES="$self.runfiles"
            break
        fi

        if [[ "$self" == *.runfiles/* ]]; then
            RUNFILES="${self%%.runfiles/*}.runfiles"
            # don't break; this is a last resort for case 6b
        fi

        if [ ! -L "$self" ]; then
            break
        fi

        readlink="$(readlink "$self")"
        if [[ "$readlink" == /* ]]; then
            self="$readlink"
        else
            # resolve relative symlink
            self="${self%%/*}/$readlink"
        fi
    done

    if [ -z "${RUNFILES:-}" ]; then
        log_fatal "RUNFILES environment variable is not set"
        exit 1
    fi

    RUNFILES=$(_normalize_path "$RUNFILES")
fi
if [ "${RUNFILES:0:1}" != "/" ]; then
    # Ensure RUNFILES set above is an absolute path. It may be a path relative
    # to the PWD in case where RUNFILES_MANIFEST_FILE is used above.
    RUNFILES="$PWD/$RUNFILES"
fi
# Set RUNFILES_DIR if not already set so that tools such as @bazel/runfiles
# can locate runfiles without requiring RUNFILES to be exported.
export RUNFILES_DIR="${RUNFILES_DIR:-$RUNFILES}"
Ç*
{{log_prefix_rule_set}}aspect_rules_jsÇ 
{{log_prefix_rule}}	js_binaryÇJ
{{launcher}}:../aspect_rules_js+/js/private/node-bootstrap/launcher.cjsÇI
{{node_options}}5JS_BINARY__NODE_OPTIONS+=("--preserve-symlinks-main")ÇH
{{node}}<../rules_nodejs++node+nodejs_linux_amd64/bin/nodejs/bin/nodeÇ	
{{npm}}Ç
{{workspace_name}}_mainBYbazel_toolsBXtoolsYB
WtestXBVcollect_coverageW
%Vy@7a39b61d5744a8903119e17b3ddc7e56e330f240d2bead98c3ba081a81b5c9ac"ExecutableSymlink(BJ%h%r@@platforms//host:hostBZquery.tsP
&Zå	@ed93ae2d2ca6952c52ad071d3c447d0a55889f4d5cd51c67ff7d4c7e1a4dd89d"CopyFile(BJ&Z
supports-path-mapping1h&r@@platforms//host:hostB"[tsconfig.build.commonjs.json-
'["'B"\tsconfig.build.commonjs.json
(\å	@ea8439ef62e576dc448185c76a34e296221a6445e2c72a1867d94d44609ca968"CopyFile(BJ(Z
supports-path-mapping1h(r@@platforms//host:hostB]tsconfig.json-
)]")B^tsconfig.json
*^å	@ca78fdcddb26bc5090f6d7bad5544b75858f8d575b56254e51896b7ae1a47319"CopyFile(BJ*Z
supports-path-mapping1h*r@@platforms//host:host?9//src/query/ts:.aspect_rules_js/node_modules/undici-types	B.query/B-ts.B	+src-B
protocol.ts+

"
+Oå
@355c71261c2901fdb9a8b691e5b3994c2c7877c4e84cc840900585e5c25b3681"CopyFile(BJ+Z
supports-path-mapping1h+r@@platforms//host:host"
,Zå
@ed93ae2d2ca6952c52ad071d3c447d0a55889f4d5cd51c67ff7d4c7e1a4dd89d"CopyFile(BJ,Z
supports-path-mapping1h,r@@platforms//host:hostB atsconfig.build.module.json-
.aB#`+languages+query_undici_types".B_package.tgz`B btsconfig.build.module.json
-_
/bå
@eb16123fff5c14f3d38fd4f9395321e5eaaf4185e891bd23f5163f2313bfe32f"CopyFile(BJ/Z
supports-path-mapping1h/r@@platforms//host:host"-Beundici-types@7.16.05Bdnode_moduleseBcundici-typesd
0c")
1^®@808d3dd8e3b7822833218c13dca70010d16f0a1d05e17e459ed5f277c8a3df49"NpmPackageExtract(:
LC_ALLC.UTF-8BJ0Z
supports-path-mapping1h0r@@platforms//host:hostå
@ca78fdcddb26bc5090f6d7bad5544b75858f8d575b56254e51896b7ae1a47319"CopyFile(BJ1Z
supports-path-mapping1h1r@@platforms//host:host"(*Bjtsc_worker.repo_mapping$
4jx@4f4bf4b1b5b2284ce521a69b165072b12450dee320415b733ec58bd4930c216f"RepoMappingManifest(J4h4r@@platforms//host:hostB#kcollect_coverage.repo_mappingW
5kx@9df0fc7af996fee90934caf5821e6d3bf171df2d4270b392733ad8c5820cfbfa"RepoMappingManifest(J5h5r@@platforms//host:hostB(l"collect_coverage.runfiles_manifestW"
6lB"mtsc_worker.runfiles_manifest$z@8bfd336cc84e266eab28b0241686be81d8b7b052c4033aef8a98a9430853f275"SourceSymlinkManifest(J6h6r@@platforms//host:host
7m}@aeb51d69bd94c236f4ecfb31cbd3f2e1c7076041098ca62ed400c2617e654062"SourceSymlinkManifest(BJ7h7r@@platforms//host:host"7"6Bocollect_coverage.runfilesWBnMANIFESTo
8nBqtsc_worker.runfiles$BpMANIFESTqs@6c51cb2745410b7f3021e2c6da7719dd646a1f8007539f27ba608eeaec4dc9d9"SymlinkTree(BJ8h8r@@platforms//host:host
9ps@41ae5ee3bb7cce9243d85ef829862800b09b0a8e30356db261cc1c34d42eee02"SymlinkTree(BJ9h9r@@platforms//host:host"$$"%
%"	"$"#%%"	 #85"/1Bhinternal#
EBg
_middlemenhB#Qnpm.sources__main_config.jsonê@784a5dc4f99b530faf423a9953d183a9c90b5828f320b7d2fddf304d14e670cd"CopyToDirectory(:
GODEBUGwinsymlink=0BJhr@@platforms//host:host
#Qn@52509dd660d2da8dfa398df24019a0abcc8a70177dffc0c56122bb1e0b67ad26"	FileWrite(J#h#r@@platforms//host:hostB#t+bun_toolchains+bun_linux_x64B	sbunt
;s"&;Bu	unit_test
<uy@7a39b61d5744a8903119e17b3ddc7e56e330f240d2bead98c3ba081a81b5c9ac"ExecutableSymlink(B&J<h<r@@platforms//host:hostBx
build_defsBw
foundationxB!vbun-test-entrypoint.mts.tplw
=v"'=Byunit_test.entry.mtsBEr?external_Sbazel_Utools_Stools_Stest_Scollect_Ucoverage-runfilesg
:rq@709e80c88487a2411e1ee4dfb9f22a861492d20c4765150c0c794abd70f8147c"	Middleman(B J:h:r@@platforms//host:hostBztsc.repo_mapping
?zx@12c9b1f6f544d5257dfac27c1dd0b0313c3c828a3d038baeb2859a2090ae2103"RepoMappingManifest(J?h?r@@platforms//host:hostBivalidator.repo_mappingM
>yB^fXexternal_Saspect_Urules_Uts++typescript+npm_Utypescript_Svalidator_U_Svalidator-runfilesg
2f" 2"B {commonjs_params.validation
@{ª	@409d1bf0360f30c3b7f0dc097f86cd5258a2bbd1440bc8531f8cbb5597a46032"TsValidateOptions(:$
PATH/bin:/usr/bin:/usr/local/binBJ@Z
supports-path-mapping1h@r@@platforms//host:host∂@f4b635ed843c3a32b801874310b9103478bbd7a65f0284d8e84ba2fd34741dac"TemplateExpand(B'J>h>r@@platforms//host:hostz˜import { isAbsolute, join, resolve } from "node:path";

const configuration = @@CONFIG@@;
const declaredRoot = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR ?? join(import.meta.dir, configuration.runfilesSibling);
if (!declaredRoot || !isAbsolute(declaredRoot)) {
  throw new Error("Bazel Bun entrypoints require an absolute directory runfiles root");
}
const root = resolve(declaredRoot);
const args = configuration.arguments.map((argument) =>
  "file" in argument ? join(root, argument.file) : argument.literal,
);
if (configuration.runfilesArgument) args.push(root);
args.push(...process.argv.slice(2));
const testArguments = configuration.testRunner ? ["test"] : [];
if (configuration.testRunner && !args.some((argument) => argument === "--timeout" || argument.startsWith("--timeout="))) {
  testArguments.push("--timeout=30000");
}
const environment = { ...process.env, ...configuration.environment };
for (const name of configuration.runfilesEnvironment) environment[name] = root;
// Execute the authored runner as the main module: importing it would skip
// runners guarded by import.meta.main. No script interpreter or shell is used.
const result = Bun.spawnSync(
  [process.execPath, "--no-install", "--no-env-file", ...testArguments, join(root, configuration.runner), ...args],
  {
    cwd: join(root, configuration.testRunner ? configuration.sourceRoot : configuration.workspace),
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(result.exitCode);
Ç¬

@@CONFIG@@≥{"arguments":[],"environment":{},"runfilesArgument":false,"runfilesEnvironment":[],"runfilesSibling":"unit_test.runfiles","runner":"_main/src/query/ts/unit_test.sources/_main/src/query/ts/test/protocol.test.ts","sourceRoot":"_main/src/query/ts/unit_test.sources/_main","testRunner":true,"workspace":"_main"}B}queryxB|package.mts}
A|B
ÄtoolsB	packagingÄB~archive-directory.mts
B~BÅportable-archive.mts
CÅ")ABC#"()BÉnpm.sourcesBÇ_mainÉ
DÇê@4a9b99ad2ba2756cd3dafdd8d8a264442cde23e7a874c3b78e4c2379a98ef29b"CopyToDirectory(:
GODEBUGwinsymlink=0B(JDhDr@@platforms//host:host"-	".0",-."+,"&(*BSÑLexternal_Saspect_Urules_Uts++typescript+npm_Utypescript_Stsc_U_Stsc-runfilesg
EÑ"/EBáunit_test.repo_mappingBÖpackage.json-"Bàmodule_params.validation
Iàª
@8daa333b8da0ce7b58fc8e5efbd32a5d743e6c9cc88d02f4d5992a520e59260f"TsValidateOptions(:$
PATH/bin:/usr/bin:/usr/local/binBJIZ
supports-path-mapping1hIr@@platforms//host:host
3iBÜtsc.runfiles_manifestx@bec6c834996de644e591e6008973b7e4952fba4a55a4ac5576c35cab841b5b2f"RepoMappingManifest(J3h3r@@platforms//host:host
GÜ"5-."45+,/1"34/BãdistBämoduleãBâprotocol.jsä
JâBåquery.jsä
KåBçprotocol.d.tsä
LçBé
query.d.tsä
Mé∂
@121bdf1046708dcd2f7c80900beaafd362b9a7f02d02a4b39eb27f39d73c9d87"	TsProject(:$
PATH/bin:/usr/bin:/usr/local/binB3JJKLMZ
supports-path-mapping1hJr@@platforms//host:host
Háx@170a6ade2e703fab4f3dc67c45dee7c2309a69850303f8638d31b50bbba9979b"RepoMappingManifest(JHhHr@@platforms//host:host"*+/BêcommonjsãBèprotocol.jsê
NèBëquery.jsê
OëBíprotocol.d.tsê
PíBì
query.d.tsê
Qì∂	@eb70c7f97e2bb8f5fafa862131b73ff9d4ead652d655ca0a50b666f0ab914da2"	TsProject(:$
PATH/bin:/usr/bin:/usr/local/binB*JNOPQZ
supports-path-mapping1hNr@@platforms//host:host
FÖBîmodule.package.json-
RîBï	README.md-
SïBñLICENSE-
Tñ"2FJKLMNOPQRSTABC"12D"01;Bóoliphaunt-ts-query.tgz
Uóu@14e4b9ba30e7e0fbf72f2d1a4350e0938c172b1965375bffaeafa4ba4fc8d8d8"QueryEnvelope(B0JUhUr@@platforms//host:host}@508f993cdec86653e41f1ace9feaacb9cfa1eb8d095ddc04168c89046a1ec842"SourceSymlinkManifest(BJGhGr@@platforms//host:hostB"òvalidator.runfiles_manifestM
Vò"6G}@13d51e1fac28ddc9aca91b290ea8733ba5d35a33c7904c0df272ebf35cd12613"SourceSymlinkManifest(BJVhVr@@platforms//host:hostB"ôunit_test.runfiles_manifestBõtsc.runfiles
WôBöMANIFESTõ
Xöz@3a906f60ecc5e30400344adf6001ddb42db3e92b914004ae55e63580e01681c7"SourceSymlinkManifest(JWhWr@@platforms//host:hosts@1f17070e60e3bf9a9669670316b52e74d536f87222038f3a83a6a7e8a90cb6d4"SymlinkTree(B6JXhXr@@platforms//host:host"	<$$"=$";<=">$":;>Bùnode_binBúnodeù
YúB,¢%rules_nodejs++node+nodejs_linux_amd64B°bin¢B†nodejs°Bübin†Bûnodeü"@V"AWB•validator.runfilesMB£MANIFEST•B¶unit_test.runfiles
ZûB§MANIFEST¶
\§
[£B®node-bootstraps@cb69b03d8a1b01347e46537d8b3df85ef4e388f5a184e9deb179862b9cd65f29"SymlinkTree(BAJ\h\r@@platforms//host:hostBßfs.cjs®
]ßs@6f39b35c51abc0e698bc3153a3b074c18e08c2f6d3da4848388f8c84f2496ad3"SymlinkTree(B@J[h[r@@platforms//host:hostB©bootstrap.cjs®
^©B™launcher.cjs®
_™B´util.cjs®
`´"?YZ]^_`"9:?"89"	78X?q@709e80c88487a2411e1ee4dfb9f22a861492d20c4765150c0c794abd70f8147c"	Middleman(B7JEhEr@@platforms//host:host"D
>;"CD<"	BC\HBÆinternalB≠
_middlemenÆB+¨#src_Squery_Sts_Sunit_Utest-runfiles≠
a¨q@709e80c88487a2411e1ee4dfb9f22a861492d20c4765150c0c794abd70f8147c"	Middleman(BBJahar@@platforms//host:host"
J$!$"IJ="HI>"K YZ]^_`"GHK"FG "	EF[3q@709e80c88487a2411e1ee4dfb9f22a861492d20c4765150c0c794abd70f8147c"	Middleman(BEJ2h2r@@platforms//host:hostBØtest-setup.sh
bØB∞generate-xml.sh
c∞"LabcB∂testlogsBµsrc∂B¥queryµB
≥ts¥B≤	unit_test≥B±test.log≤
d±B∑test.xml≤
e∑B∏test.cache_status≤
f∏Bπtest.outputs≤
gπõ@6ed99f9926c5224d162959d96f5725ecf16b892c1a3df98821d2c5892b186ea3"
TestRunner(:$
PATH/bin:/usr/bin:/usr/local/binBLJdefghdr@@platforms//host:host"!"$"!=">"MYZ]^_`"M""	94Bc∫\external_Saspect_Urules_Uts++typescript+npm_Utypescript_Stsc_Uworker_U_Stsc_Uworker-runfilesg
h∫q@709e80c88487a2411e1ee4dfb9f22a861492d20c4765150c0c794abd70f8147c"	Middleman(BJhhhr@@platforms//host:host