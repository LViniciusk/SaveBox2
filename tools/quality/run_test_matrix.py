"""Run the local dynamic test lanes with bounded, deterministic parallelism."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Sequence

from run_backend_shards import create_run_root, default_binary, execute_backend, write_json_atomic


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def validate_profile(value: str) -> str:
    if value not in {"Fast", "Full"}:
        raise ValueError("profile must be Fast or Full")
    return value


def validate_shard_count(value: int) -> int:
    if not 1 <= value <= 4:
        raise ValueError("backend shard count must be between 1 and 4")
    return value


def npm_command() -> str:
    name = "npm.cmd" if os.name == "nt" else "npm"
    return shutil.which(name) or name


def python_command() -> str:
    if os.name == "nt":
        return shutil.which("py") or sys.executable
    return shutil.which("python3") or sys.executable


def frontend_commands(profile: str) -> list[tuple[str, list[str]]]:
    npm = npm_command()
    if profile == "Fast":
        return [("unit", [npm, "test", "--", "--watch=false", "--browsers=ChromeHeadless"])]
    return [
        ("coverage", [npm, "run", "test:coverage"]),
        ("mutation", [npm, "run", "quality:mutation"]),
    ]


def _relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _display_command(command: Sequence[str]) -> list[str]:
    executable_names = {npm_command(), python_command()}
    return [Path(part).name if part in executable_names else part for part in command]


def run_logged_command(command: Sequence[str], cwd: Path, log_path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8", newline="\n") as log:
        completed = subprocess.run(list(command), cwd=str(cwd), stdout=log, stderr=subprocess.STDOUT, check=False)
    return {
        "command": list(command),
        "status": "passed" if completed.returncode == 0 else "failed",
        "exit_code": completed.returncode,
        "duration_seconds": round(time.perf_counter() - started, 3),
        "log": log_path,
    }


def run_frontend_lane(root: Path, profile: str, run_root: Path) -> dict[str, Any]:
    started = time.perf_counter()
    stages: list[dict[str, Any]] = []
    commands = frontend_commands(profile)
    for stage, command in commands:
        result = run_logged_command(command, root / "frontend", run_root / "logs" / f"frontend-{stage}.log")
        result["command"] = _display_command(result["command"])
        stages.append(result)
        if result["exit_code"] != 0:
            break
    return {
        "status": "passed" if all(stage["exit_code"] == 0 for stage in stages) and len(stages) == len(commands) else "failed",
        "wall_seconds": round(time.perf_counter() - started, 3),
        "stages": stages,
    }


def read_playwright_status(root: Path) -> dict[str, Any] | None:
    path = root / ".quality" / "playwright" / "run-status.json"
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    fields = ("outcome", "exit_code", "report_sha256", "phase", "started_at", "finished_at")
    return {key: value.get(key) for key in fields}


def run_playwright(root: Path, run_root: Path) -> dict[str, Any]:
    result = run_logged_command(
        [python_command(), "tools/quality/run_playwright.py"],
        root,
        run_root / "logs" / "playwright.log",
    )
    result["command"] = _display_command(result["command"])
    provenance = read_playwright_status(root)
    if provenance is not None:
        result["provenance"] = provenance
    return result


def run_parallel_lanes(
    backend: Callable[[], dict[str, Any]],
    frontend: Callable[[], dict[str, Any]],
    serial: bool = False,
) -> dict[str, dict[str, Any]]:
    def invoke(lane: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        try:
            return lane()
        except Exception as error:
            return {
                "status": "failed",
                "exit_code": 1,
                "error": f"{type(error).__name__}: lane execution failed",
            }

    if serial:
        return {"backend": invoke(backend), "frontend": invoke(frontend)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        backend_future = executor.submit(invoke, backend)
        frontend_future = executor.submit(invoke, frontend)
        return {"backend": backend_future.result(), "frontend": frontend_future.result()}


def _failure(lane: str, result: dict[str, Any]) -> dict[str, Any] | None:
    if result.get("status") == "passed":
        return None
    for stage in result.get("stages", result.get("processes", [])):
        if stage.get("status") == "failed" or stage.get("exit_code", 0) != 0:
            return {"lane": lane, "stage": stage.get("index", stage.get("name", "unknown")), "exit_code": stage.get("exit_code", result.get("exit_code", 1))}
    return {"lane": lane, "stage": "aggregate", "exit_code": result.get("exit_code", 1)}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=repository_root())
    parser.add_argument("--profile", choices=("Fast", "Full"), default="Full")
    parser.add_argument("--backend-shards", "--shards", dest="backend_shards", type=int, default=2)
    parser.add_argument("--backend-seed", type=int, default=60201)
    parser.add_argument("--backend-binary", type=Path, default=None)
    parser.add_argument("--serial", action="store_true")
    return parser.parse_args(argv)


def run_matrix(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    validate_profile(args.profile)
    validate_shard_count(args.backend_shards)
    root = args.root.resolve()
    run_root = create_run_root(root)
    binary = (args.backend_binary or default_binary(root)).resolve()
    requested_shards = 1 if args.serial else args.backend_shards
    started = time.perf_counter()
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    lanes = run_parallel_lanes(
        lambda: execute_backend(root, binary, requested_shards, args.backend_seed, run_root, args.serial),
        lambda: run_frontend_lane(root, args.profile, run_root),
        serial=args.serial,
    )
    playwright: dict[str, Any]
    if args.profile == "Full" and lanes["backend"].get("status") == "passed" and lanes["frontend"].get("status") == "passed":
        playwright = run_playwright(root, run_root)
    else:
        playwright = {"status": "not_run", "reason": "required lanes are not green"}

    failures = [_failure(lane, lanes[lane]) for lane in ("backend", "frontend")]
    if playwright.get("status") == "failed" and args.profile == "Full":
        failures.append({"lane": "playwright", "stage": "canonical", "exit_code": playwright.get("exit_code", 1)})
    first_failure = next((failure for failure in failures if failure), None)
    status = "passed" if first_failure is None else "failed"
    payload = {
        "schema": 1,
        "profile": args.profile,
        "status": status,
        "started_at": started_at,
        "wall_seconds": round(time.perf_counter() - started, 3),
        "backend": {**lanes["backend"], "processes": lanes["backend"].get("processes", [])},
        "frontend": lanes["frontend"],
        "playwright": playwright,
        "first_failure": first_failure,
    }
    for stage in payload["frontend"].get("stages", []):
        if isinstance(stage.get("log"), Path):
            stage["log"] = _relative(stage["log"], run_root)
    if "log" in payload["playwright"]:
        payload["playwright"]["log"] = _relative(payload["playwright"]["log"], run_root)
    payload["_run_root"] = run_root
    return (0 if status == "passed" else 1), payload


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        code, payload = run_matrix(args)
        current = payload.pop("_run_root")
        write_json_atomic(current / "summary.json", payload)
        print(f"Test matrix: {payload['status']} ({payload['wall_seconds']:.3f}s)")
        print(f"Summary: {_relative(current / 'summary.json', repository_root())}")
        return code
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Test matrix failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
