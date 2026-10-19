"""Run the backend Catch2 suite in isolated processes and databases."""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Sequence


DATABASE_NAME_RE = re.compile(r"^nanika_shard_[0-9a-f]{6}_[0-3]$")
CONFIG_KEYS = {
    "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_HOST", "DB_PORT", "PASS_PEPPER",
    "NANIKA_JWT_SECRET", "RESEND_API_KEY", "EMAIL_VALIDATION_API_KEY", "IMGUR_CLIENT_ID",
    "CORS_ORIGIN", "CORS_ALLOWED_ORIGINS", "TRUST_PROXY_HEADERS", "PORT",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "NANIKA_STORAGE_PATH",
}
SECRET_KEYS = {
    "DB_PASSWORD", "PASS_PEPPER", "NANIKA_JWT_SECRET", "RESEND_API_KEY",
    "EMAIL_VALIDATION_API_KEY", "GOOGLE_CLIENT_SECRET", "IMGUR_CLIENT_ID",
}
LOCAL_DATABASE_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


@dataclasses.dataclass(frozen=True)
class PostgresAdmin:
    provider: str
    createdb: str | None = None
    dropdb: str | None = None
    docker: str | None = None
    compose_service: str | None = None


@dataclasses.dataclass(frozen=True)
class Catch2Capabilities:
    native_sharding: bool
    xml_reporter: bool


@dataclasses.dataclass(frozen=True)
class ShardResult:
    index: int
    database: str
    working_directory: str
    log_path: Path
    report_path: Path
    duration_seconds: float
    exit_code: int
    exit_code_hex: str | None
    process_aborted: bool
    report: dict[str, Any] | None
    error: str | None = None


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def validate_shard_count(value: int) -> int:
    if not 1 <= value <= 4:
        raise ValueError("backend shard count must be between 1 and 4")
    return value


def safe_database_name(run_token: str, shard_index: int) -> str:
    if not re.fullmatch(r"[0-9a-f]{6}", run_token) or not 0 <= shard_index <= 3:
        raise ValueError("invalid internally generated shard identifier")
    name = f"nanika_shard_{run_token}_{shard_index}"
    if not DATABASE_NAME_RE.fullmatch(name) or len(name) > 63:
        raise ValueError("unsafe PostgreSQL database name")
    return name


def is_safe_database_name(name: str) -> bool:
    return bool(DATABASE_NAME_RE.fullmatch(name)) and len(name) <= 63


def normalize_database_host(value: str) -> str:
    host = value.strip().lower()
    return host[1:-1] if host.startswith("[") and host.endswith("]") else host


def is_local_database_host(config: dict[str, str]) -> bool:
    return normalize_database_host(config.get("DB_HOST", "127.0.0.1")) in LOCAL_DATABASE_HOSTS


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def merged_config(root_env: Path) -> dict[str, str]:
    values = read_dotenv(root_env)
    for key in CONFIG_KEYS:
        if key not in values and key in os.environ:
            values[key] = os.environ[key]
    return values


def write_dotenv(path: Path, values: dict[str, str]) -> None:
    path.write_text(
        "".join(f"{key}={values[key]}\n" for key in sorted(values)),
        encoding="utf-8",
        newline="\n",
    )


def run_id() -> str:
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{timestamp}-{os.getpid()}-{secrets.token_hex(3)}"


def create_run_root(root: Path, identifier: str | None = None) -> Path:
    path = (root / ".quality" / "test-runs" / (identifier or run_id())).resolve()
    path.mkdir(parents=True, exist_ok=False)
    for child in ("logs", "reports", "backend"):
        (path / child).mkdir()
    return path


def _under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def remove_workspace(path: Path, run_root: Path) -> None:
    if not _under(path, run_root) or path.resolve() == run_root.resolve():
        raise RuntimeError("refusing to remove a path outside the current test run")
    if path.exists():
        shutil.rmtree(path)


