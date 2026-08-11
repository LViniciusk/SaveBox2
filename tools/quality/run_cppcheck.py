"""Run the repository's report-only Cppcheck configuration."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, default=Path(".quality/cppcheck.xml"))
    args = parser.parse_args()

    root = args.root.resolve()
    output = args.output if args.output.is_absolute() else root / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    executable = shutil.which("cppcheck")
    if executable is None:
        print("Cppcheck is not installed or is not available on PATH.", file=sys.stderr)
        return 2

    command = [
        executable,
        "--enable=warning,style,performance,portability,unusedFunction",
        "--std=c++17",
        "--xml",
        "--xml-version=2",
        "-i",
        str(root / "backend/include/crow_all.h"),
        str(root / "backend/src"),
        str(root / "backend/include"),
    ]
    completed = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
    output.write_text(completed.stderr, encoding="utf-8")
    if completed.stdout:
        print(completed.stdout, end="")
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
