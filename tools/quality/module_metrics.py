"""Deterministic module and function metrics using Lizard's Python API."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import lizard


EXCLUDED_NAMES = {"crow_all.h"}
EXCLUDED_PARTS = {"build", "coverage", "node_modules", ".quality", "dist", "vendor"}


def source_files(root: Path) -> list[tuple[str, Path]]:
    roots = [("frontend", root / "frontend" / "src" / "app"), ("backend", root / "backend" / "src")]
    roots.append(("backend", root / "backend" / "include"))
    files: list[tuple[str, Path]] = []
    for area, source_root in roots:
        if not source_root.exists():
            continue
        for path in source_root.rglob("*"):
            if not path.is_file() or path.name in EXCLUDED_NAMES:
                continue
            if any(part in EXCLUDED_PARTS for part in path.parts):
                continue
            if area == "frontend" and (path.suffix != ".ts" or path.name.endswith(".spec.ts")):
                continue
            if area == "backend" and path.suffix not in {".cpp", ".hpp", ".h"}:
                continue
            files.append((area, path))
    return sorted(files, key=lambda item: item[1].as_posix())


def function_metric(path: Path, root: Path, function: Any) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    return {
        "path": relative,
        "function": function.name,
        "long_name": function.long_name,
        "line": function.start_line,
        "end_line": function.end_line,
        "nloc": function.nloc,
        "cyclomatic_complexity": function.cyclomatic_complexity,
        "token_count": function.token_count,
        "parameter_count": len(function.full_parameters),
    }


def metric(area: str, path: Path, root: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    relative = path.relative_to(root).as_posix()
    imports = sum(1 for line in lines if re.search(r"^\s*(import\s|#include\s)", line))
    functions = [function_metric(path, root, item) for item in lizard.analyze_file(str(path)).function_list]
    return {
        "area": area,
        "path": relative,
        "physical_lines": len(lines),
        "nonblank_lines": sum(bool(line.strip()) for line in lines),
        "function_count": len(functions),
        "max_cyclomatic_complexity": max((item["cyclomatic_complexity"] for item in functions), default=0),
        "total_function_nloc": sum(item["nloc"] for item in functions),
        "import_include_count": imports,
        "functions": functions,
        "inline_template_or_style_caveat": area == "frontend" and path.name.endswith("component.ts"),
    }


def top(items: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: (-item[key], item["path"]))[:25]


def top_functions(modules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    functions = [function for module in modules for function in module["functions"]]
    return sorted(
        functions,
        key=lambda item: (-item["cyclomatic_complexity"], -item["nloc"], item["path"], item["line"]),
    )[:25]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    modules = [metric(area, path, root) for area, path in source_files(root)]
    payload = {
        "schema": 2,
        "analyzer": "lizard-python-api",
        "modules": modules,
        "functions": [function for module in modules for function in module["functions"]],
        "top_by_lines": top(modules, "physical_lines"),
        "top_by_complexity": top_functions(modules),
        "top_by_module_complexity": top(modules, "max_cyclomatic_complexity"),
        "top_by_function_nloc": top(modules, "total_function_nloc"),
        "top_by_functions": top(modules, "function_count"),
        "top_by_imports_includes": top(modules, "import_include_count"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