def create_shard_workspace(
    shard_root: Path,
    config: dict[str, str],
    database: str,
    blocklist_source: Path,
    docs_source: Path,
) -> Path:
    shard_root.mkdir(parents=True, exist_ok=False)
    (shard_root / "config").mkdir()
    run_cwd = shard_root / "work" / "run"
    run_cwd.mkdir(parents=True)
    shard_config = dict(config)
    shard_config["DB_NAME"] = database
    shard_config["NANIKA_STORAGE_PATH"] = "./savebox_storage/"
    write_dotenv(shard_root / ".env", shard_config)
    target_blocklist = shard_root / "config" / "disposable_domains.txt"
    shutil.copy2(blocklist_source, target_blocklist)
    target_docs = shard_root / "docs"
    target_docs.mkdir()
    shutil.copy2(docs_source / "swagger.yaml", target_docs / "swagger.yaml")
    shutil.copytree(docs_source / "swagger-ui", target_docs / "swagger-ui")
    return run_cwd


def _postgres_bin_candidates() -> list[Path]:
    candidates: list[Path] = []
    for env_name in ("ProgramFiles", "PROGRAMFILES"):
        program_files = os.environ.get(env_name)
        if program_files:
            candidates.extend(path / "bin" for path in sorted((Path(program_files) / "PostgreSQL").glob("*"), reverse=True))
    pg_config = shutil.which("pg_config")
    if pg_config:
        result = subprocess.run([pg_config, "--bindir"], capture_output=True, text=True, check=False)
        if result.returncode == 0 and result.stdout.strip():
            candidates.insert(0, Path(result.stdout.strip()))
    return candidates


