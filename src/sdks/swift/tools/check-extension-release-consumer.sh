#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
	echo "check-extension-release-consumer.sh: must run inside the Oliphaunt checkout" >&2
	exit 1
}
cd "$root"

fail() {
	echo "check-extension-release-consumer.sh: $*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_file() {
	[ -f "$1" ] || fail "missing required file: $1"
	[ -s "$1" ] || fail "required file is empty: $1"
}

require_directory() {
	[ -n "${2:-}" ] || fail "missing required environment variable $1"
	[ -d "$2" ] || fail "$1 is not a directory: $2"
}

usage() {
	echo "usage: src/sdks/swift/tools/check-extension-release-consumer.sh --source-carrier FILE --cache-warm-carrier FILE --extension-carrier FILE [--extension-carrier FILE ...]"
}

source_carrier=""
cache_warm_carrier=""
extension_carriers=()
while (($# > 0)); do
	case "$1" in
	--source-carrier | --cache-warm-carrier | --extension-carrier)
		(($# >= 2)) || fail "$1 requires a value"
		option="$1"
		value="$2"
		shift 2
		case "$option" in
		--source-carrier)
			[ -z "$source_carrier" ] || fail "--source-carrier must be passed exactly once"
			source_carrier="$value"
			;;
		--cache-warm-carrier)
			[ -z "$cache_warm_carrier" ] || fail "--cache-warm-carrier must be passed exactly once"
			cache_warm_carrier="$value"
			;;
		--extension-carrier) extension_carriers+=("$value") ;;
		esac
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		usage >&2
		fail "unknown argument: $1"
		;;
	esac
done

[ -n "$source_carrier" ] || fail "--source-carrier is required"
[ -n "$cache_warm_carrier" ] || fail "--cache-warm-carrier is required"
((${#extension_carriers[@]} > 0)) || fail "at least one --extension-carrier is required"

safe_extract_zip() {
	local archive="$1"
	local destination="$2"
	require_file "$archive"
	if [ -e "$destination" ] || [ -L "$destination" ]; then
		fail "verified ZIP destination already exists: $destination"
	fi
	tools/dev/bun.sh src/sdks/swift/tools/extract-verified-zip.mjs \
		--archive "$archive" \
		--destination "$destination"
}

for command in git swift unzip zipinfo; do
	require_command "$command"
done

[ "$(uname -s)" = "Darwin" ] || fail "exact-extension Swift release consumer must run on macOS"
[ "$(uname -m)" = "arm64" ] || fail "exact-extension Swift release consumer requires macOS arm64; found $(uname -m)"

candidate_sha="${CI_HEAD_SHA:-}"
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] ||
	fail "CI_HEAD_SHA must be the full immutable candidate commit"
actual_sha="$(git rev-parse HEAD)"
[ "$actual_sha" = "$candidate_sha" ] ||
	fail "checked-out candidate $actual_sha does not match CI_HEAD_SHA $candidate_sha"

sdk_artifact_dir="${OLIPHAUNT_SWIFT_SDK_ARTIFACT_DIR:-}"
native_asset_dir="${OLIPHAUNT_SWIFT_NATIVE_ASSET_DIR:-}"
require_directory OLIPHAUNT_SWIFT_SDK_ARTIFACT_DIR "$sdk_artifact_dir"
require_directory OLIPHAUNT_SWIFT_NATIVE_ASSET_DIR "$native_asset_dir"
require_file "$source_carrier"
require_file "$cache_warm_carrier"
for carrier in "${extension_carriers[@]}"; do
	require_file "$carrier"
done

carrier_input_args=(--source-carrier "$source_carrier")
extension_carrier_args=()
for carrier in "${extension_carriers[@]}"; do
	carrier_input_args+=(--extension-carrier "$carrier")
	extension_carrier_args+=(--extension-carrier "$carrier")
done
carrier_plan="$(
	tools/dev/bun.sh tools/release/swift-extension-release-consumer-inputs.mjs \
		"${carrier_input_args[@]}"
)"
extensions_csv="$(
	tools/dev/bun.sh -e '
    const plan = JSON.parse(Bun.argv[1]);
    process.stdout.write(plan.extensionsCsv);
  ' "$carrier_plan"
)"
extension="$(
	tools/dev/bun.sh -e '
    const plan = JSON.parse(Bun.argv[1]);
    process.stdout.write(plan.finalLink.nativeExtension ?? "");
  ' "$carrier_plan"
)"
final_link_kind="$(
	tools/dev/bun.sh -e '
    const plan = JSON.parse(Bun.argv[1]);
    process.stdout.write(plan.finalLink.kind);
  ' "$carrier_plan"
)"
planned_native_version="$(
	tools/dev/bun.sh -e '
    const plan = JSON.parse(Bun.argv[1]);
    process.stdout.write(plan.finalLink.runtimeVersion);
  ' "$carrier_plan"
)"
[ -n "$extensions_csv" ] || fail "independent extension carriers selected no extensions"
case "$final_link_kind" in
base-runtime)
	[ -z "$extension" ] || fail "base-runtime proof unexpectedly selected native extension $extension"
	;;
