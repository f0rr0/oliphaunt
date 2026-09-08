import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { assertQualifiedReplaySourceState } from "./qualified-release-replay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Only publication execution may differ. In particular, tools/release also
// contains packagers: allowing that directory wholesale would change bytes.
const CONTROL_FILES = new Set([
  ".github/workflows/release.yml",
  ".github/scripts/resolve-release-head.sh",
  ".github/scripts/validate-release-workflow-inputs.sh",
  ".github/scripts/release-transport-ref.mjs",
  ".github/scripts/download-bootstrap-ledger.mjs",
  ".github/scripts/download-bootstrap-ledger.test.mjs",
  ".github/scripts/download-completed-bootstrap.mjs",
  "tools/release/publication-controller.mjs",
  "tools/release/audit-github-release-controls.mjs",
  "tools/release/fixtures/github-release-controls/desired-solo.json",
  "tools/release/fixtures/github-release-controls/desired-team.json",
  "tools/release/crates-io-bootstrap-capacity.mjs",
  "tools/release/frozen-cargo-publish.mjs",
  "tools/release/verify_github_release_attestations.mjs",
]);

export function assertPublicationController({ source, controller, root = ROOT }) {
  assertQualifiedReplaySourceState({ repo: root, headRef: controller, expectedSha: controller });
  return assertPublicationChanges({ source, controller, root });
}

export function assertPublicationChanges({ source, controller, root = ROOT }) {
  for (const sha of [source, controller]) {
    if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) throw new Error("publication source and controller must be full commit SHAs");
  }
  const git = (...args) => {
    const result = captureCommandOutput("git", args, {
      cwd: root, label: "publication controller source comparison", allowEmptyOutput: true,
      stdoutTerminator: args.includes("-z") ? "\0" : "\n",
    });
    if (result.error || result.status !== 0) throw new Error(result.stderr || "publication source must be an ancestor of the controller");
    return result.stdout;
  };
  git("merge-base", "--is-ancestor", source, controller);
  const changed = git("diff", "--no-renames", "--name-only", "-z", source, controller).split("\0").filter(Boolean);
  const rejected = changed.filter((file) => !CONTROL_FILES.has(file)
    && !/^tools\/(?:release|policy)\/[^/]+[.]test[.]mjs$/u.test(file)
    && !/^docs\/maintainers\/release(?:-setup)?[.]md$/u.test(file));
  if (rejected.length) throw new Error(`approved candidate cannot be reused after non-publication changes:\n${rejected.join("\n")}`);
  return { source, controller };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, controller] = process.argv.slice(2);
    assertPublicationController({ source, controller });
    console.log(`verified publication controller ${controller} for frozen source ${source}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
