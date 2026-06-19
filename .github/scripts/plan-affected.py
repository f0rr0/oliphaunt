#!/usr/bin/env python3
"""GitHub Actions wrapper for the shared Moon affected CI planner."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "graph"))

import ci_plan  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(ci_plan.emit_github_outputs())