native-extension)
	[ -n "$extension" ] || fail "native-extension proof did not select a native extension"
	;;
*) fail "independent extension carrier plan returned unknown final-link kind: $final_link_kind" ;;
esac

native_version="$(tools/dev/bun.sh tools/release/product-version.mjs version liboliphaunt-native)"
[ "$planned_native_version" = "$native_version" ] ||
	fail "carrier plan requires liboliphaunt-native $planned_native_version, but the candidate builds $native_version"
source_archive="$sdk_artifact_dir/Oliphaunt-source.zip"
release_manifest="$sdk_artifact_dir/Package.swift.release"
release_tree="$sdk_artifact_dir/release-tree"
xcframework_archive="$native_asset_dir/liboliphaunt-$native_version-apple-spm-xcframework.zip"
require_file "$source_archive"
require_file "$release_manifest"
require_file "$xcframework_archive"
require_directory swift-release-tree "$release_tree"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-swift-extension-consumer.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
release_package="$scratch/release/oliphaunt"
mkdir -p "$release_package/src/sdks/swift"
safe_extract_zip "$source_archive" "$scratch/source"
require_directory swift-source-package "$scratch/source/package"
cp -R "$scratch/source/package/." "$release_package/src/sdks/swift/"
cp -R "$release_tree/." "$release_package/"
safe_extract_zip "$xcframework_archive" "$release_package/Artifacts"
require_directory apple-xcframework "$release_package/Artifacts/liboliphaunt.xcframework"
require_directory macos-arm64-base-slice "$release_package/Artifacts/liboliphaunt.xcframework/macos-arm64"
library="$release_package/Artifacts/liboliphaunt.xcframework/macos-arm64/liboliphaunt.framework/liboliphaunt"
require_file "$library"
[ -x "$library" ] || fail "macOS base framework library is not executable: $library"
tools/dev/bun.sh tools/release/prepare-swift-release-consumer.mjs \
	--manifest "$release_manifest" \
	--asset "$xcframework_archive" \
	--output "$release_package/Package.swift"

selected_package="$scratch/selected-extensions"
cache="$scratch/carrier-cache"
tools/dev/bun.sh src/sdks/swift/tools/render-extension-products.mjs \
	--carrier "$cache_warm_carrier" \
	--extensions "$extensions_csv" \
	--cache-dir "$cache" \
	--allow-file-urls \
	--local-binary-targets \
	--base-package-path "$release_package" \
	--output-dir "$scratch/cache-warm-package"
tools/dev/bun.sh src/sdks/swift/tools/render-extension-products.mjs \
	--carrier "$source_carrier" \
	"${extension_carrier_args[@]}" \
	--extensions "$extensions_csv" \
	--cache-dir "$cache" \
	--offline \
	--local-binary-targets \
	--base-package-path "$release_package" \
	--output-dir "$selected_package"

