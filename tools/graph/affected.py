#!/usr/bin/env python3
"""Shared Moon affectedness helpers for local and GitHub CI planners."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def moon_bin() -> str:
    if configured := os.environ.get("MOON_BIN"):
        return configured
    proto_moon = Path.home() / ".proto" / "bin" / "moon"
    return str(proto_moon) if proto_moon.exists() else "moon"


def moon(args: list[str]) -> dict[str, object]:
    command = [moon_bin(), *args]
    env = dict(os.environ)
    output = subprocess.check_output(command, cwd=ROOT, env=env, text=True)
    return json.loads(output)


def names(value: object) -> set[str]:
    if isinstance(value, dict):
        return {str(key) for key in value}
    if isinstance(value, list):
        result: set[str] = set()
        for item in value:
            if isinstance(item, str):
                result.add(item)
            elif isinstance(item, dict):
                identifier = item.get("id") or item.get("target")
                if identifier:
                    result.add(str(identifier))
        return result
    return set()


def affected_projects_and_tasks() -> tuple[set[str], set[str], set[str]]:
    direct = moon(["query", "affected", "--upstream", "none", "--downstream", "none"])
    downstream = moon(["query", "affected", "--upstream", "none", "--downstream", "deep"])
    direct_projects = names(direct.get("projects"))
    projects = names(downstream.get("projects"))
    tasks = names(downstream.get("tasks"))
    return direct_projects, projects, tasks


def project_task_targets(projects: set[str], task_name: str) -> list[str]:
    queried = moon(["query", "tasks"])
    tasks_by_project = queried.get("tasks")
    if not isinstance(tasks_by_project, dict):
        raise RuntimeError("moon query tasks did not return a tasks object")

    targets: list[str] = []
    for project in sorted(projects):
        project_tasks = tasks_by_project.get(project)
        if isinstance(project_tasks, dict) and task_name in project_tasks:
            targets.append(f"{project}:{task_name}")
    return targets
