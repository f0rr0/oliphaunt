#!/usr/bin/env bun

// Bun deliberately skips hidden directories during test discovery. Keep the
// integration fixture beside the GitHub script while exposing it through the
// repository's normal release-test surface.
import "../../.github/scripts/download-bootstrap-ledger.test.mjs";