products="$selected_package/extension-products.json"
require_file "$products"
consumer="$scratch/consumer"
mkdir -p "$consumer/Sources/OliphauntExtensionReleaseConsumer"
# JavaScript template interpolation is evaluated by Bun.
# shellcheck disable=SC2016
OLIPHAUNT_CARRIER_PLAN="$carrier_plan" \
	OLIPHAUNT_EXTENSION_PRODUCTS="$products" \
	OLIPHAUNT_RELEASE_PACKAGE="$release_package" \
	OLIPHAUNT_SELECTED_PACKAGE="$selected_package" \
	OLIPHAUNT_EXTENSION_CONSUMER="$consumer" \
	tools/dev/bun.sh -e '
    import path from "node:path";
    const plan = JSON.parse(process.env.OLIPHAUNT_CARRIER_PLAN);
    const products = JSON.parse(await Bun.file(process.env.OLIPHAUNT_EXTENSION_PRODUCTS).text());
    if (!Array.isArray(products.selected) || products.selected.length === 0) {
      throw new Error("generated extension package selected no products");
    }
    const selected = products.selected.map((row, index) => {
      const swiftProduct = row?.swiftProduct;
      if (typeof swiftProduct !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/u.test(swiftProduct)) {
        throw new Error(`generated extension package selected[${index}] has an invalid Swift product name`);
      }
      if (typeof row.sqlName !== "string" || !/^[A-Za-z0-9._-]+$/u.test(row.sqlName)) {
        throw new Error(`generated extension package selected[${index}] has an invalid SQL name`);
      }
      if (typeof row.product !== "string" || !/^oliphaunt-extension-[A-Za-z0-9._-]+$/u.test(row.product)) {
        throw new Error(`generated extension package selected[${index}] has an invalid release product`);
      }
      if (
        row.nativeModuleStem !== null
        && (typeof row.nativeModuleStem !== "string" || !/^[A-Za-z0-9._-]+$/u.test(row.nativeModuleStem))
      ) {
        throw new Error(`generated extension package selected[${index}] has an invalid native module stem`);
      }
      return {
        nativeModuleStem: row.nativeModuleStem,
        product: row.product,
        sqlName: row.sqlName,
        swiftProduct,
      };
    });
    if (new Set(selected.map(({ swiftProduct }) => swiftProduct)).size !== selected.length) {
      throw new Error("generated extension package repeats a Swift product name");
    }
    if (new Set(selected.map(({ sqlName }) => sqlName)).size !== selected.length) {
      throw new Error("generated extension package repeats an extension SQL name");
    }
    const actualExtensions = selected.map(({ sqlName }) => sqlName).sort();
    if (JSON.stringify(actualExtensions) !== JSON.stringify(plan.extensions)) {
      throw new Error("generated extension package does not exactly cover the carrier-planned extension set");
    }
    const actualProducts = [...new Set(selected.map(({ product }) => product))].sort();
    if (JSON.stringify(actualProducts) !== JSON.stringify(plan.extensionProducts)) {
      throw new Error("generated extension package does not exactly cover the carrier-planned release products");
    }
    if (
      products.nativeRuntime?.product !== plan.finalLink.runtimeProduct
      || products.nativeRuntime?.version !== plan.finalLink.runtimeVersion
    ) {
      throw new Error("generated extension package native runtime identity differs from the final-link plan");
    }
    let finalLink = null;
    if (plan.finalLink.kind === "native-extension") {
      finalLink = selected.find(({ sqlName }) => sqlName === plan.finalLink.nativeExtension) ?? null;
      if (finalLink === null || finalLink.nativeModuleStem !== plan.finalLink.nativeModuleStem) {
        throw new Error(
          `generated extension package is missing the planned native final-link extension ${plan.finalLink.nativeExtension}/${plan.finalLink.nativeModuleStem}`,
        );
      }
    } else if (plan.finalLink.kind === "base-runtime") {
      if (
        plan.finalLink.nativeExtension !== null
        || plan.finalLink.nativeModuleStem !== null
        || selected.some(({ nativeModuleStem }) => nativeModuleStem !== null)
      ) {
        throw new Error("base-runtime final-link proof requires an entirely SQL-only extension selection");
      }
    } else {
      throw new Error(`unknown final-link proof kind ${plan.finalLink.kind}`);
    }
    const packagePath = JSON.stringify(path.resolve(process.env.OLIPHAUNT_SELECTED_PACKAGE));
    const releasePackagePath = JSON.stringify(path.resolve(process.env.OLIPHAUNT_RELEASE_PACKAGE));
    const dependencies = [
      `.product(name: "COliphaunt", package: "oliphaunt")`,
      ...selected.map(({ swiftProduct }) =>
        `.product(name: ${JSON.stringify(swiftProduct)}, package: "selectedExtensions")`),
    ].join(", ");
    const packageFile = `// swift-tools-version: 6.0\n\n` +
      `import PackageDescription\n\n` +
      `let package = Package(\n` +
      `    name: "OliphauntExtensionReleaseConsumer",\n` +
      `    platforms: [.macOS(.v14)],\n` +
      `    dependencies: [\n` +
      `        .package(name: "oliphaunt", path: ${releasePackagePath}),\n` +
      `        .package(name: "selectedExtensions", path: ${packagePath})\n` +
      `    ],\n` +
      `    targets: [\n` +
      `        .executableTarget(\n` +
      `            name: "OliphauntExtensionReleaseConsumer",\n` +
      `            dependencies: [${dependencies}]\n` +
      `        )\n` +
      `    ]\n` +
      `)\n`;
    const runtimeVersion = JSON.stringify(plan.finalLink.runtimeVersion);
    const nativeAssertion = finalLink === null
      ? `print("OLIPHAUNT_SWIFT_BASE_RUNTIME_LINK_PASS runtime=\\(linkedNativeRuntimeVersion!) products=${selected.length}")\n`
      : `precondition(${finalLink.swiftProduct}.sqlName == ${JSON.stringify(finalLink.sqlName)} && ${finalLink.swiftProduct}.product == ${JSON.stringify(finalLink.product)}, "planned native extension identity mismatch")\n` +
        `print("OLIPHAUNT_SWIFT_NATIVE_EXTENSION_LINK_PASS extension=${finalLink.sqlName} native_module=${finalLink.nativeModuleStem} runtime=\\(linkedNativeRuntimeVersion!) products=${selected.length}")\n`;
    const main = `import COliphaunt\n${selected.map(({ swiftProduct }) => `import ${swiftProduct}`).join("\n")}\n\n` +
      `${selected.map(({ swiftProduct }) => `try ${swiftProduct}.register()`).join("\n")}\n` +
      `let linkedNativeRuntimeVersion = oliphaunt_version().map { String(cString: $0) }\n` +
      `precondition(linkedNativeRuntimeVersion == ${runtimeVersion}, "linked liboliphaunt runtime version mismatch")\n` +
      nativeAssertion;
    await Bun.write(path.join(process.env.OLIPHAUNT_EXTENSION_CONSUMER, "Package.swift"), packageFile);
    await Bun.write(
      path.join(
        process.env.OLIPHAUNT_EXTENSION_CONSUMER,
        "Sources",
        "OliphauntExtensionReleaseConsumer",
        "main.swift",
      ),
      main,
    );
  '

echo "==> Building and running a macOS exact-extension Swift consumer (proof=$final_link_kind${extension:+ extension=$extension})"
swift package \
	--package-path "$consumer" \
	--scratch-path "$scratch/consumer-build" \
	describe
env \
	LIBOLIPHAUNT_PATH="$library" \
	DYLD_LIBRARY_PATH="$(dirname "$library")${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
	swift run \
	--package-path "$consumer" \
	--scratch-path "$scratch/consumer-build" \
	OliphauntExtensionReleaseConsumer
echo "OLIPHAUNT_SWIFT_EXTENSION_RELEASE_CONSUMER_PASS proof=$final_link_kind extension=${extension:-none} extension_carriers=${#extension_carriers[@]} selected_extensions=$extensions_csv"
