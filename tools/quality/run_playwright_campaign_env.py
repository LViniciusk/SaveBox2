"""Run the canonical Playwright campaign with one owned disposable environment."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import run_playwright_campaign as campaign
import owned_frontend as frontend_owner


HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
DEFAULT_FRONTEND_URL = "http://127.0.0.1:4200"
ROUND_ID_PATTERN = re.compile(r"^B\.\d+-R\d+\.M\d+$")
CANONICAL_RUNS = 5
CANONICAL_TESTS = 5
PROTECTED_TREES = ("backend/include", "backend/src", "frontend/src", "frontend/e2e", "frontend/e2e-probe", "frontend/tools")
PROTECTED_FILES = (
    "backend/CMakeLists.txt",
    "frontend/angular.json",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/playwright.config.ts",
    "frontend/playwright.login-boundary.config.ts",
    "tools/quality/run_playwright.py",
    "tools/quality/test_run_playwright.py",
    "tools/quality/run_playwright_campaign.py",
    "tools/quality/run_playwright_campaign_env.py",
    "tools/quality/test_run_playwright_campaign.py",
    "tools/quality/test_run_playwright_campaign_env.py",
    "tools/quality/run_browser_boundary_probe.py",
    "tools/quality/test_run_browser_boundary_probe.py",
    "tools/quality/owned_frontend.py",
    "tools/quality/test_owned_frontend.py",
)


class EnvironmentFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class DatabaseCredentials:
    user: str
    password: str
    name: str


@dataclass(frozen=True)
class PostgresHandle:
    container_id: str
    host_port: int
    credentials: DatabaseCredentials


@dataclass(frozen=True)
class RuntimeWorkspace:
    root: Path
    env_file: Path
    cwd: Path
    storage_root: Path
    storage_marker: Path
    storage_id: str


@dataclass(frozen=True)
class EnvironmentLease:
    postgres: PostgresHandle
    workspace: RuntimeWorkspace
    summary: dict[str, object]
    e2e_environment: dict[str, str]


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def validate_round_id(value: str | None) -> str:
    if value is None or not ROUND_ID_PATTERN.fullmatch(value):
        raise EnvironmentFailure("CAMPAIGN_ROUND_ID_INVALID")
    return value


def validate_output_is_new(output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise EnvironmentFailure("ARTIFACT_ROUND_ALREADY_EXISTS")


def _tree_sha256(root: Path, relative: str) -> str:
    directory = root / relative
    if not directory.is_dir():
        raise EnvironmentFailure("CAMPAIGN_SOURCE_HASH_FAILED")
    digest = hashlib.sha256()
    for path in sorted((item for item in directory.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        if path.is_symlink():
            raise EnvironmentFailure("CAMPAIGN_SOURCE_HASH_FAILED")
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        try:
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            raise EnvironmentFailure("CAMPAIGN_SOURCE_HASH_FAILED") from None
        digest.update(b"\0")
    return digest.hexdigest()


def capture_source_hashes(root: Path) -> dict[str, object]:
    files: dict[str, str] = {}
    try:
        for relative in PROTECTED_FILES:
            path = root / relative
            if not path.is_file() or path.is_symlink():
                raise EnvironmentFailure("CAMPAIGN_SOURCE_HASH_FAILED")
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        trees = {relative: _tree_sha256(root, relative) for relative in PROTECTED_TREES}
    except OSError:
        raise EnvironmentFailure("CAMPAIGN_SOURCE_HASH_FAILED") from None
    return {"algorithm": "sha256", "files": files, "trees": trees}


def capture_campaign_hashes(root: Path) -> dict[str, object]:
    import run_recovery_targeted as recovery_owner

    snapshot = recovery_owner.source_hashes(root)
    for directory in (root / ".quality").iterdir():
        if directory.is_dir() and re.fullmatch(r"b90-r1m27-[a-z0-9-]+", directory.name):
            relative = directory.relative_to(root).as_posix()
            snapshot["historicalArtifacts"][relative] = _tree_sha256(root, relative)
    return snapshot


def validate_playwright_config(path: Path) -> dict[str, bool]:
    try:
        source = path.read_text(encoding="utf-8")
    except OSError:
        raise EnvironmentFailure("CAMPAIGN_PLAYWRIGHT_CONFIG_INVALID") from None
    checks = {
        "testDirE2e": bool(re.search(r"\btestDir:\s*['\"]\./e2e['\"]", source)),
        "serialWorkers": bool(re.search(r"\bfullyParallel:\s*false\b", source) and re.search(r"\bworkers:\s*1\b", source)),
        "zeroRetries": bool(re.search(r"\bretries:\s*0\b", source)),
        "diagnosticArtifactsOff": all(re.search(rf"\b{key}:\s*['\"]off['\"]", source) for key in ("trace", "video", "screenshot")),
        "serviceWorkersBlocked": bool(re.search(r"\bserviceWorkers:\s*['\"]block['\"]", source)),
        "chromiumProject": bool(re.search(r"\bname:\s*['\"]chromium['\"]", source) and "Desktop Chrome" in source),
    }
    if not all(checks.values()):
        raise EnvironmentFailure("CAMPAIGN_PLAYWRIGHT_CONFIG_INVALID")
    return checks


def _validate_local_base_url(url: str) -> None:
    try:
        parsed = urlsplit(url)
        valid = (
            parsed.scheme == "http"
            and parsed.hostname in LOCAL_HOSTS
            and parsed.port is not None
            and 1 <= parsed.port <= 65535
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
        )
    except ValueError:
        valid = False
    if not valid:
        raise EnvironmentFailure("CAMPAIGN_ENV_INVALID")


def _preferred_frontend_port(url: str) -> int:
    try:
        return frontend_owner.preferred_frontend_port(url)
    except frontend_owner.FrontendOwnershipFailure:
        raise EnvironmentFailure("CAMPAIGN_FRONTEND_PREFERENCE_INVALID") from None


def discover_canonical_tests(root: Path, *, runner=subprocess.run) -> dict[str, object]:
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        raise EnvironmentFailure("CAMPAIGN_PLAYWRIGHT_CLI_UNAVAILABLE")
    try:
        completed = runner(
            [npm, "run", "e2e:chromium", "--", "--list"],
            cwd=root / "frontend",
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
    except OSError:
        raise EnvironmentFailure("CAMPAIGN_PLAYWRIGHT_DISCOVERY_FAILED") from None
    matches = re.findall(r"^Total:\s*(\d+)\s+tests?\s+in\s+\d+\s+files?\s*$", completed.stdout, re.MULTILINE)
    if completed.returncode != 0 or len(matches) != 1 or int(matches[0]) != CANONICAL_TESTS:
        raise EnvironmentFailure("CAMPAIGN_CANONICAL_DISCOVERY_INVALID")
    return {
        "testsDiscovered": int(matches[0]),
        "workers": 1,
        "fullyParallel": False,
        "retries": 0,
        "executionStarted": False,
    }


def preflight(
    root: Path,
    round_id: str,
    runs: int,
    output: Path,
    frontend_url: str,
    backend_url: str,
    backend_executable: Path,
    *,
    discovery_runner=subprocess.run,
) -> dict[str, object]:
    validate_round_id(round_id)
    if runs != CANONICAL_RUNS:
        raise EnvironmentFailure("CAMPAIGN_RUN_COUNT_INVALID")
    validate_output_is_new(output)
    if not backend_executable.is_file() or backend_executable.is_symlink():
        raise EnvironmentFailure("CAMPAIGN_BACKEND_EXECUTABLE_MISSING")
    preferred_port = _preferred_frontend_port(frontend_url)
    _validate_local_base_url(backend_url)
    if campaign.endpoint_reachable(backend_url):
        raise EnvironmentFailure("CAMPAIGN_BACKEND_ALREADY_RUNNING")
    config = validate_playwright_config(root / "frontend" / "playwright.config.ts")
    discovery = discover_canonical_tests(root, runner=discovery_runner)
    if discovery.get("testsDiscovered") != CANONICAL_TESTS:
        raise EnvironmentFailure("CAMPAIGN_CANONICAL_DISCOVERY_INVALID")
    return {
        "roundId": round_id,
        "runs": runs,
        "preferredFrontendPort": preferred_port,
        "playwrightConfig": config,
        "discovery": discovery,
    }


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as destination:
        destination.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def make_database_credentials() -> DatabaseCredentials:
    password = secrets.token_hex(16)
    name = f"nanika_e2e_m10_{secrets.token_hex(6)}"
    if not HEX32.fullmatch(password) or not re.fullmatch(r"nanika_e2e_[0-9a-z_]{1,50}", name):
        raise EnvironmentFailure("CAMPAIGN_DATABASE_PREFLIGHT_INVALID")
    return DatabaseCredentials("nanika_e2e", password, name)


def create_runtime_workspace(base_root: Path | None = None, storage_id: str | None = None) -> RuntimeWorkspace:
    root = (base_root or Path(tempfile.mkdtemp(prefix="nanika-b90-r1m10-"))).resolve()
    storage = root / "storage"
    cwd = root / "work" / "run"
    try:
        storage.mkdir(parents=True, exist_ok=False)
        cwd.mkdir(parents=True, exist_ok=False)
        marker_value = storage_id or secrets.token_hex(32)
        if not HEX64.fullmatch(marker_value):
            raise EnvironmentFailure("CAMPAIGN_STORAGE_PREP_FAILED")
        marker = storage / ".nanika-e2e-storage-id"
        marker.write_text(marker_value, encoding="ascii", newline="")
        return RuntimeWorkspace(root, root / ".env", cwd, storage, marker, marker_value)
    except EnvironmentFailure:
        raise
    except OSError:
        raise EnvironmentFailure("CAMPAIGN_STORAGE_PREP_FAILED") from None


def workspace_summary(workspace: RuntimeWorkspace) -> dict[str, object]:
    return {
        "dotenvCreated": workspace.env_file.is_file(),
        "configAuthority": "nearest-ancestor-dotenv",
        "nearestAncestorDotenv": workspace.env_file.is_file(),
        "fixtureCwdShared": True,
        "storageIsolated": workspace.storage_root.is_dir(),
        "storageMarkerValid": HEX64.fullmatch(workspace.storage_id) is not None,
        "secretRecorded": False,
    }


def write_runtime_env(
    workspace: RuntimeWorkspace,
    credentials: DatabaseCredentials,
    database_port: int,
    backend_port: int,
    frontend_url: str,
) -> None:
    values = {
        "CORS_ALLOWED_ORIGINS": frontend_url.rstrip("/"),
        "CORS_ORIGIN": frontend_url.rstrip("/"),
        "DB_HOST": "127.0.0.1",
        "DB_NAME": credentials.name,
        "DB_PASSWORD": credentials.password,
        "DB_PORT": str(database_port),
        "DB_USER": credentials.user,
        "EMAIL_VALIDATION_API_KEY": "m10-email-validation",
        "GOOGLE_CLIENT_ID": "m10-google-client",
        "GOOGLE_CLIENT_SECRET": "m10-google-secret",
        "IMGUR_CLIENT_ID": "m10-imgur-client",
        "NANIKA_E2E_STORAGE_ID": workspace.storage_id,
        "NANIKA_JWT_SECRET": secrets.token_hex(32),
        "NANIKA_STORAGE_PATH": str(workspace.storage_root),
        "NANIKA_BIND_ADDRESS": "127.0.0.1",
        "PASS_PEPPER": secrets.token_hex(16),
        "PORT": str(backend_port),
        "RESEND_API_KEY": "m10-resend",
        "TRUST_PROXY_HEADERS": "false",
    }
    if len(values["PASS_PEPPER"]) > 64 or not values["NANIKA_STORAGE_PATH"]:
        raise EnvironmentFailure("CAMPAIGN_RUNTIME_CONFIG_INVALID")
    workspace.env_file.write_text("".join(f"{key}={values[key]}\n" for key in sorted(values)), encoding="utf-8", newline="\n")


def postgres_command(container_name: str, credentials: DatabaseCredentials) -> tuple[list[str], dict[str, str]]:
    if not re.fullmatch(r"nanika-e2e-m10-[0-9a-f]{12}", container_name):
        raise EnvironmentFailure("CAMPAIGN_POSTGRES_START_FAILED")
    argv = [
        "docker", "run", "--detach", "--name", container_name,
        "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB",
        "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", "postgres:15-alpine",
    ]
    child_env = os.environ.copy()
    child_env.update({
        "POSTGRES_USER": credentials.user,
        "POSTGRES_PASSWORD": credentials.password,
        "POSTGRES_DB": credentials.name,
    })
    return argv, child_env


def _run(argv: list[str], *, env: dict[str, str] | None = None, runner=subprocess.run) -> subprocess.CompletedProcess[str]:
    return runner(argv, env=env or os.environ.copy(), capture_output=True, text=True, check=False, shell=False)


def _host_port(container_id: str, runner=subprocess.run) -> int:
    result = _run(["docker", "port", container_id, "5432/tcp"], runner=runner)
    if result.returncode != 0:
        raise EnvironmentFailure("CAMPAIGN_POSTGRES_START_FAILED")
    match = re.fullmatch(r"127\.0\.0\.1:(\d+)\s*", result.stdout.strip())
    if not match:
        raise EnvironmentFailure("CAMPAIGN_POSTGRES_START_FAILED")
    port = int(match.group(1))
    if not 1 <= port <= 65535:
        raise EnvironmentFailure("CAMPAIGN_POSTGRES_START_FAILED")
    return port


def start_disposable_postgres(credentials: DatabaseCredentials, *, runner=subprocess.run) -> PostgresHandle:
    container_name = f"nanika-e2e-m10-{secrets.token_hex(6)}"
    argv, child_env = postgres_command(container_name, credentials)
    result = _run(argv, env=child_env, runner=runner)
    if result.returncode != 0:
        raise EnvironmentFailure("CAMPAIGN_POSTGRES_START_FAILED")
    container_id = result.stdout.strip()
    if not CONTAINER_ID.fullmatch(container_id):
        raise EnvironmentFailure("CAMPAIGN_POSTGRES_START_FAILED")
    try:
        host_port = _host_port(container_id, runner=runner)
    except EnvironmentFailure:
        _run(["docker", "rm", "-f", container_id], runner=runner)
        raise
    return PostgresHandle(container_id, host_port, credentials)


def wait_for_postgres(handle: PostgresHandle, *, runner=subprocess.run, timeout: float = 30.0) -> None:
    env = os.environ.copy()
    env["PGPASSWORD"] = handle.credentials.password
    deadline = time.monotonic() + timeout
    argv = [
        "docker", "exec", "--env", "PGPASSWORD", handle.container_id, "pg_isready",
        "--host", "127.0.0.1", "--port", "5432", "--username", handle.credentials.user,
        "--dbname", handle.credentials.name,
    ]
    while time.monotonic() < deadline:
        if _run(argv, env=env, runner=runner).returncode == 0:
            return
        time.sleep(0.1)
    raise EnvironmentFailure("CAMPAIGN_POSTGRES_HEALTH_TIMEOUT")


def probe_database_credentials(handle: PostgresHandle, *, runner=subprocess.run) -> bool:
    env = os.environ.copy()
    env["PGPASSWORD"] = handle.credentials.password
    argv = [
        "docker", "exec", "--env", "PGPASSWORD", handle.container_id, "psql",
        "--host", "127.0.0.1", "--port", "5432", "--username", handle.credentials.user,
        "--dbname", handle.credentials.name, "--no-password", "--tuples-only", "--no-align",
        "--command", "SELECT 1",
    ]
    result = _run(argv, env=env, runner=runner)
    if result.returncode != 0 or result.stdout.strip() != "1":
        raise EnvironmentFailure("CAMPAIGN_DATABASE_AUTH_FAILED")
    return True


def remove_disposable_postgres(handle: PostgresHandle, *, runner=subprocess.run) -> None:
    if not CONTAINER_ID.fullmatch(handle.container_id):
        raise EnvironmentFailure("CAMPAIGN_TEARDOWN_FAILED")
    result = _run(["docker", "rm", "-f", handle.container_id], runner=runner)
    if result.returncode != 0:
        raise EnvironmentFailure("CAMPAIGN_TEARDOWN_FAILED")


def cleanup_runtime_workspace(workspace: RuntimeWorkspace) -> None:
    temp_root = Path(tempfile.gettempdir()).resolve()
    root = workspace.root.resolve()
    if root == temp_root or not str(root).startswith(str(temp_root) + os.sep):
        raise EnvironmentFailure("CAMPAIGN_TEARDOWN_FAILED")
    if root.exists():
        shutil.rmtree(root)


def _runtime_credentials(workspace: RuntimeWorkspace, handle: PostgresHandle) -> DatabaseCredentials:
    values = read_dotenv(workspace.env_file)
    required = {"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"}
    if not required.issubset(values) or values["DB_HOST"] != "127.0.0.1" or int(values["DB_PORT"]) != handle.host_port:
        raise EnvironmentFailure("CAMPAIGN_DATABASE_PREFLIGHT_INVALID")
    runtime = DatabaseCredentials(values["DB_USER"], values["DB_PASSWORD"], values["DB_NAME"])
    if runtime != handle.credentials:
        raise EnvironmentFailure("CAMPAIGN_DATABASE_AUTH_FAILED")
    return runtime


def prepare_environment(
    root: Path,
    frontend_url: str,
    backend_url: str,
    backend_executable: Path,
    *,
    credential_factory=make_database_credentials,
) -> EnvironmentLease:
    postgres: PostgresHandle | None = None
    workspace: RuntimeWorkspace | None = None
    try:
        parsed = urlsplit(backend_url)
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.port is None:
            raise EnvironmentFailure("CAMPAIGN_ENV_INVALID")
        credentials = credential_factory()
        postgres = start_disposable_postgres(credentials)
        workspace = create_runtime_workspace()
        config_source = root / "config" / "disposable_domains.txt"
        if not config_source.is_file():
            raise EnvironmentFailure("CAMPAIGN_STORAGE_PREP_FAILED")
        (workspace.root / "config").mkdir()
        shutil.copy2(config_source, workspace.root / "config" / "disposable_domains.txt")
        wait_for_postgres(postgres)
        write_runtime_env(workspace, credentials, postgres.host_port, parsed.port, frontend_url)
        runtime_credentials = _runtime_credentials(workspace, postgres)
        authenticated = probe_database_credentials(PostgresHandle(postgres.container_id, postgres.host_port, runtime_credentials))
        return EnvironmentLease(
            postgres,
            workspace,
            {
                "postgres": {
                    "owned": True,
                    "containerStarted": True,
                    "ready": True,
                    "credentialAuthentication": authenticated,
                    "loopbackOnly": True,
                    "tmpfs": True,
                    "secretRecorded": False,
                },
                "runtime": workspace_summary(workspace),
                "backendExecutablePresent": backend_executable.is_file(),
            },
            {
                "NANIKA_E2E_STORAGE_PATH": str(workspace.storage_root),
                "NANIKA_E2E_STORAGE_ID": workspace.storage_id,
                "NANIKA_E2E_FIXTURE_CWD": str(workspace.cwd),
            },
        )
    except EnvironmentFailure:
        cleanup_failed = False
        if postgres is not None:
            try:
                remove_disposable_postgres(postgres)
            except EnvironmentFailure:
                cleanup_failed = True
        if workspace is not None:
            try:
                cleanup_runtime_workspace(workspace)
            except EnvironmentFailure:
                cleanup_failed = True
        if cleanup_failed:
            raise EnvironmentFailure("CAMPAIGN_TEARDOWN_FAILED") from None
        raise


def write_campaign_artifacts(
    output: Path,
    *,
    round_id: str,
    environment: dict[str, object],
    source_before: dict[str, object],
    source_after: dict[str, object] | None,
    performance: dict[str, object],
    result: str,
    failure_code: str | None,
    summary: dict[str, object] | None,
    teardown_ok: bool,
) -> dict[str, object]:
    hashes_match = source_after is not None and source_before == source_after
    write_json(
        output / "post" / "protected-hashes.json",
        {
            "round": round_id,
            "capture": "POST_CAMPAIGN",
            "historicalHashesCompared": bool(source_before.get("historicalArtifacts")) and source_after is not None,
            "protectedHashes": source_after,
            "matchesPreExecutionSnapshot": hashes_match,
            "protectedSourceChangedDuringExecution": source_after is not None and not hashes_match,
        },
    )
    write_json(output / "environment" / "result.json", environment)
    write_json(output / "performance" / "pipeline.json", performance)
    passed_runs = int(summary.get("passedRuns", 0)) if summary else 0
    runs = (summary or {}).get("runs", [])
    canonical_records = [run.get("canonical", {}) for run in runs if isinstance(run, dict)]
    canonical_passed = sum(int(record.get("passed", 0)) for record in canonical_records if isinstance(record, dict))
    canonical_failed = sum(int(record.get("failed", 0)) for record in canonical_records if isinstance(record, dict))
    canonical_skipped = sum(int(record.get("skipped", 0)) for record in canonical_records if isinstance(record, dict))
    canonical_flaky = sum(int(record.get("flaky", 0)) for record in canonical_records if isinstance(record, dict))
    canonical_retries = int(summary.get("retries", 0)) if summary else 0
    canonical_exact = bool(summary) and (
        int(summary.get("canonicalRunsStarted", 0)) == CANONICAL_RUNS
        and int(summary.get("canonicalRunsCompleted", 0)) == CANONICAL_RUNS
        and passed_runs == CANONICAL_RUNS
        and int(summary.get("failedRuns", 0)) == 0
        and int(summary.get("backendProcessesSpawned", 0)) == CANONICAL_RUNS
        and int(summary.get("backendGenerationsReady", 0)) == CANONICAL_RUNS
        and not bool(summary.get("stoppedEarly"))
        and len(canonical_records) == CANONICAL_RUNS
        and all(
            isinstance(record, dict)
            and record.get("total") == CANONICAL_TESTS
            and record.get("passed") == CANONICAL_TESTS
            and record.get("failed") == 0
            and record.get("skipped") == 0
            and record.get("flaky") == 0
            and record.get("retries") == 0
            for record in canonical_records
        )
        and canonical_passed == CANONICAL_RUNS * CANONICAL_TESTS
        and canonical_failed == canonical_skipped == canonical_flaky == canonical_retries == 0
    )
    frontend_ready = bool(environment.get("frontendReady"))
    frontend_stopped = bool(environment.get("frontendStopped"))
    frontend_used_by_campaign = bool(environment.get("campaignUsedOwnedFrontend"))
    frontend_ownership_complete = (
        bool(environment.get("frontendOwned"))
        and frontend_ready
        and frontend_stopped
        and frontend_used_by_campaign
        and environment.get("frontendGenerations") == 1
    )
    backend_processes_spawned = int((summary or {}).get("backendProcessesSpawned", 0))
    backend_teardown_records = sum(
        1
        for run in (summary or {}).get("runs", [])
        if isinstance(run, dict) and isinstance(run.get("backendTeardown"), dict)
    )
    all_backends_stopped = bool(summary) and backend_teardown_records == backend_processes_spawned
    formal_pass = (
        result == "PASS"
        and canonical_exact
        and frontend_ownership_complete
        and all_backends_stopped
        and hashes_match
        and teardown_ok
        and bool(environment.get("postgresRemoved"))
        and bool(environment.get("workspaceRemoved"))
        and environment.get("userResourcesPreserved") is True
    )
    formal_result = "PASS_CANONICAL_5X_RATIFICATION" if formal_pass else (
        result if result.startswith("BLOCKED_OWNED_FRONTEND_") or result == "BLOCKED_RESOURCE_TEARDOWN"
        else "BLOCKED_CANONICAL_RATIFICATION"
    )
    decision = {
        "round": round_id,
        "result": formal_result,
        "frontend": {
            "owned": bool(environment.get("frontendOwned")),
            "generations": int(environment.get("frontendGenerations", 0)),
            "ready": frontend_ready,
            "usedPreferredPort": environment.get("frontendUsedPreferredPort"),
            "stopped": environment.get("frontendStopped"),
            "teardownEscalated": bool(environment.get("frontendTeardownEscalated")),
            "campaignUsedOwnedAuthority": frontend_used_by_campaign,
        },
        "canonical": {
            "plannedInvocations": CANONICAL_RUNS,
            "startedInvocations": int(summary.get("canonicalRunsStarted", 0)) if summary else 0,
            "completedInvocations": int(summary.get("canonicalRunsCompleted", 0)) if summary else 0,
            "passedInvocations": passed_runs,
            "failedInvocations": int(summary.get("failedRuns", 0)) if summary else 0,
            "testsPerInvocation": CANONICAL_TESTS,
            "totalPassed": canonical_passed,
            "totalFailed": canonical_failed,
            "totalSkipped": canonical_skipped,
            "totalFlaky": canonical_flaky,
            "totalExecutions": sum(int(record.get("total", 0)) for record in canonical_records if isinstance(record, dict)),
            "retries": canonical_retries,
        },
        "ownership": {
            "singleDisposableDatabase": True,
            "freshBackendPerInvocation": True,
            "backendGenerations": int((summary or {}).get("backendProcessesSpawned", 0)),
            "allBackendsStopped": all_backends_stopped,
            "postgresRemoved": environment.get("postgresRemoved"),
            "workspaceRemoved": environment.get("workspaceRemoved"),
            "userContainersPreserved": environment.get("userResourcesPreserved"),
            "unknownProcessesPreserved": True,
        },
        "sourceHashesMatch": hashes_match,
        "sourceRuntimeComparison": environment.get("sourceRuntimeComparison", "NOT_RUN"),
        "sourceUnchangedAcrossRuntime": environment.get("sourceUnchangedAcrossRuntime"),
        "environmentTeardownSucceeded": teardown_ok,
        "failureCode": failure_code,
        "source": {
            "protectedHashesMatchBeforeAfter": hashes_match,
            "protectedSourceChangedDuringExecution": source_after is not None and not hashes_match,
        },
        "findings": {
            "M21-F01": "CLOSED",
            "M21-F02": "CLOSED / PRESERVED",
            "M20-F01": "CLOSED",
            "M13-F01": "CLOSED_BY_CURRENT_ACTUAL_ANGULAR_LOGIN_BOUNDARY",
            "M13HistoricalRootCause": "NOT_RECONSTRUCTED",
            "B90-F02": "CLOSED" if formal_pass else "OPEN",
            "B.90": "CLOSED / FROZEN" if formal_pass else "OPEN / NOT FROZEN",
            "B.91": "READY TO START (NOT STARTED)" if formal_pass else "NOT STARTED",
        },
        "productionSourceChanged": None if source_after is None else any(
            source_before.get("trees", {}).get(tree) != source_after.get("trees", {}).get(tree)
            for tree in ("backend/include", "backend/src", "frontend/src")
        ),
    }
    write_json(output / "ratification-decision.json", decision)
    report_lines = [
        f"# {round_id} — Relatório final",
        "",
        f"**Resultado:** {decision['result']}",
        "",
        "## Correção de ownership e ordem do preflight",
        "",
        "- A campanha inicia uma geração Angular própria em IPv4 loopback e propaga sua URL efetiva ao backend descartável e ao Playwright.",
        "- A porta 4200 é preferência; se ocupada, usa-se uma única porta IPv4 loopback dinâmica, sem inspecionar ou encerrar listeners existentes.",
        "- Validação estática e uma descoberta de cinco testes ocorrem antes da alocação de processos ou Docker/PostgreSQL.",
        "- PostgreSQL é iniciado uma vez; cada invocação recebe backend novo; a campanha para na primeira falha, sem retry.",
        "",
        "## Lifecycle compartilhado",
        "",
        "As primitivas de reserva, spawn, readiness, logs temporários e teardown estão em `tools/quality/owned_frontend.py`; o probe M19/M20 usa a mesma implementação com aliases compatíveis.",
        "",
        "## Descoberta canônica",
        "",
        f"- Testes descobertos: {int(environment.get('canonicalTestsDiscovered', 0))}.",
        "- A descoberta `npm run e2e:chromium -- --list` ocorreu uma vez e não executou specs.",
        "",
        f"- Campanha: {decision['canonical']['completedInvocations']}/{CANONICAL_RUNS} invocações concluídas; {decision['canonical']['startedInvocations']} iniciadas.",
        f"- Specs aprovados: {canonical_passed}/{CANONICAL_RUNS * CANONICAL_TESTS}.",
        f"- Falhas/skips/flaky/retries: {canonical_failed}/{canonical_skipped}/{canonical_flaky}/{decision['canonical']['retries']}.",
        f"- Hashes protegidos {round_id} pré/pós: {'iguais' if hashes_match else 'divergentes ou incompletos'}.",
        f"- Limpeza do ambiente: {'concluída' if teardown_ok else 'falhou'}.",
        f"- Código de falha: {failure_code or 'nenhum'}.",
        "",
        "## Proveniência e decisões de pipeline",
        "",
        f"- `--round-id` é a autoridade desta execução: `{round_id}`; não há round hardcoded no plano formal.",
        "- Uma descoberta precede a alocação do ambiente; uma lease PostgreSQL atende as cinco invocações.",
        "- Cada invocação recebe uma geração backend nova; a campanha para na primeira falha e mantém zero retries.",
        "- A validação invariável da configuração é reaproveitada entre gerações; prontidão e limpeza permanecem por geração.",
        "- O wrapper `npm run e2e:chromium` foi mantido; nenhuma redução material foi demonstrada que justificasse removê-lo.",
        "- Builds, matrix completa, coverage, mutation e probes históricos foram evitados/reutilizados, não repetidos.",
        "",
        "## Resultados por invocação",
        "",
        "| Run | Resultado | Aprovados | Startup backend (ms) | Playwright (ms) | Teardown backend (ms) |",
        "|---:|---|---:|---:|---:|---:|",
        *[
            f"| {run.get('index', '?')} | {run.get('result', 'BLOCKED')} | {run.get('canonical', {}).get('passed', 0)}/5 | {run.get('backendStartupMs', '—')} | {run.get('canonicalMs', '—')} | {run.get('backendTeardownMs', '—')} |"
            for run in runs
            if isinstance(run, dict)
        ],
        "",
        "## Performance e gates focados",
        "",
        "Os tempos são informativos, sem threshold de aprovação. O fluxo evita frontend manual, startups Angular repetidos, descoberta após alocação de processos e repetição de gates históricos pesados; nenhum percentual de speedup é inferido.",
        "",
        "## Ownership e limpeza de recursos",
        "",
        f"- Angular: pronto={frontend_ready}; gerações={environment.get('frontendGenerations', 0)}; usado pela campanha={frontend_used_by_campaign}; parado={frontend_stopped}; teardown escalonado={bool(environment.get('frontendTeardownEscalated'))}.",
        f"- PostgreSQL removido={bool(environment.get('postgresRemoved'))}; workspace removido={bool(environment.get('workspaceRemoved'))}; backends parados={decision['ownership']['allBackendsStopped']}.",
        f"- Preservação de containers preexistentes por inventário pré/pós: {environment.get('userResourcesPreserved')}.",
        "",
        "## Estado formal",
        "",
        f"- M21-F01: {decision['findings']['M21-F01']}.",
        f"- M21-F02: {decision['findings']['M21-F02']}.",
        f"- B90-F02: {decision['findings']['B90-F02']}.",
        f"- B.90: {decision['findings']['B.90']}.",
        f"- B.91: {decision['findings']['B.91']}.",
        "- B.91 não foi iniciado.",
        f"- Source protegido alterado durante a execução: {source_after is not None and not hashes_match}.",
        "- A comparação usa snapshots imediatamente anterior e posterior à execução formal, incluindo hashes dos artefatos históricos protegidos.",
        "",
        "## Evidências",
        "",
        "- `baseline/protected-hashes.json` e `post/protected-hashes.json` (comparação pré/pós desta campanha).",
        "- `discovery/canonical.json` (descoberta canônica sem execução).",
        "- `environment/plan.json` e `environment/result.json`.",
        "- `canonical/campaign-plan.json`, `canonical/campaign-summary.json` e diretórios por invocação.",
        "- `performance/pipeline.json` (telemetria informativa, sem limite de aprovação).",
        "- `ratification-decision.json`.",
        "",
    ]
    with (output / "final-report.md").open("x", encoding="utf-8", newline="\n") as report:
        report.write("\n".join(report_lines))
    return decision


def _campaign_frontend_failure(code: str) -> str:
    return {
        "FRONTEND_NODE_UNAVAILABLE": "CAMPAIGN_FRONTEND_START_FAILED",
        "FRONTEND_TOOLING_UNAVAILABLE": "CAMPAIGN_FRONTEND_START_FAILED",
        "FRONTEND_PORT_ALLOCATION_FAILED": "CAMPAIGN_FRONTEND_START_FAILED",
        "FRONTEND_START_FAILED": "CAMPAIGN_FRONTEND_START_FAILED",
        "FRONTEND_EXITED_EARLY": "CAMPAIGN_FRONTEND_EXITED_EARLY",
        "FRONTEND_LISTENER_TIMEOUT": "CAMPAIGN_FRONTEND_LISTENER_TIMEOUT",
        "FRONTEND_HTTP_TIMEOUT": "CAMPAIGN_FRONTEND_NOT_READY",
        "FRONTEND_TEARDOWN_FAILED": "CAMPAIGN_FRONTEND_TEARDOWN_FAILED",
    }.get(code, "CAMPAIGN_FRONTEND_START_FAILED")


def main(argv: list[str] | None = None) -> int:
    import run_recovery_targeted as recovery_owner

    root = repository_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round-id", nargs="?", const=None)
    parser.add_argument("--runs", type=int, default=CANONICAL_RUNS)
    parser.add_argument("--output", type=Path, default=root / ".quality" / "b90-r1m21-canonical-ratification")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    backend_url = os.environ.get("NANIKA_E2E_BACKEND_URL", "http://127.0.0.1:18082")
    frontend_preference = os.environ.get("NANIKA_E2E_BASE_URL", DEFAULT_FRONTEND_URL)
    backend_executable = Path(os.environ.get("NANIKA_E2E_BACKEND_EXE", root / "backend" / "build" / "savebox_server.exe"))
    output = args.output if args.output.is_absolute() else root / args.output
    preflight_started = time.perf_counter()
    try:
        round_id = validate_round_id(args.round_id)
        preflight_result = preflight(
            root, round_id, args.runs, output, frontend_preference, backend_url, backend_executable
        )
        output.mkdir(parents=True, exist_ok=False)
    except EnvironmentFailure as error:
        print(json.dumps({"result": "BLOCKED", "failureCode": error.code, "secretRecorded": False}, sort_keys=True), file=sys.stderr)
        return 1
    except OSError:
        print(json.dumps({"result": "BLOCKED", "failureCode": "CAMPAIGN_ARTIFACT_PREPARATION_FAILED", "secretRecorded": False}, sort_keys=True), file=sys.stderr)
        return 1
    write_json(output / "discovery" / "canonical.json", {"round": round_id, **preflight_result["discovery"]})
    docker_proof: dict[str, object] = {"cliAvailable": None, "daemonAvailable": None}
    try:
        docker_proof = recovery_owner.probe_docker_runtime()
        preexisting_containers = recovery_owner.container_snapshot()
        write_json(output / "baseline" / "preexisting-resources.json", {
            "round": round_id,
            "containers": [
                {"identitySha256": hashlib.sha256(identity.encode()).hexdigest(), "state": state}
                for identity, state in sorted(preexisting_containers.items())
            ],
        })
        source_before = capture_campaign_hashes(root)
    except (recovery_owner.TargetFailure, EnvironmentFailure) as error:
        if error.code == "DOCKER_CLI_UNAVAILABLE":
            docker_proof = {"cliAvailable": False, "daemonAvailable": None}
        elif error.code == "DOCKER_DAEMON_UNAVAILABLE":
            docker_proof = {"cliAvailable": True, "daemonAvailable": False}
        elif error.code == "DOCKER_DAEMON_PROOF_INVALID":
            docker_proof = {"cliAvailable": True, "daemonAvailable": None}
        blocked = recovery_owner.BLOCKED_RESULTS.get(error.code, "BLOCKED_CANONICAL_RATIFICATION")
        write_json(output / "environment" / "runtime-prerequisites.json", {
            "round": round_id, "docker": docker_proof, "failureCode": error.code,
            "result": blocked, "sourceFreeze": "NOT_RUN", "ownedResourcesStarted": 0,
            "cleanupStatus": "NOT_APPLICABLE", "sourceUnchangedAcrossRuntime": None,
        })
        print(json.dumps({"round": round_id, "result": blocked, "failureCode": error.code, "secretRecorded": False}, sort_keys=True))
        return 1
    write_json(output / "environment" / "runtime-prerequisites.json", {
        "round": round_id, "docker": docker_proof, "result": "PASS",
        "ownedResourcesStarted": 0, "discoveryPassed": True,
    })
    preflight_ms = round((time.perf_counter() - preflight_started) * 1000, 3)
    plan = {
        "round": round_id,
        "frontendOwnership": "owned",
        "frontendLoopbackOnly": True,
        "frontendGenerationsPlanned": 1,
        "plannedRuns": CANONICAL_RUNS,
        "testsPerRun": CANONICAL_TESTS,
        "workers": 1,
        "fullyParallel": False,
        "retries": 0,
        "stopOnFirstFailure": True,
        "freshBackendProcessPerInvocation": True,
        "singleDisposableDatabaseForCampaign": True,
        "databaseCredentialPreflightRequired": True,
        "discoveryExecutionStarted": False,
        "productionChangesAllowed": False,
        "secretRecorded": False,
    }
    write_json(
        output / "baseline" / "protected-hashes.json",
        {"round": round_id, "capture": "PRE_CAMPAIGN", "m19HistoricalHashesCompared": False, "protectedHashes": source_before},
    )
    write_json(output / "source-freeze.json", {"round": round_id, "phase": "SOURCE_FREEZE", **source_before})
    write_json(output / "environment" / "plan.json", {"environmentStages": ["static_preflight", "canonical_discovery", "source_snapshot", "owned_frontend_spawn", "owned_frontend_ready", "postgres_spawn", "postgres_ready", "database_authentication", "storage_preparation", "runtime_config_preparation", "canonical_campaign", "cleanup"], **plan})
    write_json(output / "canonical" / "campaign-plan.json", plan)
    lease: EnvironmentLease | None = None
    frontend_generation: frontend_owner.FrontendGeneration | None = None
    source_after: dict[str, object] | None = None
    summary: dict[str, object] | None = None
    environment_summary: dict[str, object] = {
        "round": round_id,
        "canonicalTestsDiscovered": int(preflight_result["discovery"]["testsDiscovered"]),
        "frontendOwned": False,
        "frontendStarted": False,
        "frontendReady": False,
        "frontendStopped": None,
        "frontendTeardownEscalated": False,
        "frontendGenerations": 0,
        "frontendUsedPreferredPort": None,
        "frontendTcpObserved": False,
        "frontendIndependentTcpProbeObserved": False,
        "frontendHttpObserved": False,
        "frontendFirstTcpReadyMs": None,
        "frontendFirstHttpReadyMs": None,
        "campaignUsedOwnedFrontend": False,
        "environmentPrepared": False,
        "databaseAuthenticated": False,
        "canonicalCampaignStarted": False,
        "postgresRemoved": None,
        "workspaceRemoved": None,
        "userResourcesPreserved": None,
        "secretRecorded": False,
    }
    result = "BLOCKED_CANONICAL_RATIFICATION"
    failure_code: str | None = None
    frontend_startup_ms = 0.0
    frontend_teardown_ms = 0.0
    environment_setup_ms = 0.0
    canonical_ms = 0.0
    teardown_ms = 0.0
    teardown_ok = True
    previous: dict[str, str | None] = {}
    try:
        frontend_started_at = time.perf_counter()
        reservation: frontend_owner.PortReservation | None = None
        try:
            node, ng_cli = frontend_owner.resolve_frontend_tooling(root)
            reservation = frontend_owner.reserve_frontend_port(int(preflight_result["preferredFrontendPort"]))
            try:
                frontend_generation = frontend_owner.spawn_frontend(root, node, ng_cli, reservation)
            finally:
                if reservation is not None:
                    reservation.socket.close()
                    reservation = None
            environment_summary["frontendOwned"] = True
            environment_summary["frontendStarted"] = True
            environment_summary["frontendGenerations"] = 1
            environment_summary["frontendUsedPreferredPort"] = frontend_generation.used_preferred_port
            frontend_owner.wait_frontend_ready(frontend_generation)
            readiness = frontend_generation.readiness
            environment_summary["frontendReady"] = True
            environment_summary["frontendTcpObserved"] = bool(readiness and (readiness.tcp_ever_ready or readiness.http_ever_ready))
            environment_summary["frontendIndependentTcpProbeObserved"] = bool(readiness and readiness.tcp_ever_ready)
            environment_summary["frontendHttpObserved"] = bool(readiness and readiness.http_ever_ready)
            environment_summary["frontendFirstTcpReadyMs"] = readiness.first_tcp_ready_ms if readiness else None
            environment_summary["frontendFirstHttpReadyMs"] = readiness.first_http_ready_ms if readiness else None
        except frontend_owner.FrontendOwnershipFailure as error:
            failure_code = _campaign_frontend_failure(error.code)
            readiness_failure = error.code in {
                "FRONTEND_EXITED_EARLY", "FRONTEND_LISTENER_TIMEOUT", "FRONTEND_HTTP_TIMEOUT"
            }
            result = "BLOCKED_OWNED_FRONTEND_READINESS" if readiness_failure else "BLOCKED_OWNED_FRONTEND_START"
            if frontend_generation is not None and frontend_generation.readiness is not None:
                readiness = frontend_generation.readiness
                environment_summary["frontendTcpObserved"] = bool(readiness.tcp_ever_ready or readiness.http_ever_ready)
                environment_summary["frontendIndependentTcpProbeObserved"] = readiness.tcp_ever_ready
                environment_summary["frontendHttpObserved"] = readiness.http_ever_ready
                environment_summary["frontendFirstTcpReadyMs"] = readiness.first_tcp_ready_ms
                environment_summary["frontendFirstHttpReadyMs"] = readiness.first_http_ready_ms
        except OSError:
            failure_code = "CAMPAIGN_FRONTEND_START_FAILED"
            result = "BLOCKED_OWNED_FRONTEND_START"
        finally:
            frontend_startup_ms = round((time.perf_counter() - frontend_started_at) * 1000, 3)

        if result not in {"BLOCKED_OWNED_FRONTEND_START", "BLOCKED_OWNED_FRONTEND_READINESS"}:
            actual_frontend_url = frontend_generation.url
            environment_started = time.perf_counter()
            try:
                lease = prepare_environment(root, actual_frontend_url, backend_url, backend_executable)
            finally:
                environment_setup_ms = round((time.perf_counter() - environment_started) * 1000, 3)
            if lease.postgres.container_id in preexisting_containers:
                raise EnvironmentFailure("PREEXISTING_POSTGRES_ADOPTION_REJECTED")
            environment_summary.update({
                **lease.summary,
                "environmentPrepared": True,
                "databaseAuthenticated": True,
            })
            previous = {key: os.environ.get(key) for key in ("NANIKA_E2E_BASE_URL", "NANIKA_E2E_BACKEND_URL", "NANIKA_E2E_BACKEND_CWD", *lease.e2e_environment)}
            os.environ.update({
                "NANIKA_E2E_BASE_URL": actual_frontend_url,
                "NANIKA_E2E_BACKEND_URL": backend_url.rstrip("/"),
                "NANIKA_E2E_BACKEND_CWD": str(lease.workspace.cwd),
                **lease.e2e_environment,
            })
            try:
                spec = campaign.BackendSpec(backend_executable, lease.workspace.cwd, backend_url.rstrip("/"))
                environment_summary["canonicalCampaignStarted"] = True
                environment_summary["campaignUsedOwnedFrontend"] = True
                canonical_started = time.perf_counter()
                try:
                    summary = campaign.run_campaign(
                        root, spec, actual_frontend_url, output / "canonical", runs=CANONICAL_RUNS, round_id=round_id
                    )
                finally:
                    canonical_ms = round((time.perf_counter() - canonical_started) * 1000, 3)
                result = "PASS" if summary["result"] == "PASS" else "BLOCKED_CANONICAL_RATIFICATION"
                if result != "PASS":
                    failure_code = next(
                        (run.get("failureCode") for run in summary["runs"] if run.get("failureCode")),
                        "CAMPAIGN_CANONICAL_FAILED",
                    )
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
    except campaign.CampaignFailure as error:
        failure_code = error.code
    except EnvironmentFailure as error:
        failure_code = error.code
    except frontend_owner.FrontendOwnershipFailure as error:
        failure_code = _campaign_frontend_failure(error.code)
        result = "BLOCKED_OWNED_FRONTEND_START"
    except Exception:
        failure_code = "CAMPAIGN_ORCHESTRATION_FAILED"
    finally:
        teardown_started = time.perf_counter()
        if lease is not None:
            if lease.postgres.container_id not in preexisting_containers:
                try:
                    remove_disposable_postgres(lease.postgres)
                    environment_summary["postgresRemoved"] = True
                except Exception:
                    teardown_ok = False
                    environment_summary["postgresRemoved"] = False
                    failure_code = "CAMPAIGN_TEARDOWN_FAILED"
            try:
                cleanup_runtime_workspace(lease.workspace)
                environment_summary["workspaceRemoved"] = True
            except Exception:
                teardown_ok = False
                environment_summary["workspaceRemoved"] = False
                failure_code = "CAMPAIGN_TEARDOWN_FAILED"
        if frontend_generation is not None:
            frontend_teardown_started = time.perf_counter()
            try:
                environment_summary["frontendTeardownEscalated"] = frontend_owner.stop_frontend(frontend_generation)
                environment_summary["frontendStopped"] = True
            except frontend_owner.FrontendOwnershipFailure:
                teardown_ok = False
                environment_summary["frontendStopped"] = False
                failure_code = "CAMPAIGN_FRONTEND_TEARDOWN_FAILED"
            except Exception:
                teardown_ok = False
                environment_summary["frontendStopped"] = False
                failure_code = "CAMPAIGN_FRONTEND_TEARDOWN_FAILED"
            finally:
                frontend_teardown_ms = round((time.perf_counter() - frontend_teardown_started) * 1000, 3)
        teardown_ms = round((time.perf_counter() - teardown_started) * 1000, 3)
        if not teardown_ok:
            result = "BLOCKED_RESOURCE_TEARDOWN"
        try:
            final_containers = recovery_owner.container_snapshot()
            environment_summary["userResourcesPreserved"] = all(
                final_containers.get(identity) == state for identity, state in preexisting_containers.items()
            )
            write_json(output / "post" / "preexisting-resources.json", {
                "round": round_id, "preexistingResourcesPreserved": environment_summary["userResourcesPreserved"],
                "containers": [
                    {"identitySha256": hashlib.sha256(identity.encode()).hexdigest(), "state": state}
                    for identity, state in sorted(final_containers.items())
                ],
            })
            if not environment_summary["userResourcesPreserved"]:
                result = "BLOCKED_CANONICAL_RATIFICATION"
                failure_code = "PREEXISTING_RESOURCES_CHANGED"
            if lease is not None and lease.postgres.container_id not in preexisting_containers and lease.postgres.container_id in final_containers:
                teardown_ok = False
                environment_summary["postgresRemoved"] = False
                result = "BLOCKED_RESOURCE_TEARDOWN"
                failure_code = "CAMPAIGN_TEARDOWN_FAILED"
        except recovery_owner.TargetFailure as error:
            result = "BLOCKED_CANONICAL_RATIFICATION"
            failure_code = error.code
        try:
            source_after = capture_campaign_hashes(root)
        except (EnvironmentFailure, recovery_owner.TargetFailure):
            result = "BLOCKED_CANONICAL_RATIFICATION"
            failure_code = "CAMPAIGN_SOURCE_HASH_FAILED"
        if source_after is not None and source_after != source_before:
            result = "BLOCKED_CANONICAL_RATIFICATION"
            failure_code = "CAMPAIGN_SOURCE_HASH_MISMATCH"
        environment_summary["environmentTeardownSucceeded"] = teardown_ok
        environment_summary["sourceHashesMatch"] = source_after == source_before if source_after is not None else False
        environment_summary["ownedResourcesStarted"] = (
            int(environment_summary["frontendGenerations"]) + (2 if lease is not None else 0)
            + int((summary or {}).get("backendProcessesSpawned", 0))
        )
        runtime_started = environment_summary["ownedResourcesStarted"] > 0
        environment_summary["cleanupRequired"] = runtime_started
        environment_summary["cleanupStatus"] = ("PASS" if teardown_ok else "FAIL") if runtime_started else "NOT_APPLICABLE"
        environment_summary["sourceUnchangedAcrossRuntime"] = source_after == source_before if runtime_started and source_after is not None else None
        environment_summary["sourceRuntimeComparison"] = (
            "MATCH" if environment_summary["sourceUnchangedAcrossRuntime"] is True else
            "MISMATCH" if environment_summary["sourceUnchangedAcrossRuntime"] is False else "NOT_RUN"
        )
        environment_summary["canonicalCampaignStarted"] = bool(environment_summary.get("canonicalCampaignStarted"))
        environment_summary["result"] = result
        environment_summary["failureCode"] = failure_code
        environment_summary["secretRecorded"] = False
        environment_summary["frontendGenerations"] = int(environment_summary.get("frontendGenerations", 0))
        performance = {
            "round": round_id,
            "pipeline": {
                "preflightMs": preflight_ms,
                "frontendStartupMs": frontend_startup_ms,
                "environmentMs": environment_setup_ms,
                "canonicalMs": canonical_ms,
                "frontendTeardownMs": frontend_teardown_ms,
                "teardownMs": teardown_ms,
                "totalMs": round((time.perf_counter() - started) * 1000, 3),
            },
            "informationalOnly": True,
            "usedForPassFail": False,
        }
        decision = write_campaign_artifacts(
            output,
            round_id=round_id,
            environment=environment_summary,
            source_before=source_before,
            source_after=source_after,
            performance=performance,
            result=result,
            failure_code=failure_code,
            summary=summary,
            teardown_ok=teardown_ok,
        )
        result = str(decision["result"])
    print(json.dumps({"round": round_id, "result": result, "failureCode": failure_code, "secretRecorded": False}, sort_keys=True))
    return 0 if result == "PASS_CANONICAL_5X_RATIFICATION" else 1


if __name__ == "__main__":
    raise SystemExit(main())
