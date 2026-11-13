#!/usr/bin/env python3
"""Validate the liangify plugin marketplace layout.

Checks:
- every JSON file parses
- marketplace.json lists every plugin directory, and every listed source exists
- each plugin.json has a name matching its directory and a semver version
- plugin dependencies refer to plugins in this marketplace
- hooks.json has a top-level "hooks" object, and hook scripts it references exist
- every SKILL.md and agent .md has YAML frontmatter with name and description,
  and a skill's name matches its directory

Uses only the standard library so it runs on any CI runner with Python 3.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
errors: list[str] = []


def error(path: Path, message: str) -> None:
    errors.append(f"{path.relative_to(ROOT)}: {message}")


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error(path, f"invalid JSON ({exc})")
        return None


def frontmatter(path: Path) -> dict[str, str] | None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.DOTALL)
    if not match:
        error(path, "missing YAML frontmatter delimited by ---")
        return None
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and not line.startswith((" ", "\t")):
            fields[key.strip()] = value.strip()
    return fields


def check_markdown(path: Path, expected_name: str | None) -> None:
    fields = frontmatter(path)
    if fields is None:
        return
    for key in ("name", "description"):
        if not fields.get(key):
            error(path, f"frontmatter is missing '{key}'")
    if expected_name and fields.get("name") and fields["name"] != expected_name:
        error(path, f"frontmatter name '{fields['name']}' should be '{expected_name}'")


def hook_script_paths(node) -> list[str]:
    """Collect ${CLAUDE_PLUGIN_ROOT}-relative paths mentioned in hook commands."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "command" and isinstance(value, str):
                found += re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/([^\s\"']+)", value)
            else:
                found += hook_script_paths(value)
    elif isinstance(node, list):
        for item in node:
            found += hook_script_paths(item)
    return found


def main() -> int:
    for path in ROOT.rglob("*.json"):
        if ".git" not in path.parts and "node_modules" not in path.parts:
            load_json(path)

    marketplace_path = ROOT / ".claude-plugin" / "marketplace.json"
    marketplace = load_json(marketplace_path) or {}
    entries = marketplace.get("plugins", [])
    listed = {}
    for entry in entries:
        name, source = entry.get("name"), entry.get("source")
        if not name or not source:
            error(marketplace_path, f"plugin entry needs name and source: {entry}")
            continue
        if not entry.get("description"):
            error(marketplace_path, f"plugin '{name}' has no description")
        if not (ROOT / source).is_dir():
            error(marketplace_path, f"plugin '{name}' source '{source}' does not exist")
        listed[name] = source

    plugin_dirs = sorted(p for p in (ROOT / "plugins").iterdir() if p.is_dir())
    known = {p.name for p in plugin_dirs}
    for plugin_dir in plugin_dirs:
        if plugin_dir.name not in listed:
            error(plugin_dir, "plugin directory is not registered in marketplace.json")

        manifest_path = plugin_dir / ".claude-plugin" / "plugin.json"
        if not manifest_path.is_file():
            error(plugin_dir, "missing .claude-plugin/plugin.json")
            continue
        manifest = load_json(manifest_path) or {}
        if manifest.get("name") != plugin_dir.name:
            error(manifest_path, f"name should be '{plugin_dir.name}'")
        if not SEMVER.match(str(manifest.get("version", ""))):
            error(manifest_path, "version must be semver (e.g. 0.1.0)")
        if not manifest.get("description"):
            error(manifest_path, "description is required")
        for dep in manifest.get("dependencies", []):
            dep_name = dep.get("name") if isinstance(dep, dict) else dep
            if dep_name not in known:
                error(manifest_path, f"depends on unknown plugin '{dep_name}'")

        hooks_path = plugin_dir / "hooks" / "hooks.json"
        if hooks_path.is_file():
            hooks = load_json(hooks_path)
            if hooks is not None and not isinstance(hooks.get("hooks"), dict):
                error(hooks_path, "must contain a top-level 'hooks' object")
            for rel in hook_script_paths(hooks or {}):
                if not (plugin_dir / rel).is_file():
                    error(hooks_path, f"references missing file '{rel}'")

        for skill in sorted((plugin_dir / "skills").glob("*/SKILL.md")):
            check_markdown(skill, skill.parent.name)
        for skill_dir in sorted(p for p in (plugin_dir / "skills").glob("*") if p.is_dir()):
            if not (skill_dir / "SKILL.md").is_file():
                error(skill_dir, "skill directory has no SKILL.md")
        for agent in sorted((plugin_dir / "agents").glob("*.md")):
            check_markdown(agent, agent.stem)

    if errors:
        print("Marketplace validation failed:")
        for message in errors:
            print(f"  - {message}")
        return 1
    print(f"Marketplace OK: {len(plugin_dirs)} plugins validated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