def _docker_compose_service(root: Path, docker: str) -> str | None:
    result = subprocess.run(
        [docker, "compose", "config", "--services"],
        cwd=str(root), capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return None
    services = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    for service in services:
        if "postgres" in service.lower() or service.lower() in {"db", "database"}:
            return service
    return None


def discover_postgres_admin(root: Path, config: dict[str, str]) -> PostgresAdmin | None:
    tool_names = ("createdb.exe", "createdb") if os.name == "nt" else ("createdb",)
    drop_names = ("dropdb.exe", "dropdb") if os.name == "nt" else ("dropdb",)
    createdb = next((shutil.which(name) for name in tool_names if shutil.which(name)), None)
    dropdb = next((shutil.which(name) for name in drop_names if shutil.which(name)), None)
    if os.name == "nt" and (createdb and Path(createdb).suffix.lower() != ".exe" or dropdb and Path(dropdb).suffix.lower() != ".exe"):
        createdb = None
        dropdb = None
    if createdb and dropdb:
        return PostgresAdmin("native", createdb=createdb, dropdb=dropdb)

    for candidate in _postgres_bin_candidates():
        create_path = candidate / ("createdb.exe" if os.name == "nt" else "createdb")
        drop_path = candidate / ("dropdb.exe" if os.name == "nt" else "dropdb")
        if create_path.is_file() and drop_path.is_file():
            return PostgresAdmin("native", createdb=str(create_path), dropdb=str(drop_path))

    docker = shutil.which("docker")
    if docker:
        service = _docker_compose_service(root, docker)
        if service:
            return PostgresAdmin("docker", docker=docker, compose_service=service)
    return None


def _native_db_env(config: dict[str, str]) -> dict[str, str]:
    env = os.environ.copy()
    if "DB_PASSWORD" in config:
        env["PGPASSWORD"] = config["DB_PASSWORD"]
    return env


def _admin_command(admin: PostgresAdmin, action: str, database: str, config: dict[str, str]) -> tuple[list[str], dict[str, str]]:
    if not is_safe_database_name(database):
        raise ValueError("refusing database operation for an unsafe name")
    user = config.get("DB_USER", "")
    if admin.provider == "native":
        executable = admin.createdb if action == "create" else admin.dropdb
        if not executable:
            raise RuntimeError("native PostgreSQL admin tool is incomplete")
        common = ["--host", config.get("DB_HOST", "127.0.0.1"), "--port", config.get("DB_PORT", "5432"), "--username", user]
        if action == "create":
            return [executable, *common, "--owner", user, database], _native_db_env(config)
        return [executable, *common, "--if-exists", database], _native_db_env(config)
    if admin.provider == "docker" and admin.docker and admin.compose_service:
        if action == "create":
            command = [admin.docker, "compose", "exec", "-T", admin.compose_service, "createdb", "-U", user, f"--owner={user}", database]
        else:
            command = [admin.docker, "compose", "exec", "-T", admin.compose_service, "dropdb", "-U", user, "--if-exists", database]
        return command, os.environ.copy()
    raise RuntimeError("unknown PostgreSQL admin provider")


def create_database(admin: PostgresAdmin, database: str, config: dict[str, str], root: Path) -> None:
    command, env = _admin_command(admin, "create", database, config)
    result = subprocess.run(command, cwd=str(root), env=env, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"database creation failed with exit code {result.returncode}")


def drop_database(admin: PostgresAdmin, database: str, config: dict[str, str], root: Path) -> None:
    command, env = _admin_command(admin, "drop", database, config)
    result = subprocess.run(command, cwd=str(root), env=env, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"database cleanup failed with exit code {result.returncode}")


def detect_catch2_capabilities(binary: Path, cwd: Path) -> Catch2Capabilities:
    help_result = subprocess.run([str(binary), "--help"], cwd=str(cwd), capture_output=True, text=True, check=False)
    help_text = f"{help_result.stdout}\n{help_result.stderr}"
    reporter_result = subprocess.run([str(binary), "--list-reporters"], cwd=str(cwd), capture_output=True, text=True, check=False)
    reporter_text = f"{reporter_result.stdout}\n{reporter_result.stderr}"
    return Catch2Capabilities(
        native_sharding="--shard-count" in help_text and "--shard-index" in help_text,
        xml_reporter=bool(re.search(r"(?m)^\s*XML:\s", reporter_text)),
    )


def build_shard_command(
    binary: Path,
    report_path: Path,
    seed: int,
    shard_count: int,
    shard_index: int,
    capabilities: Catch2Capabilities,
) -> list[str]:
    validate_shard_count(shard_count)
    if not capabilities.xml_reporter:
        raise RuntimeError("Catch2 XML reporter is unavailable")
    command = [str(binary), "--order", "rand", "--rng-seed", str(seed), "-r", "XML", "-o", str(report_path)]
    if shard_count > 1:
        if not capabilities.native_sharding:
            raise RuntimeError("Catch2 native sharding is unavailable")
        command.extend(["--shard-count", str(shard_count), "--shard-index", str(shard_index)])
    return command


def parse_catch_report(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing Catch2 report: {path.name}")
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as error:
        raise ValueError("invalid Catch2 XML report") from error
    if root.tag != "Catch2TestRun":
        raise ValueError("unexpected Catch2 XML root")
    overall = next((node for node in root if node.tag == "OverallResults" and "successes" in node.attrib), None)
    case_overall = next((node for node in root if node.tag == "OverallResultsCases" and "successes" in node.attrib), None)
    if overall is None or case_overall is None:
        raise ValueError("Catch2 XML report has no aggregate totals")

    def integer(node: ET.Element, key: str) -> int:
        try:
            value = int(node.attrib.get(key, "0"))
        except ValueError as error:
            raise ValueError("invalid Catch2 aggregate total") from error
        if value < 0:
            raise ValueError("negative Catch2 aggregate total")
        return value

    names = [node.attrib["name"] for node in root.findall(".//TestCase") if "name" in node.attrib]
    if len(names) != len(set(names)):
        raise ValueError("duplicate test case inside Catch2 report")
    result = {
        "cases": integer(case_overall, "successes") + integer(case_overall, "failures") + integer(case_overall, "expectedFailures") + integer(case_overall, "skips"),
        "case_successes": integer(case_overall, "successes"),
        "case_failures": integer(case_overall, "failures"),
        "assertions": integer(overall, "successes") + integer(overall, "failures") + integer(overall, "expectedFailures"),
        "assertion_successes": integer(overall, "successes"),
        "assertion_failures": integer(overall, "failures"),
        "expected_failures": integer(overall, "expectedFailures"),
        "names": names,
    }
    if result["cases"] <= 0:
        raise ValueError("Catch2 report selected zero test cases")
    if len(names) != result["cases"]:
        raise ValueError("Catch2 report case names do not match aggregate total")
    return result


def aggregate_reports(results: Sequence[ShardResult]) -> dict[str, Any]:
    if not results:
        raise ValueError("no backend shard reports")
    names: set[str] = set()
    totals = {key: 0 for key in ("cases", "case_successes", "case_failures", "assertions", "assertion_successes", "assertion_failures", "expected_failures")}
    for result in results:
        if result.report is None:
            raise ValueError(result.error or "missing backend shard report")
        for name in result.report["names"]:
            if name in names:
                raise ValueError(f"duplicate test case across shards: {name}")
            names.add(name)
        for key in totals:
            totals[key] += result.report[key]
    if totals["cases"] <= 0:
        raise ValueError("backend aggregate selected zero test cases")
    return {**totals, "test_case_names": sorted(names)}


def normalize_exit_code(code: int) -> tuple[str | None, bool]:
    if code == 0:
        return None, False
    value = code & 0xFFFFFFFF if os.name == "nt" else code
    code_hex = f"0x{value:08X}" if os.name == "nt" else None
    return code_hex, os.name == "nt" and value >= 0xC0000000


def _relative_run_path(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _sanitize_log(path: Path, config: dict[str, str]) -> None:
    if not path.is_file():
        return
    content = path.read_text(encoding="utf-8", errors="replace")
    for key in SECRET_KEYS:
        value = config.get(key)
        if value:
            content = content.replace(value, "[REDACTED]")
    path.write_text(content, encoding="utf-8", newline="\n")


def _run_process(
    index: int,
    database: str,
    cwd: Path,
    working_directory: str,
    binary: Path,
    command: list[str],
    env: dict[str, str],
    log_path: Path,
    report_path: Path,
    config: dict[str, str],
    processes: list[subprocess.Popen[str]],
    process_lock: threading.Lock,
) -> ShardResult:
    started = time.perf_counter()
    error: str | None = None
    report: dict[str, Any] | None = None
    with log_path.open("w", encoding="utf-8", newline="\n") as log:
        process = subprocess.Popen(command, cwd=str(cwd), env=env, stdout=log, stderr=subprocess.STDOUT, text=True)
        with process_lock:
            processes.append(process)
        exit_code = process.wait()
    try:
        report = parse_catch_report(report_path)
    except ValueError as parse_error:
        error = str(parse_error)
    _sanitize_log(log_path, config)
    exit_hex, aborted = normalize_exit_code(exit_code)
    return ShardResult(index, database, working_directory, log_path, report_path, time.perf_counter() - started, exit_code, exit_hex, aborted, report, error)


def _run_processes(specs: Sequence[dict[str, Any]]) -> list[ShardResult]:
    processes: list[subprocess.Popen[str]] = []
    process_lock = threading.Lock()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=len(specs))
    futures = [executor.submit(_run_process, **spec, processes=processes, process_lock=process_lock) for spec in specs]
    try:
        results = [future.result() for future in futures]
    except KeyboardInterrupt:
        with process_lock:
            active = list(processes)
        for process in active:
            if process.poll() is None:
                process.terminate()
        raise
    finally:
        executor.shutdown(wait=True)
    return sorted(results, key=lambda result: result.index)


def _process_summary(result: ShardResult, root: Path) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "index": result.index,
        "database": result.database,
        "working_directory": result.working_directory,
        "log": _relative_run_path(result.log_path, root),
        "report": _relative_run_path(result.report_path, root),
        "duration_seconds": round(result.duration_seconds, 3),
        "exit_code": result.exit_code,
        "exit_code_hex": result.exit_code_hex,
        "process_aborted": result.process_aborted,
        "status": "passed" if result.exit_code == 0 and result.report is not None else "failed",
    }
    if result.report:
        payload.update({key: result.report[key] for key in ("cases", "assertions", "case_failures", "assertion_failures", "expected_failures")})
    if result.error:
        payload["error"] = result.error
    return payload


def _base_binary_cwd(binary: Path) -> Path:
    return binary.parent.resolve()


def _single_process(
    root: Path,
    run_root: Path,
    binary: Path,
    seed: int,
    config: dict[str, str],
    capabilities: Catch2Capabilities,
) -> list[ShardResult]:
    report = run_root / "reports" / "backend-shard-0.xml"
    log = run_root / "logs" / "backend-shard-0.log"
    spec = {
        "index": 0,
        "database": "base-existing",
        "cwd": _base_binary_cwd(binary),
        "working_directory": "backend/build",
        "binary": binary,
        "command": build_shard_command(binary, report, seed, 1, 0, capabilities),
        "env": os.environ.copy(),
        "log_path": log,
        "report_path": report,
        "config": config,
    }
    return _run_processes([spec])


def execute_backend(
    root: Path,
    binary: Path,
    requested_shards: int,
    seed: int,
    run_root: Path,
    serial: bool = False,
) -> dict[str, Any]:
    requested_shards = validate_shard_count(requested_shards)
    binary = binary.resolve()
    if not binary.is_file():
        raise FileNotFoundError(f"backend test binary not found: {binary}")
    config = merged_config(root / ".env")
    started = time.perf_counter()
    effective_shards = 1 if serial else requested_shards
    reason: str | None = "serial_requested" if serial else None
    if effective_shards > 1 and not is_local_database_host(config):
        effective_shards = 1
        reason = "remote_database_sharding_disabled"
    capabilities = Catch2Capabilities(native_sharding=False, xml_reporter=True)
    if effective_shards > 1:
        capabilities = detect_catch2_capabilities(binary, _base_binary_cwd(binary))
        if not capabilities.native_sharding:
            effective_shards = 1
            reason = "catch2_native_sharding_unavailable"
        elif not capabilities.xml_reporter:
            effective_shards = 1
            reason = "catch2_xml_reporter_unavailable"

    admin: PostgresAdmin | None = None
    if effective_shards > 1:
        admin = discover_postgres_admin(root, config)
        if admin is None:
            effective_shards = 1
            reason = "isolated_database_provisioning_unavailable"

    databases: list[str] = []
    workspaces: list[Path] = []
    results: list[ShardResult] = []
    cleanup_errors: list[str] = []
    try:
        if effective_shards == 1:
            results = _single_process(root, run_root, binary, seed, config, capabilities)
        else:
            blocklist = root / "config" / "disposable_domains.txt"
            if not blocklist.is_file():
                raise RuntimeError("disposable domain blocklist is unavailable")
            token = secrets.token_hex(3)
            specs: list[dict[str, Any]] = []
            for index in range(effective_shards):
                database = safe_database_name(token, index)
                create_database(admin, database, config, root)
                databases.append(database)
                shard_root = run_root / "backend" / f"shard-{index}"
                workspaces.append(shard_root)
                cwd = create_shard_workspace(shard_root, config, database, blocklist, root / "docs")
                report = run_root / "reports" / f"backend-shard-{index}.xml"
                log = run_root / "logs" / f"backend-shard-{index}.log"
                child_env = os.environ.copy()
                child_env.update(config)
                child_env["DB_NAME"] = database
                child_env["NANIKA_STORAGE_PATH"] = "./savebox_storage/"
                specs.append({
                    "index": index,
                    "database": database,
                    "cwd": cwd,
                    "working_directory": f"backend/shard-{index}/work/run",
                    "binary": binary,
                    "command": build_shard_command(binary, report, seed, effective_shards, index, capabilities),
                    "env": child_env,
                    "log_path": log,
                    "report_path": report,
                    "config": config,
                })
            results = _run_processes(specs)
    except (OSError, RuntimeError, ValueError) as error:
        if effective_shards > 1:
            reason = "isolated_database_provisioning_failed"
            effective_shards = 1
            for database in list(databases):
                try:
                    drop_database(admin, database, config, root)  # type: ignore[arg-type]
                except Exception:
                    cleanup_errors.append(f"failed to clean database {database}")
            databases.clear()
            results = _single_process(root, run_root, binary, seed, config, capabilities)
            results[0] = dataclasses.replace(results[0], error=f"sharding setup failed; fell back to one process: {error}")
        else:
            raise
    finally:
        for database in list(databases):
            try:
                drop_database(admin, database, config, root)  # type: ignore[arg-type]
            except Exception:
                cleanup_errors.append(f"failed to clean database {database}")
        for workspace in workspaces:
            try:
                remove_workspace(workspace, run_root)
            except Exception:
                cleanup_errors.append(f"failed to clean workspace backend/{workspace.name}")

    try:
        aggregate = aggregate_reports(results)
    except ValueError as error:
        aggregate = {"cases": 0, "assertions": 0, "case_failures": 0, "assertion_failures": 0, "expected_failures": 0, "error": str(error)}
    child_ok = all(result.exit_code == 0 and result.report is not None for result in results)
    status = "passed" if child_ok and aggregate.get("case_failures", 1) == 0 and aggregate.get("assertion_failures", 1) == 0 and not cleanup_errors else "failed"
    return {
        "status": status,
        "exit_code": 0 if status == "passed" else 1,
        "requested_shards": requested_shards,
        "effective_shards": effective_shards,
        "reason": reason,
        "seed": seed,
        "wall_seconds": round(time.perf_counter() - started, 3),
        **{key: aggregate.get(key, 0) for key in ("cases", "assertions", "case_failures", "assertion_failures", "expected_failures")},
        "processes": [_process_summary(result, run_root) for result in results],
        "cleanup_errors": cleanup_errors,
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(path)


def default_binary(root: Path) -> Path:
    candidates = [
        root / "backend" / "build" / ("savebox_tests.exe" if os.name == "nt" else "savebox_tests"),
        root / "backend" / "build-msvc" / "Debug" / "savebox_tests.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=repository_root())
    parser.add_argument("--backend-binary", type=Path, default=None)
    parser.add_argument("--backend-shards", "--shards", dest="backend_shards", type=int, default=2)
    parser.add_argument("--backend-seed", type=int, default=60201)
    parser.add_argument("--serial", action="store_true")
    parser.add_argument("--run-root", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        validate_shard_count(args.backend_shards)
        root = args.root.resolve()
        binary = (args.backend_binary or default_binary(root)).resolve()
        run_root = args.run_root.resolve() if args.run_root else create_run_root(root)
        if args.run_root and not run_root.exists():
            run_root.mkdir(parents=True)
            for child in ("logs", "reports", "backend"):
                (run_root / child).mkdir()
        result = execute_backend(root, binary, args.backend_shards, args.backend_seed, run_root, args.serial)
        if not args.run_root:
            write_json_atomic(run_root / "summary.json", result)
        for process in result["processes"]:
            print(f"Backend shard {process['index']}: {process['status']} ({process['duration_seconds']:.3f}s)")
        print(f"Backend aggregate: {result['status']} ({result['wall_seconds']:.3f}s)")
        return int(result["exit_code"])
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Backend shard runner failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
