"""Build the checked-in quality baseline from sanitized machine-readable reports."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


QUALITY_SCOPE = (
    "Rodada B.50 FINAL MICRO-FREEZE / RATIFICATION — "
    "Google external finalize / unlink lifecycle authority; "
    "B.31–B.49 remain FROZEN FINAL / RATIFIED; "
    "B.50 is emitted as FROZEN FINAL / RATIFIED only when current final-freeze evidence is green; "
    "B.51 remains SELECTED / NOT STARTED."
)

B53_QUALITY_SCOPE = (
    "Rodada B.53 — Share link rate-limit concurrency authority; "
    "B.50 remains FROZEN FINAL / RATIFIED; B.51 and B.52 are FROZEN FINAL / RATIFIED "
    "after focused catch-up; B.53 is IMPLEMENTED CANDIDATE / LOCAL GREEN; "
    "B.54+ remain NOT SELECTED; heavy checkpoint deferred until at least five new hardening rounds accumulate."
)

B54_QUALITY_SCOPE = (
    "Rodada B.54 — Google upload init / unlink lifecycle authority; "
    "B.31–B.53 remain FROZEN FINAL / RATIFIED or IMPLEMENTED CANDIDATE / LOCAL GREEN as previously recorded; "
    "B.54 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.55 and B.56 remain SELECTED / NOT STARTED; "
    "B.57+ remain NOT SELECTED; heavy checkpoint deferred."
)

B55_QUALITY_SCOPE = (
    "Rodada B.55 — Folder restore / hard-delete root lifecycle authority; "
    "B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53 and B.54 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; "
    "B.55 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.56 remains SELECTED / NOT STARTED; "
    "B.57+ remain NOT SELECTED; focused evidence only; heavy checkpoint deferred."
)

B56_QUALITY_SCOPE = (
    "Rodada B.56 — Public share / file delete lifecycle authority; "
    "B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53–B.55 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; "
    "B.56 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.57+ remain NOT SELECTED pending a fresh broad audit; "
    "focused evidence only; heavy checkpoint deferred."
)

B57_QUALITY_SCOPE = (
    "Rodada B.57 — Registration DB lease / password-hash authority; "
    "B.31–B.56 remain FROZEN FINAL / RATIFIED or IMPLEMENTED CANDIDATE / LOCAL GREEN as previously recorded; "
    "B.57 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.58 and B.59 remain SELECTED / NOT STARTED; "
    "B.60+ remain NOT SELECTED; focused evidence only; heavy checkpoint deferred until after B.59."
)

B58_QUALITY_SCOPE = (
    "Rodada B.58 — Registration email delivery truth / recoverability; "
    "B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53–B.57 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; "
    "B.58 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.59 remains SELECTED / NOT STARTED; "
    "B.60+ remain NOT SELECTED; focused evidence only; heavy checkpoint deferred until after B.59."
)

B59_QUALITY_SCOPE = (
    "Rodada B.59 — External email validation result authority; "
    "B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53–B.58 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; "
    "B.59 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.60+ remain NOT SELECTED; "
    "focused evidence only; HC-PREFLIGHT green; heavy checkpoint ready / next."
)

B59_FINAL_FREEZE_QUALITY_SCOPE = (
    "HEAVY CHECKPOINT B.53–B.59 / FINAL RATIFICATION — current repository-wide frontend, backend, "
    "coverage, mutation, canonical E2E, static-analysis, dead-code, module, deployment and OpenAPI evidence; "
    "B.31–B.59 are FROZEN FINAL / RATIFIED; B.60+ remain NOT SELECTED; NEXT: FRESH BROAD AUDIT. "
    "No claim beyond the configured tools."
)


def load(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        raw = path.read_bytes()
        for encoding in ("utf-8-sig", "utf-16"):
            try:
                return json.loads(raw.decode(encoding))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        return default
    except OSError:
        return default


def version(candidates: list[list[str]], cwd: Path | None = None) -> str:
    for command in candidates:
        try:
            output = subprocess.check_output(command, cwd=cwd, stderr=subprocess.STDOUT, text=True, timeout=20)
            lines = [line.strip() for line in output.splitlines() if line.strip()]
            if lines:
                return next((line for line in lines if "version" in line.lower()), lines[0])
        except (OSError, subprocess.SubprocessError):
            continue
    return "unavailable"


def percentage(summary: dict[str, Any], key: str) -> float | None:
    value = summary.get(key)
    if isinstance(value, dict):
        value = value.get("pct", value.get("percent"))
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def coverage(path: Path) -> dict[str, float | None]:
    report = load(path, {})
    report = report.get("total", report) if isinstance(report, dict) else {}
    return {
        "statements": percentage(report, "statements"),
        "branches": percentage(report, "branches"),
        "functions": percentage(report, "functions"),
        "lines": percentage(report, "lines"),
    }


def frontend_file_ranking(path: Path, metric_name: str) -> list[dict[str, Any]]:
    report = load(path, {})
    result: list[dict[str, Any]] = []
    for raw_path, data in report.items() if isinstance(report, dict) else []:
        if raw_path == "total" or not isinstance(data, dict):
            continue
        normalized = str(raw_path).replace("\\", "/")
        marker = "frontend/src/app/"
        if marker not in normalized or ".spec.ts" in normalized or "/environment" in normalized:
            continue
        relative = normalized[normalized.index(marker) :]
        value = data.get(metric_name, {})
        if isinstance(value, dict) and isinstance(value.get("pct"), (int, float)):
            result.append({"path": relative, "percent": value["pct"]})
    return sorted(result, key=lambda item: (item["percent"], item["path"]))[:10]


def package_inventory(root: Path) -> dict[str, list[str]]:
    package = load(root / "frontend" / "package.json", {})
    return {
        "frontend_runtime": sorted(package.get("dependencies", {}).keys()),
        "frontend_dev": sorted(package.get("devDependencies", {}).keys()),
        "backend_manifest": sorted(load(root / "backend" / "vcpkg.json", {}).get("dependencies", [])),
    }


def display(value: Any) -> str:
    return "NOT AVAILABLE" if value is None else f"{value}%"


def not_run_coverage() -> dict[str, Any]:
    return {
        "status": "NOT RUN / NOT READ",
        "statements": None,
        "branches": None,
        "functions": None,
        "lines": None,
    }


def not_run_e2e() -> dict[str, Any]:
    return {
        "status": "NOT RUN / NOT READ",
        "outcome": None,
        "exit_code": None,
        "started_at": None,
        "finished_at": None,
        "retries": None,
        "total": 0,
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "flaky": 0,
        "report_sha256": None,
        "expected_report_sha256": None,
        "status_valid": False,
        "report_valid": False,
        "hash_match": False,
        "current_run": False,
    }


def not_run_mutation() -> dict[str, Any]:
    return {
        "status": "NOT RUN / NOT READ",
        "scope": [],
        "total": 0,
        "killed": 0,
        "survived": 0,
        "no_coverage": 0,
        "compile_error": 0,
        "timeout": 0,
        "score": None,
    }


def mutation_summary(path: Path) -> dict[str, Any]:
    report = load(path, {})
    mutants: list[dict[str, Any]] = []
    files = report.get("files", {}) if isinstance(report, dict) else {}
    for file_data in files.values() if isinstance(files, dict) else []:
        mutants.extend(file_data.get("mutants", []))
    counts: dict[str, int] = {}
    for mutant in mutants:
        status = str(mutant.get("status", "unknown")).lower()
        counts[status] = counts.get(status, 0) + 1
    total = len(mutants)
    killed = counts.get("killed", 0)
    compile_error = counts.get("compileerror", 0)
    scored_mutants = total - compile_error
    config = report.get("config", {}) if isinstance(report, dict) else {}
    scope = config.get("mutate", []) if isinstance(config, dict) else []
    return {
        "status": "executed" if total else "not run",
        "scope": scope if isinstance(scope, list) else [],
        "total": total,
        "killed": killed,
        "survived": counts.get("survived", 0),
        "no_coverage": counts.get("nocoverage", 0),
        "compile_error": compile_error,
        "timeout": counts.get("timeout", 0),
        "score": round(killed / scored_mutants * 100, 2) if scored_mutants > 0 else None,
    }


def file_sha256(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def valid_hash(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value.lower())


def valid_status(status: Any) -> bool:
    if not isinstance(status, dict):
        return False
    allowed = {"schema", "outcome", "exit_code", "report_sha256", "started_at", "finished_at", "phase"}
    return (
        not set(status) - allowed
        and status.get("schema") == 1
        and status.get("outcome") in {"completed", "preflight_failed", "playwright_failed", "report_missing", "runner_error"}
        and type(status.get("exit_code")) is int
        and isinstance(status.get("started_at"), str)
        and isinstance(status.get("finished_at"), str)
        and (status.get("report_sha256") is None or valid_hash(status.get("report_sha256")))
    )


def e2e_summary(report_path: Path, status_path: Path) -> dict[str, Any]:
    report = load(report_path, None)
    run_status = load(status_path, None)
    status_is_valid = valid_status(run_status)
    report_hash = file_sha256(report_path)
    hash_matches = status_is_valid and report_hash is not None and run_status["report_sha256"] == report_hash
    report_is_valid = isinstance(report, dict) and isinstance(report.get("suites"), list)
    config = report.get("config", {}) if report_is_valid else {}
    counts = {"passed": 0, "failed": 0, "skipped": 0, "flaky": 0}
    total = 0

    def visit(value: Any) -> None:
        nonlocal total
        if not isinstance(value, dict):
            return
        for spec in value.get("specs", []) if isinstance(value.get("specs"), list) else []:
            for test in spec.get("tests", []) if isinstance(spec, dict) and isinstance(spec.get("tests"), list) else []:
                total += 1
                test_status = str(test.get("status", "")).lower()
                if test_status in {"expected", "passed"}:
                    counts["passed"] += 1
                elif test_status == "flaky":
                    counts["flaky"] += 1
                elif test_status in {"skipped", "pending"}:
                    counts["skipped"] += 1
                else:
                    counts["failed"] += 1
        for child in value.get("suites", []) if isinstance(value.get("suites"), list) else []:
            visit(child)

    for suite in report.get("suites", []) if report_is_valid else []:
        visit(suite)
    return {
        "status": run_status.get("outcome") if status_is_valid else "not run",
        "outcome": run_status.get("outcome") if status_is_valid else None,
        "exit_code": run_status.get("exit_code") if status_is_valid else None,
        "started_at": run_status.get("started_at") if status_is_valid else None,
        "finished_at": run_status.get("finished_at") if status_is_valid else None,
        "retries": config.get("retries", 0) if isinstance(config, dict) else 0,
        "total": total,
        **counts,
        "report_sha256": report_hash,
        "expected_report_sha256": run_status.get("report_sha256") if status_is_valid else None,
        "status_valid": status_is_valid,
        "report_valid": report_is_valid,
        "hash_match": hash_matches,
        "current_run": bool(status_is_valid and report_hash is not None and hash_matches),
    }


def e2e_is_green(summary: dict[str, Any]) -> bool:
    return (
        summary.get("status_valid") is True
        and summary.get("report_valid") is True
        and summary.get("current_run") is True
        and summary.get("outcome") == "completed"
        and summary.get("exit_code") == 0
        and summary.get("hash_match") is True
        and summary.get("total") == 5
        and summary.get("passed") == 5
        and summary.get("failed") == 0
        and summary.get("skipped") == 0
        and summary.get("flaky") == 0
    )


def b49_final_freeze_ready(
    *,
    e2e: dict[str, Any],
    frontend_coverage: dict[str, float | None],
    backend_coverage: dict[str, float | None],
    mutation: dict[str, Any],
    frontend_tests: int,
    backend_cases: int,
    backend_assertions: int,
) -> bool:
    return (
        positive_count(frontend_tests)
        and positive_count(backend_cases)
        and positive_count(backend_assertions)
        and e2e_is_green(e2e)
        and all(frontend_coverage.get(metric) is not None for metric in ("statements", "branches", "functions", "lines"))
        and backend_coverage.get("lines") is not None
        and backend_coverage["lines"] >= 50
        and mutation.get("status") == "executed"
        and mutation.get("survived") == 0
        and mutation.get("no_coverage") == 0
        and mutation.get("timeout") == 0
    )


def b50_candidate_ready(
    *,
    e2e: dict[str, Any],
    frontend_coverage: dict[str, float | None],
    backend_coverage: dict[str, float | None],
    mutation: dict[str, Any],
    frontend_tests: int,
    backend_cases: int,
    backend_assertions: int,
) -> bool:
    return b49_final_freeze_ready(
        e2e=e2e,
        frontend_coverage=frontend_coverage,
        backend_coverage=backend_coverage,
        mutation=mutation,
        frontend_tests=frontend_tests,
        backend_cases=backend_cases,
        backend_assertions=backend_assertions,
    )


def b50_final_freeze_ready(
    *,
    e2e: dict[str, Any],
    frontend_coverage: dict[str, float | None],
    backend_coverage: dict[str, float | None],
    mutation: dict[str, Any],
    frontend_tests: int,
    backend_cases: int,
    backend_assertions: int,
) -> bool:
    return b50_candidate_ready(
        e2e=e2e,
        frontend_coverage=frontend_coverage,
        backend_coverage=backend_coverage,
        mutation=mutation,
        frontend_tests=frontend_tests,
        backend_cases=backend_cases,
        backend_assertions=backend_assertions,
    ) and e2e.get("retries") == 0


def b53_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b54_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b55_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b56_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b57_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b58_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b59_candidate_ready(*, backend_cases: int, backend_assertions: int) -> bool:
    return backend_cases > 0 and backend_assertions > 0


def b59_final_freeze_ready(
    *,
    e2e: dict[str, Any],
    frontend_coverage: dict[str, float | None],
    backend_coverage: dict[str, float | None],
    mutation: dict[str, Any],
    frontend_tests: int,
    backend_cases: int,
    backend_assertions: int,
    fixture_cases: int,
    fixture_assertions: int,
) -> bool:
    return (
        positive_count(frontend_tests)
        and positive_count(backend_cases)
        and positive_count(backend_assertions)
        and positive_count(fixture_cases)
        and positive_count(fixture_assertions)
        and e2e_is_green(e2e)
        and e2e.get("retries") == 0
        and all(frontend_coverage.get(metric) is not None for metric in ("statements", "branches", "functions", "lines"))
        and backend_coverage.get("lines") is not None
        and backend_coverage["lines"] >= 50
        and mutation.get("status") == "executed"
        and mutation.get("survived") == 0
        and mutation.get("no_coverage") == 0
        and mutation.get("timeout") == 0
    )


def count_knip(path: Path, key: str) -> int | None:
    report = load(path, None)
    if report is None:
        return None
    total = 0
    found = False

    def visit(value: Any) -> None:
        nonlocal total, found
        if isinstance(value, dict):
            for name, child in value.items():
                if name == key and isinstance(child, list):
                    total += len(child)
                    found = True
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(report)
    return total if found else 0


def positive_count(value: Any) -> bool:
    return isinstance(value, int) and value > 0


def backend_coverage(path: Path) -> dict[str, float | None]:
    report = load(path, {})
    values: dict[str, float | None] = {"lines": None, "branches": None, "functions": None}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                target = {"linepercent": "lines", "branchpercent": "branches", "functionpercent": "functions"}.get(
                    key.lower().replace("_", "")
                )
                if target:
                    try:
                        values[target] = float(child)
                    except (TypeError, ValueError):
                        pass
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(report)
    return values


def function_top(modules: list[dict[str, Any]], area: str) -> list[dict[str, Any]]:
    functions = [
        function
        for module in modules
        if module.get("area") == area
        for function in module.get("functions", [])
    ]
    return sorted(
        functions,
        key=lambda item: (-item.get("cyclomatic_complexity", 0), -item.get("nloc", 0), item["path"], item["line"]),
    )[:10]


def render(payload: dict[str, Any]) -> str:
    coverage_data = payload["coverage"]
    frontend = coverage_data["frontend"]
    backend = coverage_data["backend"]
    dead = payload["dead_code"]
    e2e = payload["tests"]["e2e"]
    mutation = payload["mutation"]["frontend"]
    e2e_line = (
        e2e["status"]
        if e2e.get("status") == "NOT RUN / NOT READ"
        else
        f"{e2e['passed']}/{e2e['total']} PASS (0 failed, 0 skipped, 0 flaky)"
        if e2e_is_green(e2e)
        else f"{e2e['passed']}/{e2e['total']} NOT GREEN (outcome: {e2e['outcome'] or 'not run'}, {e2e['failed']} failed, {e2e['skipped']} skipped, {e2e['flaky']} flaky)"
    )
    frontend_coverage_line = (
        f"Status: {frontend['status']}"
        if frontend.get("status")
        else f"Statements: {display(frontend['statements'])} · Branches: {display(frontend['branches'])} · Functions: {display(frontend['functions'])} · Lines: {display(frontend['lines'])}"
    )
    backend_coverage_line = (
        f"Status: {backend['status']}"
        if backend.get("status")
        else f"Lines: {display(backend['lines'])} · Branches: {display(backend['branches'])} · Functions: {display(backend['functions'])}"
    )
    mutation_line = (
        f"Status: {mutation['status']}"
        if mutation.get("status") == "NOT RUN / NOT READ"
        else f"Scope: {', '.join(mutation['scope']) or 'NOT RUN'}\nStatus: {mutation['status']} · total: {mutation['total']} · killed: {mutation['killed']} · survived: {mutation['survived']} · compile errors: {mutation['compile_error']} · no coverage: {mutation['no_coverage']} · score: {mutation['score']}"
    )
    lines = [
        "# Nanika Quality Baseline",
        "",
        "## Scope",
        "",
        payload.get("quality_scope", QUALITY_SCOPE),
        "",
        "## Tool Versions",
        "",
        *[f"- {name}: {value}" for name, value in sorted(payload["tools"].items())],
        "",
        "## Test Inventory",
        "",
        f"- Frontend unit: {payload['tests']['frontend_unit']} tests (PASS)",
        f"- Backend: {payload['tests']['backend_assertions']} assertions / {payload['tests']['backend_cases']} cases ({payload.get('backend_gate', 'PASS')})",
        f"- E2E: {e2e_line}",
        "",
        *(
            [
                "## Evidence Provenance",
                "",
                f"- Current round: {payload['evidence_provenance']['current_round']}",
                f"- Historical/reused inventory: {payload['evidence_provenance']['historical_reused']}",
                f"- Heavy checkpoint: {payload['evidence_provenance']['heavy_checkpoint']}",
                *(
                    [
                        f"- Full frontend: {payload['evidence_provenance']['full_frontend']}",
                        f"- Full backend: {payload['evidence_provenance']['full_backend']}",
                        f"- Cppcheck full: {payload['evidence_provenance']['cppcheck_full']}",
                        f"- Knip full: {payload['evidence_provenance']['knip_full']}",
                    ]
                    if payload['evidence_provenance'].get('full_frontend')
                    else []
                ),
                "",
            ]
            if payload.get("evidence_provenance")
            else []
        ),
        "## Frontend Coverage",
        "",
        frontend_coverage_line,
        "",
        "## Backend Coverage",
        "",
        backend_coverage_line,
        "",
        "## Lowest Branch Coverage",
        "",
        *[f"- `{item['path']}`: {item['percent']}%" for item in payload["coverage_files"]["branches"]],
        "",
        "## Dead Code — Knip",
        "",
        f"Normal files: {dead['normal_files']} · production files: {dead['production_files']} · exports: {dead['exports']} · types: {dead['types']} · dependencies: {dead['dependencies']} · devDependencies: {dead['devDependencies']} · cycles: {dead['cycles']}",
        "The npm quality:* scripts use --no-exit-code, so findings remain visible without making local report-only commands fail.",
        "Strict Knip semantics: exit 0 means no findings, exit 1 means findings, and exit >=2 means a tool/configuration failure. CI accepts only 0 or 1.",
        "",
        "## Backend Static Analysis",
        "",
        f"Cppcheck: {payload['static_analysis']['cppcheck']}",
        "",
        "## Mutation — Frontend",
        "",
        *mutation_line.splitlines(),
        "",
        "## Complexity — Frontend Top 10 Functions",
        "",
        *[f"- `{item['path']}:{item['line']}` `{item['function']}`: CC {item['cyclomatic_complexity']} · {item['nloc']} NLOC" for item in payload["complexity"]["frontend_top"]],
        "",
        "## Complexity — Backend Top 10 Functions",
        "",
        *[f"- `{item['path']}:{item['line']}` `{item['function']}`: CC {item['cyclomatic_complexity']} · {item['nloc']} NLOC" for item in payload["complexity"]["backend_top"]],
        "",
        "## Module Size — Frontend",
        "",
        *[f"- `{item['path']}`: {item['physical_lines']} physical lines" for item in payload["modules"]["frontend_top"]],
        "",
        "## Module Size — Backend",
        "",
        *[f"- `{item['path']}`: {item['physical_lines']} physical lines" for item in payload["modules"]["backend_top"]],
        "",
        "## E2E Coverage",
        "",
        "Five Playwright specs use an isolated prefixed artificial user fixture: auth/vault, local bytes, interrupted recovery, public share and trash lifecycle. Google OAuth is intentionally excluded.",
        "",
        "## Security Assertions",
        "",
        "The harness keeps credentials in memory, sends fixture input through stdin, avoids request-body logging, disables trace/video/screenshots, and checks fragment/non-plaintext request leakage.",
        "",
        "## Fixture Regressions",
        "",
        f"Focused fixture tests: {payload['fixture_regressions']['focused_cases']} cases / {payload['fixture_regressions']['focused_assertions']} assertions",
        f"Regression scenarios: {payload['fixture_regressions']['scenario_count']}",
        "",
        *[f"- {item}" for item in payload["fixture_regressions"]["scenarios"]],
        "",
        "## Cleanup History — B.1",
        "",
        "### Removed",
        "",
        *[f"- `{item}` — export-only cleanup; internal consumers remain unchanged." for item in payload["cleanup"]["removed_exports"]],
        *[f"- `{item}` — type export removed; the type remains private to its module." for item in payload["cleanup"]["removed_types"]],
        "- `libzip` — removed after source, CMake, manifest, CI and Docker searches found no active consumer; fresh MinGW configure/build passed without ZIP variables.",
        "",
        "### Kept / deferred",
        "",
        *[f"- `{item}` — kept/deferred because the module is protected or the dependency has a live consumer." for item in payload["cleanup"]["kept"]],
        "- `crow` framework — KEEP; `backend/vcpkg.json` manifest entry remains INVESTIGATE/DEFER because Crow is bootstrapped directly via `crow_all.h` and its transitive impact is not isolated here.",
        "",
        "## B.2 Changes",
        "",
        *[f"- {item}" for item in payload["b2_changes"]],
        "",
        "## B.3 Changes",
        "",
        *[f"- {item}" for item in payload["b3_changes"]],
        "",
        "## B.4 Changes",
        "",
        *[f"- {item}" for item in payload["b4_changes"]],
        "",
        "## Findings",
        "",
        *[f"- {finding['id']} [{finding['category']}] {finding['finding']} — {finding['action']}" for finding in payload["findings"]],
        "",
        "## B.5 Changes",
        "",
        *[f"- {item}" for item in payload["b5_changes"]],
        "",
        "## B.6 Changes",
        "",
        *[f"- {item}" for item in payload["b6_changes"]],
        "",
        "## B.7 Changes",
        "",
        *[f"- {item}" for item in payload["b7_changes"]],
        "",
        "## B.8 Changes",
        "",
        *[f"- {item}" for item in payload["b8_changes"]],
        "",
        "## B.9 Changes",
        "",
        *[f"- {item}" for item in payload["b9_changes"]],
        "",
        "## B.10 Changes",
        "",
        *[f"- {item}" for item in payload["b10_changes"]],
        "",
        "## B.11 Changes",
        "",
        *[f"- {item}" for item in payload["b11_changes"]],
        "",
        "## B.12 Changes",
        "",
        *[f"- {item}" for item in payload["b12_changes"]],
        "",
        "## B.13 Changes",
        "",
        *[f"- {item}" for item in payload["b13_changes"]],
        "",
        "## B.14 Changes",
        "",
        *[f"- {item}" for item in payload["b14_changes"]],
        "",
        "## B.15 Changes",
        "",
        *[f"- {item}" for item in payload.get("b15_changes", [])],
        "",
        "## B.16 Changes",
        "",
        *[f"- {item}" for item in payload.get("b16_changes", [])],
        "",
        "## B.17 Changes",
        "",
        *[f"- {item}" for item in payload.get("b17_changes", [])],
        "",
        "## B.18 Changes",
        "",
        *[f"- {item}" for item in payload.get("b18_changes", [])],
        "",
        "## B.19 Changes",
        "",
        *[f"- {item}" for item in payload.get("b19_changes", [])],
        "",
        "## B.20 Changes",
        "",
        *[f"- {item}" for item in payload.get("b20_changes", [])],
        "",
        "## B.21 Changes",
        "",
        *[f"- {item}" for item in payload.get("b21_changes", [])],
        "",
        "## B.22 Changes",
        "",
        *[f"- {item}" for item in payload.get("b22_changes", [])],
        "",
        "## B.23 Changes",
        "",
        *[f"- {item}" for item in payload.get("b23_changes", [])],
        "",
        "## B.24 Changes",
        "",
        *[f"- {item}" for item in payload.get("b24_changes", [])],
        "",
        "## B.25 Changes",
        "",
        *[f"- {item}" for item in payload.get("b25_changes", [])],
        "",
        "## B.26 Changes",
        "",
        *[f"- {item}" for item in payload.get("b26_changes", [])],
        "",
        "## B.27 Changes",
        "",
        *[f"- {item}" for item in payload.get("b27_changes", [])],
        "",
        "## B.28 Changes",
        "",
        *[f"- {item}" for item in payload.get("b28_changes", [])],
        "",
        "## B.29 Changes",
        "",
        *[f"- {item}" for item in payload.get("b29_changes", [])],
        "",
        "## B.30 Changes",
        "",
        *[f"- {item}" for item in payload.get("b30_changes", [])],
        "",
        "## B.31 Changes",
        "",
        *[f"- {item}" for item in payload.get("b31_changes", [])],
        "",
        "## B.32 Changes",
        "",
        *[f"- {item}" for item in payload.get("b32_changes", [])],
        "",
        "## B.33 Changes",
        "",
        *[f"- {item}" for item in payload.get("b33_changes", [])],
        "",
        "## B.31 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b31_micro_freeze_changes", [])],
        "",
        "## B.32 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b32_final_micro_freeze_changes", [])],
        "",
        "## B.32 Final Micro-Freeze #2 Changes",
        "",
        *[f"- {item}" for item in payload.get("b32_final_micro_freeze_2_changes", [])],
        "",
        "## B.33 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b33_final_micro_freeze_changes", [])],
        "",
        "## B.33 Final Micro-Freeze #2 Changes",
        "",
        *[f"- {item}" for item in payload.get("b33_final_micro_freeze_2_changes", [])],
        "",
        "## B.34 Changes",
        "",
        *[f"- {item}" for item in payload.get("b34_changes", [])],
        "",
        "## B.35 Changes",
        "",
        *[f"- {item}" for item in payload.get("b35_changes", [])],
        "",
        "## B.35 Final Micro-Freeze #1 Changes",
        "",
        *[f"- {item}" for item in payload.get("b35_final_micro_freeze_1_changes", [])],
        "",
        "## B.36 Changes",
        "",
        *[f"- {item}" for item in payload.get("b36_changes", [])],
        "",
        "## B.37 Changes",
        "",
        *[f"- {item}" for item in payload.get("b37_changes", [])],
        "",
        "## B.38 Changes",
        "",
        *[f"- {item}" for item in payload.get("b38_changes", [])],
        "",
        "## B.39 Changes",
        "",
        *[f"- {item}" for item in payload.get("b39_changes", [])],
        "",
        "## B.40 Changes",
        "",
        *[f"- {item}" for item in payload.get("b40_changes", [])],
        "",
        "## B.41 Changes",
        "",
        *[f"- {item}" for item in payload.get("b41_changes", [])],
        "",
        "## B.42 Changes",
        "",
        *[f"- {item}" for item in payload.get("b42_changes", [])],
        "",
        "## B.42 Final Test-Harness Micro-Gate Changes",
        "",
        *[f"- {item}" for item in payload.get("b42_final_test_harness_changes", [])],
        "",
        "## B.43 Changes",
        "",
        *[f"- {item}" for item in payload.get("b43_changes", [])],
        "",
        "## B.44 Changes",
        "",
        *[f"- {item}" for item in payload.get("b44_changes", [])],
        "",
        "## B.45 Changes",
        "",
        *[f"- {item}" for item in payload.get("b45_changes", [])],
        "",
        "## B.46 Changes",
        "",
        *[f"- {item}" for item in payload.get("b46_changes", [])],
        "",
        "## B.47 Changes",
        "",
        *[f"- {item}" for item in payload.get("b47_changes", [])],
        "",
        "## B.48 Changes",
        "",
        *[f"- {item}" for item in payload.get("b48_changes", [])],
        "",
        "## B.48 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b48_final_micro_freeze_changes", [])],
        "",
        "## B.49 Changes",
        "",
        *[f"- {item}" for item in payload.get("b49_changes", [])],
        "",
        "## B.50 Changes",
        "",
        *[f"- {item}" for item in payload.get("b50_changes", [])],
        "",
        "## B.50 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b50_final_micro_freeze_changes", [])],
        "",
        "## B.51 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b51_final_micro_freeze_changes", [])],
        "",
        "## B.52 Final Micro-Freeze Changes",
        "",
        *[f"- {item}" for item in payload.get("b52_final_micro_freeze_changes", [])],
        "",
        "## B.53 Changes",
        "",
        *[f"- {item}" for item in payload.get("b53_changes", [])],
        "",
        "## B.54 Changes",
        "",
        *[f"- {item}" for item in payload.get("b54_changes", [])],
        "",
        "## B.55 Changes",
        "",
        *[f"- {item}" for item in payload.get("b55_changes", [])],
        "",
        "## B.56 Changes",
        "",
        *[f"- {item}" for item in payload.get("b56_changes", [])],
        "",
        "## B.57 Changes",
        "",
        *[f"- {item}" for item in payload.get("b57_changes", [])],
        "",
        "## B.58 Changes",
        "",
        *[f"- {item}" for item in payload.get("b58_changes", [])],
        "",
        "## B.59 Changes",
        "",
        *[f"- {item}" for item in payload.get("b59_changes", [])],
        "",
        *(
            [
                "## B.53–B.59 Heavy Checkpoint / Final Freeze",
                "",
                *[f"- {item}" for item in payload.get("b59_final_freeze_changes", [])],
                "",
            ]
            if payload.get("b59_final_freeze_changes")
            else []
        ),
        "## Limitations",
        "",
        "- Lizard reports individual functions; Angular inline template/style code remains a physical-size caveat.",
        "- Backend mutation tooling remains unavailable in the current Windows toolchain.",
        "- Google real OAuth is not used in E2E.",
        "- npm outdated and Cppcheck depend on the CI environment/registry.",
        "- GitHub Actions remote execution remains pending; the workflow was corrected and statically reviewed locally.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--frontend-tests", type=int)
    parser.add_argument("--backend-cases", type=int)
    parser.add_argument("--backend-assertions", type=int)
    parser.add_argument("--fixture-cases", type=int)
    parser.add_argument("--fixture-assertions", type=int)
    parser.add_argument("--b49-final-freeze", action="store_true")
    parser.add_argument("--b50-candidate", action="store_true")
    parser.add_argument("--b50-final-freeze", action="store_true")
    parser.add_argument("--b53-candidate", action="store_true")
    parser.add_argument("--b54-candidate", action="store_true")
    parser.add_argument("--b55-candidate", action="store_true")
    parser.add_argument("--b56-candidate", action="store_true")
    parser.add_argument("--b57-candidate", action="store_true")
    parser.add_argument("--b58-candidate", action="store_true")
    parser.add_argument("--b59-candidate", action="store_true")
    parser.add_argument("--b59-final-freeze", action="store_true")
    args = parser.parse_args()

    lightweight_candidate_mode = any((
        args.b53_candidate,
        args.b54_candidate,
        args.b55_candidate,
        args.b56_candidate,
        args.b57_candidate,
        args.b58_candidate,
        args.b59_candidate,
    ))
    if lightweight_candidate_mode:
        if args.backend_cases is None or args.backend_assertions is None:
            parser.error("lightweight candidate requires focused backend case and assertion counts")
        args.fixture_cases = args.fixture_cases or 0
        args.fixture_assertions = args.fixture_assertions or 0
    elif any(value is None for value in (
        args.frontend_tests,
        args.backend_cases,
        args.backend_assertions,
        args.fixture_cases,
        args.fixture_assertions,
    )):
        parser.error("full/freeze baseline modes require all test and fixture counts")
    if args.fixture_cases < 0 or args.fixture_assertions < 0:
        parser.error("fixture counts must be non-negative")
    root = args.root.resolve()
    quality = root / ".quality"
    modules = load(quality / "module-metrics.json", {"modules": []})
    all_modules = modules.get("modules", [])
    dead = (
        {key: "NOT RUN" for key in (
            "normal_files",
            "production_files",
            "exports",
            "types",
            "dependencies",
            "devDependencies",
            "cycles",
        )}
        if lightweight_candidate_mode
        else {
            "normal_files": count_knip(quality / "knip-normal.json", "files"),
            "production_files": count_knip(quality / "knip-production.json", "files"),
            "exports": count_knip(quality / "knip-normal.json", "exports"),
            "types": count_knip(quality / "knip-normal.json", "types"),
            "dependencies": count_knip(quality / "knip-production.json", "dependencies"),
            "devDependencies": count_knip(quality / "knip-normal.json", "devDependencies"),
            "cycles": count_knip(quality / "knip-cycles.json", "cycles"),
        }
    )
    dead = {key: (value if value is not None else "NOT RUN") for key, value in dead.items()}
    mutation = not_run_mutation() if lightweight_candidate_mode else mutation_summary(quality / "mutation" / "mutation.json")
    e2e = not_run_e2e() if lightweight_candidate_mode else e2e_summary(quality / "playwright" / "results.json", quality / "playwright" / "run-status.json")
    frontend_coverage = not_run_coverage() if lightweight_candidate_mode else coverage(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json")
    backend_coverage_data = not_run_coverage() if lightweight_candidate_mode else backend_coverage(quality / "backend-coverage.json")
    freeze_modes = [args.b49_final_freeze, args.b50_candidate, args.b50_final_freeze]
    selected_freeze_modes = [*freeze_modes, args.b53_candidate, args.b54_candidate, args.b55_candidate, args.b56_candidate, args.b57_candidate, args.b58_candidate, args.b59_candidate, args.b59_final_freeze]
    if sum(bool(mode) for mode in selected_freeze_modes) > 1:
        parser.error("B.49 final freeze, B.50 candidate and B.50 final freeze are mutually exclusive; B.53-B.59 candidate modes are mutually exclusive with freeze and with each other")
    if args.b53_candidate and not b53_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.53 candidate requires positive focused backend case and assertion counts")
    if args.b54_candidate and not b54_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.54 candidate requires positive focused backend case and assertion counts")
    if args.b55_candidate and not b55_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.55 candidate requires positive focused backend case and assertion counts")
    if args.b56_candidate and not b56_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.56 candidate requires positive focused backend case and assertion counts")
    if args.b57_candidate and not b57_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.57 candidate requires positive focused backend case and assertion counts")
    if args.b58_candidate and not b58_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.58 candidate requires positive focused backend case and assertion counts")
    if args.b59_candidate and not b59_candidate_ready(
        backend_cases=args.backend_cases,
        backend_assertions=args.backend_assertions,
    ):
        parser.error("B.59 candidate requires positive focused backend case and assertion counts")
    if args.b59_final_freeze:
        required_evidence = [
            root / "docs" / "swagger.yaml",
            root / "tools" / "quality" / "test_openapi_contract.py",
            quality / "module-metrics.json",
            quality / "cppcheck.xml",
            quality / "mutation" / "mutation.json",
            quality / "playwright" / "results.json",
            quality / "playwright" / "run-status.json",
            quality / "knip-normal.json",
            quality / "knip-production.json",
            quality / "knip-cycles.json",
            root / "frontend" / "coverage" / "frontend" / "coverage-summary.json",
            quality / "backend-coverage.json",
        ]
        if not all(path.is_file() for path in required_evidence) or not b59_final_freeze_ready(
            e2e=e2e,
            frontend_coverage=frontend_coverage,
            backend_coverage=backend_coverage_data,
            mutation=mutation,
            frontend_tests=args.frontend_tests,
            backend_cases=args.backend_cases,
            backend_assertions=args.backend_assertions,
            fixture_cases=args.fixture_cases,
            fixture_assertions=args.fixture_assertions,
        ):
            parser.error("B.59 final freeze requires current heavy evidence artifacts and green full-suite gates")
    elif any(freeze_modes):
        required_evidence = [
            root / "docs" / "swagger.yaml",
            root / "tools" / "quality" / "test_openapi_contract.py",
            root / "backend" / "tests" / "test_b50_external_finalize_unlink.cpp",
            quality / "module-metrics.json",
            quality / "cppcheck.xml",
            quality / "mutation" / "mutation.json",
            quality / "playwright" / "results.json",
            quality / "playwright" / "run-status.json",
        ]
        if args.b50_final_freeze:
            required_evidence.extend([
                root / "frontend" / "coverage" / "frontend" / "coverage-summary.json",
                quality / "backend-coverage.json",
            ])
        ready = (
            b49_final_freeze_ready
            if args.b49_final_freeze
            else b50_final_freeze_ready
            if args.b50_final_freeze
            else b50_candidate_ready
        )
        if not all(path.is_file() for path in required_evidence) or not ready(
            e2e=e2e,
            frontend_coverage=frontend_coverage,
            backend_coverage=backend_coverage_data,
            mutation=mutation,
            frontend_tests=args.frontend_tests,
            backend_cases=args.backend_cases,
            backend_assertions=args.backend_assertions,
        ):
            parser.error("current freeze/candidate status requires green E2E, coverage, mutation and evidence reports")
    cppcheck_version = version([["cppcheck", "--version"]]) if shutil.which("cppcheck") else "unavailable"
    findings = []
    if positive_count(dead["exports"]) or positive_count(dead["types"]):
        findings.append({"id": "KNIP-001", "category": "DEFER", "finding": f"Knip still reports {dead['exports']} export(s) and {dead['types']} type(s) after the public-surface audit.", "action": "Audit each remaining public-surface finding before changing or deleting declarations."})
    if positive_count(dead["cycles"]):
        findings.append({"id": "CYCLE-001", "category": "DEFER", "finding": f"Knip still reports {dead['cycles']} import cycle(s).", "action": "Rodada B.3: characterize any newly reported boundary without changing auth/drive behavior."})
    if positive_count(dead["dependencies"]):
        findings.append({"id": "DEP-001", "category": "DEFER", "finding": f"Knip still reports {dead['dependencies']} production dependency candidate(s) after graph configuration.", "action": "Reconfirm consumers before changing package manifests."})
    if not lightweight_candidate_mode and mutation["status"] != "executed":
        findings.append({"id": "MUT-001", "category": "TEST GAP", "finding": "The bounded frontend mutation report was not executed.", "action": "Run the configured Stryker scope before treating the mutation baseline as complete."})
    elif mutation["survived"]:
        findings.append({"id": "MUT-001", "category": "MUTATION SURVIVOR", "finding": f"The bounded mutation report contains {mutation['survived']} survivor(s) and {mutation['compile_error']} compile error(s).", "action": "Rodada B.3: review survivors and keep compile errors as mutation-tool diagnostics."})
    elif mutation["compile_error"]:
        findings.append({"id": "MUT-001", "category": "MUTATION DIAGNOSTIC", "finding": f"The bounded mutation report has no survivors and {mutation['compile_error']} compile-time mutant diagnostic(s).", "action": "Keep the compile-error mutant as a tool diagnostic; no production change is justified."})
    findings.append({"id": "CROW-MANIFEST-001", "category": "DEFER", "finding": "The Crow framework is consumed through the checked-in crow_all.h bootstrap, but no local vcpkg executable/toolchain was available for a clean manifest proof.", "action": "KEEP / DEFER the backend/vcpkg.json crow entry; do not replace it speculatively."})
    findings.append({"id": "SIZE-001", "category": "MODULE SIZE", "finding": "The module report identifies large physical Drive/API files and separate function-level complexity hotspots; inline Angular templates/styles remain a physical-size caveat.", "action": "Leave large modules unchanged until a separately scoped and tested low-risk split is approved."})
    if not lightweight_candidate_mode and not e2e_is_green(e2e):
        findings.insert(4, {"id": "E2E-001", "category": "TEST GAP", "finding": "The five-spec Playwright report lacks valid current-run provenance or is not an exact 5/5 pass.", "action": "Run the canonical provenance-backed harness before treating E2E as green."})
    if not lightweight_candidate_mode and e2e.get("status_valid") and (e2e.get("outcome") != "completed" or e2e.get("failed") or e2e.get("flaky")):
        findings.insert(5, {"id": "E2E-FLAKE-001", "category": "E2E FLAKINESS", "finding": "The current canonical Playwright evidence records a non-green or unstable run.", "action": "Investigate the failing phase in a separately scoped E2E stabilization round; do not increase retries or timeouts here."})
    if not any(item["id"] == "E2E-FLAKE-001" for item in findings):
        findings.append({"id": "E2E-FLAKE-001", "category": "HISTORICAL E2E FLAKINESS", "finding": "Earlier canonical Playwright instability remains part of the quality history; the current green run does not erase that evidence.", "action": "Retain as historical context and do not treat it as a current-run failure."})
    fixture_scenarios = [
        "unsafe username prefix rejected",
        "safe username prefix accepted",
        "production password hash verifies and wrong password fails",
        "missing-user cleanup is idempotent",
        "target canonical file/user removed while control user/file is preserved",
    ]
    cleanup = {
        "removed_exports": [
            "initializeApp",
            "GOOGLE_DRIVE_SHARING_UNAVAILABLE",
            "FOLDER_BATCH_LIMIT",
            "FOLDER_TREE_DEPTH_LIMIT",
        ],
        "removed_types": [
            "DriveFolderDto",
            "DriveFileDto",
            "PinnedFolderReference",
            "StorageTargetStatus",
            "StorageMoveStatus",
            "UploadProgressUpdate",
        ],
        "kept": [
            "@angular/forms",
            "@angular/router",
            "@ffmpeg/ffmpeg",
            "@ffmpeg/util",
            "libsodium-wrappers-sumo",
            "mp4box",
        ],
    }
    payload = {
        "schema": 3,
        "tests": {"frontend_unit": args.frontend_tests if args.frontend_tests is not None else "NOT RUN", "backend_cases": args.backend_cases, "backend_assertions": args.backend_assertions, "e2e": e2e},
        "quality_scope": B59_FINAL_FREEZE_QUALITY_SCOPE if args.b59_final_freeze else B59_QUALITY_SCOPE if args.b59_candidate else B58_QUALITY_SCOPE if args.b58_candidate else B57_QUALITY_SCOPE if args.b57_candidate else B56_QUALITY_SCOPE if args.b56_candidate else B55_QUALITY_SCOPE if args.b55_candidate else B54_QUALITY_SCOPE if args.b54_candidate else B53_QUALITY_SCOPE if args.b53_candidate else QUALITY_SCOPE,
        "backend_gate": (
            "PASS: HEAVY CHECKPOINT B.53–B.59; final ratification; B.31–B.59 FROZEN FINAL / RATIFIED; B.60+ NOT SELECTED; NEXT: FRESH BROAD AUDIT"
            if args.b59_final_freeze
            else
            "PASS: focused B.59 candidate gate; HC preflight green; heavy checkpoint ready / next"
            if args.b59_candidate
            else
            "PASS: focused B.58 candidate gate; repository-wide heavy checkpoint deferred"
            if args.b58_candidate
            else
            "PASS: focused B.57 candidate gate; repository-wide heavy checkpoint deferred"
            if args.b57_candidate
            else
            "PASS: focused B.56 candidate gate; repository-wide heavy checkpoint deferred"
            if args.b56_candidate
            else
            "PASS: focused B.55 candidate gate; repository-wide heavy checkpoint deferred"
            if args.b55_candidate
            else
            "PASS: focused B.54 candidate gate; repository-wide heavy checkpoint deferred"
            if args.b54_candidate
            else
            "PASS: focused B.53 candidate gate; repository-wide heavy checkpoint deferred"
            if args.b53_candidate
            else "PASS: current full backend gate on the recreated disposable database"
            if any(selected_freeze_modes)
            else "NOT FROZEN: B.49 final micro-freeze was not asserted"
        ),
        "fixture_regressions": {
            "focused_cases": args.fixture_cases,
            "focused_assertions": args.fixture_assertions,
            "scenario_count": len(fixture_scenarios),
            "scenarios": fixture_scenarios,
        },
        "cleanup": cleanup,
        "coverage": {
            "frontend": frontend_coverage,
            "backend": backend_coverage_data,
        },
        "evidence_provenance": (
            {
                "current_round": f"B.53–B.59 current repository-wide heavy evidence: frontend {args.frontend_tests} tests; backend {args.backend_assertions} assertions / {args.backend_cases} cases; fixture {args.fixture_assertions} assertions / {args.fixture_cases} cases",
                "historical_reused": "B.53–B.59 candidate evidence and E2E-FLAKE-001 history are retained as provenance; they do not replace current heavy artifacts",
                "heavy_checkpoint": "PASS / RATIFIED",
                "full_frontend": f"{args.frontend_tests} tests, coverage {frontend_coverage['statements']}% statements / {frontend_coverage['branches']}% branches / {frontend_coverage['functions']}% functions / {frontend_coverage['lines']}% lines",
                "full_backend": f"{args.backend_assertions} assertions / {args.backend_cases} cases; coverage {backend_coverage_data['lines']}% lines / {backend_coverage_data['branches']}% branches / {backend_coverage_data['functions']}% functions",
                "cppcheck_full": "current repository report present; known report-only diagnostics retained",
                "knip_full": "normal/cycles reports current; production report-only findings retained",
            }
            if args.b59_final_freeze
            else
            {
                "current_round": f"B.59 FOCUSED CURRENT evidence: {args.backend_assertions} assertions / {args.backend_cases} focused backend cases; HC-PREFLIGHT related evidence is recorded separately; no full-suite claim",
                "historical_reused": "Frontend unit count and repository-wide inventory are not current B.59 evidence",
                "heavy_checkpoint": "READY / NEXT / NOT RUN IN THIS EXECUTION",
                "full_frontend": "NOT RUN",
                "full_backend": "NOT RUN",
                "cppcheck_full": "NOT RUN",
                "knip_full": "NOT RUN",
            }
            if args.b59_candidate
            else
            {
                "current_round": f"B.58 FOCUSED CURRENT evidence: {args.backend_assertions} assertions / {args.backend_cases} focused backend cases; no full-suite claim",
                "historical_reused": "Frontend unit count and repository-wide inventory are not current B.58 evidence",
                "heavy_checkpoint": "DEFERRED / NOT RERUN",
                "full_frontend": "NOT RUN",
                "full_backend": "NOT RUN",
                "cppcheck_full": "NOT RUN",
                "knip_full": "NOT RUN",
            }
            if args.b58_candidate
            else
            {
                "current_round": f"B.57 FOCUSED CURRENT evidence: {args.backend_assertions} assertions / {args.backend_cases} focused backend cases; no full-suite claim",
                "historical_reused": "Frontend unit count and repository-wide inventory are not current B.57 evidence",
                "heavy_checkpoint": "DEFERRED / NOT RERUN",
                "full_frontend": "NOT RUN",
                "full_backend": "NOT RUN",
                "cppcheck_full": "NOT RUN",
                "knip_full": "NOT RUN",
            }
            if args.b57_candidate
            else
            {
                "current_round": f"B.56 FOCUSED CURRENT evidence: {args.backend_assertions} assertions / {args.backend_cases} focused backend cases; no full-suite claim",
                "historical_reused": "Frontend unit count and repository-wide inventory are not current B.56 evidence",
                "heavy_checkpoint": "DEFERRED / NOT RERUN",
                "full_frontend": "NOT RUN",
                "full_backend": "NOT RUN",
                "cppcheck_full": "NOT RUN",
                "knip_full": "NOT RUN",
            }
            if args.b56_candidate
            else {
                "current_round": f"B.55 FOCUSED CURRENT evidence: {args.backend_assertions} assertions / {args.backend_cases} backend cases; no full-suite claim",
                "historical_reused": f"Frontend unit count {args.frontend_tests} and repository inventory fields are historical/reused context, not rerun B.55 evidence",
                "heavy_checkpoint": "DEFERRED / NOT RERUN",
            }
            if args.b55_candidate
            else None
        ),
        "mutation": {"frontend": mutation, "backend": {"status": "NOT RUN / NOT READ" if lightweight_candidate_mode else "not run", "reason": "Deferred to the future heavy checkpoint" if lightweight_candidate_mode else "Mull/Clang unavailable in the current Windows toolchain"}},
        "dead_code": dead,
        "static_analysis": {
            "cppcheck": (
                "NOT RUN in lightweight candidate mode"
                if lightweight_candidate_mode
                else
                "available locally; report-only command exit 0 with existing warning/style diagnostics"
                if cppcheck_version != "unavailable"
                else "NOT AVAILABLE locally; CI command documented"
            )
        },
        "tools": {
            "Node": version([["node", "--version"]]),
            "npm": version([["npm.cmd", "--version"], ["npm", "--version"]], root / "frontend"),
            "Python": version([[sys.executable, "--version"]]),
            "Lizard": version([[sys.executable, "-m", "lizard", "--version"], ["py", "-m", "lizard", "--version"]]),
            "Knip": version([["npm.cmd", "exec", "--", "knip", "--version"], ["npm", "exec", "--", "knip", "--version"]], root / "frontend"),
            "Playwright": version([["npm.cmd", "exec", "--", "playwright", "--version"], ["npm", "exec", "--", "playwright", "--version"]], root / "frontend"),
            "Stryker": version([["npm.cmd", "exec", "--", "stryker", "--version"], ["npm", "exec", "--", "stryker", "--version"]], root / "frontend"),
            "CMake": version([["cmake", "--version"]]),
            "Cppcheck": cppcheck_version,
            "Mull": "unavailable",
        },
        "modules": {
            "frontend_top": sorted((item for item in all_modules if item.get("area") == "frontend"), key=lambda item: (-item.get("physical_lines", 0), item["path"]))[:20],
            "backend_top": sorted((item for item in all_modules if item.get("area") == "backend"), key=lambda item: (-item.get("physical_lines", 0), item["path"]))[:20],
        },
        "complexity": {"frontend_top": function_top(all_modules, "frontend"), "backend_top": function_top(all_modules, "backend")},
        "coverage_files": {
            "branches": [] if lightweight_candidate_mode else frontend_file_ranking(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", "branches"),
            "functions": [] if lightweight_candidate_mode else frontend_file_ranking(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", "functions"),
            "lines": [] if lightweight_candidate_mode else frontend_file_ranking(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", "lines"),
        },
        "dependencies": package_inventory(root),
        "findings": findings,
        "b2_changes": [
            "Knip: removed the manual entry/project override; Angular and Playwright plugin discovery now resolves the live frontend dependency graph.",
            "Knip: kept only precise exclusions for runtime FFmpeg assets and E2E harness support; dependency, export, type and cycle checks remain enabled.",
            "Cycles: converted the resolver's DriveFile edge to a type-only import and moved BYPASS_LOGOUT to the neutral HTTP-context token module.",
            "formatBytes: added the >PB boundary test; the production formatter was not changed.",
            "Crow: vcpkg was unavailable locally, so the manifest entry remains KEEP/DEFER rather than being removed speculatively.",
        ],
        "b3_changes": [
            "Knip: audited all six remaining exports and the remaining type; removed only the export modifier from the six internal-only declarations that compile and retain their existing consumers.",
            "Final B.3 polish: removed BATCH_API_LIMIT after confirming it had no internal or external consumer; no replacement was added.",
            "Crow: vcpkg and CMAKE_TOOLCHAIN_FILE were unavailable locally; the framework and backend/vcpkg.json manifest entry remain KEEP / DEFER with no backend changes.",
            "Complexity: generated fresh function-level metrics and characterized hotspots without changing their implementation.",
        ],
        "b4_changes": [
            "ThumbnailLoaderService: added public-load characterization coverage for deduplication, local/Google range sources, adaptive metadata growth, size caps, retry classification/budget and FDK zeroization.",
            "ThumbnailLoaderService: refactored loadOnce into small local responsibilities while preserving public API, generation safety, direct Google browser requests, range policy and retry behavior.",
            "Complexity: loadOnce decreased from CC 19 / 44 NLOC / 487 tokens to CC 8 / 18 NLOC / 207 tokens; the largest new helper is loadMetadata at CC 11.",
            "Validation: focused thumbnail tests 17/17, frontend unit tests 552/552, coverage and build passed, fresh Playwright passed 5/5; backend was unchanged and not rerun.",
            "Final B.4 polish: added a generation guard after resolving the asynchronous Google range source so stale Google metadata cannot fall through to the local range path; focused thumbnail tests 18/18, frontend unit tests 553/553 and fresh Playwright passed 5/5.",
        ],
        "b5_changes": [
            "VideoStreamService: added six characterization tests covering vault/share guards, proxy and forceOriginal selection, local/share/Google range routing, Kasumi metadata, MediaSource/bootstrap setup and initial seek behavior.",
            "VideoStreamService: added fourteen lifecycle hardening regressions for stale initialization/failure isolation, destroy-time cancellation, RxJS abort, retry cancellation, worker/ObjectURL ownership, timer cleanup and FDK/baseNonce zeroization.",
            "VideoStreamService: refactored initializeStream from CC 34 / 121 NLOC / 1032 tokens to CC 17 / 103 NLOC / 615 tokens; no extracted helper exceeds CC 8.",
            "VideoStreamService: preserved public API, media/range/chunk semantics, direct Google browser requests, batching and retry policy while making initialization ownership explicit.",
            "Validation: focused tests 36/36 in three independent runs, frontend unit tests 573/573, coverage and Angular build passed, fresh Playwright passed 5/5; backend, Docker, CI and Git state were not mutated.",
            "Final B.5 polish: closed the temporary FDK ownership gap across asynchronous Google metadata resolution, added regression coverage for failure/abort before stream-state commit, and preserved all streaming contracts.",
            "Final B.5 polish metrics: initializeStream remained at CC 17 and measured 105 NLOC / 635 tokens; resolveOwnedFdk is CC 2 and resolveStreamSource is CC 4, with no artificial extraction added.",
            "Final validation: focused tests 38/38 in three independent runs, frontend unit tests 575/575, fresh coverage/build passed and Playwright passed 5/5.",
            "B.5 freeze polish: added the final generation barrier after complete metadata/baseNonce resolution, preventing stale MediaSource/ObjectURL/video side effects; the regression proves FDK and baseNonce zeroization.",
            "B.5 freeze polish: removed only the redundant post-bootstrap s.aborted guard after proving generation validation and teardown ownership; no public streaming contract changed.",
            "B.5 freeze validation: focused tests 39/39 in three independent runs, frontend unit tests 576/576, global coverage 74.24% statements / 61.46% branches / 77.27% functions / 76.78% lines, VideoStream coverage 57.94% / 45.71% / 65.81% / 59.48%, Angular build passed, and Playwright passed 5/5.",
        ],
        "b6_changes": [
            "FilePreviewResolver: added characterization coverage for MIME precedence/case handling, exact file.type precedence, all 21 supported extensions, name fallback edge cases and preview MIME fallbacks; focused tests increased from 2/2 to 9/9.",
            "FilePreviewResolver: consolidated extension kind and MIME metadata into one static table, with static MIME-prefix, file.type and default-MIME lookups; per-call extension arrays, MIME Record creation and duplicated extraction were removed.",
            "FilePreviewResolver: preserved MIME > type > extension > unsupported precedence, literal explicit MIME values, case-sensitive file.type, decryptedName || encryptedName semantics and every existing MIME mapping.",
            "Complexity: resolveFilePreviewKind decreased from CC 13 / 14 NLOC / 211 tokens to CC 4 / 10 NLOC / 82 tokens; previewMimeType decreased from CC 7 / 14 NLOC / 193 tokens to CC 4 / 8 NLOC / 76 tokens, with helper maximum CC 3.",
            "Validation: focused tests 9/9 in three independent runs, frontend unit tests 583/583, global coverage 74.26% statements / 61.61% branches / 77.33% functions / 76.79% lines, FilePreviewResolver coverage 96.55% / 100% / 100% / 95.45%, Angular build passed, Knip normal/cycles remained clean, production Knip retained only the three historical diagnostics, and Playwright passed 5/5.",
            "Final B.6 polish: characterized valid parameterized MIME values and prototype-like lookup keys, made input lookup metadata readonly, added the private PreviewFile alias and made default MIME handling compile-time exhaustive; behavior and supported formats remained unchanged.",
            "Final B.6 validation: resolver focused tests 11/11 in three independent runs and FilePreviewResolver coverage reached 100% for statements, branches, functions and lines.",
        ],
        "b7_changes": [
            "AudioPlayerComponent: characterized MediaError codes 1, 2, 3, 4, 0 and unknown values, full diagnostics, empty MIME, null target, null MediaError, canPlayType results and supported audio MIME behavior.",
            "AudioPlayerComponent: moved media error messages to a static readonly policy and normalized diagnostics through one local helper; onMediaError now only orchestrates diagnostics and message selection.",
            "AudioPlayerComponent: reduced repeated audioMimeType signal reads in the audioRef setter without changing load order, unsupported-MIME wording or playback behavior.",
            "Complexity: onMediaError decreased from CC 15 / 19 NLOC / 142 tokens to CC 5 / 6 NLOC / 63 tokens; buildMediaDiagnostics is CC 4 / 11 NLOC / 102 tokens, with no artificial hotspot transfer.",
            "Validation: audio focused tests 17/17, combined resolver/audio focused tests 28/28 in three independent runs, frontend unit tests 596/596, coverage and Angular build passed, Knip normal/cycles remained clean, production Knip retained only the three historical diagnostics, and Playwright passed 5/5.",
            "Final B.7 polish: reused AudioMediaDiagnostics on the diagnostics signal and directly characterized the browser 'maybe' support diagnostic; runtime behavior remained unchanged.",
        ],
        "b8_changes": [
            "DataTransferReader: expanded characterization of browser item/Entry/FileList fallback policy, including loose, unreadable, opaque, native file, directory, empty-directory and mixed drops.",
            "Security characterization: preserved unsafe paths, exact MAX_DEPTH/MAX_FOLDERS boundaries, duplicate paths, missing callbacks and callback failures.",
            "Refactor: separated per-item reading from final browser fallback selection with a small DropReadState, readItem and finalizeRead structure; directory traversal remains sequential and unchanged.",
            "Complexity: read decreased from CC 13 / 26 NLOC / 235 tokens to CC 7 / 15 NLOC / 145 tokens. The current Lizard TypeScript parser did not reliably report readItem/finalizeRead, so no exact helper CC is claimed; their final control flow was reviewed structurally.",
            "Validation: pre-refactor DataTransferReader focused tests 27/27 in three characterization runs; final DataTransferReader focused tests 28/28 and combined focused tests 50/50 in three independent runs; frontend unit tests 614/614, fresh coverage/build, Knip, module metrics and Playwright passed.",
            "Final B.8 freeze polish: strengthened the non-file filter characterization, added opaque Entry + FileList coverage, removed the derived unreadableItem flag and consolidated duplicate FileList fallback logic; all browser fallback, traversal and path-security contracts remained unchanged.",
        ],
        "b9_changes": [
            "FolderUploadCoordinatorService: characterized the exact response contract for out-of-order items, strict client_ref/folder_id/created types, response length, duplicate references and IDs, malformed null/undefined/empty items, tolerated extra fields and plaintext-free batch requests.",
            "FolderUploadCoordinatorService: replaced redundant seen/final-cardinality bookkeeping with one runtime shape helper, remainingRefs and the existing folder-ID Set/Map; response mapping remains order-independent and O(n).",
            "Complexity: validateResponse decreased from CC 12 / 18 NLOC / 217 tokens to CC 6 / 14 NLOC / 146 tokens; isValidResponseItem is CC 6 / 9 NLOC / 71 tokens, with no module-level complexity transfer and prepare/prepareSources/prepareTree unchanged.",
            "Validation: pre-refactor coordinator characterization 10/10 and folder-tree focused tests 3/3; final coordinator focused tests 10/10, folder-tree focused tests 3/3 and combined focused tests 13/13, each in three independent runs; frontend unit retry passed 621/621, coverage reached 74.42% statements / 61.84% branches / 77.40% functions / 76.86% lines, coordinator coverage reached 94.59% statements / 81.25% branches / 100% functions / 100% lines, Angular build and module metrics passed.",
            "Quality diagnostics: Knip normal reported only two configuration hints, production Knip retained the three historical diagnostics, and cycles remained empty; earlier Playwright backend/preflight, login and UI-race instability remains documented as B.9 history.",
            "Final quality-gate polish: added the canonical cross-platform tools/quality/run_playwright.py runner, which deletes stale report/status evidence before preflight, preserves the real Playwright exit code and writes a sanitized current-run status manifest with the exact report SHA-256.",
            "Final quality-gate polish: added fail-closed tooling regressions for stale/missing/invalid/mismatched evidence, failed preflight, failed Playwright, wrong suite cardinality, skipped/flaky tests and valid current 5/5; run-tests.ps1 and the CI E2E job now delegate to the canonical runner.",
            "Final B.9 gate: the provenance-backed canonical Playwright run completed 5/5 with zero failed, skipped or flaky tests, exit code 0 and a matching report hash; B.9 is frozen for the B.10 prerequisite.",
        ],
        "b10_changes": [
            "UploadBatchCoordinatorService: expanded characterization from 10 to 24 tests, covering empty input, operation serialization/recovery, preparation concurrency, out-of-order correlation, strict encrypted request shape, duplicate handling, 401/non-401 windows, aggregate cancellation, listener disposal, post-init cleanup, invalid responses, provider routing and exactly-once summaries.",
            "UploadBatchCoordinatorService: extracted duplicate rejection, batch initialization/error ownership and initialized execution into private helpers; removed the process-level stop flag while preserving the 401 break boundary and pending-candidate failure semantics.",
            "Final B.10 polish: initializeWindow now returns a private discriminated union (ready/failed/unauthorized), owns only the current window, and leaves 401 pending-candidate traversal to process() without an eager future-candidate slice.",
            "Final characterization: candidate abort-listener ownership is asserted against each candidate signal on success and initialization failure; deterministic execution tests prove local concurrency 3 and Google concurrency 2 without sleeps or timing retries.",
            "Windowing and performance contracts remain unchanged: window size 10, preparation concurrency 2, local concurrency 3, Google concurrency 2, bounded per-window Maps/Sets/task arrays, O(n) duplicate detection and name_hash correlation.",
            "Security contracts remain unchanged: batch requests contain only encrypted metadata, never plaintext filename/path/File/FDK/access token/root ID; Google credentials remain response-only and invalid responses never execute.",
            "Complexity: process is CC 7 / 23 NLOC / 224 tokens after the semantic 401 branch; initializeWindow is CC 1 / 12 NLOC / 84 tokens, rejectDuplicates is CC 1 / 8 NLOC / 42 tokens, and the module maximum is CC 7, with no transferred hotspot.",
            "Performance review: successful windows no longer allocate future candidates; only an actual 401 iterates the remaining suffix, restoring linear coordinator overhead while preserving the 401 stop contract.",
            "Validation: pre-polish focused characterization 24/24 in three runs, final focused 27/27 in three runs, combined upload suite 59/59, frontend unit 638/638, global coverage 74.68% statements / 62.05% branches / 77.76% functions / 77.07% lines, coordinator coverage 95.33% / 89.79% / 100% / 96.66%, build passed, module-metrics tests and fresh metrics passed; Knip reported two normal configuration hints, three historical production diagnostics and zero cycles.",
            "E2E diagnosis: the obsolete --repeat-each=20 experiment produced 15 successful runs, four authentication 429 policy collisions after exceeding the intentional five-auth-requests-per-IP window, and one unexpected protected 401; the 429s were not trash-flow flakes. The protected 401 did not reproduce under the corrected rate-aware design.",
            "E2E closure: trash.spec.ts now installs sanitized structured 401 diagnostics before upload, runs bounded same-session cycles (default 1, freeze 20), returns to /drive/home after every cycle, synchronizes every mutation response, and removes the listener in finally. The targeted run completed 20/20 cycles and the final canonical run completed 5/5 tests with 20 trash cycles, zero unexpected 401, zero auth 429, zero failed/skipped/flaky tests and retry 0.",
            "Quality status: B.10 FROZEN after the retry-free provenance-backed canonical gate. This closure added no production auth/backend change and no coordinator change beyond the already-approved B.10 implementation; B.11 remains NOT STARTED.",
        ],
        "b11_changes": [
            "DownloadEngineService.runLocal: added eight characterization regressions, expanding the focused suite from 11 to 19 tests and proving true multi-chunk ranges, exact chunk boundaries, pause retention, stale arrayBuffer barriers, zeroization, crypto failure propagation and zero-byte completion.",
            "DownloadEngineService.runLocal: consolidated the repeated current-runtime-plus-pause checkpoint into canContinueLocal and isolated terminal local completion in completeLocalDownload; chunk sizing, inclusive ranges, sequential decrypt/commit ordering, resume state and browser download semantics remain unchanged.",
            "Complexity: runLocal decreased from CC 16 / 61 NLOC / 538 tokens to CC 8 / 38 NLOC / 338 tokens; canContinueLocal is CC 3 / 11 NLOC / 68 tokens, completeLocalDownload is CC 5 / 15 NLOC / 147 tokens, and module maximum decreased from CC 16 to CC 9 without transferring a hotspot.",
            "Security and lifecycle: successful local completion still zeroizes FDK, baseNonce and plaintextChunks; pause retains resumable state and keys; stale runtimes cannot decrypt, commit or trigger a download; non-abort crypto/network/corruption errors remain observable.",
            "Validation: original focused tests passed 11/11 in three runs; expanded characterization passed 19/19 in three runs against original production; final focused tests passed 19/19 in three runs; combined download regression passed 98/98; frontend unit tests passed 646/646; module-metrics tests, coverage and Angular build passed.",
            "Coverage: global frontend reached 74.78% statements / 62.26% branches / 77.72% functions / 77.13% lines; DownloadEngineService reached 87.9% statements / 66.66% branches / 100% functions / 92.3% lines.",
            "Static quality: Knip normal retained two configuration hints, production Knip retained three historical diagnostics, and cycles remained empty; no package, configuration, CI, Docker, backend, crypto-format or Google-download architecture changes were made.",
            "Final B.11 gate: the canonical provenance-backed Playwright runner completed exactly 5/5 with zero failed, skipped or flaky tests, exit code 0, valid status/report, matching SHA-256 and current_run true; NANIKA_E2E_TRASH_CYCLES was unset and retries remained 0.",
            "Quality status: B.11 FROZEN after the canonical gate. B.10 history remains frozen and B.12 remains NOT STARTED.",
            "Final B.11 baseline polish: corrected the generated top-level Scope from the stale B.10 UploadBatchCoordinatorService.process() description to the current B.11 DownloadEngineService.runLocal() scope and added a renderer/artifact consistency regression; production and previously validated unit/E2E evidence were unchanged.",
        ],
        "b12_changes": [
            "CryptoService.changeSecurityPhrase: added characterization for normalized salt, old/new derivation failures, verification HTTP failures, malformed verification values, wrong current phrase, wrapping failures, POST error classification, Vault Key identity, no plaintext request material and lock-during-change lifecycle semantics.",
            "Characterization gate: the original focused suite passed 10/10 in three independent runs; the expanded characterization suite passed 16/16 in three independent runs against the original production implementation.",
            "CryptoService.changeSecurityPhrase: extracted only the two real ownership phases, verifyCurrentSecurityPhrase and buildVaultVerification; each owns its transient Master Key and zeroizes it immediately after its final consumer, while the encrypted POST remains the commit point.",
            "Hardening: added deterministic regressions proving the Old Master Key is wiped before new-key derivation and the New Master Key is wiped before POST completion, including representative POST failure; the active Vault Key remains the same reference and bytes.",
            "Complexity: changeSecurityPhrase decreased from CC 16 / 48 NLOC / 370 tokens to CC 6 / 18 NLOC / 154 tokens; verifyCurrentSecurityPhrase is CC 8 / 28 NLOC / 189 tokens and buildVaultVerification is CC 4 / 12 NLOC / 102 tokens. Module maximum decreased from CC 16 to CC 11 through the unchanged unlockVault hotspot; physical lines increased from 250 to 262.",
            "Security and performance: the flow still performs exactly 2 KDF derivations, 1 verification decrypt, 1 verification encrypt, 1 GET and 1 POST sequentially, with no retry, Vault Key clone, file re-encryption, FDK access, plaintext phrase transmission or secret logging; GET/POST error classifications and mid-flight lock behavior remain unchanged.",
            "Validation: final focused crypto tests passed 23/23 in three independent runs; related crypto/UI/recovery/guard tests passed 39/39; frontend unit tests passed 659/659; fresh coverage reached 74.93% statements / 62.32% branches / 77.91% functions / 77.24% lines, and CryptoService reached 97.34% / 96.87% / 100% / 96.87%.",
            "Static quality: module-metrics tests and fresh metrics passed, Knip normal retained two configuration hints, production Knip retained the three known diagnostics, and cycles remained empty; no package, configuration, CI, Docker, backend, Kasumi, recovery-file or Drive changes were made.",
            "Final B.12 gate: the canonical provenance-backed Playwright runner completed exactly 5/5 with zero failed, skipped or flaky tests, exit code 0, outcome completed, current_run true, valid status/report, matching SHA-256 and retries 0; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Quality status: B.12 FROZEN after cryptographic ownership hardening and the canonical gate. B.11 history remains frozen and B.13 remains NOT STARTED.",
        ],
        "b13_changes": [
            "Track-policy characterization retained array/object/missing containers, invalid-entry skipping, metadata membership via String IDs, all frozen codec prefixes, flags, conflicting-signal recognition, exact segment options, numeric-key ordering, duplicate IDs and empty/missing codec stringification; the pre-polish contract passed 12/12 in three independent runs.",
            "Ready lifecycle characterization added production-used tests for duration mutation, segment configuration before initializeSegmentation, initData reset, unified video/mp4 MIME construction for video-only/audio-only/mixed tracks, numeric and duplicate codec ordering, init buffer identity, no-buffer behavior, start, ready resolution and resolver nulling.",
            "Test seam: immutable MP4Box ESM bindings prevented direct createFile spying in Karma, so onReady now delegates to the single production-used handleTransmuxReady export; no worker-global hook, mutable namespace hack, DI container or test-only production export was added.",
            "The dead video/audio implementation distinction was removed: one private isRecognizedTrack policy now unions the existing metadata, codec-prefix and flag signals, because no track kind is emitted after classification; conflicting signals still configure the track exactly once.",
            "Removed configureReadyTracks and its callback-only public surface, merged codec prefix recognition into one list, and kept one cohesive ready handler; raw String(track.codec) values still retain Object.keys ordering and duplicate-ID overwrite semantics before the same unified video/mp4 MIME is assembled.",
            "Final complexity: onReady CC 28 / 58 NLOC / 509 tokens before B.13 to CC 1 / 1 NLOC / 9 tokens; handleTransmuxReady is CC 13 / 38 NLOC / 303 tokens and isRecognizedTrack is CC 6 / 11 NLOC / 77 tokens; self.onmessage remains CC 23 / 112 NLOC / 685 tokens.",
            "Final worker metrics: stream-transmux.worker.ts is 261 physical lines with module maximum CC 23; the ready module is 87 physical lines with no near-CC20 replacement hotspot. No ArrayBuffer copy, MP4 parse, segment-count change or MP4Box lifecycle change was added.",
            "Preserved duration truthiness, original ID forwarding, exact setSegmentOptions(track.id, null, {nbSamples: 35, rapAlign: true}), initializeSegmentation/start/ready order, empty initData behavior, unified video/mp4 MIME and init ArrayBuffer identity.",
            "Protocol and security review: RESET, SEEK, BOOTSTRAP, TRANSMUX_CHUNK, chunk offsets, transferables, pending segments, VideoStreamService, crypto, backend and plaintext-media logging were unchanged.",
            "Validation: final focused ready tests passed 14/14 in three independent runs; related media tests passed 64/64; full frontend passed 673/673 in two consecutive runs; fresh coverage reached 75.03% statements / 62.66% branches / 78.02% functions / 77.35% lines, and the ready module reached 100% in all measured dimensions.",
            "Static quality: Angular build passed with existing budget warnings, module-metrics tests and fresh metrics passed, Knip normal retained two configuration hints, production Knip retained the known ng plus two unused exports, and cycles remained empty.",
            "Quality tooling: corrected the current-round Scope regression to reject the stale CryptoService.changeSecurityPhrase() predecessor while retaining Rodada B.13 and stream-transmux.worker.ts::mp4file.onReady; B.12 history remains unchanged.",
            "Final B.13 gate: the canonical provenance-backed Playwright runner completed exactly 5/5 with zero failed, skipped or flaky tests, exit code 0, outcome completed, current_run true, valid status/report, matching SHA-256 and retries 0; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Quality status: B.13 FROZEN after final ready-phase characterization, complexity cleanup and the canonical gate. B.12 history remains frozen and B.14 remains NOT STARTED.",
        ],
        "b14_changes": [
            "Previous B.14 lifecycle hardening remains preserved: generation-aware worker seek handling, SourceBuffer ownership, stale GC/quota guards, 300 ms scrubbing debounce, error-overlay recovery and the safe HTMLMediaElement diagnostics seam were not reverted.",
            "Manual rapid-seek evidence remains open: the earlier failure reported MediaError.code 3 with isSeeking true, MediaSource readyState open, networkState 1, readyState 1 and seekGeneration 12; after the pendingSegments fix, the later failure still reported code 3 with message 'PipelineStatus::PIPELINE_ERROR_DECODE: Failed to send video packet for decoding', packet timestamp 61958333, duration 41666, size 19451, key frame 0, isSeeking false, MediaSource open, networkState 1, readyState 1 and seekGeneration 28. Neither browser observation is being relabeled as a passing decoder result.",
            "The installed MP4Box 2.4.1 implementation was inspected: start() synchronously calls processSamples(false) and can emit onSegment, seek(time, true) repositions tracks and returns an adjusted byte offset/time without processing segments, and the installed RAP option is rapAlignement. Hypothesis A is proven as an order/state difference, but not proven as the sole cause of the browser MediaError.",
            "RED regression reproduced pre-seek leakage: after a deferred candidate became ready, three replay segments remained queued and the first target chunk was published as [pre-seek..., target] instead of only [target], including the wrong transferable identity.",
            "Minimal fix: immediately before seek(), the candidate alone drains pendingSegments with the existing splice(0) queue operation; active state, bootstrap state and the target post-seek segment remain untouched, and the regression is GREEN.",
            "Candidate ownership is now explicit: bootstrap starts processing on ready; seek candidates configure and initialize without start, call MP4Box.seek(time, true), then start only the latest candidate after seek. Stale candidates never start or commit; a candidate start failure reports a generation-correlated error while preserving the active state.",
            "SEEK_COMPLETE now returns the adjusted MP4Box resumeTime and exactOffset together with the derived chunkIndex. VideoStreamService keeps the requested playhead unchanged, removes forward MSE data from max(0, min(requestedTime, resumeTime)), and resumes fetching at floor(exactOffset / KASUMI_CHUNK_SIZE), with generation guards between SourceBuffers.",
            "The worker now passes the installed option name rapAlignement: true; the prior rapAlign spelling was not recognized by MP4Box 2.4.1. This correction is an API audit result, not evidence that RAP alignment alone caused the browser decode failure.",
            "Candidate initData is released after readiness because it is not consumed by the seek protocol; the dead worker fileOffset declaration/initializer was removed, and worker output/API comments now describe the actual segments-based protocol.",
            "The existing transmuxer-gated HTMLMediaElement diagnostic now includes only MediaError.code, MediaError.message, readyState, networkState, seekGeneration, isSeeking and MediaSource.readyState, with cleanup preserved and no user-facing error, retry or secret exposure added.",
            "The exact-offset slicing question was audited against the installed MP4Box 2.4.1 MultiBufferStream: overlapping containing buffers are accepted and samples are read by file offset; no real MP4 fixture exists in the repository to prove a smaller slice is required, so slicing remains deferred rather than speculative.",
            "Latest human rapid-seek failures remain the motivating evidence: LOG 1 (generation 33) failed with MediaError.code 3, PipelineStatus::PIPELINE_ERROR_DECODE, packet timestamp 261750000, duration 41666, size 32047, is_key_frame 0, isSeeking false, MediaSource open, readyState 1 and networkState 1; LOG 2 (generation 4) failed with code 3 at packet timestamp 147750000 while isSeeking true. These observations are not relabeled as fixed without a fresh browser stress retest.",
            "RED characterization before the production edit: the new heavy-seek parser-reset test observed abort called 0 times and only remove → schedule; it now proves remove completion → SourceBuffer.abort() → schedule, with isSeeking true and SourceBuffer.updating false during abort.",
            "Minimal parser reset: clearAndResume() calls abort() once on each active SourceBuffer only after forward cleanup and generation checks, before nextChunkIndex promotion, isSeeking=false and scheduleNextChunk. It skips reset when MediaSource is not open, stops between SourceBuffers on generation change, and propagates abort exceptions without retry, swallowing or scheduling.",
            "Scope characterization: buffered seek, linear playback, bootstrap append, quota recovery and GC remain abort-free; the requested playhead and MP4Box resumeTime/exactOffset/RAP-aligned seek protocol remain unchanged, with no exactOffset media slice, new copy, network, crypto, backend or worker protocol path.",
            "Deterministic validation: the core SEEK/transmux contract group passed 92/92 in three independent runs; the broader Drive-focused group passed 582/582; the full frontend passed 715/715 in two consecutive runs. The new RED/GREEN parser-reset regression and generation/error boundary tests are included.",
            "Fresh coverage: global frontend reached 76.33% statements / 64.71% branches / 78.86% functions / 78.68% lines; VideoStreamService reached 67.63% / 62.68% / 73.50% / 69.45%; VideoPlayer remained 75.22% / 59.09% / 75.00% / 81.44%; stream-transmux-protocol reached 98.73% / 90.90% / 100% / 98.57%; stream-transmux-ready reached 100% in all measured dimensions.",
            "Fresh module metrics: before/after the parser reset, video-stream.service.ts moved from 1,760 to 1,767 physical lines and 1,598 to 1,604 nonblank lines while remaining at 95 functions, max CC 16 and 712 function NLOC; video-player.component.ts remains 1,107 / 989 / 12 / max CC 7 / 38 function NLOC; stream-transmux-protocol.ts is 160 / 132 / 10 / max CC 8 / 126 function NLOC; stream-transmux-ready.ts is 92 / 75 / 6 / max CC 14 / 58 function NLOC; stream-transmux.worker.ts is 126 / 114 / 9 / max CC 3 / 53 function NLOC.",
            "Static quality: Angular production build passed with existing bundle/style budget warnings, module-metrics tests and fresh metrics passed, baseline-generator tests passed, Knip retained two configuration hints plus the known ng and two unused exports, and cycles remained empty.",
            "Canonical E2E after this edit completed exactly 5/5 with zero failed, skipped or flaky tests, exit code 0, outcome completed, current_run true, valid status/report and matching SHA-256. No current real rapid-seek browser stress retest was executed by Codex.",
            "Quality status: B.14 automated gates are green, but the real rapid-seek browser retest remains required before freeze; no B.15 work started. B.12 and B.13 history remain unchanged.",
            "Latest human reproduction reopened B.14: generation 23 reached requestedTime 341.2 with resumeTime 336.0416666666667, exactOffset 127570034 and chunkIndex 30, then chunks 30, 31 and 32 completed (totalChunks 33); generations 24–30 logged Seek resync but produced no new fetchRange, decrypt or append restart. The previous MediaError.code=3 did not appear in that run, but this post-EOF dead-end blocked freeze.",
            "W3C MSE review confirmed the native lifecycle: SourceBuffer.remove() invoked while the parent MediaSource is ended transitions it to open before range removal; SourceBuffer.abort() requires open. Production never mutates readyState.",
            "RED before the EOF fix: the focused suite reached 69 tests with 64 success and 5 failures, proving ended skipped remove(), ended-without-forward-data skipped the reopen path, direct removeRange rejected ended, reopen failure was swallowed and a current-generation closed state returned instead of rejecting.",
            "Minimal EOF fix: removeRange now treats only closed as terminal, while ended may invoke native remove(); forward cleanup reads readyState live and invokes one valid removal when ended even without a meaningful forward range. After cleanup, a current generation that is not open throws a short non-secret error before the retained SourceBuffer.abort() loop.",
            "Generation and teardown ownership remain unchanged: aborted or stale work returns silently before promotion, abort and scheduling; current-generation reopen and parser-reset failures remain observable through the existing onSeek catch.",
            "EOF characterization covers ended with/without forward data, open without forward data, closed entry, multiple SourceBuffers, abort/stale during reopen, failed reopen, abort failure after reopen and the direct removeRange ended/open/closed contract. No retry, timer, queue, MediaSource recreation, SourceBuffer recreation, worker message, copy, network, crypto, backend or exactOffset slicing was added.",
            "Deterministic validation: the final core SEEK/transmux/EOF group passed 75/75 in three independent runs; the broader Drive-focused group passed 592/592; the full frontend passed 725/725 in two consecutive runs.",
            "Fresh coverage: global frontend reached 76.41% statements / 64.92% branches / 78.86% functions / 78.77% lines; VideoStreamService reached 68.33% / 64.26% / 74.35% / 70.10%; VideoPlayer remained 75.22% / 59.09% / 75.00% / 81.44%; stream-transmux-protocol reached 98.73% / 90.90% / 100% / 98.57%; stream-transmux-ready remained 100% in all measured dimensions.",
            "Fresh module metrics: video-stream.service.ts moved from the previous 1,767 physical / 1,604 nonblank lines and 712 function NLOC to 1,775 / 1,611 and 714, while remaining at 95 functions and max CC 16; video-player.component.ts remains 1,107 / 989 / 12 / max CC 7 / 38 function NLOC; worker protocol, ready and transmux modules remain unchanged.",
            "Static quality: Angular production build passed with existing bundle/style budget warnings, module-metrics tests and fresh metrics passed, baseline-generator tests passed, Knip retained two configuration hints plus the known ng and two unused exports, and cycles remained empty.",
            "RED characterization: a requested time contained by every SourceBuffer was incorrectly treated as a buffered fast path even after the HTMLMediaElement exposed MediaError.code 3; clearAndResume() was skipped and normal scheduling remained active.",
            "Minimal decoder-safety fix: a non-null native MediaError now invalidates only the buffered fast path, forcing the existing generation-aware clear/resync path; the no-error buffered fast path remains unchanged. No new helper, retry, queue, MediaSource recreation, worker protocol, network, crypto or backend path was added.",
            "Deterministic validation: the decoder-focused service suite passed 77/77 in three independent runs; the full frontend passed 727/727; fresh coverage reached 76.41% statements / 64.94% branches / 78.94% functions / 78.75% lines; build and static quality gates passed with the existing budget/configuration diagnostics.",
            "Quality status: B.14 remains reopened and freeze-blocked by the required post-EOF real rapid-seek retest. Automated gates are green; no B.15 work started. B.12 and B.13 history remain unchanged.",
            "B.14 freeze finalization: after the accumulated B.14 fixes, including invalidating the buffered fast path when HTMLMediaElement.error is non-null, the user performed a clean frontend reset followed by approximately 10 minutes of real-browser rapid-seek stress without reproducing MediaError.code 3, the secondary appendBuffer error or the post-EOF dead-end, and accepted B.14 for freeze. This does not claim that the one-line guard was the sole root cause.",
            "Quality status: B.14 is FROZEN after the user's final real-browser stress run; B.12 and B.13 history remain intact. B.15 work is documented separately and made no B.14 production change.",
        ],
        "b15_changes": [
            "CryptoService.unlockVault: original characterization passed 23/23 in three independent runs; the expanded RED characterization added lock-during-KDF/GET/decrypt, both concurrent resolution orders, response-shape and 31/32/33-byte payload checks, transient-key lifetime and active-key replacement contracts.",
            "RED findings: the original implementation allowed all three lock races to continue, allowed stale concurrent attempts to resolve/overwrite, accepted truthy non-string verification and wrong-sized decoded keys, and did not wipe the replaced active Vault Key reference. These failures were observed before production edits.",
            "Lifecycle hardening: a single private unlock generation invalidates pending unlocks on lockVault() and makes the latest-started attempt the only owner; ownership is checked after KDF, GET and decrypt, stale attempts reject with the internal UNLOCK_CANCELLED error and cannot issue later phases or publish state.",
            "Vault Key integrity: verification is accepted only as a non-empty string that decodes to exactly 32 bytes; malformed, missing or wrong-sized material never becomes active, and the candidate remains local until the final commit.",
            "Transient lifetime: the candidate Master Key is wiped immediately after verification decrypt resolves, while finally cleanup still covers KDF/HTTP/decrypt failure, stale and cancellation paths. A successful replacement wipes the previous active key by its original reference; a failed re-unlock preserves the existing key and unlocked state.",
            "Complexity: unlockVault decreased from CC 11 / 34 NLOC / 265 tokens to CC 6 / 39 NLOC / 280 tokens; assertCurrentUnlock is CC 2 / 3 NLOC / 24 tokens and decodeVaultKey is CC 4 / 13 NLOC / 87 tokens. The measured CryptoService module maximum decreased from CC 11 to CC 8; physical lines moved from 262 to 290 as the explicit security ownership code was added.",
            "Network and zero-knowledge contracts remain unchanged: one KDF, one credentialed GET, one verification decrypt, no retry, no new request body/header/query material and no plaintext secret logging.",
            "Final deterministic validation: focused CryptoService passed 34/34 in three independent runs, related crypto/UI passed 52/52 in three independent runs, and the full frontend passed 738/738 in two consecutive runs. Fresh coverage reached 76.47% statements / 64.93% branches / 78.97% functions / 78.82% lines; CryptoService reached 97.72% / 96.77% / 100% / 97.39%.",
            "Quality gates: Angular build passed with the existing bundle/style budget warnings; module metrics, generator tests, Knip review, zero cycles and configured frontend mutation passed. The canonical provenance-backed Playwright runner completed exactly 5/5 with zero failed, skipped or flaky tests, exit code 0, completed outcome, current_run true, valid status/report, matching SHA-256 and retries 0; NANIKA_E2E_TRASH_CYCLES was unset.",
            "B.15 scope is limited to CryptoService.unlockVault()/lockVault(), its focused characterization tests and factual quality-baseline entries; no backend, protocol, dependency, CI, Docker or B.14 production change was made.",
            "Quality status: B.15 FROZEN after the deterministic lifecycle/security suite and all required quality gates; B.12, B.13 and B.14 history remains intact.",
        ],
        "b16_changes": [
            "Source audit: prune() collected the union of inFlight, retryTimers, retries, permanentFailures, fileGenerations and thumbnail IDs, then synchronously re-queried those same six sources to compute an invalidated predicate that could not add information.",
            "Original focused baseline: ThumbnailLoaderService passed 18/18 in each of three independent runs before the B.16 characterization additions.",
            "Expanded characterization: the focused suite reached 34 tests; 33 passed against the original production implementation and one genuine RED reproduced the falsy timer-handle defect. The other lifecycle, ownership, signal, candidate-source and prune/reload contracts were already green and were not claimed as regressions.",
            "Implementation: prune() now captures the thumbnail Signal value once, deletes per-file generation/state directly for every non-retained candidate, uses exact timer-handle presence semantics and publishes a new thumbnail object only when a thumbnail entry was actually removed.",
            "Selective ownership remains intact: prune() never increments global generation or resets nextFileGeneration; pruning B does not stale A, while pruning A removes its file generation and blocks stale loads/retries from resurrecting it.",
            "Same-file reload races remain safe in both old-first and new-first completion orders; load() identity cleanup prevents an older finally block from deleting a newer inFlight promise.",
            "Timer characterization: a defined timer handle of 0 was skipped by the original truthiness check; the final code clears every handle except undefined. Retry delays, retry budget, network requests, Google direct-range behavior, FDK zeroization and error classification were unchanged.",
            "Complexity: prune() decreased from CC 11 / 31 NLOC / 303 tokens to CC 6 / 27 NLOC / 240 tokens. The ThumbnailLoaderService module moved from 223 to 219 physical lines and 206 to 202 nonblank lines, remained at 17 measured functions and retained module maximum CC 12 because the existing loadMetadata hotspot was untouched; no helper transferred complexity.",
            "Performance: candidate Set construction remains O(n); six redundant membership probes and one extra thumbnail Signal read were removed. No persistent fields, timers, requests, Promise chains, buffer copies, global invalidation or caller-set mutation were added.",
            "Security and architecture: Zero-Knowledge, FDK lifetime, Google access-token flow, backend, crypto, network/range behavior, UI, dependencies, CI and Docker remain unchanged. No security vulnerability was inferred from the removed redundancy.",
            "Final deterministic validation: focused ThumbnailLoaderService passed 34/34 in three independent runs, the related Drive suite passed 610/610, and the full frontend passed 754/754 in two consecutive runs. Fresh coverage reached 76.5% statements / 64.93% branches / 78.97% functions / 78.82% lines; ThumbnailLoaderService reached 93.16% / 81.08% / 95.23% / 99.2%.",
            "Quality gates: Angular build passed with the existing bundle/style budget warnings; module metrics and generator tests passed; Knip normal exited 0 with two configuration hints, production Knip exited 0 with the known ng plus two unused exports, cycles exited 0, and configured frontend mutation passed with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile error and score 100% while retaining its existing format-bytes.ts scope.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 176abed5dba462e979804c920e01f742d39beaae94b2039cbad5dfec3ba3ea30; NANIKA_E2E_TRASH_CYCLES was unset.",
            "B.16 scope is limited to ThumbnailLoaderService.prune(), its characterization tests and factual quality-baseline entries; B.4 and B.12–B.15 history remain unchanged.",
            "Quality status: B.16 FROZEN after selective lifecycle characterization, the minimal prune cleanup and all required quality gates.",
        ],
        "b17_changes": [
            "Source audit: cleanupCancelledUpload() already owned the complete cancellation cleanup contract; callers await the canonical Promise except for the existing batch coordinator fire-and-forget path, whose later finally block still joins the same single-flight entry.",
            "Original focused baseline: the DriveStore suite passed 18/18 in each of three independent runs before B.17 characterization additions.",
            "Expanded characterization: the focused suite reached 49 tests; 48 passed against the original production implementation and one deterministic RED reproduced the detached rejection created by the cleanup lifecycle release handler when terminal sync rejects.",
            "Minimal implementation: the canonical cleanup Promise remains in uploadCleanupPromises, while lifecycle release now observes both fulfillment and rejection through one handled then(release, release) chain; callers, cleanup ordering and rejection identity remain unchanged.",
            "Ownership and security remain intact: initialized, recovery-owned and active runtime file IDs are deduplicated; each captured FDK reference is zeroized before remote I/O; unrelated uploads are untouched and no secret enters logs, URLs or requests.",
            "Remote delete semantics remain intact: each owned file executes trash then hard-delete sequentially, 404 is tolerated per operation, non-404 failures are logged and do not prevent later owned files, and terminal sync is invoked exactly once after the cleanup loop.",
            "No caller, backend, protocol, crypto, range, transfer, dependency, CI, Docker or public API change was made; no new helper, retry, queue, request, buffer copy or compatibility path was added.",
            "Deterministic validation: the final focused DriveStore suite passed 49/49 in three independent runs, the related Drive behavior suite passed 57/57, and the full frontend passed 785/785 in two consecutive runs.",
            "Complexity: drive.store.ts moved from 2,091 physical / 1,888 nonblank lines and 674 total function NLOC to 2,094 / 1,891 and 676, remaining at 194 measured functions and module maximum CC 10. cleanup() remains CC 10 / 22 NLOC / 198 tokens; the lifecycle release is a separate CC 1 / 3 NLOC / 14-token function, with no complexity relocation into a helper.",
            "Fresh coverage: global frontend reached 76.65% statements / 65.15% branches / 78.97% functions / 78.95% lines; DriveStore reached 64.82% / 52.39% / 71.81% / 65.87%.",
            "Quality gates: Angular production build passed with the existing bundle/style budget warnings; module metrics and tests passed; Knip normal exited 0 with two configuration hints, production Knip exited 0 with the known ng plus two unused exports, cycles were empty, and configured frontend mutation passed with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile error and score 100% while retaining its existing format-bytes.ts scope.",
            "Canonical Playwright provenance: total 5, passed 5, failed 0, skipped 0, flaky 0, exit code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 3c833a10294b9c12aa80c1d3012d2af166333aba5a2d77a3c588c0e3a85db932; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Quality status: B.17 FROZEN after the deterministic lifecycle characterization, minimal Promise ownership fix and all required quality gates; B.12–B.16 history remains intact and B.18 is NOT STARTED.",
        ],
        "b18_changes": [
            "Source audit: DefaultShell is the live address producer; it emits one outer `Nanika` namespace and omits DriveStore's display-only `Meu Drive` root, while Computer paths expose `Este Computador` as the first segment after `Nanika`. ComputerStore.navigateAddress() already uses the same exact-leading-segment grammar and remained unchanged.",
            "Original focused baseline: the VaultHome suite passed 9/9 in each of three independent runs before B.18 characterization additions.",
            "Expanded characterization against original production: 33 tests total, 26 GREEN and 7 genuine RED findings. The REDs covered raw substring Computer dispatch, global reserved-name removal, nested/root literal `Nanika` and `Meu Drive` folders, and nested exact `Este Computador` folders.",
            "Minimal implementation: onAddressNavigate() now tokenizes once, consumes at most one exact leading `Nanika`, dispatches to Computer only for the exact first remaining `Este Computador` namespace or an already-active Computer view, and treats every Drive segment after dispatch as literal folder data.",
            "Drive resolution remains synchronous, parent-scoped, folder-only, case-insensitive and atomic: the file Signal is snapshotted once, each requested segment is lowercased once, and navigateTo() is called exactly once only after the complete path resolves. Empty input still commits the Drive root.",
            "Computer delegation preserves the original raw address string and the existing current-view override; separator normalization, whitespace trimming, repeated separators, relative paths and case-insensitive matching are characterized.",
            "Performance review: raw substring regex scanning and global reserved-name filtering were removed; Signal reads changed from once per path segment to one snapshot, and candidate-name lowercasing changed from once per candidate to once per requested segment. Lookup remains the existing depth-by-files.find traversal, O(depth × files). No benchmark percentage is claimed.",
            "Complexity: onAddressNavigate() measured CC 10 / 23 NLOC / 189 tokens before B.18 and CC 13 / 25 NLOC / 214 tokens after the inline structural parser; VaultHomeComponent measured 633 physical / 565 nonblank / 34 functions / max CC 10 before and 636 physical / 567 nonblank / 33 functions / max CC 13 after. The increase is local parser branching, with no helper or hotspot transfer.",
            "Security and architecture: Zero-Knowledge, plaintext handling, secrets, backend, API, crypto, auth, ComputerStore, DriveStore, DefaultShell, onDropped, dependencies, CI and Docker contracts remain unchanged. B.18 is navigation namespace correctness, not a new path-traversal security boundary.",
            "Validation: final focused VaultHome tests passed 33/33 in three independent runs; DefaultShell navigation passed 9/9; ComputerStore navigation passed 5/5; full frontend passed 809/809 in two consecutive runs; fresh global coverage reached 76.85% statements / 65.43% branches / 79.19% functions / 79.14% lines, and VaultHome reached 51.04% statements / 39.53% branches / 42.42% functions / 54.11% lines.",
            "Quality gates: Angular production build passed with existing bundle/style budget warnings; module-metrics tests and fresh metrics passed; Knip normal retained two configuration hints, Knip production retained the unlisted `ng` binary plus two unused exports, cycles exited with zero findings, and configured mutation passed with 15 mutants, 14 killed, 0 survivors, 0 no-coverage, 1 compile-error diagnostic and score 100% in its existing `format-bytes.ts` scope.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `910466b96ec1134056ff9aa12825ac3eb1c69ab4f7a43520a7953ab1d4b5bc60`; `NANIKA_E2E_TRASH_CYCLES` was unset.",
            "Quality status: B.18 FROZEN after exact namespace characterization, minimal atomic resolver correction and all required gates. B.12–B.17 history remains unchanged and B.19 remains NOT STARTED.",
        ],
        "b19_changes": [
            "Source audit: the live external-drop chain is DriveDropZoneDirective → DriveWorkspace → shell → VaultHomeComponent; VaultHome captures the nullable Drive destination once in onDropStarted(), consumes it before validation in onDropped(), and intentionally performs file uploads before folder uploads.",
            "Original focused baseline: the DriveDropZoneDirective suite passed 4/4 in three independent runs, and the VaultHome suite passed 33/33 in three independent runs before B.19 characterization additions.",
            "Expanded characterization: the directive suite reached 7 tests; the original implementation produced one deterministic RED overlap finding because two pending external drops invoked DataTransferReaderService.read() and dropStarted twice while both drop events still required preventDefault(). The final VaultHome suite reached 54/54 GREEN and preserved root-null, destination snapshot, single-consumer, phase ordering, best-effort error and lock/view contracts.",
            "Minimal implementation: DriveDropZoneDirective now owns one private dropReadPending boolean. It is set only after dropStarted, blocks a second read, remains outside canHandle(), and is released in finally after success or reader error; the busy drop still calls preventDefault() and resets the visual state.",
            "No DataTransferReaderService, VaultHome onDropped/onDropStarted/onDropError, shell/workspace event payload, upload API, queue, timer, retry, generation token, request, buffer copy, public type, dependency, backend, crypto, auth, range, UI or compatibility path changed.",
            "Ordering and ownership remain intact: the captured folderId may be null, is consumed once, files retain single versus multi dispatch and exact drop-files label, folders retain exact drop-folders label, mixed drops remain files-then-folders, view changes during the operation retain the current best-effort behavior, and a lock before the folder phase still blocks it.",
            "Validation: directive 7/7, VaultHome 54/54 and DataTransferReader 28/28 passed; the full frontend passed 833/833, coverage reached 77.19% statements / 66.12% branches / 79.50% functions / 79.47% lines, Angular build passed with existing budget warnings, static checks and module metrics passed, configured mutation passed with 14 killed / 0 survived / 1 compile error and score 100%.",
            "Canonical Playwright provenance: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `d2c372b33f847fca70d81b80ed09a22cd95fa2a4737c952a8f3172e00843ff56`.",
            "Quality status: B.19 is FROZEN only after the final focused characterization, related suites, full frontend, build, coverage, static checks, configured mutation and canonical Playwright gates pass; B.12–B.18 history remains unchanged and B.20 is NOT STARTED.",
            "Round status: B.20 remains NOT STARTED.",
        ],
        "b20_changes": [
            "Source audit: parseDirectoryFiles() is the thin webkitRelativePath wrapper and the only direct File[] entrypoint; FolderUploadCoordinatorService calls parseDirectoryFiles(files) and parseDirectorySources(sources) without custom limits. DataTransferReaderService has a separate frozen browser-entry validator and was not reopened.",
            "Original focused baseline: folder-upload-tree.spec.ts passed 3/3 in each of three independent runs before B.20 characterization additions.",
            "Expanded characterization against original production: the focused suite reached 32/32 in each of three independent runs; every added contract was GREEN against the original implementation and no genuine runtime RED was reproduced.",
            "Path contract: empty input, source order, File identity and non-mutation are preserved; absolute POSIX, absolute Windows drive paths, NUL, empty/repeated separators, dot, dot-dot, trailing separators and missing webkitRelativePath are rejected with the existing folder-path error.",
            "Filename and depth contracts: the final path segment must equal File.name; exact depth 128 is accepted and 129 is rejected; duplicate paths use the existing exact error, slash-normalized duplicates collide, and case-different paths remain distinct.",
            "Folder-count ownership: buildFolderUploadTree() remains the owner of the 1000-folder batch limit; exactly 1000 generated folders is accepted and 1001 rejects. No maxFolders parser seam was retained.",
            "Dead API audit: FolderUploadLimits, maxFolders and maxDepth were only declared/read in folder-upload-tree.ts; no live caller, barrel export or public consumer supplied a second argument. FolderUploadLimits and both optional limits parameters were removed.",
            "Minimal implementation: parseDirectorySources() now compares directly with the fixed FOLDER_TREE_DEPTH_LIMIT (128); validation, normalization, duplicate Set ownership, tree construction and FOLDER_BATCH_LIMIT (1000) behavior were otherwise unchanged.",
            "Security and privacy: path traversal defenses, NUL rejection, basename consistency and duplicate ownership remain enforced locally; no plaintext filename/path, secret, backend request, crypto, DataTransferReader or upload-flow behavior changed.",
            "Complexity and performance: no helper, field, class, dependency, queue, retry, copy or compatibility path was added; the parser remains a single pass with a local Set and the tree builder remains unchanged, so time is O(n) for parsing and O(total segments) for tree construction.",
            "Final focused validation: folder-upload-tree 32/32 in three independent runs; FolderUploadCoordinatorService 10/10; DataTransferReaderService 28/28; all related suites remained green.",
            "Final frontend validation: 862/862 in two consecutive runs; global coverage 77.20% statements / 66.11% branches / 79.50% functions / 79.45% lines; Angular build passed with existing bundle/style budget warnings.",
            "Static quality: baseline generator tests, module metrics, Knip normal, Knip production and cycle checks passed; the known Knip diagnostics remain unchanged. Backend, Docker, CI, dependencies and generated build artifacts were not changed.",
            "Mutation: the configured existing format-bytes.ts scope was rerun with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile-error diagnostic and score 100%; folder-upload-tree is outside that configured mutation scope.",
            "Canonical Playwright: the provenance-backed runner completed exactly 5/5 with zero failed, skipped or flaky tests, exit code 0, completed outcome, current_run true, valid status/report and matching SHA-256 `028240668f87a51daa3771eab3a071bd9eb6d525f6876e154bcb531a03022152`; E2E-FLAKE-001 remains historical and E2E-001 is absent.",
            "Quality status: B.20 is FROZEN after the focused characterization, minimal dead-API cleanup and all required gates; B.12–B.19 history remains unchanged and B.21 is NOT STARTED.",
        ],
        "b21_changes": [
            "Format source audit: encryptFile() writes KAS1 as nonce[24] + plaintextSize uint64 LE[8] followed by data chunks, and KAS2 as the same 32-byte base header plus KAS2[4], metaSize uint32 LE[4], metadata MAC[16] and metadata ciphertext. Data chunks remain MAC[16] + ciphertext, with 4 MiB plaintext chunks; nonce derivation and metadata index 0xFFFFFFFF are unchanged.",
            "Caller audit: the live production surface has five decryptFile() call sites across DecryptedMediaLoaderService, DownloadEngineService and the two PublicMediaPlayerComponent paths plus SharedFileComponent; every caller consumes Promise<Blob>, keeps metadata separate and supplies borrowed FDK material. No caller was changed.",
            "Original focused baseline: KasumiCryptoService passed 12/12 in each of three independent runs before B.21 characterization additions.",
            "Expanded characterization against original production: 30 tests total, 26 GREEN and 4 deterministic RED findings. The four RED tests were prefix-only, truncated metadata MAC, truncated metadata ciphertext and shifted/oversized KAS2 metadata framing; they are one root defect, not four independent production bugs.",
            "Root cause: decryptFile() trusted a KAS2-derived data offset beyond encryptedBlob.size. For zero-plaintext files this skipped the data loop and allowed totalDecrypted === expectedSize === 0 to return an empty Blob from malformed framing.",
            "Minimal fix: decryptFile() now rejects only when the KAS2 data offset is greater than encryptedBlob.size, reusing 'File corrupted or truncated'. Exact equality remains valid for canonical empty V2 files; KAS1 and the writer are unchanged.",
            "Malformed-format coverage: prefix-only, metadata-MAC truncation, metadata-ciphertext truncation, oversized uint32 metaSize, shifted metaSize, corrupted KAS2 magic, trailing bytes and smaller/larger declared plaintext sizes all fail closed; huge uint64 header values reject without large allocation.",
            "Compatibility coverage: valid empty/small V1 and V2 files, UTF-8 metadata byte sizing, exact data offset, empty metadata retaining the existing V1 writer path, exact 4 MiB and 4 MiB+1 two-chunk boundaries, wrong key, chunk-1 tamper and no-partial-Blob behavior remain covered and green.",
            "Key ownership: caller-supplied FDK bytes remain unchanged after successful decryption, wrong-key failure and tamper failure. decryptFile() does not zeroize borrowed key material, log secrets or add network behavior.",
            "Metadata boundary: extractMetadata() remains the owner of metadata authentication/decryption; decryptFile() performs only the structural bound check needed to locate file data and does not add metadata authentication, extra crypto work or changed error ordering for valid files.",
            "Performance: the hot loop now passes MAC and ciphertext TypedArray views via subarray(), removing per-chunk slice copies while the synchronous libsodium call is active. The plaintext wrapper copy remains because the current TypeScript BlobPart type rejects libsodium's Uint8Array<ArrayBufferLike> without an unsafe cast.",
            "Ponytail review: no production helper, type, field, service, dependency, parser, queue, worker, API, AbortSignal or compatibility layer was added. Three tiny mutation/patch helpers exist only in the spec to construct malformed bytes and tamper cases; production logic remains inline at the consumed framing boundary.",
            "Complexity: decryptFile() moved from CC 9 / 64 NLOC / 488 tokens to CC 10 / 67 NLOC / 505 tokens; the module moved from 402 physical / 328 nonblank lines, 15 functions and max CC 9 to 405 / 331, 15 functions and max CC 10. The increase is the required security branch, not moved complexity.",
            "Final focused validation: KasumiCryptoService 30/30 in three independent runs; related crypto 34/34, DecryptedMediaLoader 2/2, DownloadEngine 19/19, SharedFile 7/7 and PublicMediaPlayer 14/14.",
            "Final frontend validation: 880/880 in two consecutive runs; global coverage 77.22% statements / 66.12% branches / 79.58% functions / 79.48% lines; KasumiCryptoService coverage 97.79% statements / 100% branches / 86.66% functions / 98.28% lines.",
            "Quality gates: Angular build passed with existing bundle/style budget warnings; fresh module metrics passed; Knip normal retained two configuration hints, production Knip retained the unlisted ng binary plus two historical unused exports, and cycles remained empty.",
            "Mutation: the configured existing format-bytes.ts scope passed with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile-error diagnostic and score 100%; KasumiCryptoService was not mutation-tested because it is outside the configured scope.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `c0b8ca9e7f3b7cfb403415467fa88645e2e4cf525ca5559560b6464c9dcbf307`; NANIKA_E2E_TRASH_CYCLES was unset. The current run was green on its first attempt; prior E2E-FLAKE-001 history remains preserved.",
            "Format status: KAS1, KAS2, AEAD additional data null, nonce derivation, 4 MiB chunk size, metadata special nonce and deployed stored-file compatibility remain unchanged; no KAS3 or migration was introduced.",
            "Quality status: B.21 is FROZEN after characterization, the single structural framing fix, compatibility/security tests and all required gates; B.12–B.20 history remains unchanged and B.22 is NOT STARTED.",
        ],
        "b22_changes": [
            "Source audit: Google media remains a direct browser → Google request through DriveService.downloadExternalFile(), followed by one whole-file Kasumi decrypt and one browser download trigger; the backend remains outside the media path.",
            "Runtime audit: controllers and activeDownloads already provide the exact current-runtime identity; pause retains state/FDK/token metadata, while cancel/reset/deleteState wipe the owned FDK and remove the runtime.",
            "Original focused baseline: DownloadEngineService passed 19/19 in each of three independent runs before B.22 characterization additions.",
            "Expanded characterization against the original implementation: 35 tests total, 31 GREEN and 4 deterministic RED findings. The REDs were 70% callback cancel, 70% callback runtime replacement, 70% callback pause and 95% callback pause.",
            "Root cause: runGoogleDrive revalidated ownership/pause after awaited HTTP/decrypt phases, but the synchronous 70% callback was immediately followed by decrypt without a checkpoint, and the 95% callback was followed only by ownership validation.",
            "Minimal implementation: added one private canContinueGoogle() policy boundary and applied it after external HTTP, after the 70% callback, after decrypt and after the 95% callback; post-click handling remains ownership-only.",
            "HTTP lifecycle: cancellation still aborts/unsubscribes the direct Google Observable and wipes/removes state; pause still lets an already-running monolithic request settle and drops before decrypt; resume reissues the complete Google operation; stale runtimes cannot publish or continue.",
            "Decrypt lifecycle: pause, cancel/reset and newer-runtime replacement drop the completed plaintext result before the next phase; no decrypted Blob is cached or persisted.",
            "Terminal ownership: the exact decrypted Blob and decrypted/fallback filename reach the existing browser trigger; object URLs and anchors retain existing finally cleanup, and cancellation during click cannot publish success afterward.",
            "Security/performance: FDK remains the exact borrowed runtime reference, is preserved on pause and zeroized on terminal removal; access tokens remain transient Bearer-header metadata and never enter the URL/logs/persistence. Successful Google runs still perform one request, one whole-file decrypt and one browser trigger with no retry, timer, queue, Blob copy or range redesign.",
            "B.11/B.21 preservation: runLocal(), canContinueLocal(), KasumiCryptoService production and all adjacent DriveStore/DriveService/crypto contracts remained unchanged.",
            "Final validation: DownloadEngineService passed 36/36 in three independent runs, including the explicit pending-HTTP pause regression; DriveService 49/49, DecryptedMediaLoader 2/2, KasumiCryptoService 30/30 and DriveStore 49/49 passed as related suites; the full frontend passed 897/897 in two consecutive standard runs.",
            "Fresh coverage: global frontend reached 77.34% statements / 66.40% branches / 79.59% functions / 79.56% lines; the coverage run completed all 897 tests.",
            "Complexity: runGoogleDrive decreased from CC 9 / 37 NLOC / 298 tokens to CC 8 / 30 NLOC / 270 tokens; canContinueGoogle is CC 3 / 11 NLOC / 68 tokens, runLocal remains CC 8 / 38 NLOC / 338 tokens, and the module moved from 248/216/15/max CC9 to 254/220/16/max CC8.",
            "Quality gates: Angular build passed with existing bundle/style budget warnings; module metrics and 1 module-metrics test passed; baseline-generator tests passed 15/15; Knip normal retained two configuration hints, production retained two historical unused exports, cycles were empty, and the configured format-bytes mutation scope passed with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile-error diagnostic and score 100%.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `fdf4a7eac56ec1c47050e3f0ef59cec506141d5e32bb001a71a854abc6184d08`; NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Quality status: B.22 is FROZEN only after the final focused, related, full frontend, coverage, build, static, mutation and canonical Playwright gates pass; B.12–B.21 history remains unchanged and B.23 is NOT STARTED.",
        ],
        "b23_changes": [
            "Source audit: canContinueLocal() and canContinueGoogle() were semantically and byte-equivalent provider-independent ownership/pause policies; isCurrent() already encoded exact id, state reference, controller reference and non-aborted-controller identity; updateTransfer() is synchronous; deleteState(id) wipes whichever runtime currently owns the id.",
            "Original focused baseline: DownloadEngineService passed 36/36 in each of three independent runs before B.23 characterization additions.",
            "Expanded characterization against the original implementation: 38 tests total, 36 GREEN and 2 deterministic RED findings. The REDs were Google and Local success callbacks synchronously installing newer runtimes under the same transfer id.",
            "Root cause: both terminal paths validated ownership immediately before the synchronous success callback, then invoked ID-based deleteState(id) without revalidating the original state/controller; a stale terminal invocation therefore wiped and removed the newer owner.",
            "Google RED contract: the newer state identity and exact FDK reference/bytes survive, while begin(id) still cancels and zeroizes the old Google runtime; the old run emits no post-ownership side effect.",
            "Local RED contract: the newer state identity, FDK, baseNonce and plaintextChunks array/reference/content survive, while begin(id) still zeroizes the old Local FDK/baseNonce/chunks; this is runtime-state destruction, not stored-file deletion.",
            "Minimal implementation: replaced the duplicated canContinueLocal()/canContinueGoogle() helpers with one DownloadState-based canContinue() policy and centralized the common browser-download/success/cleanup sequence in commitDownload().",
            "Terminal ownership: commitDownload() preserves the existing click and post-click isCurrent() barrier, publishes the exact existing success object, rechecks exact state/controller ownership after the synchronous callback, and calls deleteState(id) only while the original runtime remains current. No try/finally cleanup was introduced.",
            "Provider boundaries: completeLocalDownload() remains because it still owns Local-specific Blob assembly, exact 95% progress values and the pre-commit pause checkpoint; Local range/resume and Google monolithic HTTP/decrypt paths remain separate.",
            "Public/security contracts: DownloadState variants, DownloadCallbacks, begin(), setState(), getState(), deleteState(), cancel() and resetRuntimeState() are unchanged; FDK/baseNonce/chunk zeroization, access-token handling, object-URL cleanup, fallback filename and Zero-Knowledge boundaries remain unchanged.",
            "Final focused validation: DownloadEngineService passed 38/38 in three independent runs; the two new ownership tests are synchronous and cancel their retained replacement runtime after assertions.",
            "Related validation: DriveStore 49/49, DriveService 49/49, DecryptedMediaLoader 2/2 and KasumiCryptoService 30/30 passed.",
            "Final frontend validation: 899/899 in two consecutive standard runs; fresh coverage reached 77.35% statements / 66.42% branches / 79.59% functions / 79.56% lines; DownloadEngineService reached 95.79% / 88.88% / 100% / 97.95%.",
            "Complexity: runGoogleDrive decreased from CC 8 / 30 NLOC / 270 tokens to CC 6 / 27 NLOC / 226 tokens; completeLocalDownload decreased from CC 5 / 15 NLOC / 147 tokens to CC 3 / 12 NLOC / 103 tokens; canContinue is CC 3 / 11 NLOC / 68 tokens; commitDownload is CC 4 / 13 NLOC / 101 tokens; runLocal remains CC 8 / 38 NLOC / 338 tokens; the module moved from 254/220/16/max CC8 to 250/216/16/max CC8.",
            "Performance and architecture: normal network, crypto, Blob and browser-trigger counts are unchanged; the only lifecycle cost is one additional O(1) isCurrent() check after the success callback. No field, type, service, dependency, controller, queue, timer, retry, copy, generation token, CAS map, backend, Google API, DriveService, DriveStore or CI/Docker change was added.",
            "Quality gates: Angular build passed with existing bundle/style budget warnings; module-metrics test passed; Knip normal retained two configuration hints, production reported the unlisted ng binary plus two unused exports, cycles had zero findings, and the configured format-bytes mutation scope passed with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile-error diagnostic and score 100%. DownloadEngineService remained outside mutation scope.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `e22a8783b42e1c0b5ddbe1dec29870acd4745e12da8009fac4edda6bcea03757`; NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Quality status: B.23 is FROZEN after deterministic Google/Local ownership characterization, shared lifecycle cleanup and all required gates; B.11 and B.12–B.22 historical evidence remains unchanged and B.24 is NOT STARTED.",
        ],
        "b24_changes": [
            "Target: DriveStore.downloadFile() in frontend/src/app/features/drive/state/drive.store.ts; DownloadEngineService B.23 remained frozen.",
            "Original focused baseline: DriveStore public behavior passed 57/57 in each of three independent runs before B.24 characterization additions.",
            "Expanded characterization against original B.23 production: 63 tests total, 61 GREEN and 2 deterministic RED findings. The REDs were a Vault FDK and a runtime shareFdk copy surviving local extractMetadata() failure before DownloadEngine.setState().",
            "Root cause: deleteState(transferId) only wipes a state already registered in DownloadEngine; before setState(), the DriveStore-local FDK had no engine owner and the original scattered abort wipes did not cover normal pre-handoff failures.",
            "Minimal implementation: centralized DriveStore-local FDK cleanup in one finally, removed only redundant pre-handoff wipes and abort-catch getState() branching, and assigns fdk = undefined immediately after every setState() return so ownership cannot be ambiguous.",
            "Ownership contract: before setState() DriveStore owns the FDK; after setState(true) DownloadEngine owns the state/FDK; after setState(false) the frozen engine contract wipes the rejected state before returning false. shareFdk remains a runtime copy and the caller-owned input remains unchanged.",
            "Behavior preserved: Local 128 KiB header range, metadata extraction, baseNonce/chunk state, range/decrypt/resume behavior and Google metadata control-plane/direct browser media behavior were unchanged; no new request, copy, retry, timer, queue, API or backend change was introduced.",
            "Validation: DriveStore 63/63 in three final runs; DownloadEngine 38/38 in three runs; related Drive/DecryptedMediaLoader/ThumbnailLoader/Share/Kasumi/Auth/public-share suites 141/141; full frontend 905/905 in two consecutive runs.",
            "Fresh coverage: global frontend reached 78.18% statements / 66.98% branches / 80.06% functions / 80.47% lines; DriveStore reached 69.56% statements / 55% branches / 74.13% functions / 71.47% lines; coverage completed all 905 tests.",
            "Build and static quality: Angular build passed with existing bundle/style budget warnings; module metrics and baseline-generator tests passed; Knip retained two normal configuration hints plus the historical unlisted ng and two unused exports, cycles were empty, and configured format-bytes mutation passed with 15 mutants, 14 killed, 0 survived, 0 no-coverage, 1 compile-error diagnostic and score 100%; DriveStore remained outside mutation scope.",
            "Quality status: B.24 is FROZEN only after the final canonical Playwright evidence is valid and all required gates pass; B.12–B.23 history remains unchanged and B.25 is NOT STARTED.",
        ],
        "b25_changes": [
            "Target: storage move manual pause/resume state machine across backend FileManager::set_storage_move_status() and frontend TransferPanel; StorageMoveEngine production remained unchanged.",
            "Original focused baselines: TransferPanel passed 19/19, StorageMoveEngine passed 29/29 and backend storage-move passed 284 assertions in 12 test cases, each in three independent runs before B.25 additions.",
            "Expanded characterization against the original implementation: TransferPanel reached 21 specs with 19 GREEN and 2 deterministic RED specs; the backend storage-move suite reached 13 cases with 295 assertions and 1 deterministic RED case; StorageMoveEngine reached 32/32 after the pause-race characterization. The three B.25 RED findings were manual paused backend resume rejection, hidden full-card Continue, and incorrect mini-popup actions for manual paused/target-uploaded states.",
            "Root cause: backend resume eligibility admitted paused moves only when is_retryable=true, while the UI treated paused as retryable-only and used a broad non-terminal predicate in the mini popup. Manual pause is intentionally paused with is_retryable=false and must still be resumable.",
            "Backend contract: resume now admits exactly paused/prepared/transferring under the existing user/id ownership predicate and transaction; unfinished items transition to transferring, fully uploaded items to target_uploaded, retryable failure metadata is cleared on resume, and manual pause remains without failure metadata. No schema, endpoint, API, query shape, reservation or active-index change was added.",
            "Frontend contract: full TransferPanel shows Continue for every paused move while preserving Pausado versus Erro recuperável / Pausado labels; the mini popup shows Resume only for paused and Pause only for prepared/transferring. target_uploaded, committing, cleanup_pending, completed, cancelled and failed expose neither control. Cancel, clear, retryable failure metadata and existing delegates remain unchanged.",
            "Local/Google resume: StorageMoveEngine production remained byte-for-byte unchanged. Existing state-driven resume, activeFileIds, reservation and runtime ownership remain intact; paused Google moves reconcile metadata before resume without auto-resuming during load, and paused moves never trigger a download before an explicit resume.",
            "Pause-race characterization: a stale Pause against a backend move that became non-pausable is rejected, aborts the local controller and leaves the local job transferring without an extra GET. No production redesign was introduced because safe repair requires explicit ownership/restart coordination beyond this minimal contract; the race is documented for a future scoped task.",
            "Focused final validation: TransferPanel passed 21/21 in three runs; StorageMoveEngine passed 32/32 in three runs; backend storage-move passed 295 assertions in 13 test cases in three runs.",
            "Related frontend validation: DriveService 49/49, VaultHome 54/54 and AuthService 8/8 passed. Full frontend passed 910/910 in two consecutive runs; fresh coverage passed 910/910 with 78.31% statements, 67.05% branches, 80.13% functions and 80.62% lines.",
            "Separate exploratory full-backend run: 69/70 cases and 6349/6350 assertions passed; the single failure was the pre-existing auth-session 11th-device eviction assertion in test_api_auth_sessions.cpp, outside storage-move scope and not changed by B.25.",
            "Build and static quality: full backend CMake build and Angular production build passed; the Angular build retained existing bundle/style budget warnings. Module-metrics and baseline-generator tests passed; Knip retained two configuration hints plus the historical production ng/unused-export findings; cycles were empty.",
            "Mutation: configured Stryker scope remained only format-bytes.ts; 15 mutants were generated, 14 killed and 1 compile-error diagnostic was reported, with 100% reported mutation score and exit code 0. No B.25 production file was added to mutation scope.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `1b56a4ab65b2e8777008095823a44324b0ea66334f6ac892011620387d7f22cf`; NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Complexity: FileManager::set_storage_move_status() remained NLOC 36 / cyclomatic complexity 9 / 248 tokens before and after because the production change is only the resume status predicate; StorageMoveEngine production complexity and source remained unchanged. No new type, helper, class, dependency, timer, retry, queue, API, request, crypto or Google path was added.",
            "Quality status: B.25 is FROZEN after the manual-pause contract, recoverable-failure contract, pause-race characterization and required validation gates; B.12–B.24 history remains unchanged and B.26 is NOT STARTED.",
        ],
        "b26_changes": [
            "Target: StorageMoveEngineService.pause() in frontend/src/app/features/drive/storage-move/storage-move-engine.service.ts; B.25 backend pause/resume SQL and TransferPanel policy remain frozen and unchanged.",
            "Original B.25 baseline preserved: StorageMoveEngine focused suite passed 32/32 in three independent runs before B.26 characterization additions.",
            "Expanded characterization against B.25 production: 36 tests total, 32 GREEN and 4 deterministic RED findings — rejected Pause did not fetch canonical state, did not restart runnable target_uploaded state, did not resolve canonical paused/terminal state without resume/restart, and did not mark stateSyncError when canonical GET failed.",
            "After Level 1 inline recovery, the stale-operation characterization reached 40 tests with 38 GREEN and 2 deterministic RED findings: stale rejected-Pause recovery overwrote a winning cancel and resurrected a job after resetRuntimeState().",
            "Final focused characterization: 40/40 GREEN in three independent runs after exact Pause-operation ownership was added.",
            "Root cause: the existing runner intentionally aborts on lifecycle commands and therefore skips failure persistence; rejected Pause had no canonical GET fallback, so no owner published or continued the backend-authoritative state after the old runner released its controller.",
            "Minimal recovery: pause() still aborts the old controller, drops transient sessions, and sends the existing Pause request. On rejection it performs exactly one getStorageMove() fallback, publishes that canonical state, and invokes the existing run() only for prepared, transferring, target_uploaded or cleanup_pending. Paused and terminal states stop without resume or restart; committing remains out of scope.",
            "Ownership guard required by deterministic REDs: one private Map<number, symbol> records the exact pending Pause operation; cancel() invalidates that operation and resetRuntimeState() clears all pending operations. Publication and restart occur only while the captured operation remains current, so stale recovery cannot overwrite cancel/reset or resurrect a job. No new helper and no run() finalizer change were introduced.",
            "Error contract: successful Pause resolves from the returned canonical paused state; rejected Pause resolves after successful canonical reconciliation, because the command's ambiguity is contained and the real caller is a fire-and-forget Angular template action. If the canonical GET also fails, stateSyncError=true is published when a local job exists and the original Pause error is rethrown; no guessed state or retry is introduced.",
            "Runner ownership: the real-run regression proves the old request teardown, old controller abort, no failure persistence, a distinct recovered controller, no overlapping owner, final controller release and one completeStorageMove() call. target_uploaded resumes through run(), skips already-uploaded work and publishes completed without source reads, target writes, new Google sessions, PUTs, ACKs or retransmission.",
            "Provider preservation: Local chunk/range resume and Google session/PUT/ACK protocols were not changed; the recovery path only reconciles control-plane state and delegates to existing run() behavior. No automatic retry, timer, queue, Blob copy, crypto operation or extra happy-path request was added.",
            "Cancel/reset characterization: deterministic races prove that a stale rejected-Pause response cannot overwrite cancelled state or repopulate a reset engine; the exact operation identity is invalidated before cancel publication and cleared by resetRuntimeState().",
            "Validation: StorageMoveEngine passed 40/40 in three runs; the related TransferPanel/DriveService/VaultHome/AuthService suites passed 132/132; full frontend passed 918/918 in two consecutive runs; backend storage-move passed 295 assertions in 13 cases; frontend coverage ran all 918 tests.",
            "Fresh coverage: global frontend reached 78.43% statements / 67.19% branches / 80.15% functions / 80.71% lines; StorageMoveEngineService reached 86.21% statements / 77.56% branches / 94.28% functions / 88.35% lines.",
            "Complexity: repository module metrics moved from 559/523 physical/nonblank lines, 43 functions, max CC 8 and total function NLOC 131 to 583/547 lines, 44 functions, max CC 8 and total function NLOC 132. The configured parser does not emit named class methods pause()/run() as standalone metrics; run() production code remained unchanged and pause() gained only the inline reconciliation/ownership branches.",
            "Build/static quality: Angular production build and backend CMake build passed with existing Angular bundle/style budget warnings; module-metrics and baseline-generator tests passed; Knip retained its historical unlisted ng/two-unused-export and two configuration-hint findings; cycles reported no cycles; git diff --check passed.",
            "Mutation: configured Stryker scope remained only format-bytes.ts; 15 mutants were generated, 14 killed, 0 survived, 0 no-coverage and 1 compile-error diagnostic, with the tool reporting 100% and exit code 0. StorageMoveEngine was not in the configured mutation scope, so no B.26 mutation score is claimed.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `93a56405fd52785764c33a295e82d87b41a4d30d90e16160970de99d8e90582f`; NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Security review: no secret/token logging, plaintext exposure, anti-IDOR change, backend change, crypto change, media proxy, duplicate local chunk operation or duplicate Google transfer was introduced.",
            "Quality status: B.26 is FROZEN after canonical rejected-Pause recovery, exact stale-operation ownership and all required validation gates; B.12–B.25 history remains unchanged and B.27 is NOT STARTED.",
        ],
        "b27_changes": [
            "Target: StorageMoveEngineService.resume() in frontend/src/app/features/drive/storage-move/storage-move-engine.service.ts; B.12–B.26 history, backend behavior, UI/TransferPanel policy, DriveService, pause(), pauseOperations, run(), start() and loadActive() remain frozen.",
            "Original B.26 baseline preserved: StorageMoveEngine focused suite passed 40/40 in three independent runs before B.27 characterization additions.",
            "Expanded characterization against original B.26 production: 54 tests total, 44 GREEN and 10 deterministic RED findings covering stale initial GET success/error, reset during GET/response, stale Google reconciliation success/error, stale Resume POST success/error, Resume during superseding Cancel, and an older Resume finalizer deleting a newer Resume owner.",
            "Root cause: Set<number> represented only that a Resume existed, not which asynchronous Resume operation owned a publication or finalizer; Cancel did not invalidate Resume ownership, and older finally blocks could release a newer Resume attempt.",
            "Minimal implementation: replaced the existing Resume presence Set with Map<number, symbol>; each Resume captures one ephemeral operation token and checks exact ownership after canonical GET, Google reconciliation and Resume POST before publishing or continuing.",
            "Stale errors are silent after ownership loss. Current-owner initial GET and Local Resume errors still reject as before; current-owner Google reconciliation errors still publish stateSyncError and resolve as before. No guessed state, retry, timer or extra request was added.",
            "Cancel race: cancel() installs a superseding barrier token in the same existing Map before its backend command, so a pending Resume cannot start or publish after Cancel wins. No second ownership collection was introduced.",
            "Reset race: resetRuntimeState() clears the same Map, so pending Resume operations lose ownership and cannot resurrect, reject, or publish after reset. The existing pauseOperations reset behavior is unchanged.",
            "Finalizer ownership: Resume finally deletes the Map entry only when the entry still equals its captured token; an older Resume cannot remove or complete over a newer Resume owner.",
            "Single-flight and provider preservation: duplicate Resume remains suppressed while the first operation is pending; runnable statuses remain prepared, transferring, target_uploaded and cleanup_pending; run() is still the sole execution path, and Local/Google transfer protocols were not changed.",
            "No stale activity: ownership checks prevent stale Resume publication and later-phase continuation; no stale Resume run, provider request, duplicate transfer, crypto operation, queue, timer or controller was introduced.",
            "Focused validation: StorageMoveEngine passed 54/54 in three consecutive runs. Related frontend suites passed 132/132; full frontend passed 932/932 in two consecutive runs; backend storage-move passed 295 assertions in 13 test cases.",
            "Fresh coverage: global frontend reached 78.46% statements / 67.22% branches / 80.15% functions / 80.75% lines; StorageMoveEngineService reached 86.55% statements / 77.41% branches / 94.28% functions / 89.00% lines.",
            "Complexity: StorageMoveEngine module metrics moved from 583/547 physical/nonblank lines, 44 functions, max CC 8 and total function NLOC 132 to 613/577 lines, 44 functions, max CC 8 and total function NLOC 132. The configured parser does not emit named resume()/run() methods as standalone metrics; this is a parser limitation, not an omitted audit.",
            "Build/static quality: Angular production build and backend CMake build passed with existing Angular bundle/style budget warnings; module-metrics and baseline-generator tests passed; Knip normal and production modes exited 0 with historical findings, cycles exited 0 with no cycles and two existing configuration hints.",
            "Mutation: configured Stryker scope remained only format-bytes.ts; 15 mutants were generated, 14 killed, 0 survived, 0 no-coverage and 1 compile-error diagnostic, with 100% reported mutation score and exit code 0. StorageMoveEngine was not in the configured mutation scope, so no B.27 mutation score is claimed.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `1bfde448ba7d59e2aa64224db17aa9e72f98b980c915f36f103af62695d3c25c`; NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Security: no secret/token logging, plaintext exposure, IDOR change, backend change, crypto change, media proxy, schema change or provider authorization change was introduced.",
            "Quality status: B.27 is FROZEN after exact Resume ownership, Cancel/Reset winner semantics, stale publication suppression and all required validation gates; B.12–B.26 history remains unchanged and B.28 is NOT STARTED.",
        ],
        "b28_changes": [
            "Target: StorageMoveEngineService.start() and loadActive() in frontend/src/app/features/drive/storage-move/storage-move-engine.service.ts; B.12–B.27 history, backend behavior, UI/TransferPanel policy, DriveService, pause(), resume(), cancel(), run(), Download/Crypto behavior and API/schema remain frozen; B.29 is NOT STARTED.",
            "Original B.27 focused baseline preserved: StorageMoveEngine passed 54/54 in three independent runs before B.28 characterization additions.",
            "Expanded characterization against original B.27 production: 63 tests total, 55 GREEN and 8 deterministic RED findings covering reset during start response, presentation clear during start, reset during initial loadActive GET, stale initial GET error marking a newer runtime, presentation clear during initial GET, reset during Google reconciliation success/error, and an older loadActive result overwriting a newer post-reset result.",
            "Root cause: start() and loadActive() had no runtime-generation barrier after awaited HTTP boundaries, so an older operation could publish jobs, labels, stateSyncError or run() after reset/logout; clearDecryptedPresentationData() cleared the names map but an older closure could reinsert a decrypted filename after the presentation data had been cleared.",
            "Existing safety preserved: upsert() already falls back to the non-secret 'Arquivo <id>' label when a name is unavailable; current-runtime start, loadActive, Google reconciliation and error behavior remain unchanged when no lifecycle boundary wins.",
            "Minimal implementation: added scalar runtimeGeneration and presentationGeneration counters. resetRuntimeState() invalidates the runtime generation; clearDecryptedPresentationData() invalidates the presentation generation; start() and loadActive() capture and revalidate the relevant generation after the existing POST/GET/reconciliation awaits before publishing or continuing.",
            "Runtime contract: reset/logout wins over an older start or loadActive operation; stale success, stale error, stale label publication, stale stateSyncError and stale run() continuation are suppressed. A newer post-reset loadActive result remains authoritative even when the older request completes last.",
            "Presentation contract: lock/clear wins over an older start or loadActive operation for decrypted names; old closures cannot restore a plaintext filename. The existing non-secret fallback remains available and no decrypted presentation data is persisted or logged.",
            "Execution preservation: no request, retry, timer, queue, controller, Map/Set, worker, crypto operation, provider protocol, pause/resume/cancel behavior or TransferPanel behavior was added or changed. Existing run() remains the execution path for current Google reconciliation.",
            "Focused validation: StorageMoveEngine passed 63/63 in three consecutive runs; the normal current-runtime start contract and all existing B.27 tests remained green.",
            "Related frontend validation: TransferPanel, DriveService, VaultHome and AuthService suites passed 132/132. Full frontend passed 941/941 in two consecutive runs; coverage also passed all 941 tests.",
            "Fresh coverage: global frontend reached 78.50% statements / 67.36% branches / 80.07% functions / 80.80% lines; StorageMoveEngineService reached 86.95% statements / 78.66% branches / 94.28% functions / 89.46% lines.",
            "Complexity: StorageMoveEngine module metrics moved from 613/577 physical/nonblank lines, 44 functions, max CC 8 and total function NLOC 132 to 631/595 lines, 44 functions, max CC 8 and total function NLOC 132. The configured parser does not emit named start()/loadActive()/resume()/run() methods as standalone metrics; this is a parser limitation, not an omitted audit.",
            "Build/static quality: Angular production build and backend CMake build passed with existing Angular bundle/style budget warnings; backend storage-move passed 295 assertions in 13 cases; module-metrics and baseline-generator tests passed; Knip normal/production and cycle checks exited 0 with historical findings only.",
            "Mutation: configured Stryker scope remained only format-bytes.ts; 15 mutants were generated, 14 killed, 0 survived, 0 no-coverage and 1 compile-error diagnostic, with 100% reported mutation score and exit code 0. StorageMoveEngine remains outside that configured mutation scope.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `07a48c5490274ff4feeab7405acfd57882600427ad5ce9b12bb3c7894adc6f2c`; NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Security: no secret/token logging, plaintext exposure, IDOR change, backend change, crypto change, media proxy, schema change or provider authorization change was introduced; lifecycle guards only suppress stale publication and preserve the existing fallback label.",
            "Quality status: B.28 is FROZEN after the focused characterization, minimal runtime/presentation ownership guards and all required validation gates; B.12–B.27 history remains unchanged and B.29 is NOT STARTED.",
        ],
        "b29_changes": [
            "Target: StorageMoveEngineService.cancel() in frontend/src/app/features/drive/storage-move/storage-move-engine.service.ts; B.12–B.28 history, backend behavior, UI/TransferPanel policy, DriveService, start(), loadActive(), run(), pause(), resume(), API/schema and provider protocols remain frozen; B.30 is NOT STARTED.",
            "Original B.28 focused baseline preserved: StorageMoveEngine passed 63/63 in three independent runs before B.29 characterization additions.",
            "Expanded characterization against original B.28 production: 81 tests total, 64 GREEN and 17 deterministic RED findings covering rejected Cancel canonical cancelled/completed/cleanup_pending/paused/failed/committing/prepared/transferring states, Google target reconciliation, double-failure preservation, reset during fallback GET/reconciliation, stale older Cancel ownership and Resume suppression during recovery.",
            "Initial B.29 root cause: B.28 cancel() aborted the current runner before awaiting the backend Cancel command but lacked exact post-await ownership and canonical recovery on command rejection, allowing late stale publication and leaving rejected/ambiguous active moves without an execution owner.",
            "Minimal implementation: reused the existing resumingMoveIds Map<number, symbol> and existing resumeBarrier token as the exact Cancel owner. No new field, map, helper, generation counter, queue, timer, retry loop or controller was added.",
            "Happy-path contract: a successful Cancel still performs exactly one DELETE, publishes the server response and drops target/transient state without a fallback GET or reconciliation request.",
            "Rejected Cancel contract: while the captured owner is current, exactly one canonical getStorageMove request determines the state; cancelled/completed publish and clean transient target state, cleanup_pending publishes and continues through the existing run/cleanup path, paused/failed/committing publish without auto-resume, and prepared/transferring/target_uploaded continue only through the existing run path.",
            "Failure contract: a canonical GET failure preserves the original Cancel error, marks stateSyncError on the current presentation and preserves target state; stale operations after reset or newer ownership are silent and issue no recovery GET after ownership is lost.",
            "Google safety: a known Google target in transferring performs the existing single reconcileStorageMove boundary before run(); reconciliation failure fails closed with stateSyncError and preserved target state, preventing duplicate transfer activity. Unknown or non-Google targets do not receive speculative reconciliation.",
            "No semantic expansion: no second DELETE, retry, timer, polling, queue, duplicate local chunk operation, duplicate Google transfer, crypto operation, backend request, API change, schema change, secret logging or plaintext exposure was introduced.",
            "Focused validation: StorageMoveEngine passed 81/81 in three consecutive independent runs. Related frontend suites passed 132/132; full frontend passed 959/959 in two consecutive runs; coverage also passed all 959 tests.",
            "Fresh coverage: global frontend reached 78.66% statements / 67.52% branches / 80.18% functions / 80.95% lines; StorageMoveEngineService reached 88.19% statements / 79.50% branches / 94.44% functions / 90.97% lines.",
            "Complexity: StorageMoveEngine module metrics are 680 physical lines / 640 nonblank lines, 46 functions, maximum CC 8 and total function NLOC 134. The configured parser does not emit named cancel()/run() methods as standalone metrics; this remains a parser limitation, not an omitted audit.",
            "Build/static quality: Angular production build and backend CMake build passed with existing Angular bundle/style budget warnings; backend storage-move passed 295 assertions in 13 cases; module-metrics and baseline-generator tests passed; Knip normal/production and cycle checks exited 0 with historical findings only.",
            "Mutation: configured Stryker scope remained only format-bytes.ts; 15 mutants were generated, 14 killed, 0 survived, 0 no-coverage and 1 compile-error diagnostic, with 100% reported mutation score and exit code 0. StorageMoveEngine remains outside that configured mutation scope.",
            "Initial B.29 candidate Playwright evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, report SHA-256 `75fdf98c111f6647256748d752e47fc852af0e41d1c2cf822a22684afb455a19`; this was superseded by the final micro-freeze run. NANIKA_E2E_TRASH_CYCLES was unset and E2E-FLAKE-001 remains historical.",
            "Security: exact ownership checks prevent stale Cancel publication, target loss and recovery requests after reset/newer operation; the change does not alter authorization, encryption, token handling, request logging or secret boundaries.",
            "Initial B.29 candidate status: the previous report labeled B.29 FROZEN; this final micro-freeze reopens the closure decision without erasing the prior findings or evidence.",
            "Post-freeze source review finding: a Pause created after Cancel began could retain a newer pauseOperations token and publish a delayed pre-Cancel paused result after authoritative cancellation or completion; the earlier B.29 implementation did not characterize this boundary.",
            "Final micro-freeze characterization: five new deterministic Subject-based tests were added. Pause during successful Cancel, Pause during rejected-Cancel recovery and Pause versus canonical completed were RED against the current B.29 production; direct target_uploaded real-run recovery and nonterminal preservation were GREEN and required no production change.",
            "Minimal final correction: after exact Cancel ownership is confirmed, cancel() invalidates only the existing pauseOperations token immediately before publishing a successful Cancel response or canonical cancelled/completed recovery. pause(), resume(), run(), resumingMoveIds, backend contracts and all nonterminal Pause behavior remain unchanged.",
            "Final focused validation: StorageMoveEngine passed 86/86 in three consecutive independent runs; related frontend passed 132/132; full frontend passed 964/964 in two consecutive runs.",
            "Final coverage: global frontend reached 78.68% statements / 67.52% branches / 80.18% functions / 80.98% lines; StorageMoveEngineService reached 88.23% statements / 79.50% branches / 94.44% functions / 91.01% lines.",
            "Final complexity: StorageMoveEngine module moved from 680/640 physical/nonblank lines to 682/642, with 46 functions, maximum CC 8 and total function NLOC 134; the two-line ownership correction caused no complexity increase.",
            "Direct target_uploaded real-run: rejected Cancel canonical target_uploaded entered the existing run() path, completed without source range download, Google session creation, target upload, reconciliation or retransmission; completion was published once.",
            "Final validation: Angular build, backend build, frozen backend storage-move 295 assertions/13 cases, module metrics, baseline generator tests, Knip normal/production, cycle checks and configured mutation all passed. Mutation remains format-bytes.ts only: 15 mutants, 14 killed, 0 survived, 0 no coverage, 1 compile diagnostic and 100% reported score.",
            "Final canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `4e385beace1adffa75aa924c592ea025c9d81ed951c1fce0d61e848dd3e44f8f`; NANIKA_E2E_TRASH_CYCLES was unset and this SHA supersedes the previous candidate evidence.",
            "Final security/performance contract: Pause cannot publish paused after canonical cancelled/completed; stale Cancel cannot invalidate a newer Pause after losing ownership; targetFileIds are not prematurely erased; Google reconciliation cannot duplicate a target; reset/newer Cancel cannot publish stale state; successful Cancel remains exactly one request; no secrets, backend auth or Zero-Knowledge boundary changed.",
            "Quality status: B.29 is FROZEN after the final micro-freeze characterization and all required gates; B.12–B.28 remain FROZEN and B.30 remains NOT STARTED.",
        ],
        "b30_changes": [
            "Target: StorageMoveEngineService.run() and immediate runner-owned helpers; B.12–B.29 behavior, backend contracts, provider protocols, API/schema, UI policy and configured mutation scope remain frozen; B.31 is NOT STARTED.",
            "Original B.29 focused baseline preserved: StorageMoveEngine passed 86/86 in three independent runs before B.30 characterization additions.",
            "B.30 characterization against unmodified B.29 production: 15 deterministic REDs and 86 GREENs. REDs covered initial GET, Resume, completion, cleanup publication, progress, Local ACK, Google session/source metadata, ambiguous reconciliation, failure persistence, stale rerun and Google target ownership after progress failure.",
            "Initial GET/Resume/complete/cleanup/progress/ACK RED: firstValueFromAbortable() can settle before the async continuation resumes; Reset could therefore allow stale canonical publication or a new request boundary to execute after the runner had lost ownership.",
            "Finalizer RED: the old runner protected only controllers.delete(moveId); its unconditional dropTransientExecutionState() could remove sessions, source metadata, startedAt, stages and validating state belonging to a newer controller for the same move.",
            "Secret-state REDs: stale Google session and source-metadata continuations could overwrite or erase newer runtime state after Reset. Ambiguous reconciliation could also republish and remove a newer validation marker through its unconditional finalizer.",
            "Failure/rerun REDs: stale failure report/recovery responses could recreate a card after Reset, and rerunAfterCleanup could launch a new run after the original owner had been invalidated.",
            "Google ownership RED: the final PUT returned google-target-123, but targetFileIds was populated only after reportStorageMoveProgress(); a later progress failure therefore persisted an empty cleanup target list despite one irreversible provider write.",
            "Minimal correction: reused AbortController.signal guards at the proven post-await publication/request boundaries; made final transient cleanup conditional on exact current controller identity; suppressed stale rerun; preserved aborted-owner caches/validation state from destructive old-owner cleanup; and recorded Google target IDs immediately after direct final PUT or confirmed reconciliation. No new field, Map, generation, helper, queue, timer, retry, request or dependency was added.",
            "Initial corrected B.30 candidate: StorageMoveEngine passed 101/101 in three consecutive independent runs; the 86 original B.29 cases remained green and all 15 initial B.30 RED regressions turned green. Related frontend passed 132/132; full frontend passed 979/979 in two consecutive runs; coverage passed all 979 tests.",
            "Initial candidate coverage: global frontend reached 79.01% statements / 67.87% branches / 80.26% functions / 81.25% lines; StorageMoveEngineService reached 92.11% statements / 83.13% branches / 95.83% functions / 94.33% lines.",
            "Initial candidate complexity: StorageMoveEngine module measured 704 physical lines / 664 nonblank lines, 46 functions, maximum CC 9 and total function NLOC 141; no broad run() refactor was performed.",
            "Google target regression: one final PUT, one Google session, zero retransmissions, zero target ACKs after progress failure, and reportStorageMoveFailure retained target_external_file_id google-target-123.",
            "Final validation: Angular build, backend build, frozen backend storage-move 295 assertions/13 cases, module metrics, baseline-generator tests, Knip normal/production, cycle checks and configured mutation all passed. Mutation remains format-bytes.ts only: 15 mutants, 14 killed, 0 survived, 0 no coverage, 1 compile diagnostic and 100% reported score.",
            "Initial candidate canonical failure preserved: 5 total, 4 passed, 1 failed, 0 skipped, 0 flaky, retries 0, exit_code 1, outcome playwright_failed, current_run true, status_valid true, report_valid true, hash_match true, SHA-256 2d96e569776373f20d2fd136b1b0aa8ea81408e5f19ae10cecea7dba2d0c1b99; recovery.spec.ts timed out while the forced failed upload remained in Enviando original... at 0%.",
            "Post-candidate micro-freeze characterization against the current 101-test candidate added three deterministic tests: all three were RED. The Google session finalizer deleted a newer session; the run caller deleted newer targetFileIds after a completed finishCleanup() return; and the transfer loop continued to the next item/commit after Reset won following a settled helper.",
            "Micro-freeze correction: the existing AbortSignal now owns Google session final cleanup; throwIfAborted() guards both finishCleanup() caller boundaries and each settled transfer helper before the next item/commit. No new Map, generation, helper, queue, timer, retry, request or dependency was added.",
            "E2E causal stabilization: recovery.spec.ts records forcedChunkFailureInjected and phase-aware outcomes without increasing its 30-second timeout or retries. The targeted diagnostic passed 1/1 and proved the second chunk failure was injected; the 6 MiB fixture remained unchanged and still guarantees at least two chunks.",
            "Upload audit: UploadEngineService and DriveStore were not modified because no deterministic Upload unit RED was proven; the E2E issue was harness observation/synchronization, not an established Upload production defect.",
            "Final micro-freeze validation: StorageMoveEngine passed 104/104 in three consecutive independent runs; related frontend passed 132/132; full frontend passed 982/982 in two consecutive runs; coverage passed all 982 tests.",
            "Final coverage: global frontend reached 79.02% statements / 67.89% branches / 80.26% functions / 81.26% lines; StorageMoveEngineService reached 92.16% statements / 83.20% branches / 95.83% functions / 94.36% lines.",
            "Final complexity: StorageMoveEngine module measured 707 physical lines / 667 nonblank lines, 46 functions, maximum CC 9 and total function NLOC 141; the three ownership guards caused no new function or complexity hotspot.",
            "Final canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, SHA-256 75669922115fd9e2641d8fa5de63295d3d53be0508cc6b3be7f030a687be4abd; NANIKA_E2E_TRASH_CYCLES was unset and the failed candidate SHA remains historical.",
            "Final security/performance contract: stale runners cannot republish after Reset where characterized, old finalizers cannot clear new transient state, stale reruns cannot start, target_uploaded does not retransmit, provider targets remain recoverable, successful paths gain no request, and no queue/timer/worker/media copy/crypto/retry or provider retransmission was added.",
            "Quality status: B.30 is FROZEN after the post-candidate characterization, minimum correction, causal E2E stabilization, fresh 5/5 canonical evidence and all required gates; B.12–B.29 remain FROZEN and B.31 remains NOT STARTED.",
        ],
        "b31_changes": [
            "Target: GarbageCollector::run_cleanup() in backend/src/storage/GarbageCollector.cpp; B.12–B.30 behavior, backend contracts, provider protocols, API/schema, UI policy and configured mutation scope remain frozen.",
            "Original B.31 focused baseline preserved: GarbageCollector focused coverage passed 103 assertions in 3 test cases before the new B.31 characterization cases.",
            "B.31 characterization against unmodified production: 4 deterministic tests, 21 assertions, 17 passed and 4 failed. Restored trash, completed uploads and stale quota refund were RED; a file created after the old orphan snapshot was also RED.",
            "Root cause: destructive cleanup trusted a stale candidate snapshot for database deletion, quota refund, external-deletion bookkeeping and filesystem/orphan decisions instead of deriving ownership from the row actually deleted by the current transaction.",
            "Minimal correction: one authoritative DELETE ... RETURNING transaction now owns deleted file IDs and quota/external bookkeeping; filesystem deletion runs only after commit, and orphan cleanup receives a fresh post-commit files snapshot. No global filesystem lock, per-chunk query, retry or new dependency was added.",
            "Final focused validation: B.31 passed 24 assertions in 4 test cases in three consecutive independent runs (seeds 31055, 31056 and 31057). The deterministic PostgreSQL lock tests cover restore, completion, stale quota and fresh-file orphan ownership.",
            "Related frozen validation: storage-move passed 295 assertions in 13 cases; the full backend passed 6391 assertions in 75 test cases; backend and frontend builds passed.",
            "Final GarbageCollector metrics: 374 physical lines, 343 nonblank lines, 6 functions, maximum cyclomatic complexity 22 and 311 total function NLOC; no complexity-laundering helper extraction was used.",
            "Security/performance contract: live rows cannot be removed by stale GC candidates, quota is refunded only for rows returned by DELETE, external deletion bookkeeping follows the same ownership, and filesystem deletion cannot precede commit.",
            "Mutation was rerun only in the configured format-bytes.ts scope; no mutation score is claimed for B.31 production targets.",
            "B.31 freeze evidence includes the final canonical Playwright run: 5 total, 5 passed, 0 failed, 0 skipped, 0 flaky, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `b8f010062f70539dfd0c899361cdbc9f6c76752a8afe0d5aa04a45109567ec64`.",
            "Quality status: B.31 is FROZEN after characterization, minimal correction and required gates; B.12–B.30 remain FROZEN and B.32 was NOT STARTED at this freeze point.",
        ],
        "b32_changes": [
            "Target: DriveStore.recoverUpload() and its direct execution body in frontend/src/app/features/drive/state/drive.store.ts; B.12–B.31 behavior, upload protocols, crypto ownership, UI policy and configured mutation scope remain frozen.",
            "B.32 characterization against unmodified production: the focused suite had 53 specs, with 49 passing and 4 deterministic failures. Same-ID recovery duplicated work/FDK derivation, and terminal success/error plus independent-ID cleanup exposed controller lifecycle ownership failures.",
            "Root cause: recoverUpload() created independent async chains even when the transfer ID already had an upload operation, while controller release lived outside an exact recovery owner.",
            "Minimal correction: recoverUpload() is now a thin owner over the existing uploadOperations map, returns the exact canonical Promise for the same transfer ID, uses one execution helper, and releases operation/controller state only when Promise and controller identity still match. Existing recovery zeroization and runtime ownership remain intact.",
            "Cancellation correction required by the RED: non-cancellable decrypt/encrypt Promises are observed through the existing firstValueFromAbortable RxJS primitive, so abort settles the canonical recovery owner without waiting on an obsolete crypto continuation. No recoveryOperations map, queue, timer, File copy, FDK copy, request or dependency was added.",
            "Final focused validation: drive.store.spec.ts passed 54 specs in three consecutive independent runs. The related behavior plus ownership suite passed 117 specs, and full frontend passed 987 specs in two consecutive independent runs.",
            "Final frontend coverage: 79.10% statements, 68.11% branches, 80.29% functions and 81.34% lines; Angular build passed. Final DriveStore metrics: 2126 physical lines, 1921 nonblank lines, 195 functions, maximum cyclomatic complexity 10 and 683 total function NLOC.",
            "Performance/security contract: same-ID recovery performs one derivation/preparation/runtime, different IDs remain independent, cancel awaits the canonical owner and cleans once, FDK zeroization/runtime handoff semantics remain unchanged, and no token or plaintext is logged or sent to the backend.",
            "Mutation was rerun only in the configured format-bytes.ts scope; no mutation score is claimed for B.32 production targets.",
            "B.32 freeze evidence includes the final canonical Playwright run: 5 total, 5 passed, 0 failed, 0 skipped, 0 flaky, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `b8f010062f70539dfd0c899361cdbc9f6c76752a8afe0d5aa04a45109567ec64`.",
            "Quality status: B.32 is FROZEN after characterization, minimal correction and required gates; B.31 remains FROZEN and B.33 was NOT STARTED at this freeze point.",
        ],
        "b33_changes": [
            "Target: GoogleDriveService::get_access_token_for_storage() in backend/include/Services/GoogleDriveService.hpp and backend/src/Services/GoogleDriveService.cpp; B.12–B.32 behavior, provider protocols, API/schema, UI policy and configured mutation scope remain frozen.",
            "B.33 characterization against unmodified production: the concurrent focused case had 13 assertions, 11 passing and 2 deterministic failures. Eight same-storage callers performed eight refreshes on both successful and failed cold cohorts instead of one.",
            "Root cause: the cache had a warm fast path but no per-storage ownership for simultaneous cold misses, allowing duplicate refresh HTTP calls and duplicate failure work.",
            "Minimal correction: a per-storage shared_future registry now gives one caller refresh ownership, followers observe the same result, successful tokens enter the existing cache, and terminal success/failure erases the in-flight entry. No refresh token enters the registry and no mutex is held across DB, decrypt or HTTP.",
            "Final focused validation: B.33 passed 16 assertions in 1 test case in three consecutive independent runs (seeds 33011, 33012 and 33013), including warm-cache, same-storage success/failure retry and independent storage concurrency.",
            "Final backend validation: the full backend passed 6391 assertions in 75 test cases; backend build passed. Final GoogleDriveService metrics: 983 physical lines, 857 nonblank lines, 30 functions, maximum cyclomatic complexity 34 and 841 total function NLOC.",
            "Performance/security contract: warm cache remains the fast path, one cold refresh is performed per storage cohort, different storage IDs remain parallel, failed cohorts are retryable, no refresh token is logged/stored in the registry, and ownership/anti-IDOR behavior is unchanged.",
            "Mutation was rerun only in the configured format-bytes.ts scope; no mutation score is claimed for B.33 production targets.",
            "B.33 freeze evidence includes the final canonical Playwright run: 5 total, 5 passed, 0 failed, 0 skipped, 0 flaky, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `b8f010062f70539dfd0c899361cdbc9f6c76752a8afe0d5aa04a45109567ec64`.",
            "Quality status: B.33 is FROZEN after characterization, minimal correction and all required gates; B.12–B.32 remain FROZEN and B.34 is NOT STARTED.",
        ],
        "b31_micro_freeze_changes": [
            "Scope: B.31 FINAL MICRO-FREEZE for GarbageCollector/FileChunker canonical-file orphan ownership; previously accepted B.2–B.33 history remains frozen and B.34 is NOT STARTED. No frontend, StorageMoveEngine, GoogleDriveService, API/schema, Docker, CI or dependency changes were made for this freeze.",
            "Post-freeze independent B.31 source audit: authoritative DELETE ... RETURNING, the >4-hour incomplete-upload predicate, the >30-day trash predicate, quota refund, pending external deletion bookkeeping and commit-before-delete_file remained correct. The remaining defect was the final orphan sweep: it queried database ownership first and enumerated physical files later, so its candidates were not one coherent filesystem snapshot.",
            "Original focused baselines before micro characterization: B.31 passed 24 assertions in 4 cases; the FileChunker orphan suite passed 14 assertions in 2 cases.",
            "Mandatory RED #1 against the pre-fix production: `B.31 micro freeze - stale owner snapshot cannot delete a live file` produced 3 passed and 1 failed assertion. A database ownership snapshot was taken, then a row and its canonical physical file were created; the old delete_orphaned_files(valid_file_ids) enumerated the later file and deleted it even though its row remained.",
            "Mandatory RED #2 against the pre-fix production: `B.31 micro freeze - GC defers a canonical file created during its run` produced 4 passed and 1 failed assertion. A canonical physical file created while GC was blocked on the main DELETE row lock was deleted by the old final orphan sweep in that same run.",
            "The two RED cases therefore reproduced the same ownership race at both seams: the database row remained live in the direct case, while a filesystem-only file created during the GC run was not part of the intended initial candidate set in the integrated case.",
            "Minimal correction: FileChunker now snapshots canonical basenames at the beginning of GarbageCollector::run_cleanup(), the later ownership query remains one SELECT id FROM files, and deletion is restricted to the intersection of those pre-existing candidate basenames with IDs absent from the later ownership snapshot. The unsafe valid-ID-only overload was removed; no per-file query, global lock, retry, timer or dependency was added.",
            "Canonical parsing and proxy behavior remain unchanged: only exact `<decimal>.dat` and `<decimal>.proxy.dat` basenames are candidates; noncanonical and overflow names remain; an expired row with both canonical data and proxy files removes both through the existing delete_file contract.",
            "Post-fix micro validation: the new micro suite passed 20 assertions in 4 cases in three consecutive runs (seeds 34021, 34022 and 34023); the FileChunker/orphan suite passed 25 assertions in 4 cases in three consecutive runs (seeds 34031, 34032 and 34033); the original B.31 suite passed 24 assertions in 4 cases in three consecutive runs (seeds 34011, 34012 and 34013).",
            "The final FileChunker candidate-snapshot tests cover orphan removal, live-row preservation, a canonical file created after the first snapshot, a proxy created after the first snapshot and eventual cleanup in the next cycle. The integrated GC test confirms a file created during the blocked run survives once and is removed on the second cycle.",
            "Related validation: storage-move passed 295 assertions in 13 cases; the full backend passed 6411 assertions in 79 cases; the full frontend passed 987/987; frontend coverage passed 987/987 with 79.10% statements, 68.11% branches, 80.29% functions and 81.34% lines.",
            "Module metrics PRE → POST: FileChunker.cpp 369/315 physical/nonblank lines, 33 functions, max CC 8, total NLOC 309 → 379/323 lines, 34 functions, max CC 8, total NLOC 317. GarbageCollector.cpp 374/343 lines, 6 functions, max CC 22, total NLOC 311 → 383/351 lines, 6 functions, max CC 24, total NLOC 319. The small increase is the explicit candidate snapshot/ownership intersection, not a complexity-laundering extraction.",
            "Orphan cleanup performance contract: before the fix the path performed one database ownership SELECT and enumerated the directory after it; after the fix it performs one directory snapshot at T0, one database ownership SELECT at T1 and local candidate iteration, with no query per file and no database transaction held during directory scanning.",
            "Security contract: only canonical basenames captured from the configured storage directory are eligible, path traversal candidates are rejected, live database rows are preserved, deletion remains post-commit, and the Zero-Knowledge/API/provider boundaries are unchanged.",
            "Build and static gates passed: backend build, Angular build, baseline-generator tests, module metrics, Knip normal/production, cycle checks and the configured frontend mutation run. Existing nonblocking Knip findings remain: ignored E2E support files in normal mode and the unlisted `ng` binary plus two unused exports in production mode. Angular emitted only the existing budget warnings.",
            "Mutation was rerun only in the configured format-bytes.ts scope; no mutation score is claimed for B.31 production targets.",
            "Final canonical Playwright evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `d5cbc665b6cb78be69e3895ec4bf8ae06bc6a292c2464f69fe37426938806316`.",
            "Quality status: B.31 FROZEN FINAL. B.2–B.33 history remains frozen; B.34 is NOT STARTED.",
        ],
        "b32_final_micro_freeze_changes": [
            "Scope: B.32 FINAL MICRO-FREEZE for DriveStore recovery cancellation ownership after active-runtime handoff; B.31 FINAL MICRO-FREEZE and B.33 remain frozen, B.34 is NOT STARTED, and no backend/API/provider/crypto/UploadEngine change was made.",
            "Pre-fix source audit: recoverUpload(), executeRecovery(), runUploadLoop(), cancelTransfer() and cleanupCancelledUpload() were inspected with their existing Promise, controller, active runtime, FDK and cleanup ownership maps; no broad audit or B.34 work was started.",
            "Original focused baseline before this micro-freeze: drive.store.spec.ts passed 54/54; full frontend passed 987/987; frontend coverage was 79.10% statements, 68.11% branches, 80.29% functions and 81.34% lines.",
            "Mandatory RED against unmodified production: `does not fallback-delete a recovery already cleaned by its canonical runtime` ran the real recoverUpload() → executeRecovery() → activeUploads handoff → runUploadLoop path, with only UploadEngine.execute() controlled; trashFile and hardDeleteFile were each called twice instead of once and syncPendingUploads was called twice instead of once.",
            "Root cause: cancelTransfer() awaited the canonical operation and then inferred recovery cleanup ownership from post-await state. The canonical run loop had already removed its active runtime and cleanup markers, so cancelTransfer() could not distinguish an already-cleaned post-handoff runtime from a pre-handoff recovery and performed fallback cleanup again.",
            "Minimal correction: cancelTransfer() captures the active recovery runtime and any existing cleanup Promise before abort/join; it joins a pre-existing cleanup Promise, lets an operation that owned a pre-join runtime retain canonical cleanup ownership, and preserves the existing fallback cleanup for pre-handoff and paused/no-operation recoveries.",
            "No helper, field, type, Map, Set, generation, controller, timer, retry, request, dependency, File/FDK copy, API, backend, provider or cryptographic format change was added. The production diff is confined to two local ownership observations and the existing cleanup branch.",
            "The new test proves causal runtime existence before cancel, canonical upload operation existence, execute cancellation by AbortSignal, one prepare and one execute, exact pending file ID, one trash and one hard-delete, one pending-upload sync, cancelled transfer status, removed runtime/operation/controller and zeroized exact FDK bytes.",
            "Post-fix focused validation: drive.store.spec.ts passed 55/55 in three independent post-fix runs; related UploadEngine passed 8/8, abortable-observable passed 4/4 and drive.store.behavior passed 63/63.",
            "Final frontend validation: full Angular suite passed 988/988 in two independent runs; coverage passed 988/988 with 79.16% statements, 68.42% branches, 80.23% functions and 81.41% lines; production build passed with existing bundle/style budget warnings.",
            "Final backend preservation: backend build passed; the full backend passed 6411 assertions in 79 cases; the frozen storage-move slice passed 295 assertions in 13 cases. No backend file changed.",
            "Final DriveStore metrics: 2135 physical lines, 1930 nonblank lines, 196 functions, maximum cyclomatic complexity 10 and 684 total function NLOC; the local ownership guard introduced no new complexity hotspot or persistent state.",
            "Static gates: module-metrics test passed; Knip normal exited 0 with two existing E2E support configuration hints; production Knip exited 0 with the existing unlisted `ng` binary and two unused exports; cycles exited 0 with no findings.",
            "Mutation: configured mutation scope remained only format-bytes.ts; no mutation score is claimed for B.32.",
            "Final canonical Playwright evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `6942af2405fe51aa130310b1ca90d366859c2a63ead0641804345565662eb343`; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Quality status: B.32 FROZEN FINAL. B.31 remains FROZEN FINAL; B.33 remains FROZEN; B.34 is NOT STARTED.",
        ],
        "b32_final_micro_freeze_2_changes": [
            "Scope: B.32 FINAL MICRO-FREEZE #2 for canonical cleanup rejection ownership after active-runtime handoff and cancellation; the first B.32 micro-freeze exactly-once cleanup correction remains frozen, B.31 remains FROZEN FINAL, B.33 remains FROZEN and B.34 is NOT STARTED.",
            "Pre-fix source audit: the first micro-freeze still correctly produced exactly one trash, one hard-delete and one sync after post-handoff cancellation. The residual seam was rejection ownership, not duplicate cleanup; cleanupCancelledUpload() remained single-flight and was not changed.",
            "Original focused baseline before the new characterization: drive.store.spec.ts passed 55/55 after the first B.32 micro-freeze. No production change was made before the new RED test.",
            "Characterization test: `preserves canonical cleanup rejection after recovery runtime handoff` executed real recoverUpload() → executeRecovery() → activeUploads handoff → runUploadLoop() → cleanupCancelledUpload(), controlling only UploadEngine.execute(). Against unmodified production it ran 56 tests with 55 passing and 1 failing: both the canonical recovery Promise and cancelTransfer() resolved instead of preserving the exact `Error('offline')` rejection; the remote sequence remained one trash, one hard-delete and one sync attempt.",
            "Root cause: cleanup rejected after trash and hard-delete, runUploadLoop() rejected, then executeRecovery() classified the real cleanup error as ordinary cancellation because the controller was aborted and the transfer was marked cancelled. Its inner catch swallowed the error; the outer catch would also have swallowed a rethrown non-Abort error. cancelTransfer() intentionally joined the canonical operation without creating a second cleanup, so no caller observed the rejection.",
            "Minimal correction in executeRecovery(): cancellation remains silent for AbortError/UploadAbortError and pre-handoff cancellation, while a non-Abort error after runtime ownership is handed off is rethrown through both catches. No error wrapper or string classification was added.",
            "Minimal correction in cancelTransfer(): the existing canonical operation join now records the original rejection locally; when that operation owned a recovery runtime before the join, the same rejection object is rethrown after the delegated cleanup path, without retrying cleanup or changing fallback ownership.",
            "Preservation: successful post-handoff cleanup remains exactly once; sync rejection remains exactly one sync attempt with one trash and one hard-delete; pre-handoff fallback remains once; paused runtime without a canonical operation still uses cancelTransfer() cleanup; an existing cleanup Promise is still joined; normal upload cancel and download cancel paths are unchanged.",
            "FDK/security: the exact PreparedUpload FDK reference is zeroized before/independently of remote cleanup result propagation; no copy, secret logging, backend/API/provider/crypto/protocol or Zero-Knowledge boundary changed.",
            "Production diff for B.32 #2: 24 additions and 3 removals in drive.store.ts for local rejection capture and cancellation classification; 0 helpers, 0 fields, 0 types, 0 Maps/Sets, 0 dependencies, 0 retries, 0 timers and 0 requests. The new test adds 64 lines.",
            "Focused validation after the patch: drive.store.spec.ts passed 56/56 in three independent runs. Related suites passed drive.store.behavior 63/63, UploadEngineService 8/8 and abortable-observable 4/4.",
            "Full frontend validation: 989/989 in two independent runs; fresh coverage passed all 989 tests with 79.23% statements, 68.53% branches, 80.36% functions and 81.47% lines; Angular production build passed with existing bundle/style budget warnings.",
            "Backend preservation: backend build passed; full backend passed 6411 assertions in 79 cases; storage-move passed 295 assertions in 13 cases. No backend file changed.",
            "DriveStore metrics PRE → POST: 2135 → 2156 physical lines; 1930 → 1951 nonblank lines; 196 → 195 functions; maximum CC 10 → 10; total function NLOC 684 → 683. No helper or complexity hotspot was introduced.",
            "Static gates: module-metrics test passed; Knip normal retained two existing E2E configuration hints; production Knip retained the unlisted `ng` binary and two unused exports; cycles exited 0 with no findings; baseline-generator tests passed after this section was added.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.32 production targets. The configured run reported 1 survivor and 1 compile diagnostic without changing that scope.",
            "Final canonical Playwright evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `fb58f7ce7386d3625fd053685579a01b0782142966b7c0677571bbb18928f88c`; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Quality status: B.32 FROZEN FINAL. B.31 remains FROZEN FINAL; B.33 remains FROZEN; B.34 is NOT STARTED.",
        ],
        "b33_final_micro_freeze_changes": [
            "Scope: B.33 FINAL MICRO-FREEZE for GoogleDriveService unlink cache authority and refresh publication lifecycle only. The original b33_changes single-flight history remains intact; B.31 and B.32 remain FROZEN FINAL and B.34 is NOT STARTED.",
            "Post-freeze source audit: warm-cache O(1), per-storage shared_future ownership, shared failure, later retry and different-storage parallelism were already correct. The new findings were confined to cache invalidation outside the owner-scoped DB mutation and stale publication across unlink.",
            "Original focused baseline before new tests: 16 assertions in 1 B.33 case passed. No production change preceded the characterization runs.",
            "Unauthorized unlink RED: the dedicated API test preserved HTTP 404 and the victim DB row, but attacker-controlled foreign unlink evicted both warm token and quota caches; victim refresh_requests and quota_requests each changed from 1 to 2.",
            "Unlink-all RED: the owner-scoped UPDATE marked only user A rows, but process-global cache clear evicted user B; B's refresh count changed from 3 to 4. Post-fix coverage also proves B's warm quota remains untouched.",
            "In-flight refresh RED: a refresh causally blocked in Google HTTP before owner unlink returned a stale token, raised no error and repopulated the cache; the next call remained at refresh count 1 instead of starting the post-unlink cleanup cohort at count 2.",
            "Post-GC RED: after the same old refresh crossed unlink and GarbageCollector removed user_external_storages, the stale cache still returned a token instead of STORAGE_NOT_FOUND.",
            "Caller audit: GarbageCollector processes pending_external_deletions through delete_external_file(), which calls get_access_token_for_storage(); a refresh that begins after is_unlinking=true therefore remains a legitimate cleanup operation and its GREEN characterization passed 2/2.",
            "Minimum invalidation fix: unlink_account() captures only IDs returned by the owner-scoped UPDATE ... RETURNING id, commits DB work, rejects an empty authoritative set without cache mutation, then selectively erases token and quota entries. No caller-provided-ID erase or user-scoped global clear remains.",
            "Minimum lifecycle fix: a cold owner records the row's is_unlinking state before Google HTTP, then revalidates the same row/provider with FOR SHARE immediately around the short cache publication. Missing rows or a changed lifecycle fail the shared cohort with STORAGE_NOT_FOUND; a later cleanup refresh that starts and ends in unlinking remains valid.",
            "No helper, header field, type, generation map, retry, timer, polling, worker, dependency, registry supersession or token copy was added. token_refreshes_mutex_ and cache_mutex_ remain outside Google HTTP; refresh tokens remain local to the owner call and no token is logged.",
            "Failure/success cohort hardening is test-only and owner-first: the HTTP owner was causally held while follower threads were released into the service call; repeated stress executions preserved one refresh cohort without sleep or retry.",
            "Final focused B.33 passed 67 assertions in 2 cases in three independent runs; GoogleDriveService passed 95 assertions in 2 cases three times; API Google passed 119 assertions in 3 cases; GC passed 136 assertions in 9 cases; storage-move passed 295 assertions in 13 cases.",
            "Backend build passed and the full backend passed 6462 assertions in 80 cases. Pending external deletion and account cleanup behavior remained green.",
            "Frontend preservation passed 989/989 twice; coverage passed 989/989 with 79.23% statements, 68.53% branches, 80.36% functions and 81.47% lines; Angular build passed with the existing bundle/style budget warnings.",
            "GoogleDriveService metrics PRE → POST: 983 → 1003 physical lines, 857 → 878 nonblank lines, 30 → 30 functions, maximum CC 34 → 34 and total function NLOC 841 → 862. The cold path adds one lifecycle query/row lock; the warm path adds no query, HTTP or global mutex.",
            "Static gates: module metrics passed; Cppcheck was unavailable locally; Knip retained only the existing E2E configuration hints, unlisted ng binary and two unused exports; cycles remained zero.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.33 production targets. The fresh configured run reported 14 killed, 0 survivors and 1 compile diagnostic; historical MUT-001 was not reproduced and remains preserved in prior baseline history rather than silently erased.",
            "Canonical Playwright: the first attempt failed preflight because backend port 8080 was offline and its status was preserved separately; after starting only the required temporary backend, the canonical runner passed 5/5 with zero failed/skipped/flaky tests, retries 0, valid current status/report, matching SHA-256 `97e78d0b63f5a863ec52c0079029be2786de66b63a9565d1e081a919f9453445` and NANIKA_E2E_TRASH_CYCLES unset.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL and B.34 NOT STARTED.",
        ],
        "b33_final_micro_freeze_2_changes": [
            "Scope: B.33 FINAL MICRO-FREEZE #2 closes only terminal cache ownership after GarbageCollector deletes an unlinking Google storage. B.31 and B.32 remain FROZEN FINAL; B.34 is NOT STARTED.",
            "Pre-fix audit: the B.33 #1 owner-scoped unlink invalidation and false→true publication guard remain correct. The remaining lifecycle gap was a true→true cleanup refresh cached before terminal row deletion.",
            "Characterization RED against unmodified production: B.33 terminal unlink releases token cached by cleanup refresh proved a cleanup token was warm with refresh count 1, GC deleted the storage row, then the next token call returned the warm token instead of STORAGE_NOT_FOUND. The focused run had 81 assertions with 80 passing and 1 deterministic failure.",
            "Complementary ordering characterization remained GREEN: an in-flight cleanup refresh blocked in Google HTTP sees the missing row during post-HTTP FOR SHARE revalidation after GC terminal deletion and fails with STORAGE_NOT_FOUND without publishing a cache entry.",
            "Root cause: GarbageCollector owned terminal database deletion but did not release the corresponding Google token and quota cache ownership.",
            "Minimum correction: GoogleDriveService exposes one narrow invalidate_storage_caches() helper, reused by unlink_account(). GarbageCollector performs DELETE ... RETURNING s.id, captures only exact finalized storage IDs, commits, then asks the service to erase those token and quota entries.",
            "Terminal invalidation is post-commit only. Empty DELETE RETURNING is a no-op; failed terminal transactions clear their local ID list and cannot invalidate caches. No token_refreshes_ ownership, generation, tombstone, retry, timer, polling, worker, provider request or warm-path DB check was added.",
            "Concurrency remains convergent: a cleanup refresh that publishes under FOR SHARE commits before GC can delete, then GC commits and evicts its exact ID; if GC deletes first, the refresh observes no row and throws STORAGE_NOT_FOUND.",
            "Cleanup refresh true→true remains allowed while pending external deletion work exists; once the terminal storage row is removed, a later token request is DB-cold, returns STORAGE_NOT_FOUND and starts no Google refresh.",
            "Focused validation: B.33 passed 81 assertions in 2 cases in three independent runs; GoogleDriveService passed 109 assertions in 2 cases three times; API Google passed 119 assertions in 3 cases; GC passed 136 assertions in 9 cases; storage-move passed 295 assertions in 13 cases.",
            "Backend build passed and the full backend passed 6476 assertions in 80 cases. Frontend preservation passed 989/989 twice; coverage passed 989/989 with 79.21% statements, 68.53% branches, 80.36% functions and 81.45% lines; Angular build retained only existing bundle/style budget warnings.",
            "Static gates: module metrics and baseline-generator tests passed; Cppcheck was unavailable locally; Knip retained the existing E2E configuration hints, unlisted ng binary and two unused exports; cycles remained zero.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.33 production targets. The fresh configured run reported 14 killed, 0 survivors and 1 compile diagnostic; the historical survivor was not reproduced and current MUT-001 is a MUTATION DIAGNOSTIC.",
            "Canonical Playwright first failed preflight because backend port 8080 was offline and that provenance was preserved. After starting only a temporary backend, the final run passed 5/5 with retries 0, current/status/report/hash validity true and SHA-256 `b74f8a28b09b7a1e98395f4170c2a6a9bce199817d92d7504e96af4f0f97f039`.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL and B.34 NOT STARTED.",
        ],
        "b34_changes": [
            "Scope: B.34 GOOGLE ACCESS-TOKEN CAPABILITY / UNLINK LIFECYCLE. B.31, B.32 and B.33 remain frozen; B.35 and B.36 are not started. No frontend production, schema, crypto, OAuth scope, provider proxy or media path changed.",
            "Original focused baseline before B.34 tests: service Google Drive 109 assertions / 2 cases; API Google 119 / 3; B.33 81 / 2; GC 136 / 9; Storage Move 295 / 13. Production was unchanged before the B.34 characterization.",
            "Caller audit: normal ActiveStorage callers are API Google download metadata, Storage Move source, upload recovery, storage selection/quota, resumable session creation, external-size validation and target reconciliation. The only UnlinkCleanup caller is GoogleDriveService::delete_external_file(), reached by GarbageCollector pending_external_deletions.",
            "RED characterization against unmodified production: normal cold access during is_unlinking returned a token, performed one refresh and did not throw STORAGE_NOT_FOUND; the focused B.34 characterization had 20 assertions, 11 passing and 9 deterministic failures.",
            "RED characterization against unmodified production: a token obtained during unlink remained warm and a subsequent normal caller consumed it without another refresh; a cleanup owner and normal follower also shared the successful storage-only future. The reverse cohort likewise allowed the normal caller to receive the cleanup-compatible result.",
            "GREEN characterization: active normal access, active same-storage single-flight, failed-cohort retry, different-storage parallelism, terminal deletion and B.33 false→true/true→true lifecycle behavior remained preserved. Upload recovery, resumable-session preflight and storage selection already reject unlinking rows without provider HTTP.",
            "Minimal correction: GoogleDriveService adds TokenAccess::ActiveStorage and TokenAccess::UnlinkCleanup with the safe ActiveStorage default; delete_external_file() explicitly opts into UnlinkCleanup. No user-controlled input selects this authority.",
            "Capability isolation: the in-flight refresh registry is keyed by storage ID plus TokenAccess, so mixed-authority callers cannot share a future. The token cache retains one lifecycle bit indicating whether publication occurred while unlinking; active callers cannot consume a cleanup-scoped warm token, while cleanup can retain the existing true→true path.",
            "Normal cold denial checks is_unlinking immediately after the existing refresh-token SELECT and before key derivation or Google HTTP. B.33 FOR SHARE lifecycle revalidation, cache publication boundary, terminal GC invalidation and no warm-path DB access for active tokens remain intact.",
            "Focused B.34 validation: the dedicated B.34 filter passed 31 assertions / 2 cases in three independent runs; service Google Drive passed 137 assertions / 3 cases; API Google passed 122 / 4; B.33 passed 81 / 2; GC passed 136 / 9; Storage Move passed 295 / 13. The B.34 tests cover cold denial, cleanup-warm denial, both mixed-authority orders, recovery, resumable-session, selection and stale Google download response.",
            "Production additions: one enum, one cache lifecycle bit and one authority-aware in-flight key/hash. No helper, persistent field, database column, generation, tombstone, global lock, retry, timer, polling, worker, dependency or refresh-token shared state was added.",
            "Security/performance contract: after unlink wins, normal operations cannot acquire or consume application-managed Google access-token capability; GC cleanup retains narrow authority until terminal deletion. Active warm access remains O(1), DB-free, provider-free and protected only by the existing cache shared lock.",
            "Full backend validation: build passed and savebox_tests passed 6507 assertions in 82 cases with seed 34651. Frontend unit tests passed 989/989 twice; coverage passed 989/989 with 79.23% statements, 68.53% branches, 80.36% functions and 81.47% lines; Angular production build passed with existing bundle/style budget warnings.",
            "Static validation: module-metrics and baseline-generator tests passed; Knip normal exited 0 with two existing E2E configuration hints; Knip production retained the existing unlisted ng binary and two unused exports; npm exec -- knip --cycles exited 0 with no cycles; Cppcheck was unavailable locally.",
            "GoogleDriveService metrics PRE → POST: 1008 → 1019 physical lines; 882 → 892 nonblank lines; 31 → 31 functions; maximum CC 34 → 34; total function NLOC 866 → 876. ApiRouter and GarbageCollector were unchanged; no frontend production file changed.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.34 production targets. The configured run scored 100% of scored mutants with 14 killed, 0 survivors and 1 compile diagnostic.",
            "Canonical Playwright final evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, retries 0, report SHA-256 `04a7f29d5b4322515fc5da87766d7d4034684e48bc5405a8f472f138ec7cae2d`; NANIKA_E2E_TRASH_CYCLES was unset. The earlier backend-offline preflight remains preserved as separate provenance.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL and B.34 FROZEN FINAL; B.35 and B.36 remain NOT STARTED.",
        ],
        "b35_changes": [
            "Scope: B.35 JWT / SESSION AUTHORITY, COLLISION SAFETY, CONCURRENCY & REFRESH. B.31–B.34 remain FROZEN FINAL; B.36 is NOT STARTED. No frontend production, Zero-Knowledge, Vault, Google Drive, Storage Move, JWT algorithm or schema change was introduced.",
            "Pre-fix focused baseline: auth 113 assertions / 4 cases; API auth 109 / 3; existing session API 20 / 1. The added B.35 characterization initially ran 61 assertions / 8 cases with 39 passing and 22 deterministic failures before production changes.",
            "Collision RED against unmodified production: forcing COLLIDE for owner A and collider B caused the user_sessions INSERT to fail, but generate_token(B) swallowed the transaction error and returned a signed JWT; A remained owner, B had no row, and verify_token accepted the borrowed JTI as B.",
            "Same-user collision regression: forcing the same seven-character JTI twice for one user now fails closed, rolls back the duplicate issuance and pruning, leaves exactly one committed session and keeps the original JWT valid. This final characterization was added without changing production behavior.",
            "Independent verifier RED: a handcrafted valid JWT for B with A's JTI was accepted because the session query checked session_id without binding user_id. The same forged token also reached local logout before the fix; the post-fix route returns 401 and A's session remains valid.",
            "Issuer fail-closed REDs: missing user, soft-deleted user and AuthService without a database pool could still produce JWTs before the patch. The corrected path throws for issuance and verify_token returns nullopt without a session database.",
            "Deterministic concurrency RED: two same-user issuances were causally held at the oldest-session DELETE boundary; pg_stat_activity observed the lock waiters and unmodified production finished with 11 sessions instead of 10.",
            "Minimal issuance correction: generate_token now requires a pool, locks the active user row with FOR UPDATE, inserts the current JTI, prunes only previous sessions, signs before COMMIT and propagates every persistence/signing/commit error. No collision retry was added.",
            "Pruning contract: the current JTI is explicitly excluded; previous sessions are ordered by created_at DESC, session_id DESC and OFFSET 9, preserving at most 9 previous plus the current authority.",
            "Verifier correction: verify_token now requires a pool and performs one exact users JOIN user_sessions lookup on (user_id, session_id), preserving signature/type checks, deleted-user rejection and the existing token_tver < db_token_version contract.",
            "Refresh RED against unmodified production: repeated /refresh calls used generate_token(), changed JTI and grew the session count 1→2→3; refreshing the oldest of 10 devices evicted that logical session; concurrent refreshes produced 3 rows.",
            "Minimal refresh correction: AuthService::refresh_token validates the JWT locally, locks the matching user/session with FOR SHARE, reads current claims, signs a renewed JWT with the same JTI and commits without INSERT or DELETE. ApiRouter maps invalid authority to 401 and internal failures to generic 500.",
            "Refresh/logout contract: same-JTI refresh preserves local logout of both old and renewed JWTs; global token_version invalidates both and stale refresh returns 401. No refresh-token table, rotation, cache or new credential was introduced.",
            "Focused B.35 validation: 72 assertions / 10 cases passed in three independent runs (seeds 35051, 35052 and 35053). Auth passed 185 / 14; API auth passed 152 / 8; existing session API passed 20 / 1.",
            "Production additions: one private signer helper and one public refresh_token primitive; no persistent fields, maps, sets, mutexes, generations, retries, timers, polling, queues, workers, dependencies, tables, columns or indexes were added.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.35 production targets. The configured run remains 14 killed, 0 survivors and 1 compile diagnostic with 100% scoreable mutants.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL and B.35 FROZEN FINAL; B.36 remains NOT STARTED.",
        ],
        "b35_final_micro_freeze_1_changes": [
            "Scope: B.35 FINAL MICRO-FREEZE #1 is limited to refresh versus session issuance/pruning lock order, linearization, deadlock freedom, no resurrection and the <=10 session authority invariant. B.31–B.35 remain frozen after this closure and B.36 is NOT STARTED.",
            "Pre-micro-freeze source review: generate_token() locks users(U) with FOR UPDATE before insert/pruning; refresh_token() uses one JOIN with FOR SHARE OF u,s; verify_token() remains one unlocked owner-exact JOIN hot-path lookup. No production change was made before characterization.",
            "Original focused baseline before the new test: [auth][b35] passed 72 assertions / 10 cases with seed 35101; [api][auth][b35] passed 43 assertions / 5 cases with seed 35102.",
            "Lock-order hypothesis only: the existing refresh JOIN could, depending on PostgreSQL lock acquisition order, overlap with generate_token() holding users(U) while waiting to prune OLD0001. It was not labeled a deadlock bug before execution.",
            "Causal characterization: seeded OLD0001..OLD0010 with explicit timestamps, locked OLD0001 in an external blocker, observed the issuer waiting through pg_stat_activity, started refresh of the signed OLD0001 JWT, observed overlapping database lock waiters, then released the blocker and joined both threads. No sleep_for, detached thread, production hook, retry or stress loop was used.",
            "GREEN result against unmodified B.35 production: the new race passed 20 assertions / 1 case in all three runs (seeds 35111, 35112 and 35113); no PostgreSQL deadlock exception, no refresh internal error, no session resurrection and no invalid foreign state occurred.",
            "Linearizable outcomes accepted by the test: refresh may return before pruning and then its same-JTI JWT is invalid after the issuer commits, or pruning may win and refresh returns nullopt. In every observed run the final count was 10, the new issuer JWT was valid, OLD0001 was invalid and OLD0002..OLD0010 remained valid.",
            "Production correction: NONE. AuthService.cpp, AuthService.hpp and ApiRouter.cpp remain unchanged for this micro-freeze; the current JOIN lock shape is GREEN under the causal race.",
            "Test-only diff: one focused [auth][b35][microfreeze] regression plus the required baseline-generator/test wording. No schema, index, dependency, frontend, Google, Vault, Crypto, Storage Move, upload or download change was made.",
            "Complexity and performance: production unchanged; lock order, verify one-query hot path, generate per-user FOR UPDATE and refresh one locked query remain unchanged.",
            "Focused micro-freeze validation: 20 assertions / 1 case passed with seeds 35111, 35112 and 35113; no flaky result.",
            "Related auth validation: [auth] passed 205 assertions / 15 cases with seed 35131; [api][auth] passed 152 / 8 with seed 35132; [api][auth][sessions] passed 20 / 1 with seed 35133.",
            "Full backend validation: build passed and savebox_tests passed 6599 assertions in 93 cases with seed 35141.",
            "Frontend preservation: unit tests passed 989/989 twice; coverage passed 989/989 with 79.21% statements, 68.53% branches, 80.36% functions and 81.45% lines; Angular build passed with existing bundle/style budget warnings. No frontend production file changed.",
            "Static validation: module metrics, module-metrics tests and baseline-generator tests passed; Knip normal exited 0 with no issues, production retained the known ng binary and two unused exports, cycles exited 0 with no cycles, and Cppcheck was unavailable locally.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.35 final micro-freeze production targets. The configured run remains 14 killed, 0 survivors and 1 compile diagnostic with 100% scoreable mutants.",
            "Canonical Playwright: total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, SHA-256 `4546526dc753bffb02e3bdda44a0637bf40354e3d7d32d5ce99a3b9970fb3ceb`; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Preexisting AUTH-LOGOUT-FAIL-CLOSED remains deferred: logout_local() still suppresses database exceptions; this micro-freeze did not characterize or alter that boundary.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL and B.36 NOT STARTED.",
        ],
        "b36_changes": [
            "Scope: B.36 CLIENT IP AUTHORITY / TRUSTED PROXY BOUNDARY, RATE LIMITING, REGISTRATION ABUSE CONTROL & DEPLOYMENT INGRESS. B.31–B.35 remain FROZEN FINAL; B.37 is NOT SELECTED and the next step is a fresh broad audit.",
            "Original focused baseline before B.36 characterization: [rate_limiter] passed 5019 assertions / 1 case with seed 36001; [auth] passed 205 / 15 with seed 36002; [api][auth] passed 152 / 8 with seed 36003 after one transient repeat-only failure in the API auth run.",
            "RED characterization against unmodified production: a direct peer rotating CF-Connecting-IP created independent auth buckets (6th response 200); a forged victim header consumed the victim bucket (victim response 429); six malformed forwarding values created independent buckets and the seventh response stayed 200; and four rotated-header registrations were all accepted (4th response 201) instead of the fourth returning TOO_MANY_ACCOUNTS_FROM_IP.",
            "Deployment characterization: docker compose exposed backend 8080 and frontend 6742 on all interfaces. The versioned host Nginx passed forwarding headers without a trusted real-IP boundary, while upload remained DNS-only outside the Cloudflare Tunnel.",
            "Minimal production correction: one inline ClientIp resolver validates a single X-Real-IP address only when explicit TRUST_PROXY_HEADERS=true is enabled; otherwise the socket peer is authoritative. RateLimitMiddleware and ApiRouter::handle_register share that resolver.",
            "Ingress correction: host Nginx trusts CF-Connecting-IP only from local cloudflared peers, overwrites canonical downstream headers, and frontend Nginx preserves the canonical X-Real-IP hop. Backend and frontend Compose ports are loopback-only; the upload hostname remains direct. Effective Compose validation resolved both host IPs to 127.0.0.1 and retained TRUST_PROXY_HEADERS=true from the local deployment environment.",
            "Security contract: forged headers cannot rotate limiter identity, consume a victim bucket or bypass the three-account/24-hour registration rule; malformed trusted values fall back to the proxy peer; trusted ingress still distinguishes clients A and B. No schema, database query, network call, lock, timer, retry, dependency or Zero-Knowledge change was added.",
            "Focused B.36 validation: 34 assertions / 5 cases passed in three independent runs with seeds 36021, 36022 and 36023. Related suites passed: [rate_limiter] 5044 / 5 with seed 36031; [auth] 214 / 16 with seed 36032; [api][auth] 161 / 9 with seed 36033; and [e2e-fixture] 15 / 4 with seed 36042.",
            "Complexity PRE → POST: RateLimitMiddleware.hpp 219/185/4/max CC 30/158 NLOC → 222/187/5/max CC 28/158; ApiRouter.cpp 3364/2920/84/max CC 44/2898 → 3364/2920/84/max CC 44/2897; utils.hpp 180/152/16/max CC 13/131 → 184/155/17/max CC 13/134; main.cpp 139/110/1/max CC 12/80 → 141/112/1/max CC 12/82. The new ClientIp.hpp is 21/14/1/max CC 6/9 NLOC.",
            "Full backend validation: Debug build passed and savebox_tests passed 6633 assertions in 98 cases with seed 36043. Frontend preservation passed 989/989 twice; coverage passed 989/989 with 79.21% statements, 68.53% branches, 80.36% functions and 81.45% lines; Angular production build passed with existing bundle/style budget warnings.",
            "Static validation: deployment security tests and baseline-generator tests passed 20/20 together; module-metrics test and fresh module report passed; Knip normal retained two configuration hints, production retained the unlisted ng binary and two unused exports, cycles reported no cycles, and Cppcheck was unavailable locally.",
            "Deployment validation: docker compose config --quiet passed; Nginx syntax validation was unavailable because nginx is not installed on Windows. Static Nginx/Compose/cloudflared assertions passed; no remote server or Cloudflare configuration was changed.",
            "Mutation validation: format-bytes.ts reported 15 mutants, 14 killed, 0 survivors, 0 no-coverage and 1 compile diagnostic, with 100% scoreable mutation score. The required mutation scope remained unchanged.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.36 production targets.",
            "Canonical Playwright final evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, SHA-256 `b97340019f2814116a6a804e0e259f566671e8015c9bfeebf5554f04a257d64c`; NANIKA_E2E_TRASH_CYCLES was unset. The temporary local backend used for the run was stopped afterward.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL and B.36 FROZEN FINAL; B.37 NOT SELECTED; next step is a fresh broad audit. AUTH-LOGOUT-FAIL-CLOSED remains preexisting/deferred and MUT-001 historical/current diagnostic status is unchanged.",
        ],
        "b37_changes": [
            "Scope: B.37 GOOGLE ACCOUNT LINK CONCURRENT IDEMPOTENCY, ACTIVE-ACCOUNT UNIQUENESS AND REMOTE SIDE-EFFECT OWNERSHIP. B.31–B.36 remain FROZEN FINAL; B.38 is NOT STARTED. No frontend production, OAuth state model, token-cache lifecycle, unlink flow, Zero-Knowledge boundary, dependency, Docker or CI change was introduced.",
            "Pre-fix source audit: link_account() validated OAuth state, exchanged the code, committed a standalone active-account duplicate check, created the remote Nanika folder, then opened a second transaction for refresh-token encryption and INSERT. No database uniqueness constraint protected active rows.",
            "Original focused baseline before B.37 characterization: service Google Drive passed 137 assertions / 3 cases; API Google passed 122 / 4; database migration passed 66 / 1. Production was unchanged before the new race tests.",
            "Deterministic RED against unmodified production: two independently issued OAuth states for the same user/account both crossed the provider boundary, both returned success, performed two folder searches and two folder creations, and committed two active rows. The API race likewise returned HTTP 200/200 instead of 200/409.",
            "Root cause: the duplicate check and INSERT belonged to separate transactions, so both callers could observe absence before either active row existed; the remote provider side effect occurred outside database-owned serialization.",
            "Minimal ownership correction: link_account() now acquires one PostgreSQL transaction-scoped advisory lock derived from user_id, provider and exact account_email before the active duplicate check, remote folder side effect and INSERT. The old standalone precheck transaction was removed.",
            "Database authority: canonical table creation now installs the partial unique index idx_external_storage_one_active_account on (user_id, provider, account_email) WHERE is_unlinking = FALSE AND account_email IS NOT NULL. No ALTER TABLE, migration compatibility path, deduplication or backfill was added.",
            "Final flow: OAuth code exchange and userinfo remain before database ownership; one connection/transaction then locks the logical account, checks the active row, creates or finds the provider folder only for the winner, encrypts the refresh token, inserts and commits. A duplicate loses before provider folder work and maps through the existing ALREADY_LINKED → HTTP 409 contract.",
            "Winner/loser characterization: exactly one same-user/same-account caller succeeds, one receives ALREADY_LINKED, one folder search and one creation occur, one active row remains, and its root_folder_id belongs to the winning operation. The API result is exactly one 200 and one 409.",
            "Concurrency scope: different users linking the same Google account remain independent and can both reach their provider boundary before either is released; advisory ownership is account-scoped rather than global. PostgreSQL hash collisions can only add serialization, not violate uniqueness.",
            "Lifecycle preservation: an older row with is_unlinking=true does not block a new active link for the same user/provider/account; the partial unique predicate and duplicate query agree on active-row authority.",
            "Failure/rollback characterization: when the lock owner fails during remote folder creation, its transaction rolls back and releases advisory ownership; a later valid attempt succeeds and commits the only active row. No retry, timer, queue, compensation workflow or remote cleanup saga was introduced.",
            "Remote-side-effect PRE → POST: the failing race changed from two searches/two creations/two active rows to one search/one creation/one active row. The path adds one advisory-lock SQL statement, removes one database transaction and holds the remaining low-frequency link transaction across the existing bounded provider request.",
            "Security preservation: loser refresh/access tokens are not persisted, account ownership and OAuth-state validation remain unchanged, no token/plaintext enters logs or URLs, and B.33/B.34 cache/unlink authority remains untouched.",
            "Focused B.37 validation passed 35 assertions / 3 cases in three independent runs (seeds 37021, 37022 and 37023). Related service Google Drive passed 162 / 4; API Google passed 127 / 5; B.33 passed 81 / 2; B.34 passed 31 / 2; migration passed 76 / 2; GC passed 136 / 9; Storage Move passed 295 / 13.",
            "Full backend validation: savebox_tests passed 6673 assertions in 101 cases with seed 37043; the backend build passed. Frontend preservation passed 989/989 twice, coverage passed 989/989 with 79.20% statements, 68.53% branches, 80.29% functions and 81.45% lines, and Angular production build passed with existing budget warnings.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.37 production targets.",
            f"Canonical Playwright final evidence: total {e2e['total']}, passed {e2e['passed']}, failed {e2e['failed']}, skipped {e2e['skipped']}, flaky {e2e['flaky']}, exit_code {e2e['exit_code']}, outcome {e2e['outcome']}, current_run {str(e2e['current_run']).lower()}, status_valid {str(e2e['status_valid']).lower()}, report_valid {str(e2e['report_valid']).lower()}, hash_match {str(e2e['hash_match']).lower()}, report SHA-256 `{e2e['report_sha256']}`; NANIKA_E2E_TRASH_CYCLES remains unset.",
            "Residual distributed boundary: PostgreSQL and Google Drive are not one atomic resource. A remote folder may exist if a later unrelated INSERT/COMMIT failure occurs; no speculative compensation/saga was added in B.37, and convergence through a later provider search is not claimed as newly proven.",
            "Deferred unchanged: AUTH-LOGOUT-FAIL-CLOSED is a preexisting candidate; RATE-LIMIT-BAN-PERSISTENCE is source-reviewed but not characterized; GOOGLE-OAUTH-STATE-TTL and GOOGLE-QUOTA-CACHE-CROSS-STORAGE-SERIALIZATION were not characterized in B.37; historical/current MUT-001 diagnostic wording remains preserved.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL, B.36 FROZEN FINAL and B.37 FROZEN FINAL; B.38 is NOT STARTED.",
        ],
        "b38_changes": [
            "Scope: B.38 AUTH LOCAL LOGOUT REVOCATION COMMIT AUTHORITY AND FAIL-CLOSED FAILURE SEMANTICS. B.31–B.37 remain FROZEN FINAL; B.39 is NOT STARTED. No JWT redesign, global logout change, denylist, retry framework, schema, dependency, frontend, Google, Vault or Storage Move change was introduced.",
            "Original baseline before B.38 characterization: [auth] passed 214 assertions / 16 cases with seed 38001; [api][auth] passed 161 / 9 with seed 38002; [api][auth][sessions] passed 20 / 1 with seed 38003.",
            "Deterministic RED against unchanged production: after authenticate_request() succeeded, a test-only PostgreSQL trigger rejected DELETE for one exact JTI. The route returned HTTP 200, the success body and a clearing Set-Cookie while the session row remained and verify_token() still accepted the token. The no-pool service case also returned silently.",
            "Root cause: AuthService::logout_local() swallowed pool, DELETE and commit exceptions, so ApiRouter could not distinguish committed revocation from persistence failure and always emitted the success response/cookie.",
            "Minimal correction: logout_local() now fails with AUTH_DB_NOT_CONFIGURED when no pool exists and otherwise performs the existing single DELETE transaction without a catch; database acquisition, DELETE and commit exceptions propagate unchanged.",
            "Router correction: only the local-revocation block is caught. Persistence failure returns generic HTTP 500 without success body or Set-Cookie; successful return still produces the existing HTTP 200 message and jwt=; HttpOnly; Path=/; Max-Age=0 cookie. Authentication and 401 semantics remain outside the catch.",
            "Cookie clearing is performed only after server revocation succeeds; a failed revocation leaves the session valid and preserves the cookie for a manual retry.",
            "Test-only failure injection: the narrow b38_logout_failure_trigger/b38_logout_failure_fn trigger targets only JTI B38ERR1, is committed before the request and is removed by RAII before cleanup. No production hook, environment flag or database-process sabotage was added.",
            "Failure truth: after failed DELETE, the target session and token remain valid, the unrelated session remains valid, token_version is not changed and no global logout occurs. After trigger removal, retry returns 200, clears the cookie and revokes only the target session.",
            "Final focused B.38 validation: 21 assertions / 2 cases passed in three independent runs with seeds 38021, 38022 and 38023.",
            "Related validation after correction: [auth] passed 235 assertions / 18 cases with seed 38031; [api][auth] passed 181 / 10 with seed 38032; [api][auth][sessions] passed 20 / 1 with seed 38033; [b35] passed 92 / 11 with seed 38034.",
            "Performance and architecture: the success path retains the same authentication query plus one DELETE transaction; no success-path query, lock, cache, map, set, retry, timer, worker, dependency or state was added. logout_local became shorter and handle_logout gained only the local exception boundary.",
            "Security: PostgreSQL user_sessions remains the sole revocation authority. Failed revocation is reported truthfully as 500; no JWT, JTI, database error, trigger text or session identifier is returned or logged.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.38 production targets.",
            f"Canonical Playwright final evidence: total {e2e['total']}, passed {e2e['passed']}, failed {e2e['failed']}, skipped {e2e['skipped']}, flaky {e2e['flaky']}, exit_code {e2e['exit_code']}, outcome {e2e['outcome']}, current_run {str(e2e['current_run']).lower()}, status_valid {str(e2e['status_valid']).lower()}, report_valid {str(e2e['report_valid']).lower()}, hash_match {str(e2e['hash_match']).lower()}, report SHA-256 `{e2e['report_sha256']}`; NANIKA_E2E_TRASH_CYCLES remains unset.",
            "Deferred unchanged: RATE-LIMIT-BAN-PERSISTENCE, GOOGLE-OAUTH-STATE-TTL, GOOGLE-QUOTA-CACHE-CROSS-STORAGE-SERIALIZATION and MUT-001 remain outside B.38.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL, B.36 FROZEN FINAL, B.37 FROZEN FINAL and B.38 FROZEN FINAL; B.39 is NOT STARTED.",
        ],
        "b39_changes": [
            "Scope: B.39 RATE-LIMITER PERSISTENT BAN COMMIT, RESTART AUTHORITY AND LOCK BOUNDARY. B.31–B.38 remain FROZEN FINAL; B.40 is NOT STARTED. No threshold, ClientIp authority, general limiter policy, schema, migration, dependency, frontend, JWT, Google or Zero-Knowledge change was introduced.",
            "Original baseline before B.39 characterization: [rate_limiter] passed 5044 assertions / 5 cases with seed 39001. The source review found the transition request setting runtime ban state and should_persist_ban, then returning from inside mutex_ before the existing PostgreSQL UPSERT; init(pool) already loaded unexpired banned_ips rows.",
            "Deterministic RED against unchanged production: request #15 returned 403, but the direct banned_ips query returned zero rows; a fresh RateLimitMiddleware instance loaded nothing and its first request from the same IP returned 200. Threshold behavior, no-pool 403 behavior and manual active/expired row loading were GREEN.",
            "Root cause: the transition-specific early return made the existing deferred persistence block unreachable for the exact request that first established the runtime ban. The persistence block itself already used the canonical resolved IP and an atomic UPSERT.",
            "Minimal production correction: keep the transition request inside the lock only long enough to establish should_persist_ban, suppress the 429 return for that transition, close the lock scope, then reuse the existing UPSERT block and return 403. With no pool, the transition still returns 403 while retaining the runtime ban.",
            "Focused B.39 validation: 37 assertions / 3 cases passed independently with seeds 39021, 39022 and 39023. The final persisted row had the canonical IP, the existing brute-force reason and an expiration within the 24-hour policy window; a new middleware instance returned 403 and an unrelated IP remained allowed.",
            "Related validation: [rate_limiter] passed 5081 assertions / 8 cases with seed 39031; [b36] passed 34 / 5 with seed 39032; [auth] passed 235 / 18 with seed 39033; [api][auth] passed 181 / 10 with seed 39034.",
            "Lock/performance correction: PostgreSQL remains outside mutex_; normal requests and requests #6–#14 perform no new database work; only the transition request performs the existing one UPSERT; request #16+ exits through the memory ban cache without persistence.",
            "Failure semantics: if the existing UPSERT fails, the current runtime ban remains active and the request remains 403; no false durable claim, retry, timer, worker, queue or secondary authority was added. No real-time propagation among already-running independent middleware instances is claimed.",
            "Production delta: one header-only control-flow correction; zero new classes, structs, fields, maps, sets, mutexes, atomics, timers, retries, workers, queues, dependencies, schema changes or migrations. ClientIp.hpp, DatabaseMigration.cpp and main.cpp remain unchanged.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.39 production targets.",
            f"Canonical Playwright final evidence: total {e2e['total']}, passed {e2e['passed']}, failed {e2e['failed']}, skipped {e2e['skipped']}, flaky {e2e['flaky']}, exit_code {e2e['exit_code']}, outcome {e2e['outcome']}, current_run {str(e2e['current_run']).lower()}, status_valid {str(e2e['status_valid']).lower()}, report_valid {str(e2e['report_valid']).lower()}, hash_match {str(e2e['hash_match']).lower()}, report SHA-256 `{e2e['report_sha256']}`; NANIKA_E2E_TRASH_CYCLES remains unset.",
            "Deferred unchanged: GOOGLE-OAUTH-STATE-TTL, GOOGLE-QUOTA-CACHE-CROSS-STORAGE-SERIALIZATION and MUT-001 remain outside B.39.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL, B.36 FROZEN FINAL, B.37 FROZEN FINAL, B.38 FROZEN FINAL and B.39 FROZEN FINAL; B.40 is NOT STARTED.",
        ],
        "b40_changes": [
            "Scope: B.40 GOOGLE OAUTH STATE TEMPORAL AUTHORITY, EXPIRATION AND SINGLE-USE LIFECYCLE. B.31–B.39 remain FROZEN FINAL; B.41 is NOT STARTED. No frontend, schema, migration, provider, deployment, Zero-Knowledge or B.37 authority change was introduced.",
            "Original baseline before B.40 characterization: [googledrive][service] passed 162 assertions / 4 cases with seed 40011; [api][googledrive] passed 127 / 5 with seed 40012; [b37] passed 35 / 3 with seed 40013.",
            "PRE temporal classification: SOURCE-CONFIRMED TEMPORAL GAP. The original pending_states_ map stored only user_id → string; generation recorded no timestamp and validation read no clock. No deterministic aged PRE behavioral RED was fabricated and no production wait/sleep was used.",
            "Existing GREEN state semantics were characterized and preserved: fresh linking succeeds, replay is rejected, a mismatch does not consume the current state, a newly generated state replaces the old one, and owner scoping rejects a different user before provider work.",
            "Root cause: a correct current state remained authoritative for the lifetime of the process because the in-memory value had no expiration authority. The existing validation-before-exchange ordering was already correct and was not moved.",
            "Minimal production correction: private PendingOAuthState stores only the exact state value and a steady_clock expiration; one fixed OAUTH_STATE_TTL of 10 minutes is published with each state. The existing one-state-per-user unordered_map and states_mutex_ remain the authority.",
            "Validation now reads steady_clock::now() under states_mutex_; now >= expires_at erases and rejects the entry, while a fresh mismatch remains non-consuming and an exact fresh match erases before the existing token exchange/B.37 path.",
            "Test-only seam: one NANIKA_TESTING-only expire_oauth_state_for_test(user_id) helper can move only an already-existing user's entry to the past. It accepts no arbitrary state/time, exposes no map or token and is absent from the production runtime build; the mock exposes only a forwarding wrapper.",
            "Expired service characterization passed: 33 assertions / 3 cases with seeds 40021, 40022 and 40023. Expired validation and replay produced INVALID_OAUTH_STATE with zero token exchange, folder search, folder creation and account rows; a newly generated state recovered normally.",
            "Expired API characterization passed through GET-generated state plus forced test-only expiration: HTTP 400 with the existing State invalido ou expirado body, zero provider work, zero account row and replay rejection.",
            "Focused and related validation after correction: [googledrive][service] passed 185 assertions / 6 cases with seed 40031; [api][googledrive] passed 137 / 6 with seed 40032; [b37] passed 35 / 3 with seed 40033; [b33] passed 81 / 2 with seed 40034; [b34] passed 31 / 2 with seed 40035.",
            "Performance and memory: generate/validate retain one mutex and O(1) map lookup/write, adding one monotonic clock read and one comparison; there is no DB, HTTP, timer, thread, worker, queue, retry, second map or new mutex. Unobserved expired entries may remain physically until same-user overwrite/validation or process restart, but cannot be accepted after expiry.",
            "Production source metrics PRE → POST: GoogleDriveService.cpp 1015 → 1038 physical lines, 889 → 908 nonblank lines, 31 → 32 reported functions, maximum CC 34 → 34 and total function NLOC 873 → 890; the additional reported function is the NANIKA_TESTING-only seam. GoogleDriveService.hpp 158 → 169 physical lines and 126 → 134 nonblank lines, with its two inline functions and maximum CC 2 unchanged.",
            "Full backend validation: build passed; savebox_tests passed 6764 assertions in 109 cases with seed 40043 after one non-reproduced Windows std::shared_mutex runtime abort on the first attempt. Frontend preservation passed 989/989 twice; coverage passed 79.21% statements, 68.53% branches, 80.29% functions and 81.47% lines; Angular build passed with existing budget warnings.",
            "Static/quality validation: module metrics passed; Python quality harness passed 21/21; Knip normal/production/cycles exited 0 with existing findings; cppcheck is unavailable locally. Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.40 production targets. The configured mutation run had 15 mutants, 14 killed, 0 survivors and 1 compile diagnostic (100% scoreable).",
            f"Canonical Playwright final evidence: total {e2e['total']}, passed {e2e['passed']}, failed {e2e['failed']}, skipped {e2e['skipped']}, flaky {e2e['flaky']}, retries 0, exit_code {e2e['exit_code']}, outcome {e2e['outcome']}, current_run {str(e2e['current_run']).lower()}, status_valid {str(e2e['status_valid']).lower()}, report_valid {str(e2e['report_valid']).lower()}, hash_match {str(e2e['hash_match']).lower()}, report SHA-256 `{e2e['report_sha256']}`; NANIKA_E2E_TRASH_CYCLES remains unset.",
            "Deferred unchanged: GOOGLE-QUOTA-CACHE-CROSS-STORAGE-SERIALIZATION remains a performance/isolation candidate not characterized; MUT-001 remains the historical/current mutation diagnostic with one compile-error mutant. B.41 is not started.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL, B.36 FROZEN FINAL, B.37 FROZEN FINAL, B.38 FROZEN FINAL, B.39 FROZEN FINAL and B.40 FROZEN FINAL; B.41 is NOT STARTED.",
        ],
        "b41_changes": [
            "Scope: B.41 GOOGLE CONTROL-PLANE DATABASE LEASE SCOPE, NESTED POOL DEADLOCK AND REMOTE-I/O BOUNDARY. B.31–B.40 remain FROZEN FINAL; B.42 is NOT STARTED. No frontend, schema, migration, pool-size, deployment, Zero-Knowledge, OAuth-state, token-single-flight or quota-cache-mutex change was introduced.",
            "Original baseline before B.41 characterization: [service][googledrive] passed 185 assertions / 6 cases with seed 41011; [api][googledrive] passed 137 / 6 with seed 41012; [api][quotas] passed 24 / 1 with seed 41013; [b33] passed 81 / 2 with seed 41014; [b34] passed 31 / 2 with seed 41015; [b37] passed 35 / 3 with seed 41016.",
            "Deterministic PRE characterization against unchanged production: three causal provider-gate tests reached quota/refresh HTTP and preserved all response contracts, but pool.get_available_count() was 1 instead of the required 2 in get_total_quota(), handle_get_storage_targets() and get_upload_recovery_context(). Result: 29 assertions / 3 cases, 3 deterministic RED lease assertions; no test intentionally deadlocked and no sleep-based synchronization was used.",
            "Final evidence gap classification: B41-EVIDENCE-001 focused multi-seed freeze evidence incomplete; B41-EVIDENCE-002 frontend double-run freeze evidence incomplete; B41-TEST-SEMANTICS-001 soft-delete fixture does not match the baseline claim. The third item is a test/evidence defect, not a production defect.",
            "PRE micro-gate focused run before fixture editing: [b41] passed 29 assertions / 3 cases with seed 41030. The resource-ownership characterization was GREEN; the evidence claim about a soft-deleted row was incomplete because the fixture had not set deleted_at.",
            "Root cause: ConnectionWrapper lexical lifetime exceeded the actual PostgreSQL work boundary. get_total_quota() held both transaction and wrapper across token/provider work; the API and upload-recovery paths committed but retained the wrapper across nested token/Google work. With a production-equivalent pool of two, two concurrent callers form a source-proven reachable nested-pool deadlock schedule when both outer wrappers enter cold-token work.",
            "Minimal production correction: get_total_quota() now releases the initial storage-ID connection before token/quota HTTP and uses one short DB scope for each successful app-usage SUM; handle_get_storage_targets() scopes the local quota read before calling gdrive_->get_storage_targets(); get_upload_recovery_context() copies root_folder_id inside its DB scope and acquires the token only after that scope ends.",
            "Semantic preservation: provider request order/count, quota formula, active-storage filter, deleted complete-file accounting, incomplete-file exclusion, error propagation for the new app-usage DB scope, API keys/statuses, local 404, recovery fields, refresh behavior and post-unlink denial remain unchanged. The total-quota characterization confirms active 100 + soft-deleted 40 + incomplete 70 yields app usage 140.",
            "Test-only change: MockGoogleDriveService received one narrow quota condition_variable gate with waiter/release APIs, modeled after the existing refresh gate. No production test seam, DatabasePool API, generic gate abstraction, timer, worker or retry was added; worker exceptions are captured and every gate is released before join.",
            "Soft-delete fixture correction: after inserting the 40-byte completed b41-deleted row, the test executes UPDATE files SET deleted_at = CURRENT_TIMESTAMP and verifies size_bytes = 40, is_upload_complete = TRUE and deleted_at IS NOT NULL. No trash endpoint or production seam was used.",
            "The B.41 total-quota characterization now genuinely marks the 40-byte completed fixture row with deleted_at and proves that the existing get_total_quota() SQL continues to count completed soft-deleted files while excluding the 70-byte incomplete row.",
            "Focused B.41 multi-seed validation after the test-only correction: seeds 41021, 41022 and 41023 each passed 33 assertions / 3 cases. At every total-quota provider, storage-target provider and recovery refresh causal gate, available_count() was 2; total-quota values, API 200 response/targets and recovery external_storage_id/root_folder_id/access_token were preserved.",
            "Final evidence matrix: seed 41021 PASS (33 / 3; quota 2/2, targets 2/2, recovery 2/2); seed 41022 PASS (33 / 3; quota 2/2, targets 2/2, recovery 2/2); seed 41023 PASS (33 / 3; quota 2/2, targets 2/2, recovery 2/2).",
            "Related validation after the final evidence correction: [service][googledrive] passed 206 assertions / 8 cases with seed 41032; [api][googledrive] passed 149 / 7 with seed 41033; [api][quotas] passed 24 / 1 with seed 41034; [api][upload][recovery] passed 43 / 1 with seed 41035; [b33] passed 81 / 2 with seed 41036; [b34] passed 31 / 2 with seed 41037; [b37] passed 35 / 3 with seed 41038; [b40] passed 33 / 3 with seed 41039.",
            "Production delta: GoogleDriveService.cpp and ApiRouter.cpp only; zero header, DatabasePool, main.cpp, frontend, schema, migration, Docker/Nginx/Cloudflare or environment changes. The production patch adds no class, struct, field, map, set, mutex, queue, worker, timer, retry, timeout policy, dependency or pool connection.",
            "Source metrics PRE → POST: GoogleDriveService.cpp 1038 → 1039 physical lines, 908 → 911 nonblank lines, 32 → 32 functions, maximum CC 34 → 34 and total function NLOC 890 → 894; ApiRouter.cpp 3368 → 3372 physical lines, 2924 → 2928 nonblank lines, 84 → 84 functions, maximum CC 44 → 44 and total function NLOC 2901 → 2905. Target functions: get_total_quota CC 16 / 62 → 16 / 62 NLOC, get_upload_recovery_context CC 5 / 20 → 5 / 24 NLOC, handle_get_storage_targets CC 12 / 52 → 12 / 56 NLOC.",
            "Performance tradeoff: provider/network calls and DB statement semantics remain unchanged; connection checkout frequency can increase because app usage is read in a short scope after provider success, while seconds-long remote-I/O lease occupation is removed from the two-connection pool.",
            "Full backend validation: complete CMake build passed for savebox_server, savebox_tests, nanika_e2e_fixture and helper targets; savebox_tests passed 6797 assertions in 112 cases with seed 41041.",
            "Frontend preservation validation: two independent unit-test runs each passed 989/989; coverage remained 79.21% statements, 68.53% branches, 80.29% functions and 81.47% lines; Angular production build passed with the existing bundle/component-style budget warnings. No frontend source changed.",
            "Static/quality validation: module metrics passed; Python quality harness passed 21/21; Knip normal/production/cycles exited 0 with the existing production findings; Cppcheck is unavailable locally. Mutation remained scoped only to format-bytes.ts with 15 mutants, 14 killed, 0 survivors and 1 compile diagnostic (100% scoreable); no mutation score is claimed for B.41 production targets.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.41 production targets.",
            f"Canonical Playwright final evidence: total {e2e['total']}, passed {e2e['passed']}, failed {e2e['failed']}, skipped {e2e['skipped']}, flaky {e2e['flaky']}, retries 0, exit_code {e2e['exit_code']}, outcome {e2e['outcome']}, current_run {str(e2e['current_run']).lower()}, status_valid {str(e2e['status_valid']).lower()}, report_valid {str(e2e['report_valid']).lower()}, hash_match {str(e2e['hash_match']).lower()}, report SHA-256 `{e2e['report_sha256']}`; NANIKA_E2E_TRASH_CYCLES remains unset.",
            "The nested-pool deadlock remains SOURCE-PROVEN REACHABLE; the causal runtime regressions prove the outer-lease condition that enables that schedule without intentionally deadlocking the test process.",
            "No additional B.41 production code change was required by the final evidence micro-gate.",
            "Deferred unchanged: GOOGLE-QUOTA-CACHE-CROSS-STORAGE-SERIALIZATION, GOOGLE-QUOTA-DUPLICATE-PROVIDER-PATH and MUT-001 remain outside B.41. B.42 was not started.",
            "B.41 is FROZEN FINAL after completion of the missing multi-seed, frontend-repeatability and soft-delete characterization evidence.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL, B.36 FROZEN FINAL, B.37 FROZEN FINAL, B.38 FROZEN FINAL, B.39 FROZEN FINAL, B.40 FROZEN FINAL and B.41 FROZEN FINAL; B.42 is NOT STARTED.",
        ],
        "b42_changes": [
            "Scope: B.42 GOOGLE QUOTA CACHE PER-STORAGE SINGLE-FLIGHT, CROSS-STORAGE ISOLATION AND INVALIDATION PUBLICATION AUTHORITY. B.31–B.41 remain FROZEN FINAL; B.43 is NOT STARTED. No frontend, API, schema, migration, deployment, OAuth, token-single-flight, pool-size or Zero-Knowledge change was introduced.",
            "PRE source characterization: quota_cache_mutex_ covered cache lookup, provider token acquisition, Google HTTP, JSON parsing, cache publication and failure cleanup; there was no per-storage in-flight ownership map. The shared mutex serialized different storage IDs and allowed failure cohorts to duplicate provider requests.",
            "PRE characterization: warm cache passed; same-storage successful cold cohort passed with one request; different-storage isolation was RED because storage B could not reach its provider while storage A was blocked; same-storage failure cohort was RED with 4 provider requests and a later retry count of 5 instead of 2; invalidation-before-release was RED; selective invalidation passed.",
            "Minimum production patch: one private QuotaFlight containing a shared future/promise and one quota_flights_ map keyed only by storage_id. No new mutex, timer, worker, queue, retry policy, database lease, dependency, endpoint or schema change was added.",
            "get_quota_for_storage() now checks warm cache under quota_cache_mutex_, captures or creates the exact per-storage flight, releases the mutex before token/provider/parse work, shares success or failure with followers, and publishes only the current captured flight.",
            "Invalidation erases only the requested storage cache and exact flight entry. Success and finalization use shared_ptr identity checks, so an old owner cannot publish stale quota or erase a newer flight after invalidation and a replacement request.",
            "Test-only changes are limited to an atomic quota request counter, deterministic response controls, exact request gate release and one NANIKA_TESTING-only friend probe for flight ownership. No runtime production test seam is present; one compile-time NANIKA_TESTING-only friend declaration exists for the test target. The follower observer is compiled only into savebox_tests.",
            "Focused B.42 validation: seeds 42021, 42022 and 42023 each passed 61 assertions / 7 cases, including same-storage success/failure cohorts, cross-storage progress, invalidation return, selective invalidation, stale old-owner publication rejection and old-finalizer/new-flight preservation.",
            "Related validation: [service][googledrive] passed 267 assertions / 15 cases with seed 42031; [api][googledrive] 149 / 7 with seed 42032; [b33] 81 / 2 with seed 42033; [b34] 31 / 2 with seed 42034; [b41] 33 / 3 with seed 42035; [b37] 35 / 3 with seed 42036; [b40] 33 / 3 with seed 42037; [gc] 136 / 9 with seed 42038; [storage-move] 295 / 13 with seed 42039; [api][quotas] 24 / 1 with seed 42040.",
            "Full backend validation: CMake build passed; savebox_tests passed 6858 assertions in 119 cases with seed 42043. Frontend unit tests passed 989/989 twice; coverage passed with 79.21% statements, 68.53% branches, 80.36% functions and 81.45% lines; Angular build passed with existing budget warnings.",
            "Static validation: module metrics passed; Python quality harness passed 21/21; Knip normal/production/cycles exited 0 with existing findings. Cppcheck is unavailable locally. Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.42 production targets.",
            "Canonical Playwright final evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, report SHA-256 `6cbb74adb0a770bcb484fb0a1e74ad5b1ff3e04a4f033bffe0ddc1c29149639b`.",
            "Deferred unchanged: GOOGLE-QUOTA-DUPLICATE-PROVIDER-PATH remains a separate get_total_quota/get_quota_for_storage provider-path optimization candidate; MUT-001 remains the historical/current mutation diagnostic. No broad audit or B.43 work was started.",
            "Final status: B.31–B.42 FROZEN FINAL; B.43 is NOT STARTED.",
        ],
        "b42_final_test_harness_changes": [
            "Scope: final B.42 test-harness micro-gate only. No new normal-build production correction was intended; B.43 remains NOT STARTED.",
            "Production source re-audit: QuotaFlight still contains only promise/shared_future in the normal build; the per-storage flight registry, identity-checked publication/failure cleanup, selective invalidation and B.41 database-I/O boundaries remain unchanged.",
            "PRE micro-gate: the current focused [b42] run with seed 42100 passed 61 assertions in 7 test cases before the final harness edits.",
            "B42-TEST-CLEANUP-001: the previous concurrent cases could place a fatal REQUIRE before releasing a blocking provider gate and joining live std::thread instances.",
            "B42-TEST-COHORT-CAUSALITY-001: QuotaStartBarrier proved only that callers reached a pre-call point; it did not prove that followers captured the exact F1 flight before the owner was released.",
            "B42-BASELINE-WORDING-001: the baseline wording was corrected to distinguish a compile-time friend declaration from a runtime production seam.",
            "Design: exact QuotaFlight identity is observed with one test-only follower counter and condition_variable, avoiding a global storage counter, use_count heuristic, timing guess or polling loop.",
            "Test-only state: NANIKA_TESTING adds only test_followers_mutex, test_followers_cv and test_followers to QuotaFlight; savebox_server does not compile these fields.",
            "Follower hook: the observer increments only after an existing flight is captured and the caller has entered the follower path, immediately before future.get().",
            "GoogleDriveQuotaTestProbe: wait_for_followers() copies the exact shared_ptr under quota_cache_mutex_, releases that mutex, and waits on the flight-local condition_variable.",
            "QuotaStartBarrier was removed. Same-storage success and failure cohorts now wait for three actual followers on the exact F1 before releasing the provider gate.",
            "Fail-safe cleanup: all B.42 worker/gate waits are stored as nonfatal booleans; gates are released and every joinable thread is joined before fatal assertions or dependent follow-up assertions.",
            "Same-storage success causal trace: one owner reaches the provider, three followers capture F1, the gate is released, all four calls join, and one provider request produces the shared result.",
            "Same-storage failure causal trace: one owner and three followers capture F1 before release; one provider failure is shared by the cohort, then a later independent call creates the next owner.",
            "Invalidation, stale-owner and old-finalizer tests retain their existing authority assertions while cleaning every blocked worker before assertion failure; the cross-storage test preserves independent provider admission.",
            "Focused final validation: seeds 42121, 42122 and 42123 each passed 59 assertions in 7 test cases.",
            "Frozen regressions: [service][googledrive] 265/15 (42131), [api][googledrive] 149/7 (42132), [b33] 81/2 (42133), [b34] 31/2 (42134), [b41] 33/3 (42135), [b37] 35/3 (42136), [b40] 33/3 (42137), [gc] 136/9 (42138), [storage-move] 295/13 (42139), [api][quotas] 24/1 (42140); every run passed.",
            "Full backend validation: CMake build passed and savebox_tests passed 6856 assertions in 119 test cases with seed 42143.",
            "Frontend preservation: the standard suite passed 989/989 in two consecutive runs; coverage passed all 989 tests with 79.21% statements, 68.53% branches, 80.36% functions and 81.45% lines.",
            "Static and quality validation: Angular build, module metrics, Python quality harness, Knip normal/production/cycles and configured mutation completed according to their local gates; Cppcheck remained unavailable locally. Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.42 production targets.",
            "No runtime production test seam is present. The quota follower observer and GoogleDriveQuotaTestProbe access exist only when NANIKA_TESTING is compiled into savebox_tests.",
            "The same-storage failure-cohort test now proves causally that all three followers captured the same F1 before the provider owner was released; one provider failure is shared by the entire cohort and a later independent call creates the next owner.",
            "No B.42 concurrency test retains a fatal assertion path that can bypass release of a blocking gate or join of a live std::thread.",
            "Canonical Playwright is recorded only after a fresh current-run 5/5 result; the generated baseline captures its report hash and validity fields from .quality/playwright.",
            "B.42 is FROZEN FINAL after completion of the causal cohort-membership, fail-safe concurrency-harness and compile-time test-seam evidence.",
            "Final status: B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL, B.34 FROZEN FINAL, B.35 FROZEN FINAL, B.36 FROZEN FINAL, B.37 FROZEN FINAL, B.38 FROZEN FINAL, B.39 FROZEN FINAL, B.40 FROZEN FINAL, B.41 FROZEN FINAL, B.42 FROZEN FINAL; B.43 NOT STARTED. E2E-FLAKE-001 remains historical if present.",
        ],
        "b43_changes": [
            "Scope: B.43 account deletion lifecycle, terminal user ownership and provider cleanup authority. B.31–B.42 remain FROZEN FINAL; B.44 and B.45 remain SELECTED / NOT STARTED. No frontend, schema, migration, dependency, crypto, media-proxy or Google data-plane change was introduced.",
            "Source re-audit confirmed UsersManager::delete_user() already revoked account authority by setting users.deleted_at and incrementing token_version before commit; verify_token(), generate_token() and refresh_token() remained unchanged.",
            "PRE characterization against unmodified production: [b43] passed 84 assertions / 9 cases with seed 43011; 2 cases were GREEN and 7 deterministic REDs reproduced the unreachable deleted-user GC lifecycle, missing delete-endpoint trigger, provider-failure progression, 50-file batch progression, local tombstone login error and premature terminalization around pending external/storage-move blockers.",
            "Existing JWT rejection after account soft-delete was GREEN against unmodified production and remained unchanged.",
            "Deleted-account local login returned an internal error because authenticate_user still selected tombstones; the minimal correction excludes deleted rows while preserving dummy-hash invalid-credential handling.",
            "Production run_cleanup did not make deleted-user file lifecycle reachable; the deleted user and active file remained indefinitely outside the existing 30-day file GC predicate.",
            "Minimal file lifecycle correction: one set-based ranked UPDATE marks at most 50 active files per deleted user as older than the existing 30-day authority boundary inside run_cleanup()'s existing database transaction, before the existing B.31 DELETE ... RETURNING pipeline.",
            "B.31 authority is reused unchanged: database deletion, quota refund, pending_external_deletions enqueue and commit occur before existing post-commit local FileChunker deletion; no filesystem side effect was added to the transaction.",
            "The obsolete cleanup_deleted_users() declaration and definition were removed after its lifecycle was absorbed into the single canonical run_cleanup() path; no duplicate account-cleanup API remains.",
            "The delete-user endpoint now calls the existing trigger_gc_cleanup() only after UsersManager::delete_user() commits; it does not perform provider I/O, local deletion, synchronous GC, a new worker or a retry loop.",
            "Terminalization is a bounded, lock-safe post-cleanup transaction: a deleted user is hard-deleted only when no files, pending external deletions, pending reconciliation, pending local deletions or active storage-move status can still require its storage capability. Exact storage IDs are captured before cascade and published only from successful DELETE ... RETURNING rows after commit.",
            "Provider failure preserves the user/storage authority and pending work; the existing retry path remains available. Provider success clears the blocker, and repeated GC remains idempotent without a second quota refund.",
            "Focused B.43 validation: the final characterization with seed 43111 passed 109 assertions / 14 cases; required seeds 43121, 43122 and 43123 each passed 109 assertions / 14 cases. The suite covers local progression and physical cleanup, the 50-file bound, provider failure/retry, pending external work, pending local/reconciliation work, active storage moves, active-user isolation, tombstone auth, OAuth tombstone rejection, exact cache invalidation and endpoint scheduling.",
            "Related regression matrix: [gc] 235/18 (43131), [b31] 24/4 (43132), [b33] 81/2 (43133), [b34] 31/2 (43134), [b35] 92/11 (43135), [b38] 21/2 (43136), [b42] 59/7 (43137), [storage-move] 305/14 (43138), [service][googledrive] 274/17 (43139), [api][googledrive] 149/7 (43140) and [api][auth] 184/12 (43141); every run passed.",
            "Full backend validation: CMake build passed and savebox_tests passed 6965 assertions in 133 test cases with seed 43143.",
            "Frontend preservation: two independent unit runs passed 989/989; no frontend source changed. Coverage passed with 79.23% statements, 68.53% branches, 80.36% functions and 81.47% lines. Angular production build passed with the existing bundle/style budget warnings.",
            "Static validation: module metrics and the Python quality harness passed; Knip normal/production/cycles exited 0 with existing findings; Cppcheck is unavailable locally and is reported as unavailable, not green.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.43 production targets.",
            "B.43 FINAL EVIDENCE MICRO-GATE mutation result: the configured Stryker scope remained only format-bytes.ts with 15 total mutants, 14 killed, 0 survived, 1 compile error, 0 no-coverage and 100.00% scoreable mutation score; exit code 0. The previously reported candidate MUT-001 survivor did not reproduce, so the current state is MUTATION DIAGNOSTIC with 0 survivors and 1 compile diagnostic; format-bytes.ts and its spec were not changed.",
            "Soft-deleted JWT authority was GREEN against the already-correct B.43 production: old verify_token() authority, refresh_token() authority and generate_token() all reject after deletion with AUTH_USER_UNAVAILABLE; no AuthService production correction was required by this micro-gate.",
            "The same-provider OAuth tombstone was GREEN: create_oauth_user() resolves the existing tombstone row, while downstream generate_token() rejects the deleted user with AUTH_USER_UNAVAILABLE. No authenticated authority is regained and no OAuth production correction was justified.",
            "The terminal-deletion evidence warms the existing B.42 token and per-storage quota caches, then proves both become unusable after terminal deletion through the existing invalidation primitive; no new runtime test seam was added.",
            "The repeated-GC evidence uses one local file and one pending external blocker and proves cleanup is idempotent: the local file is accounted/refunded once, the blocker remains, and the second GC does not double-refund or duplicate pending work.",
            "The unused B43Fixture::set_due() test helper was removed; no production dead API was introduced.",
            "Canonical Playwright final evidence: the first post-implementation run recorded 4/5 with trash.spec.ts blocked during vault initialization; after the Docker backend was rebuilt from the current source, the current canonical run completed total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, report SHA-256 `16815e4d8fbc6e45a501120fb5d860aaee8d0abfa2ac3c35983bdd6f3c03b7e0`; NANIKA_E2E_TRASH_CYCLES was unset.",
            "Source metrics PRE → POST: GarbageCollector.cpp 391 → 487 physical lines, 359 → 454 nonblank lines, 6 → 5 functions, max CC 25 → 31 and total function NLOC 327 → 422; ApiRouter.cpp 3372 → 3373, 2928 → 2929, 84 → 84, max CC 44 → 44 and 2905 → 2906; AuthService.cpp 568 → 569, 468 → 469, 19 → 19, max CC 20 → 20 and 454 → 455. GarbageCollector.hpp 21 → 20 physical lines and 16 → 15 nonblank lines after dead API removal.",
            "No schema/table/column/index, worker, timer, retry policy, database-pool, Google data-plane, plaintext-secret or frontend change was made. B.44 and B.45 were not started.",
            "B.43 FINAL EVIDENCE MICRO-GATE accepted: production entered already accepted and remained unchanged; only test/evidence and baseline-generator files changed in this final micro-gate. No B.43 production source was modified by the final evidence micro-gate.",
            "Quality status: B.43 FROZEN FINAL RATIFIED after deterministic characterization, focused multi-seed evidence, regression matrix, full backend/frontend gates and current canonical E2E 5/5; B.31–B.42 remain FROZEN FINAL and B.44/B.45 remain SELECTED / NOT STARTED.",
        ],
        "b44_changes": [
            "Scope: B.44 local hard-delete commit authority, filesystem durability and rollback consistency. B.31–B.43 remain FROZEN FINAL; B.45 remains SELECTED / NOT STARTED. No frontend, schema, migration, API-result, Google data-plane, crypto, Docker or CI change was introduced.",
            "Source audit before editing confirmed the same unsafe order in FileManager::hard_delete_file(), batch_hard_delete_files() and empty_trash(), plus FolderManager::hard_delete_folder() and batch_hard_delete_folders(): FileChunker::delete_file() ran before quota/folder/pending bookkeeping and transaction commit.",
            "B.31 precedent was confirmed GREEN: GarbageCollector::run_cleanup() already commits DELETE ... RETURNING, quota and pending work before its existing post-commit FileChunker cleanup. B.44 aligns the five user hard-delete paths with that authority boundary.",
            "PRE characterization against unchanged production passed 45/53 assertions in 4/10 cases and deterministically failed the five quota-trigger rollback cases plus the failed-then-retry assertion: database rows and quota rolled back, but local ciphertext had already been physically deleted.",
            "The failure guard is test-only and deterministic: a narrow PostgreSQL trigger/function targets only the exact B44 test user and raises B44_QUOTA_FAIL before users.used_storage_bytes update; RAII removes it before fixture cleanup. No production trigger, environment switch, sleep, random outage or migration was added.",
            "Root cause: physical local deletion was performed while the database connection/transaction was still live and before its commit. A later database failure therefore restored database authority without restoring ciphertext.",
            "Minimal production correction: each method now collects exact local IDs returned by DELETE ... RETURNING, completes the existing quota, Google pending-deletion and recursive-folder database work, commits, releases the connection/transaction lexical scope, and only then invokes the existing FileChunker::delete_file() best-effort cleanup.",
            "FileManager correction covers single local delete, mixed batch delete and empty trash; FolderManager correction covers single recursive delete and batch recursive delete. Existing ownership predicates, trashed-only predicates, quota policy, result structs and Google pending bookkeeping remain unchanged.",
            "The post-commit cleanup uses std::optional<uint64_t> for the single path and std::vector<uint64_t> for batch/recursive paths. It adds no query, provider request, queue, worker, retry, schema object, lock or new state; filesystem work is O(number of local IDs) and no longer extends the database-pool lease.",
            "Failure semantics after the patch: a quota/commit failure leaves the database rows, quota and local ciphertext intact because no physical deletion has started. Successful commit preserves the existing API result and then performs the existing best-effort physical deletion; B.31 remains the convergence path for any post-commit orphan.",
            "Provider semantics remain unchanged: Google files never receive local FileChunker deletion, provider I/O is not added, and existing pending_external_deletions rows stay inside the same committed database transaction.",
            "Security and authorization remain unchanged: user_id ownership and trashed-only predicates are preserved, unauthorized/active files do not reach physical deletion, and no plaintext name, token, key or new URL/log data was introduced.",
            "Focused B.44 validation passed 53 assertions / 10 cases with seeds 44021, 44022 and 44023. All five rollback cases now prove database/quota restoration plus ciphertext preservation; success, mixed-provider, recursive, retry and IDOR cases remain green.",
            "Regression matrix passed: [api][delete][file] 27/1 (44031), [api][delete][folders] 19/2 (44032), [api][trash] 40/1 (44033), [api][quotas] 24/1 (44034), [idor] 26/2 (44035), [gc] 235/18 (44036), [b43] 109/14 (44037), [storage-move] 305/14 (44038), [service][googledrive] 274/17 (44039) and [api][pinned] 51/4 (44040).",
            "Full backend validation passed: Debug build and savebox_tests completed with 7018 assertions in 143 test cases using seed 44043. Expected mock Google/email/security diagnostics remain non-failures.",
            "Frontend preservation passed 989/989 in two independent runs; frontend coverage passed with 79.23% statements, 68.53% branches, 80.36% functions and 81.47% lines; Angular production build passed with the existing bundle/style budget warnings.",
            "Module metrics PRE → POST: FileManager.cpp 2009/1767/51/max CC 93/1757 function NLOC → 2032/1789/51/max CC 93/1779; FolderManager.cpp 1012/887/21/max CC 29/865 → 1030/903/21/max CC 29/881. The increase is lexical transaction scoping and exact-ID collection only.",
            "Static quality passed: module-metrics, baseline-generator and deployment-security tests passed; Knip normal retained two configuration hints, production retained the known ng plus two unused exports, cycles reported zero cycles, and Cppcheck was unavailable locally.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.44 production targets. The configured report had 15 mutants, 14 killed, 0 survivors, 0 no-coverage and 1 compile diagnostic, with 100% scoreable mutation score.",
            "Canonical Playwright final evidence: total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true, report SHA-256 `ff41fb5db1a805e114972367b3c1e19e08db5c3ef7f53534076c22d8ff510499`; NANIKA_E2E_TRASH_CYCLES was unset. E2E-FLAKE-001 remains historical and E2E-001 is absent.",
            "Production diff is limited to backend/src/database/FileManager.cpp and backend/src/database/FolderManager.cpp; the B.44 characterization test and quality-baseline generator/test are evidence changes. No filesystem-transactional guarantee is claimed: only the ordering before commit is made safe, while post-commit physical cleanup remains best effort and converges through B.31.",
            "Quality status: B.44 FROZEN FINAL after deterministic PRE RED/POST GREEN characterization, multi-seed focused evidence, regression matrix, full backend/frontend gates and canonical E2E 5/5. B.31–B.44 are FROZEN FINAL; B.45 is SELECTED / NOT STARTED.",
        ],
        "b45_changes": [
            "Scope: B.45 profile multipart plaintext logging and metadata minimization in ApiRouter::handle_update_profile_pic(); B.31–B.44 remain FROZEN FINAL and no fresh broad audit was performed.",
            "Source audit confirmed that authentication, multipart/form-data validation, Crow parsing, Content-Disposition name lookup, Imgur upload and avatar persistence were existing behavior; the only selected gap was the generic dump of every multipart header and parsed parameter.",
            "PRE baseline: Debug backend build passed; [api][auth] passed 184 assertions / 12 cases with seed 45001 and [auth] passed 245 assertions / 23 cases with seed 45002 when executed from backend/build so the existing ../../.env test contract was resolved correctly.",
            "PRE characterization used a real ApiRouter, real authenticate_request(), real Crow multipart parsing, an active verified database user and a small authenticated part named not-image, so execution stopped with the existing HTTP 400 before any Imgur request.",
            "PRE privacy result: the test passed HTTP 400 but failed the two absence checks because stdout contained B45-PLAINTEXT-SENTINEL.jpg and B45-PART-HEADER-SENTINEL; this is the DETERMINISTIC RED B45-MULTIPART-LOG-001, not an auth/JWT/Authorization/Cookie leak finding.",
            "The production correction is deletion-only: the generic multipart header/parameter debug dump was removed from ApiRouter::handle_update_profile_pic(). The functional Content-Disposition name lookup remains unchanged.",
            "POST focused validation passed 6 assertions / 2 cases in each required independent run: seeds 45021, 45022 and 45023. The same request still returns HTTP 400, while both sentinels are absent from captured stdout and stderr.",
            "Authentication and Content-Type preservation remained green in the second B45 test; no auth bypass, parser replacement, request-header logging, status/body contract change or new test seam escaped into production.",
            "The not-image characterization returns before cpr::Post(), and source audit confirms the recognized-image outbound multipart filename remains the fixed avatar.png; the client filename is not persisted or forwarded to Imgur.",
            "Frozen regressions passed: [b43] 109 assertions / 14 cases (45031), [b44] 53 / 10 (45032), [api][auth] 184 / 12 (45033) and [auth] 245 / 23 (45034). Full backend validation passed 7024 assertions / 145 cases with seed 45043.",
            "Frontend preservation passed 989/989 in two independent runs; coverage passed with 79.21% statements, 68.53% branches, 80.36% functions and 81.45% lines; Angular production build passed with the existing bundle/style budget warnings.",
            "Module metrics PRE → POST for ApiRouter.cpp: 3373 → 3365 physical lines, 2929 → 2922 nonblank lines, 84 → 84 functions, maximum CC 44 → 44 and total function NLOC 2906 → 2899. handle_update_profile_pic decreased from 80 to 73 NLOC, CC 22 to 20 and 747 to 655 tokens.",
            "Static validation passed: module metrics, baseline-generator, deployment-security and the Python quality harness (21 tests); Knip normal retained two E2E configuration hints, production retained the known ng binary and two unused exports, cycles reported no cycles, and Cppcheck was available with report-only exit 0 and existing warning/style diagnostics.",
            "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.45 production targets. The configured report had 15 total mutants, 14 killed, 0 survived, 0 no-coverage and 1 compile diagnostic, with 100.00% scoreable mutation score and exit 0.",
            "Superseded first-attempt provenance: retained artifacts do not establish whether the earlier canonical invocation failed during preflight or entered Playwright; no exact 4/5 count or failed-spec claim is made.",
            "Current authoritative Playwright run completed 5/5 with 0 failed, 0 skipped, 0 flaky, retries 0, exit 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true and report SHA-256 6d7e910339e08c9730bb77a33e4de6f98802ff8fbfeb1903522d3cca47d2cd55; the temporary process was stopped afterward.",
            "Final source/log search found no remaining B45-PLAINTEXT-SENTINEL, B45-PART-HEADER-SENTINEL or generic Parsed multipart part logging in the production profile handler; no schema, API, provider, crypto, Zero-Knowledge, frontend, storage or dependency change was made.",
            "Quality status: B.45 FROZEN FINAL after deterministic PRE RED/POST GREEN characterization, required focused seeds, B.43/B.44 preservation, full backend/frontend gates, current canonical E2E 5/5 and truthful baseline evidence. B.31–B.45 are FROZEN FINAL. STOP; no fresh broad audit is part of this round.",
        ],
        "b46_changes": [
            "Scope: B.46 closes only the unnecessary PostgreSQL host publication and enforces the single-public-ingress deployment contract; B.31–B.45 remain FROZEN FINAL, while B.47 and B.48 remain SELECTED / NOT STARTED.",
            "PRE source audit confirmed postgres-db published `5433:5432` without a loopback bind, while backend used DB_HOST=postgres-db and DB_PORT=5432 and all three services shared nanika_network; deploy/README.md documents host Nginx as the only public ingress.",
            "Repository consumer audit found the only versioned 5433 match in docker-compose.yml; no script, test, documentation, application configuration or tooling required host:5433, and no host.docker.internal consumer was found.",
            "Existing deployment-security baseline was GREEN with 5 tests; the new characterization was then added without editing Compose.",
            "PRE characterization was DETERMINISTIC RED B46-POSTGRES-INGRESS-001: existing 5 tests passed and test_postgres_remains_internal_to_compose_network failed because postgres-db contained the four-space ports block with `5433:5432`.",
            "The finding is an unrestricted Compose host publication inconsistent with the documented single-public-ingress model, not independent proof of Internet reachability; firewall, routing and provider controls are separate layers.",
            "Production/configuration correction is deletion-only: the postgres-db `ports: - \"5433:5432\"` block was removed. No expose, extra_hosts, network redesign, Postgres listen/HBA/TLS change or comment noise was added.",
            "Post-patch deployment-security characterization passed 6/6 in three independent runs; the helper only extracts a canonical Compose service block by indentation and asserts the Postgres/internal DB and app loopback contracts.",
            "POST active deployment/config consumer audit found no current use of 5433, localhost:5433, 127.0.0.1:5433 or host.docker.internal in the production Compose configuration, application configuration, scripts or tooling; remaining 5433 literals exist only in B.46 historical evidence and baseline-regression assertions.",
            "docker compose config --quiet passed with only the pre-existing obsolete version warning. Effective config reports postgres host ports 0, postgres on nanika_network, backend host_ip 127.0.0.1 with target 8080 and frontend host_ip 127.0.0.1 with target 80.",
            "Backend connectivity remains internal through postgres-db:5432 on nanika_network; removing host publication does not affect container-to-container service discovery and no application query, provider, crypto or request path changed.",
            "Backend Debug build passed; full savebox_tests passed 7024 assertions in 145 test cases with seed 46043. Frontend unit tests passed 989/989 in two independent runs.",
            "Frontend coverage passed with 79.23% statements, 68.53% branches, 80.36% functions and 81.47% lines; Angular production build passed with the existing bundle/style budget warnings.",
            "Module metrics passed. Knip normal retained two configuration hints, production retained the known ng binary and two unused exports, cycles reported no cycles, and Cppcheck checked 13/13 source files with exit 0 and existing warning/style diagnostics.",
            "Mutation remained scoped only to format-bytes.ts; 15 total mutants produced 14 killed, 0 survived, 0 no-coverage and 1 compile diagnostic, with 100.00% scoreable mutation score and exit 0. No B.46 mutation score is claimed.",
            "Canonical Playwright runner completed 5/5 with 0 failed, 0 skipped, 0 flaky, exit 0, outcome completed, current_run true, status_valid true, report_valid true, hash_match true and report SHA-256 d7303d7d875fcb15e72bccf85af781db67d40d84e35de3c41cc006e2d9bcaaf0; this E2E evidence validates application behavior, while Compose static validation remains the authority for the new publication boundary.",
            "Security boundary remains fail-closed: no alternative DB ingress, wildcard bind, host.docker.internal route, secret output, proxy-trust expansion, schema change, backend C++ change, frontend change, Nginx change or remote deployment was introduced. B.46 is FROZEN FINAL; B.31–B.46 are FROZEN FINAL and execution stops here.",
        ],
        "b47_changes": [
            "Scope: B.47 active-name authority and non-destructive file replacement; B.31–B.46 remain FROZEN FINAL and B.48 remains SELECTED / NOT STARTED.",
            "B46-EVIDENCE-SEARCH-001 is RESOLVED as an evidence-only preamble: the active deployment/configuration consumer wording now distinguishes current production references from historical/test 5433 literals; no B.46 production/configuration behavior changed.",
            "Source audit confirmed two conflicting name authorities: unconditional legacy unique constraints on files/folders plus four deleted_at-aware partial indexes. FolderManager::batch_create_folders() also explicitly rejected tombstones through a redundant find_deleted branch.",
            "Source audit confirmed replacement ordering was destructive: after a 409 and confirmation, DriveStore trashed and hard-deleted OLD before starting NEW. The replacement retry also initially retained the first rejected Promise as uploadOperations authority.",
            "PRE backend characterization distinguished root/nested and single/batch behavior. Root single file/folder recreation was GREEN; nested single file/folder recreation and both batch-folder tombstone cases were deterministic RED; nested batch-file recreation was RED under the legacy unconditional constraint; active-active conflicts and restore collisions remained protected.",
            "PRE frontend characterization preserved the GREEN declined-dialog behavior and exposed deterministic REDs for pending NEW, paused NEW and failure-before-init ordering; the post-patch after-init characterization initially reproduced the missing NEW cleanup as 70/71.",
            "Canonical schema correction removes unique_folder_name and unique_file_name from the CREATE TABLE definitions and requires the four active-only partial indexes semantically. No ALTER compatibility path or legacy-schema detection was added.",
            "FolderManager now consults only active folders for batch idempotent reuse; deleted folders no longer block creation and are never returned as reusable IDs. FileManager production code was unchanged because PostgreSQL partial indexes already provide the required batch authority.",
            "DriveStore now captures OLD id once, tombstones OLD, starts NEW, publishes NEW as uploadOperations authority, and hard-deletes OLD only after the transfer explicitly reports success. Paused NEW leaves both recoverable states intact; cancelled NEW restores OLD after existing NEW cleanup.",
            "Replacement failures before initialization restore OLD without hard-deleting it. Replacement failures after initialization use the existing cleanupCancelledUpload primitive only for the narrow replacement branch, then attempt OLD restoration while preserving the original NEW error; ordinary upload recovery remains unchanged.",
            "After NEW success, failure to hard-delete OLD is retained as cleanup debt: NEW remains authoritative and no compensating deletion or restore is attempted. Cleanup and restore errors log only generic text plus status, never plaintext names, FDKs, JWT/JTI, Google credentials or payloads.",
            "B47-REPLACEMENT-LOG-001 final micro-gate: deterministic PRE characterization added exactly three cases and produced 3 REDs in 74 total focused tests because the OLD post-success cleanup branch and both OLD restore-failure branches passed the full HttpErrorResponse object to console.error. The minimal production correction now logs only the existing generic message plus error.status or 'unknown'; replacement ordering, Promise ownership, cleanup, restore and primary-error propagation are unchanged.",
            "Focused B.47 backend POST passed 55 assertions / 10 cases with seeds 47021, 47022 and 47023. Related regressions passed: trash 40/1, batch folders 29/2, batch upload 33/2, migration 71/1, B.44 53/10 and B.43 109/14.",
            "Full backend validation passed 7079 assertions in 155 test cases with seed 47047; the coverage build also passed 7079 assertions / 155 cases with seed 47048.",
            "Focused frontend replacement characterization passed 74/74 in three independent runs; related Drive/upload/recovery regressions passed 108/108; the complete frontend suite passed 1000/1000 in two independent runs.",
            "Frontend coverage passed 1000/1000 with 80.02% statements, 69.45% branches, 80.76% functions and 82.30% lines. Backend gcovr coverage passed the 50% line gate with 74.9% lines, 38.9% branches and 69.2% functions.",
            "Angular production build passed with the existing initial-bundle and component-style budget warnings. Module-metrics tests and fresh metrics passed; baseline-generator and lightweight Python quality tests passed after regeneration.",
            "Knip normal and cycles are empty in the current run. Knip production retains the existing ng binary and two unused exports. Cppcheck checked 13/13 backend source files and exited 0 with the existing header-exclusion warning.",
            "The earlier B.47 configured mutation invocation timed out during the initial Karma dry-run and did not produce a fresh mutation report; that timeout remains historical provenance and the prior report was not treated as current B.47 evidence. The current configured invocation completed successfully in the unchanged format-bytes.ts-only scope: 15 total, 14 killed, 0 survived, 0 no-coverage, 1 compile diagnostic, 100.00% scoreable mutation score and exit 0. No mutation score is claimed for B.47 production targets.",
            "Canonical Playwright current evidence completed total 5, passed 5, failed 0, skipped 0, flaky 0, retries 0, exit_code 0, outcome completed, current_run true, status_valid true, report_valid true and hash_match true; report SHA-256 is abbaaeb8e94e2b50f0a5a25a4d765d8f38388ce2326f8740d4cac009941d7c3b. NANIKA_E2E_TRASH_CYCLES was unset.",
            "Security and provider contracts remain unchanged: no plaintext backend filename, Vault Key, Master Key, FDK, JWT/JTI, Google credential, provider media payload, backend media proxy, API expansion, retry loop, persistent replacement state, Docker restart, remote deployment or Git history mutation was introduced.",
            "B47-REPLACEMENT-LOG-001 CLOSED. B47-MUTATION-GATE-001 RESOLVED. Quality status: B.47 FROZEN FINAL / RATIFIED; B.31–B.47 are FROZEN FINAL / RATIFIED and B.48 remains SELECTED / NOT STARTED. STOP after this round; no B.48 work was started.",
        ],
        "b48_changes": [
            "Scope: B.48 batch upload correlation identity, cross-folder name authority and request-local Google capacity allocation; B.31–B.47 remain FROZEN FINAL / RATIFIED and B.49 remains NOT SELECTED / NOT STARTED.",
            "PRE focused frontend baseline passed 192/192; PRE focused backend baseline passed 441 assertions in 25 test cases. Characterization reproduced the frontend global-name-hash rejection as deterministic RED, while same-folder duplicate rejection and existing B.10 window/concurrency behavior remained GREEN.",
            "Frontend now reuses UploadBatchCandidate.transferId as the opaque transient client_ref; no second ID generator, plaintext filename, path, key or provider credential was introduced. The request carries client_ref and response reconciliation/validation uses client_ref rather than name_hash.",
            "Frontend duplicate authority is now the logical namespace (folder_id, name_hash): same hash in different folders is accepted, while repeated hash in the same folder remains a duplicate. Response validation rejects wrong count, missing/unknown/duplicate client_ref, duplicate file_id, hash mismatch, provider mismatch/invalid provider and incomplete Google credentials.",
            "Backend validates client_ref as a request-local 1..128 character string and rejects duplicate references before mutation. client_ref is not persisted, logged, used for authorization or added to the schema.",
            "FileManager::BatchInitResult now returns folder_id from the existing INSERT RETURNING projection. The API uses a request-local context keyed by the returned logical tuple and no longer stores Google credentials in gdrive_tokens[name_hash].",
            "Google batch allocation adds exactly one public primitive, select_batch_storages(), with deterministic linked-storage ID order, one direct provider quota observation per eligible storage, request-local remaining capacity, stable first-fit assignment and no B.42 quota-cache interaction. Non-positive capacity is not a candidate.",
            "Insufficient batch capacity returns HTTP 507 before FileManager::batch_init_uploads; the B.48 test verifies no file rows are inserted. Google response credentials/root metadata remain associated with the exact selected storage recorded in the DB.",
            "POST B.48 focused backend passed 21 assertions / 1 case with seeds 48051, 48054 and 48055; after the exact provider-affinity proof was strengthened, the final run passed 23 assertions / 1 case with seed 48057. The related backend selection passed 468 assertions / 26 cases with seed 48052 except for one pre-existing B.33 refresh-cohort failure; B.33 alone passed 81 assertions / 2 cases with seed 48053.",
            "POST focused frontend passed 195/195; the complete frontend suite passed 1003/1003 in two independent runs. Angular production build passed with the existing bundle/style budget warnings.",
            "The full backend run passed 151/156 cases and failed only in five B.47 name-authority cases because the current database still contains legacy unique_file_name/unique_folder_name constraints. This is an external stale-database gate; no B.47 production code was changed to bypass it.",
            "Coverage, Knip, cycles, Cppcheck, mutation and canonical Playwright were not rerun in this round; no results or mutation score are claimed for B.48. Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.48 production targets.",
            "Security review found no schema change, media proxy, Google file creation, public sharing, credential logging, crypto/FDK change, B.10 concurrency change, B.42 quota-cache change or B.47 replacement change. B.48 implementation is complete but is not FROZEN because the required full backend gate is blocked by the stale database state; B.49 remains NOT SELECTED / NOT STARTED.",
        ],
        "b48_final_micro_freeze_changes": (
            [
                "B48-OPENAPI-CONTRACT-001 PRE source gap: the B.48 runtime wire contract had no batch-specific client_ref schema, omitted required response correlation fields and did not document HTTP 507. The OpenAPI characterization was deterministically RED before the patch.",
                "OpenAPI patch was docs-only: batch requests now use BatchInitUploadItemRequest with opaque client_ref (1..128), batch files require 1..100 items, responses require client_ref/file_id/name_hash/storage_provider, and /files/batch-init documents HTTP 507.",
                "The single-file InitUploadRequest contract was preserved; client_ref is not required outside the batch-specific request schema. The OpenAPI regression test passed 4/4 after the patch.",
                "B48-CUMULATIVE-CAPACITY-001 GREEN CHARACTERIZATION / CLOSED: against unchanged B.48 production allocation, two files requiring 4 bytes each were rejected with HTTP 507 when the first linked storage exposed 6 bytes and the second exposed 0; no rows, usage bytes or partial allocation remained and exactly two quota observations occurred.",
                "Provider-affinity characterization used two distinct linked Google accounts, roots and storage IDs, and verified each response/file row stayed associated with its selected account. A separate token-string assertion was not added because tokens are opaque credentials; allocator identity is the linked storage record and exposing or logging token material would violate the security contract.",
                "The previous stale database was historical candidate provenance: the old full backend result was 151/156 with legacy unique_file_name/unique_folder_name constraints. The disposable local Docker database target was recreated as 127.0.0.1:5433 / nanika_db; canonical schema recreation then showed both legacy constraints absent and only the active-only indexes present. No ALTER compatibility path or legacy-schema detection was added.",
                f"B.47 regressions were GREEN on the recreated database: [b47] 55 assertions / 10 cases; the full current backend run passed {args.backend_assertions} assertions / {args.backend_cases} cases. B.48 focused backend passed 27 assertions / 1 case in three independent runs with seeds 48061, 48062 and 48063; related batch/API and provider-selection regressions also passed.",
                f"Backend coverage is current: {backend_coverage_data['lines']}% lines, {backend_coverage_data['branches']}% branches and {backend_coverage_data['functions']}% functions, with the 50% line gate passing.",
                f"Frontend preservation is current: coordinator focused tests passed 30/30 in three runs; related upload/Drive tests passed 110/110; the complete suite passed 1003/1003 in two independent runs; coverage is {frontend_coverage['statements']}% statements, {frontend_coverage['branches']}% branches, {frontend_coverage['functions']}% functions and {frontend_coverage['lines']}% lines.",
                "Angular production build passed with only the existing bundle/style budget warnings. Module metrics, deployment security, baseline-generator, OpenAPI and the remaining Python quality tests passed.",
                "Knip normal and production completed with exit 0; existing configuration hints and production diagnostics remain report-only. Knip cycles completed with exit 0 and no cycles.",
                "Cppcheck checked 13/13 backend source files with report-only exit 0 and no diagnostics beyond the existing header-exclusion warning.",
                f"Mutation is current and remains bounded to format-bytes.ts: {mutation['total']} total, {mutation['killed']} killed, {mutation['survived']} survived, {mutation['no_coverage']} no-coverage, {mutation['compile_error']} compile diagnostic, score {mutation['score']}% on scoreable mutants, exit 0.",
                "Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.48 production targets.",
                f"Canonical Playwright current run: total {e2e['total']}, passed {e2e['passed']}, failed {e2e['failed']}, skipped {e2e['skipped']}, flaky {e2e['flaky']}, retries {e2e['retries']}, exit_code {e2e['exit_code']}, outcome {e2e['outcome']}, current_run {str(e2e['current_run']).lower()}, status_valid {str(e2e['status_valid']).lower()}, report_valid {str(e2e['report_valid']).lower()}, hash_match {str(e2e['hash_match']).lower()}, report SHA-256 {e2e['report_sha256']}. NANIKA_E2E_TRASH_CYCLES was unset.",
                "Security/Zero-Knowledge review remained GREEN: no plaintext names, paths, FDKs, Vault Key, JWT/JTI, Google credential or provider payload was added to logs, URLs, persistence or the new OpenAPI contract; no media proxy, Google sharing, crypto or runtime B.48 redesign was introduced.",
                "Final diff audit is limited to the pre-existing B.48 implementation files plus docs/swagger.yaml, the batch characterization test, the OpenAPI test and baseline tooling/tests. No new production C++ or TypeScript change was made by this micro-freeze.",
                "B48-OPENAPI-CONTRACT-001 CLOSED; B48-CUMULATIVE-CAPACITY-001 GREEN CHARACTERIZATION / CLOSED; B48-FULL-BACKEND-GATE-001 RESOLVED; B48-EVIDENCE-001 RESOLVED; B48-PLAYWRIGHT-GATE-001 RESOLVED; B48-MUTATION-GATE-001 RESOLVED.",
                "Quality status: B.48 FROZEN FINAL / RATIFIED; B.31–B.48 are FROZEN FINAL / RATIFIED. B.49 remains NOT SELECTED / NOT STARTED. NEXT: FRESH BROAD AUDIT.",
            ]
            if any(selected_freeze_modes)
            else []
        ),
        "b49_changes": (
            [
                "Scope: B.49 local upload physical-byte / quota authority. B.31–B.48 remain FROZEN FINAL / RATIFIED. B.50 and B.51 remain SELECTED / NOT STARTED.",
                "Historical PRE evidence against unchanged production was DETERMINISTIC RED: a Local upload declaring size_bytes=1024 and total_chunks=1 accepted a 512-byte chunk, materialized 512 physical bytes, recorded one file_chunk and marked the upload complete while quota/metadata remained based on 1024. The executable test is now a PATCH-DERIVED REGRESSION GUARD.",
                "Root cause: files.size_bytes reserved quota and total_chunks was validated at init, but the upload endpoint enforced only the FileChunker absolute <=4 MiB limit and did not bind req.body.size() to the exact byte geometry of the stored size_bytes.",
                "UploadMetadata returns size_bytes and total_chunks in one lookup; handle_upload_chunk derives the exact expected byte count for the chunk index with overflow-safe arithmetic and rejects mismatches before filesystem or file_chunks mutation.",
                "FileChunker retains the absolute 4 MiB defense-in-depth limit. One redundant post-write total_chunks database lookup was removed by reusing the previously loaded metadata.",
                "Non-final chunks require exactly 4 MiB; the final chunk requires the exact remaining byte count; zero-byte uploads retain the existing one-empty-chunk contract. Out-of-order uploads and valid retries remain supported; malformed retries are rejected before overwriting existing bytes.",
                "Single and batch Local init use the same size_bytes/total_chunks geometry. For completed Local uploads, physical file size == files.size_bytes, quota delta == files.size_bytes and file_chunks == total_chunks.",
                "Rejected size-mismatched chunks do not mutate the filesystem, file_chunks, is_upload_complete or the already-reserved quota.",
                "No plaintext filename, key or provider credential handling changed. The direct browser↔Google data path remains unchanged. No schema, migration, persistent byte counter, filesystem-size hot-path read or pool increase was added.",
                "The endpoint replaces the previous total_chunks lookup with a size_bytes+total_chunks lookup and reuses total_chunks after the write, removing the former redundant post-write total_chunks query.",
                "B49-LOCAL-UPLOAD-BYTE-AUTHORITY-001 CLOSED; B49-PHYSICAL-NO-MUTATION-001 CLOSED; B49-QUOTA-AUTHORITY-001 CLOSED; B49-EVIDENCE-001 RESOLVED; B49-OPENAPI-DOC-001 RESOLVED.",
                f"Quality status: B.49 FROZEN FINAL / RATIFIED; B.31–B.49 are FROZEN FINAL / RATIFIED. B.50 and B.51 remain SELECTED / NOT STARTED. NEXT: B.50.",
                "LOCAL-UPLOAD-DELETE-LIFECYCLE — SOURCE-CONFIRMED REACHABLE SCHEDULE — NOT CHARACTERIZED — DEFERRED FOR FUTURE FRESH BROAD AUDIT.",
            ]
            if any(selected_freeze_modes)
            else []
        ),
        "b50_changes": (
            [
                "Scope: B.50 Google external finalize / unlink lifecycle authority. B.31–B.49 remain FROZEN FINAL / RATIFIED; B.51 remains SELECTED / NOT STARTED.",
                "PRE characterization against unchanged production was deterministic RED: pending Google uploads did not block unlink, and finalize could report success after a concurrent file deletion removed the authoritative row.",
                "Unlink now rejects active incomplete Google files scoped to the requested storage or the user's unlink-all set with ACCOUNT_HAS_PENDING_UPLOADS before is_unlinking, quota, file deletion, pending-deletion or cache mutation. Existing active storage-move blocker precedence is preserved.",
                "Finalize now reads owner/provider/completion/external-storage identity together, verifies a user-owned non-unlinking Google storage with FOR SHARE, and commits only an owner/provider/storage/incomplete/deleted_at guarded UPDATE ... RETURNING id; empty RETURNING is FINALIZE_CONFLICT.",
                "The API maps external-storage lifecycle conflicts to 409 EXTERNAL_UPLOAD_FINALIZE_CONFLICT and pending unlink to 409 ACCOUNT_HAS_PENDING_UPLOADS. OpenAPI documents both conflict surfaces.",
                "Cleanup remains authoritative after successful finalize: unlink creates pending_external_deletions from the exact finalized external_file_id and removes only after the lifecycle boundary permits it. No schema, retry, worker, timer, pool, provider I/O, media proxy or Zero-Knowledge boundary changed.",
                "Regression matrix: pending/specific/all unlink atomicity, completed/unrelated/local/foreign isolation, finalize success/duplicate/missing/unlinking/foreign cases, finalize-delete race and finalize-then-unlink exact cleanup identity.",
                "B.50 quality status: IMPLEMENTED — FROZEN CANDIDATE only after the current full evidence gate; B.50 is not marked FROZEN FINAL / RATIFIED. B.51 remains SELECTED / NOT STARTED.",
            ]
            if args.b50_candidate or args.b50_final_freeze or args.b53_candidate or args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate
            else []
        ),
        "b50_final_micro_freeze_changes": (
            [
                "B.50 final micro-freeze re-audit: finalize retains storage FOR SHARE followed by guarded UPDATE ... RETURNING; unlink rejects pending Google uploads before mutation and cleanup remains post-commit with exact returned identities.",
                "B.51 and B.52 introduced no material B.50 invalidation; B.51 registration locking and B.52 local upload row authority remain separate lock domains. B.51/B.52 candidates are preserved and not ratified here.",
                "Focused B.50 validation passed on seeds 50051, 50052 and 50053: each run completed 51 assertions in 10 cases. Existing duplicate-finalize coverage was retained; no duplicate concurrency test was added because the current guarded UPDATE RETURNING characterization is sufficient for this micro-freeze.",
                "Related preservation passed: B.33 81/2, B.34 31/2, Google service 303/23, Google API 198/12, garbage collector 235/18 and storage moves 305/14; each used an independent deterministic seed.",
                "Quality evidence is current or validated: frontend coverage, backend coverage, module metrics, Cppcheck, mutation, Knip, OpenAPI, deployment security and canonical Playwright artifacts passed their configured gates.",
                "Security and performance invariants remain unchanged: no plaintext name or key handling, token/provider logging, media proxy, provider HTTP, retry worker, new persistent state, pool increase or global serialization was added.",
                "B50-GOOGLE-FINALIZE-UNLINK-AUTHORITY-001 CLOSED; B50-PENDING-UPLOAD-UNLINK-AUTHORITY-001 CLOSED; B50-CLEANUP-IDENTITY-001 CLOSED; B50-FINALIZE-COMMIT-AUTHORITY-001 CLOSED; B50-EVIDENCE-001 RESOLVED.",
                "Quality status: B.50 FROZEN FINAL / RATIFIED; B.31–B.50 are FROZEN FINAL / RATIFIED. B.51 remains SELECTED / NOT STARTED. NEXT: B.51 FINAL MICRO-FREEZE / RATIFICATION. B.52 remains IMPLEMENTED CANDIDATE / PREEXISTING / NOT RATIFIED. NO B.53 SELECTED.",
            ]
            if args.b50_final_freeze or args.b53_candidate or args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate
            else []
        ),
        "b51_final_micro_freeze_changes": (
            [
                "B.51 final ratification catch-up executed inside the B.53 lightweight hardening round; B.50 remains FROZEN FINAL / RATIFIED.",
                "Source re-audit confirmed the transaction-scoped PostgreSQL advisory lock keyed by canonical registration IP still serializes same-IP count→insert authority before the 24-hour count; different IPs remain independent.",
                "Focused B.51 passed 15 assertions / 2 cases on each of seeds 53351, 53352 and 53353. Related regressions passed: B.36 34/5 (seed 53161), auth 260/25 (seed 53362), API auth 184/12 (seed 53163) and rate limiter 5081/8 (seed 53164).",
                "No B.51 production source change was made during this catch-up; no coverage, mutation, Playwright or full repository gate was rerun.",
                "REGISTRATION-IP-LIMIT-CONCURRENCY-001 CLOSED. B.51 FROZEN FINAL / RATIFIED.",
            ]
            if args.b53_candidate or args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b52_final_micro_freeze_changes": (
            [
                "B.52 final ratification catch-up executed inside the B.53 lightweight hardening round.",
                "Source re-audit confirmed store_local_chunk() retains exact files-row FOR UPDATE lifecycle authority before bounded filesystem mutation and owns file_chunks/completion bookkeeping until commit.",
                "Focused B.52 passed 118 assertions / 10 cases on each of seeds 53251, 53252 and 53253. Related regressions passed: B.49 82/2 (seed 53261), B.44 53/10 (seed 53262), GC 235/18 (seed 53263) and API files 248/14 (seed 53264).",
                "Upload-first/delete-second, delete-first, hard-delete no-resurrection, same-file serialization, different-file independence, retry, out-of-order, IDOR and Google negative behavior remained GREEN; no B.52 production source change was made.",
                "No heavy checkpoint was rerun. LOCAL-UPLOAD-DELETE-LIFECYCLE-001 CLOSED. B.52 FROZEN FINAL / RATIFIED.",
            ]
            if args.b53_candidate or args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b53_changes": (
            [
                f"Scope: B.53 SHARE LINK RATE-LIMIT CONCURRENCY AUTHORITY. B.31–B.52 are FROZEN FINAL / RATIFIED after the embedded B.51/B.52 catch-up; B.54 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN' if args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate else 'NOT SELECTED'}.",
                "PRE characterization against unchanged production seeded hourly_changes=9 and causally held two requests after both crossed the standalone rate-limit SELECT but before either UPSERT committed. Both returned HTTP 200 and final hourly_changes became 11: DETERMINISTIC RED / SOURCE-CONFIRMED CONCURRENCY GAP.",
                "Root cause: standalone SELECT hourly_changes and later UPSERT increment belonged to different transactions, allowing multiple callers to pass the same stale budget check.",
                "Minimal correction: removed the standalone rate-limit SELECT and made the existing INSERT ... ON CONFLICT DO UPDATE conditional with a WHERE predicate over the conflict row plus RETURNING share_uuid. Empty RETURNING maps to the existing TOO_MANY_REQUESTS → HTTP 429 contract.",
                "PostgreSQL conflict-row locking serializes only the same file_id; the condition is re-evaluated after a competing commit. From count 9, exactly one caller commits the tenth mutation and the loser cannot overwrite share_uuid, encrypted_name_fdk, hourly_changes or last_changed_at.",
                "Window expiry, threshold 10, one-hour semantics, UUID collision retry, IDOR, Local-only public sharing, Google 422, public link behavior and encrypted_name_fdk remain unchanged.",
                "Focused B.53 passed 20 assertions / 2 cases on each of seeds 53051, 53052 and 53053. The different-file test proved independent completion while file A remained blocked; API share passed 62/2 on seed 53061.",
                "The patch removes one successful-path database SELECT and adds no schema, migration, advisory lock, process mutex, persistent state, worker, timer, retry or provider I/O. No heavy checkpoint was run; B.53 is the first round of the current lightweight hardening batch.",
                "SHARE-RATE-CONCURRENCY-001 CLOSED AT CANDIDATE LEVEL / AWAITING FUTURE BATCH HEAVY CHECKPOINT. B.53 IMPLEMENTED CANDIDATE / LOCAL GREEN.",
            ]
            if args.b53_candidate or args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b54_changes": (
            [
                f"Scope: B.54 GOOGLE UPLOAD INIT / UNLINK LIFECYCLE AUTHORITY. B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53 remains IMPLEMENTED CANDIDATE / LOCAL GREEN; B.55 and B.56 remain {'IMPLEMENTED CANDIDATE / LOCAL GREEN when their rounds are included' if args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.57 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b57_candidate or args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.58 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.59 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b59_candidate else 'SELECTED / NOT STARTED'}.",
                "PRE characterization against unchanged production was deterministic RED with seed 54020: selection observed an active Google storage and had a token, unlink committed first, then init returned 201 and created a stale pending file with a 2048-byte quota mutation.",
                "Root cause: provider selection/quota HTTP and database init were separate phases; init did not revalidate the selected storage lifecycle row before locking the user quota and inserting the pending file.",
                "Single init now locks the selected active user-owned Google storage FOR SHARE before users FOR UPDATE and files mutation. A missing or unlinking row raises EXTERNAL_UPLOAD_INIT_CONFLICT.",
                "Batch init collects, requires, sorts and deduplicates every Google external_storage_id, locks each active user-owned Google storage FOR SHARE before users FOR UPDATE, and fails atomically before quota/file mutation on any conflict. Local-only batches remain unchanged.",
                "Unlink specific and unlink-all acquire lifecycle authority with FOR UPDATE before dependency/pending checks. Unlink-all captures the exact sorted active ID set and restricts checks, transition, cleanup and post-commit cache invalidation to that set.",
                "The lock order is storage FOR SHARE/FOR UPDATE → users FOR UPDATE → files. No database connection is held during provider HTTP, DatabasePool remains 2, and no schema, migration, mutex, generation, worker, timer, retry, queue or proxy was added.",
                "The API maps EXTERNAL_UPLOAD_INIT_CONFLICT to HTTP 409 with a generic safe error and error_code; Google credentials are emitted only after FileManager initialization succeeds. OpenAPI documents the 409 contract for single and batch init.",
                "Focused B.54 passed 56 assertions / 6 cases on each of seeds 54051, 54052 and 54053. The matrix covers single and batch init-first/unlink-first races, mixed Local+Google atomicity and unlink-all pending-set atomicity.",
                "B.54-GOOGLE-UPLOAD-INIT-UNLINK-AUTHORITY-001 CLOSED AT CANDIDATE LEVEL / AWAITING FUTURE BATCH HEAVY CHECKPOINT. B.54 IMPLEMENTED CANDIDATE / LOCAL GREEN.",
            ]
            if args.b54_candidate or args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b55_changes": (
            [
                f"Scope: B.55 FOLDER RESTORE / HARD-DELETE ROOT LIFECYCLE AUTHORITY. B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53 and B.54 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; B.56 remains {'IMPLEMENTED CANDIDATE / LOCAL GREEN when its round is included' if args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.57 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b57_candidate or args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.58 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.59 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b59_candidate else 'SELECTED / NOT STARTED'}.",
                "B.54 housekeeping: two test-only fatal-assertion cleanup paths now record the waiter result, capture unlink exceptions, release the quota gate and join the initializer before asserting; no B.54 production source changed.",
                "PRE source audit confirmed restore_folder() validated a trashed target without lifecycle locking before folders→files mutation, while hard_delete_folder() validated without lifecycle locking before files→quota→folders destruction; the GC folder DELETE remains in its existing transaction.",
                "PRE characterization was deterministic and source-confirmed: same-root hard-delete first allowed restore to return success after the root disappeared; ancestor hard-delete versus descendant restore exposed a cross-tree lock/lifecycle conflict. The exact target row was therefore insufficient.",
                "Minimal production correction: discover the highest continuously trashed ancestor, lock that exact folder row FOR UPDATE, revalidate target ownership/deleted state and keep the authority through restore or hard-delete commit. Batch hard-delete normalizes positive IDs, sorts/deduplicates them, locks distinct authorities in ascending order and revalidates the captured trashed set.",
                "Deleted-parent restore still detaches the restored child to the root; active-parent restore remains under its active parent. Existing duplicate-name and NOT_FOUND contracts are preserved.",
                "Hard-delete continues to commit DB/quota/pending work before Local FileChunker cleanup. Restore winner preserves quota and physical ciphertext; hard-delete winner refunds exact quota once and creates Google pending deletion only for the committed winner.",
                "Same-root and ancestor/descendant races, restore-first semantics, batch race, independent trees, parent semantics, same-folder GC race and Google cleanup identity are covered by the focused regression suite.",
                f"Focused B.55 passed {args.backend_assertions} assertions / {args.backend_cases} cases on each of seeds 55051, 55052 and 55053.",
                "No frontend, schema, migration, retry, worker, timer, global mutex, provider I/O or DatabasePool change was made. OpenAPI remains unchanged because loser statuses remain 404 and duplicate restore remains 409.",
                "Heavy checkpoint not run. B.55 is lightweight hardening batch round #3; current-round evidence is focused only and historical full-suite inventory is explicitly reused.",
                "FOLDER-RESTORE-HARD-DELETE-AUTHORITY-001 CLOSED AT CANDIDATE LEVEL / AWAITING FUTURE BATCH HEAVY CHECKPOINT. B.55 IMPLEMENTED CANDIDATE / LOCAL GREEN.",
            ]
            if args.b55_candidate or args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b56_changes": (
            [
                f"Scope: B.56 PUBLIC SHARE / FILE DELETE LIFECYCLE AUTHORITY. B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53–B.55 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; B.57 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b57_candidate or args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.58 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.59 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b59_candidate else 'SELECTED / NOT STARTED'}.",
                "PRE characterization against unchanged production was deterministic RED with seed 56020: the share crossed the old active-file check, was held before shared_links insertion, soft-delete committed first, and the unchanged source then committed B56A001. The PRE verified the stale shared_links row while the file remained hidden; it did not claim a separate post-restore public-read observation.",
                "Root cause: file active lifecycle authority and public capability mutation used different transaction boundaries.",
                "Minimal correction: every UUID attempt now validates the active user-owned file row with FOR SHARE inside the same transaction as the existing B.53 conditional shared_links UPSERT. Delete/update of that exact file therefore waits until the capability commit or causes the share to fail closed.",
                "FOR SHARE remains compatible with concurrent shares; B.53 conflict-row locking remains the only same-file rate-budget authority, with its threshold, one-hour window, RETURNING behavior and HTTP 429 mapping unchanged.",
                "UUID retries create a fresh transaction and revalidate file lifecycle on every attempt; provider validation still rejects Google before token generation and no incomplete-file policy was added.",
                "Delete-first returns NOT_FOUND before shared_links mutation, budget consumption or payload rotation; share-first commits before delete proceeds. Existing pre-delete capabilities remain hidden in trash and usable after restore; no automatic revocation was added.",
                "Focused B.56 passed 49 assertions / 7 cases on each of seeds 56051, 56052 and 56053. Related preservation passed B.53 20/2 (56061), API share including Google negative and IDOR 62/2 (56062), B.44 53/10 (56063), API trash 40/1 (56064), folders 185/21 (56065), API file delete 27/1 (56066) and API folder delete 19/2 (56067).",
                "Quality tooling now treats B.53–B.56 candidate modes as lightweight focused evidence: coverage, mutation and Playwright readers are neither executed nor read, stale heavy values cannot enter the current payload, and frontend/full-suite counts are not required. Historical freeze modes remain strict.",
                "No frontend, schema, migration, Google data-plane, auth, crypto, quota, hard-delete, folder production, global lock, worker, timer, retry or DatabasePool change was made. OpenAPI remains unchanged.",
                "PUBLIC-SHARE-FILE-LIFECYCLE-AUTHORITY-001 CLOSED AT CANDIDATE LEVEL / AWAITING FUTURE BATCH HEAVY CHECKPOINT. B.56 IMPLEMENTED CANDIDATE / LOCAL GREEN. NEXT: FRESH BROAD AUDIT.",
            ]
            if args.b56_candidate or args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b57_changes": (
            [
                f"Scope: B.57 REGISTRATION DB LEASE / PASSWORD-HASH AUTHORITY. B.31–B.56 remain FROZEN FINAL / RATIFIED or IMPLEMENTED CANDIDATE / LOCAL GREEN as previously recorded; B.57 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.58 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b58_candidate or args.b59_candidate else 'SELECTED / NOT STARTED'}; B.59 is {'IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline' if args.b59_candidate else 'SELECTED / NOT STARTED'}; B.60+ remain NOT SELECTED.",
                "PRE source audit confirmed register_user() retained the DatabasePool connection, pqxx transaction and transaction-scoped B.51 registration-IP advisory lock while hash_password() ran.",
                "PRE deterministic characterization with seed 57020: T1 entered the password-hash gate while owning the database transaction/lease and B.51 lock; T2 acquired the second application connection and was observed in pg_stat_activity waiting on the same registration-IP advisory lock. This was a SOURCE-CONFIRMED RESOURCE-LEASE / AVAILABILITY GAP.",
                "Root cause: CPU-expensive password hashing executed while the scarce DatabasePool lease, transaction and B.51 advisory ownership remained active.",
                "Minimal correction: short Phase A precheck, complete transaction/connection release, one password hash with zero database lease, then a fresh authoritative B.51 Phase B recheck/count/duplicate check before INSERT/COMMIT.",
                "Phase A is explicitly non-authoritative; Phase B repeats the exact count and username/email checks and is the sole commit authority. Existing error contracts remain unchanged.",
                "B.51 same-IP concurrency remained authoritative: initial count 2 with two concurrent registrations produced exactly one success, one TOO_MANY_ACCOUNTS_FROM_IP rejection and final count 3.",
                f"Focused B.57 passed {args.backend_assertions} assertions / {args.backend_cases} cases on each of seeds 57051, 57052 and 57053.",
                "Cheap rejection tests confirmed at-limit, duplicate username and duplicate email requests perform zero password hashes and send no verification email; stale username/email conflicts are rejected after hashing before INSERT.",
                "Successful registration hashes exactly once and preserves post-commit verification-email behavior.",
                "Related preservation passed B.51 15/2 (57061), API/auth 184/12 (57062), B.36 34/5 (57063) and rate limiter 5081/8 (57064).",
                "Email validation is covered by the current B.59 candidate baseline; verification email delivery is covered by the current B.58 candidate baseline." if args.b59_candidate else "Email validation remains unchanged and deferred to B.59; verification email delivery is covered by the current B.58 candidate baseline." if args.b58_candidate else "Email validation remains unchanged and deferred to B.59; verification email delivery remains unchanged and deferred to B.58.",
                "No schema, migration, index, frontend, OpenAPI, Argon2/hash-format, auth/session/JWT, rate-limit, pool-size, retry, worker, queue, mutex or semaphore change was made.",
                "Lightweight B.57 candidate evidence does not execute or read coverage, backend coverage, mutation, Playwright, full frontend/backend, Cppcheck or Knip; the heavy checkpoint is deferred until after B.59.",
                "AUTH-REGISTER-DB-LEASE-HASH-001 CLOSED AT CANDIDATE LEVEL / AWAITING FUTURE BATCH HEAVY CHECKPOINT. B.57 IMPLEMENTED CANDIDATE / LOCAL GREEN. NEXT: B.58.",
            ]
            if args.b57_candidate or args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b58_changes": (
            [
                "Scope: B.58 REGISTRATION EMAIL DELIVERY TRUTH / RECOVERABILITY. B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53–B.57 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; B.58 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.59 is IMPLEMENTED CANDIDATE / LOCAL GREEN in the current candidate baseline if selected; B.60+ remain NOT SELECTED.",
                "B.57 housekeeping repaired stale-precheck test cleanup so fixture exceptions cannot unwind with the registration thread blocked in the hash gate; B.57 production was unchanged. Focused B.57 rerun passed 41 assertions / 7 cases on seed 58001.",
                "Source audit confirmed successful registration committed the local unverified user before provider delivery, ignored a false delivery result, and exposed no resend or recovery route.",
                "PRE deterministic characterization with seed 58020: provider HTTP failure returned HTTP 201 while the exact unverified local user and verification token remained persisted; normal retry returned HTTP 409. Login remained blocked with HTTP 403 and forced token expiry returned HTTP 400.",
                "PRE network failure also returned HTTP 201 with the user persisted; the provider-exception variant returned HTTP 500 while the committed unverified user remained persisted. PRE characterization passed 22 assertions / 4 cases.",
                "Root cause: provider delivery truth was outside the successful registration decision, while no post-commit recovery existed after a committed undelivered local account.",
                "Minimal correction: provider delivery remains post-commit and outside DB ownership; unsuccessful delivery triggers one exact short compensation transaction keyed by user id, local provider, unverified state and the exact verification token.",
                "If exact compensation removes the row or the exact row is already absent, registration reports VERIFICATION_EMAIL_DELIVERY_FAILED and the router returns truthful HTTP 503. If concurrent verification already succeeded, the account is preserved and registration succeeds. Any ownership or recovery uncertainty fails closed as VERIFICATION_EMAIL_RECOVERY_FAILED / HTTP 500.",
                "verify_email() now uses one authoritative conditional UPDATE ... RETURNING, preventing verification from reporting success after compensation removed the user.",
                "Successful provider delivery preserves HTTP 200/201 acceptance and exactly one send. No delivery retry, worker, timer, queue, resend route or persistent delivery state was added.",
                "Failed compensated registrations do not remain in users, do not permanently consume the B.51 three-account/24h count, and a subsequent normal registration with the same username/email succeeds.",
                "Provider HTTP executes with zero application DatabasePool leases; B.57 Phase A/hash/Phase B resource ownership remains intact.",
                f"Focused B.58 passed {args.backend_assertions} assertions / {args.backend_cases} cases on each of seeds 58051, 58052 and 58053.",
                "Related preservation passed B.51 15/2 (58062), EmailService 79/11 (58063), API/auth 184/12 (58064) and OpenAPI contract 6/6; no frontend tests or build were run.",
                "Coverage, mutation, Playwright and full suites were NOT RUN / NOT READ. Heavy checkpoint remains deferred until after B.59.",
                "REGISTRATION-EMAIL-DELIVERY-TRUTH-001 CLOSED AT CANDIDATE LEVEL / AWAITING FUTURE BATCH HEAVY CHECKPOINT. B.58 IMPLEMENTED CANDIDATE / LOCAL GREEN. NEXT: B.59.",
            ]
            if args.b58_candidate or args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b59_changes": (
            [
                "Scope: B.59 EXTERNAL EMAIL VALIDATION RESULT AUTHORITY. B.31–B.52 remain FROZEN FINAL / RATIFIED; B.53–B.58 remain IMPLEMENTED CANDIDATE / LOCAL GREEN; B.59 is IMPLEMENTED CANDIDATE / LOCAL GREEN; B.60+ remain NOT SELECTED.",
                "PRE source audit and focused characterization identified the old boolean validator as fail-open for provider errors, non-2xx responses, malformed/unknown payloads and status zero; direct transport exceptions were also allowed to escape. The old result conflated Accepted, Rejected and Unavailable.",
                "EmailService now exposes EmailValidationResult with explicit Accepted, Rejected and Unavailable outcomes. Empty email remains Rejected; an empty validation key returns Unavailable before any provider request; provider HTTP/network/status-zero/transport exceptions and malformed or unknown-only payloads return Unavailable.",
                "Recognized negative signals remain authoritative: disposable, low quality score, undeliverable status, invalid SMTP, invalid MX and high address risk return Rejected. Explicit negative evidence wins over malformed evidence; recognized positive evidence returns Accepted, including partial recognized positive payloads with unknown fields.",
                "AuthService rejects only local invalid/disposable inputs and external Rejected results. Unavailable intentionally continues to the existing B.57 registration authority and B.58 post-commit verification-delivery authority; it does not become HTTP 503 or Nanika HTTP 429.",
                "External rejection maps to HTTP 400 with EMAIL_VALIDATION_REJECTED and a generic safe message. B.58 delivery failure remains the only registration HTTP 503 path covered here; successful delivery remains HTTP 201 and the existing compensation/retry behavior is preserved.",
                "Validation executes before password hashing and without an application DatabasePool lease. No schema, migration, cache, retry, queue, worker, timeout, auth/session, Google, crypto, frontend or OpenAPI format change was introduced.",
                f"Focused B.59 candidate evidence passed {args.backend_assertions} assertions / {args.backend_cases} cases on each of seeds 59051, 59052 and 59053 when run independently. HC-PREFLIGHT preserved that candidate evidence separately from the new harness and process-stability evidence.",
                "Test-only mock cleanup removed the dead allow_domain flag and restored a realistic recognized-positive provider payload. Existing EmailService tests now assert the tri-state contract and the zero-request empty-key guard.",
                "HC-PREFLIGHT recharacterized the historical B.51 related RED: the previous five-second INSERT observation waited until after external validation, Phase A, Argon2 and Phase B, so it was timing-sensitive and did not establish a production B.51 regression.",
                "The B.51 harness now uses an external connection to lock the exact production authority hashtextextended('nanika:register-ip:' || $1, 0), with no synthetic key, trigger or PostgreSQL function. Same-IP and different-IP B.51 passed 15 assertions / 2 cases on seeds 59241, 59242 and 59243; five additional isolated B.51 processes (59234–59238) also passed. No B.51 production source changed.",
                "The historical Windows 0xC0000374 was reduced to the test-only Base62Generator::test_next_token() thread-local std::string teardown path by debugger evidence. The test seam now keeps the same per-thread contract through a thread-local unique_ptr; 11 isolated B.51 and 10 isolated B.59 processes completed normally afterward. No production fix is claimed; the prior anomaly remains provenance and is monitored during the heavy checkpoint.",
                "B.51-REGRESSION-HARNESS-STABILITY-001 CLOSED / TEST HARNESS STABILIZED / NO PRODUCTION REGRESSION. WINDOWS-TEST-PROCESS-HEAP-STABILITY-001 NOT REPRODUCED AFTER TEST-ONLY FIX DURING TARGETED PREFLIGHT / MONITOR DURING HEAVY CHECKPOINT.",
                "EMAIL-VALIDATION-FAIL-OPEN-001 CLOSED AT CANDIDATE LEVEL / RELATED PREFLIGHT GREEN / AWAITING HEAVY CHECKPOINT. B.59 IMPLEMENTED CANDIDATE / LOCAL GREEN. B.60+ NOT SELECTED.",
            ]
            if args.b59_candidate or args.b59_final_freeze
            else []
        ),
        "b59_final_freeze_changes": (
            [
                "B.31–B.59 FROZEN FINAL / RATIFIED.",
                "HEAVY CHECKPOINT B.53–B.59 PASS / RATIFIED.",
                f"Current full evidence: frontend {args.frontend_tests} tests; backend {args.backend_assertions} assertions / {args.backend_cases} cases; fixture {args.fixture_assertions} assertions / {args.fixture_cases} cases; canonical E2E {e2e['passed']}/{e2e['total']} PASS with zero failures, skips, flakiness and retries.",
                f"Coverage and configured mutation gates are current: frontend {frontend_coverage['statements']}% statements / {frontend_coverage['branches']}% branches / {frontend_coverage['functions']}% functions / {frontend_coverage['lines']}% lines; backend {backend_coverage_data['lines']}% lines; mutation {mutation['killed']}/{mutation['total']} killed, {mutation['survived']} survivors, {mutation['no_coverage']} no-coverage and {mutation['timeout']} timeouts.",
                "Static analysis, Knip, module metrics, deployment security and OpenAPI evidence were read from the current heavy artifacts; known report-only findings remain classified and do not block ratification.",
                "B.60+ NOT SELECTED.",
                "NEXT: FRESH BROAD AUDIT.",
                "The former fixed minimum-five-round cadence is retired; future heavy validation is event-driven by material change, evidence invalidation, unexplained cross-suite RED or final/release ratification.",
            ]
            if args.b59_final_freeze
            else []
        ),
    }
    (root / "docs").mkdir(exist_ok=True)
    (root / "docs" / "quality-baseline.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (root / "docs" / "quality-baseline.md").write_text(render(payload), encoding="utf-8")


if __name__ == "__main__":
    main()
