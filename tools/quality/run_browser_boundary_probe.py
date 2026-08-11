"""Own Angular DEV and disposable resources for the single M19 browser probe."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

QUALITY_DIR = Path(__file__).resolve().parent
if str(QUALITY_DIR) not in sys.path:
    sys.path.insert(0, str(QUALITY_DIR))

import run_playwright_campaign as campaign
import run_playwright_campaign_env as env_owner
import owned_frontend as frontend_owner


ROUND_ID = "B.90-R1.M19"
M20_ROUND_ID = "B.90-R1.M20"
DEFAULT_FRONTEND_URL = "http://localhost:4200"
DEFAULT_BACKEND_URL = "http://127.0.0.1:18082"
FRONTEND_CHARACTERIZATION_TIMEOUT = 120.0
DEFAULT_FRONTEND_PORT = frontend_owner.DEFAULT_FRONTEND_PORT
FORMAL_FRONTEND_READINESS_TIMEOUT = frontend_owner.FORMAL_FRONTEND_READINESS_TIMEOUT
FRONTEND_READINESS_POLL_INTERVAL = frontend_owner.FRONTEND_READINESS_POLL_INTERVAL
MAX_STARTUP_LOG_TAIL = frontend_owner.MAX_STARTUP_LOG_TAIL
STARTUP_CLASSIFICATIONS = frontend_owner.STARTUP_CLASSIFICATIONS
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
SAFE_RESULTS = frozenset(
    {
        "PASS_REAL_BROWSER_BOUNDARY",
        "FRONTEND_NAVIGATION_FAILED",
        "HEALTH_ROUTE_NOT_MATCHED",
        "REAL_BACKEND_HEALTH_BROWSER_TRANSPORT_FAILED",
        "REAL_BACKEND_HEALTH_RESPONSE_NOT_OBSERVED",
        "REAL_BACKEND_HEALTH_HTTP_UNEXPECTED",
        "LOGIN_ROUTE_NOT_MATCHED",
        "REAL_LOGIN_ORIGIN_MISMATCH",
        "REAL_BACKEND_LOGIN_BROWSER_TRANSPORT_FAILED",
        "REAL_LOGIN_RESPONSE_NOT_OBSERVED",
        "REAL_CORS_RESPONSE_AUTHORITY_MISMATCH",
        "PROBE_BACKEND_CORS_CONTROL_HTTP_FAILED",
        "PROBE_BACKEND_CORS_AUTHORITY_MISMATCH",
        "PROBE_CORS_CONTROL_NOT_DISCRIMINATING",
        "PROBE_EVIDENCE_INVALID",
    }
)
SAFE_M20_RESULTS = frozenset(
    {
        "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN",
        "PROBE_EVIDENCE_INVALID",
        "LOGIN_PAGE_NOT_READY",
        "LOGIN_ACTION_NOT_TRIGGERED",
        "FRONTEND_LOGIN_REQUEST_NOT_EMITTED",
        "LOGIN_REQUEST_COUNT_INVALID",
        "LOGIN_REQUEST_METHOD_INVALID",
        "LOGIN_REQUEST_BODY_INVALID",
        "LOGIN_REQUEST_FIXTURE_MISMATCH",
        "LOGIN_REQUEST_ORIGIN_MISMATCH",
        "LOGIN_REQUEST_AUTHORIZATION_UNEXPECTED",
        "ANGULAR_LOGIN_TRANSPORT_FAILED",
        "LOGIN_RESPONSE_NOT_OBSERVED",
        "LOGIN_RESPONSE_AUTHORITY_MISMATCH",
        "LOGIN_HTTP_SEMANTIC_FAILURE",
        "LOGIN_NAVIGATION_NOT_COMMITTED",
    }
)
M20_PROTECTED_FILES = (
    "backend/include/middlewares/CustomCorsMiddleware.hpp",
    "backend/include/utils.hpp",
    "backend/include/controllers/ApiRouter.hpp",
    "backend/src/main.cpp",
    "backend/src/controllers/ApiRouter.cpp",
    "frontend/tools/e2e-backend-routing.mjs",
    "frontend/tools/e2e-login-diagnostics.mjs",
    "frontend/tools/e2e-login-diagnostics.d.mts",
    "frontend/tools/e2e-login-diagnostics.test.mjs",
    "frontend/e2e/support/fixtures.ts",
    "frontend/e2e/support/session.ts",
    "frontend/e2e-probe/credential-login-boundary.spec.ts",
    "frontend/playwright.config.ts",
    "frontend/playwright.login-boundary.config.ts",
    "frontend/angular.json",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/src/app/core/auth/auth.service.ts",
    "frontend/src/app/core/auth/auth.service.spec.ts",
    "frontend/src/app/features/auth/pages/login/login.component.ts",
    "frontend/src/app/features/auth/pages/login/login.component.spec.ts",
    "frontend/src/app/core/interceptors/jwt.interceptor.ts",
    "frontend/src/app/core/interceptors/error.interceptor.ts",
    "frontend/src/app/app.config.ts",
    "frontend/src/environments/environment.ts",
    "tools/quality/run_playwright_campaign_env.py",
    "tools/quality/run_playwright_campaign.py",
    "tools/quality/run_playwright.py",
    "tools/quality/run_browser_boundary_probe.py",
    "tools/quality/test_run_browser_boundary_probe.py",
)
M20_PROTECTED_TREES = ("backend/src", "backend/include", "frontend/src")
M20_FORBIDDEN_VALUES = (
    "http://",
    "https://",
    "Bearer",
    "Authorization",
    "Cookie",
    "Set-Cookie",
    "JWT",
    "password",
    "username",
    "email",
    "C:\\",
    "/Users/",
    "/home/",
)
M20_EMPTY_LOGIN = {
    "pageReady": False,
    "loginActionTriggered": False,
    "requestCount": 0,
    "methodPost": False,
    "bodyShapeValid": False,
    "fixtureUsernameMatches": False,
    "fixturePasswordMatches": False,
    "originMatches": False,
    "authorizationHeaderPresent": False,
    "requestFailure": "none",
    "responseCount": 0,
    "responseObserved": False,
    "backendAuthorityMatches": False,
    "httpSemanticPassed": False,
    "finalPath": "unknown",
    "uiError": "none",
}


class ProbeFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


PortReservation = frontend_owner.PortReservation
FrontendReadinessObservation = frontend_owner.FrontendReadinessObservation
FrontendGeneration = frontend_owner.FrontendGeneration

_FRONTEND_PROBE_FAILURES = {
    "FRONTEND_NODE_UNAVAILABLE": "PROBE_NODE_UNAVAILABLE",
    "FRONTEND_TOOLING_UNAVAILABLE": "PROBE_FRONTEND_TOOLING_UNAVAILABLE",
    "FRONTEND_PREFERENCE_INVALID": "PROBE_CONFIG_INVALID",
    "FRONTEND_PORT_ALLOCATION_FAILED": "PROBE_FRONTEND_PORT_ALLOCATION_FAILED",
    "FRONTEND_START_FAILED": "PROBE_FRONTEND_START_FAILED",
    "FRONTEND_EXITED_EARLY": "PROBE_FRONTEND_EXITED_EARLY",
    "FRONTEND_LISTENER_TIMEOUT": "PROBE_FRONTEND_LISTENER_TIMEOUT",
    "FRONTEND_HTTP_TIMEOUT": "PROBE_FRONTEND_HEALTH_TIMEOUT",
    "FRONTEND_TEARDOWN_FAILED": "PROBE_FRONTEND_TEARDOWN_FAILED",
}


def _probe_frontend_call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except frontend_owner.FrontendOwnershipFailure as error:
        raise ProbeFailure(_FRONTEND_PROBE_FAILURES.get(error.code, "PROBE_FRONTEND_OWNERSHIP_FAILED")) from None


def resolve_frontend_tooling(root: Path, node_path: str | None = None) -> tuple[str, Path]:
    return _probe_frontend_call(frontend_owner.resolve_frontend_tooling, root, node_path, which=shutil.which)


def reserve_frontend_port(preferred_port: int = DEFAULT_FRONTEND_PORT, *, socket_factory=None) -> PortReservation:
    kwargs = {"socket_factory": socket_factory} if socket_factory is not None else {}
    return _probe_frontend_call(frontend_owner.reserve_frontend_port, preferred_port, **kwargs)


def spawn_frontend(root: Path, node: str, ng_cli: Path, reservation: PortReservation, *, process_factory=None) -> FrontendGeneration:
    kwargs = {"process_factory": process_factory} if process_factory is not None else {}
    return _probe_frontend_call(frontend_owner.spawn_frontend, root, node, ng_cli, reservation, **kwargs)


def frontend_tcp_reachable(generation: FrontendGeneration, *, connection_factory=None) -> bool:
    kwargs = {"connection_factory": connection_factory} if connection_factory is not None else {}
    return frontend_owner.frontend_tcp_reachable(generation, **kwargs)


def frontend_http_ready(generation: FrontendGeneration, *, connection_factory=None) -> bool:
    kwargs = {"connection_factory": connection_factory} if connection_factory is not None else {}
    return frontend_owner.frontend_http_ready(generation, **kwargs)


read_log_tail = frontend_owner.read_log_tail
classify_frontend_startup_output = frontend_owner.classify_frontend_startup_output
_frontend_startup_classification = frontend_owner._frontend_startup_classification


def observe_frontend_readiness(generation: FrontendGeneration, **kwargs) -> FrontendReadinessObservation:
    kwargs.setdefault("tcp_probe", frontend_tcp_reachable)
    kwargs.setdefault("http_probe", frontend_http_ready)
    return frontend_owner.observe_frontend_readiness(generation, **kwargs)


def wait_frontend_ready(generation: FrontendGeneration, *, timeout=FORMAL_FRONTEND_READINESS_TIMEOUT, clock=None, sleeper=None) -> FrontendGeneration:
    return _probe_frontend_call(
        frontend_owner.wait_frontend_ready,
        generation,
        timeout=timeout,
        clock=clock,
        sleeper=sleeper,
        readiness_observer=observe_frontend_readiness,
    )


close_frontend_logs = frontend_owner.close_frontend_logs


def stop_frontend(generation: FrontendGeneration) -> bool:
    return _probe_frontend_call(frontend_owner.stop_frontend, generation)


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def validate_local_url(raw: str) -> str:
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname or ""
        port = parsed.port
    except ValueError as error:
        raise ProbeFailure("PROBE_CONFIG_INVALID") from error
    if (
        parsed.scheme != "http"
        or host not in LOCAL_HOSTS
        or port is None
        or not 1 <= port <= 65535
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ProbeFailure("PROBE_CONFIG_INVALID")
    display_host = f"[{host}]" if ":" in host else host
    return f"http://{display_host}:{port}"


def probe_backend_cors_authority(
    backend_url: str,
    frontend_origin: str,
    *,
    connection_factory=http.client.HTTPConnection,
) -> tuple[bool, bool]:
    parsed = urlsplit(validate_local_url(backend_url))
    if parsed.hostname is None or parsed.port is None:
        raise ProbeFailure("PROBE_CONFIG_INVALID")

    connection = connection_factory(parsed.hostname, parsed.port, timeout=1.0)
    try:
        connection.request("GET", "/health", headers={"Origin": validate_local_url(frontend_origin)})
        response = connection.getresponse()
        status_ok = response.status == 200
        allow_origin_ok = response.getheader("Access-Control-Allow-Origin") == validate_local_url(frontend_origin)
        response.read(16 * 1024)
        return status_ok, allow_origin_ok
    finally:
        connection.close()


def characterization_result(
    observation: FrontendReadinessObservation | None,
    *,
    formal_timeout: float = FORMAL_FRONTEND_READINESS_TIMEOUT,
) -> str:
    if observation and observation.http_ever_ready and observation.first_http_ready_ms is not None:
        if observation.first_http_ready_ms > round(formal_timeout * 1000):
            return "PASS_AFTER_FORMAL_DEADLINE"
        return "PASS_WITHIN_FORMAL_DEADLINE"
    if observation is None or not observation.process_alive_at_end:
        return "PROCESS_EXITED"
    if not observation.tcp_ever_ready:
        return "LISTENER_NEVER_OPENED"
    return "HTTP_NEVER_READY"


def run_frontend_characterization(
    root: Path,
    output_path: Path,
    *,
    node_path: str | None = None,
    timeout: float = FRONTEND_CHARACTERIZATION_TIMEOUT,
    reservation_factory=None,
    frontend_process_factory=subprocess.Popen,
    clock=None,
    sleeper=None,
) -> dict[str, object]:
    if output_path.exists():
        raise ProbeFailure("ARTIFACT_ROUND_ALREADY_EXISTS")

    generation = None
    observation = None
    reservation = None
    process_started = False
    teardown_succeeded = True
    teardown_escalated = False
    try:
        node, ng_cli = resolve_frontend_tooling(root, node_path)
        reservation = (reservation_factory or reserve_frontend_port)(DEFAULT_FRONTEND_PORT)
        generation = spawn_frontend(
            root,
            node,
            ng_cli,
            reservation,
            process_factory=frontend_process_factory,
        )
        reservation = None
        process_started = True
        observation = observe_frontend_readiness(
            generation,
            timeout=timeout,
            clock=clock,
            sleeper=sleeper,
        )
    except ProbeFailure:
        pass
    finally:
        if reservation is not None:
            reservation.socket.close()
        if generation is not None:
            try:
                teardown_escalated = stop_frontend(generation)
            except ProbeFailure:
                teardown_succeeded = False

    result = characterization_result(observation)
    startup_classification = observation.startup_classification if observation else None
    if startup_classification not in STARTUP_CLASSIFICATIONS:
        startup_classification = None
    payload = {
        "round": ROUND_ID,
        "result": result,
        "processStarted": process_started,
        "processExitedEarly": bool(observation and not observation.ready and not observation.process_alive_at_end),
        "processAliveAtEnd": observation.process_alive_at_end if observation else False,
        "tcpEverReady": observation.tcp_ever_ready if observation else False,
        "httpEverReady": observation.http_ever_ready if observation else False,
        "firstTcpReadyMs": observation.first_tcp_ready_ms if observation else None,
        "firstHttpReadyMs": observation.first_http_ready_ms if observation else None,
        "startupClassification": startup_classification,
        "characterizationTimeoutMs": round(timeout * 1000),
        "rawLogsRecorded": False,
        "absolutePathsRecorded": False,
        "retries": 0,
        "frontendStopped": generation is not None and teardown_succeeded,
        "frontendTeardownEscalated": teardown_escalated,
    }
    write_json(output_path, payload)
    summary_path = output_path.with_name("summary.md")
    summary_path.write_text(
        "# Caracterização de readiness do Angular\n\n"
        f"- Resultado: `{result}`\n"
        f"- Processo iniciado: `{str(process_started).lower()}`\n"
        f"- Processo vivo ao observar: `{str(payload['processAliveAtEnd']).lower()}`\n"
        f"- TCP observado: `{str(payload['tcpEverReady']).lower()}`\n"
        f"- HTTP observado: `{str(payload['httpEverReady']).lower()}`\n"
        f"- Primeiro TCP: `{payload['firstTcpReadyMs'] if payload['firstTcpReadyMs'] is not None else 'null'} ms`\n"
        f"- Primeiro HTTP: `{payload['firstHttpReadyMs'] if payload['firstHttpReadyMs'] is not None else 'null'} ms`\n"
        f"- Classe segura: `{startup_classification or 'null'}`\n"
        "- Tentativas adicionais: `0`\n"
        "- Logs brutos persistidos: `não`\n",
        encoding="utf-8",
    )
    return payload


def _safe_browser_result(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProbeFailure("PROBE_EVIDENCE_INVALID") from error
    if not isinstance(payload, dict):
        raise ProbeFailure("PROBE_EVIDENCE_INVALID")
    if payload.get("round") != ROUND_ID or payload.get("secretsRecorded") is not False:
        raise ProbeFailure("PROBE_EVIDENCE_INVALID")
    if payload.get("result") not in SAFE_RESULTS:
        raise ProbeFailure("PROBE_EVIDENCE_INVALID")
    for key in ("frontend", "routing", "health", "login"):
        if not isinstance(payload.get(key), dict):
            raise ProbeFailure("PROBE_EVIDENCE_INVALID")
    forbidden = ("http://", "https://", "Cookie", "Authorization", "Bearer", "JWT", "username", "password")

    def scan(value: object) -> None:
        if isinstance(value, str) and any(item in value for item in forbidden):
            raise ProbeFailure("PROBE_EVIDENCE_INVALID")
        if isinstance(value, dict):
            for nested in value.values():
                scan(nested)
        elif isinstance(value, list):
            for nested in value:
                scan(nested)

    scan(payload)
    return payload


def _safe_m20_result(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProbeFailure("PROBE_EVIDENCE_INVALID") from error
    if (
        not isinstance(payload, dict)
        or payload.get("round") != M20_ROUND_ID
        or payload.get("secretsRecorded") is not False
        or payload.get("result") not in SAFE_M20_RESULTS
        or not isinstance(payload.get("login"), dict)
    ):
        raise ProbeFailure("PROBE_EVIDENCE_INVALID")

    def scan_values(value: object) -> None:
        if isinstance(value, str) and any(forbidden in value for forbidden in M20_FORBIDDEN_VALUES):
            raise ProbeFailure("PROBE_EVIDENCE_INVALID")
        if isinstance(value, dict):
            for nested in value.values():
                scan_values(nested)
        elif isinstance(value, list):
            for nested in value:
                scan_values(nested)

    scan_values(payload)
    return payload


def _m20_tree_hash(root: Path, relative: str) -> str:
    directory = root / relative
    if not directory.is_dir() or directory.is_symlink():
        raise ProbeFailure("PROBE_PROTECTED_SOURCE_UNAVAILABLE")
    records = []
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        if path.is_symlink():
            raise ProbeFailure("PROBE_PROTECTED_SOURCE_UNAVAILABLE")
        file_hash = campaign.sha256_file(path)
        records.append(f"{path.relative_to(directory).as_posix()}\0{file_hash}")
    return hashlib.sha256("\n".join(records).encode("utf-8")).hexdigest()


def _m20_source_hashes(root: Path) -> dict[str, object]:
    files: dict[str, str] = {}
    for relative in M20_PROTECTED_FILES:
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise ProbeFailure("PROBE_PROTECTED_SOURCE_UNAVAILABLE")
        files[relative] = campaign.sha256_file(path)
    return {
        "files": files,
        "trees": {relative: _m20_tree_hash(root, relative) for relative in M20_PROTECTED_TREES},
    }


def _m20_baseline_ready(root: Path) -> bool:
    baseline_root = root / ".quality" / "b90-r1m19-angular-readiness"
    report = baseline_root / "ratification-decision.json"
    try:
        payload = json.loads(report.read_text(encoding="utf-8"))
        final_report = (baseline_root / "final-report.md").read_text(encoding="utf-8")
    except (OSError, ValueError):
        return False
    findings = payload.get("findings") if isinstance(payload, dict) else None
    if not (
        isinstance(payload, dict)
        and payload.get("round") == ROUND_ID
        and payload.get("result") == "PASS_REAL_BROWSER_BOUNDARY_AFTER_FRONTEND_READINESS_FIX"
        and isinstance(findings, dict)
        and findings.get("m19f01") == "CLOSED"
        and findings.get("m18f01") == "CLOSED"
        and findings.get("m18f02") == "CLOSED"
        and findings.get("m17f02") == "CLOSED"
        and findings.get("m13f01") == "OPEN_HISTORICAL_ROOT_CAUSE_NOT_PROVEN"
        and findings.get("b90f02") == "OPEN"
        and findings.get("b90") == "OPEN / NOT FROZEN"
        and findings.get("b91") == "NOT_STARTED"
        and "M19-F01: `CLOSED`" in final_report
        and "B.90: `OPEN / NOT FROZEN`" in final_report
    ):
        return False
    return True


def _m20_m19_tree_comparison(root: Path) -> dict[str, bool]:
    source = root / ".quality" / "b90-r1m19-angular-readiness" / "baseline" / "protected-hashes.json"
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
        expected = payload["protectedTreeHashesAfterFormal"]
        return {relative: _m20_tree_hash(root, relative) == expected.get(relative) for relative in M20_PROTECTED_TREES}
    except (OSError, ValueError, KeyError, TypeError, ProbeFailure):
        return {relative: False for relative in M20_PROTECTED_TREES}


def _m20_fixture_cleanup_failed(completed: subprocess.CompletedProcess[str]) -> bool:
    output = f"{completed.stdout or ''}\n{completed.stderr or ''}"
    return re.search(r"E2E fixture cleanup failed(?: \(FIXTURE_[A-Z_]+\))?", output) is not None


def _m20_block_for_login_result(result: str) -> str | None:
    return {
        "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN": None,
        "FRONTEND_LOGIN_REQUEST_NOT_EMITTED": "BLOCKED_FRONTEND_LOGIN_REQUEST_NOT_EMITTED",
        "ANGULAR_LOGIN_TRANSPORT_FAILED": "BLOCKED_ACTUAL_ANGULAR_LOGIN_TRANSPORT",
        "LOGIN_HTTP_SEMANTIC_FAILURE": "BLOCKED_LOGIN_HTTP_SEMANTICS",
        "LOGIN_NAVIGATION_NOT_COMMITTED": "BLOCKED_LOGIN_STATE_OR_NAVIGATION_COMMIT",
    }.get(result, "BLOCKED_M20_EVIDENCE_INVALID")


def _m20_process_outcome(
    completed: subprocess.CompletedProcess[str],
    login_result: str,
    fixture_provision_reached: bool,
) -> tuple[str | None, bool]:
    if _m20_fixture_cleanup_failed(completed):
        return "BLOCKED_M20_FIXTURE_CLEANUP_FAILED", False
    if (completed.returncode == 0) != (login_result == "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN"):
        return "BLOCKED_M20_EVIDENCE_INVALID", False
    return _m20_block_for_login_result(login_result), fixture_provision_reached


def _result_for_failure(code: str | None) -> str:
    if code in {"PROBE_FRONTEND_START_FAILED", "PROBE_FRONTEND_EXITED_EARLY"}:
        return "BLOCKED_OWNED_FRONTEND_START"
    if code in {"PROBE_FRONTEND_HEALTH_TIMEOUT", "PROBE_FRONTEND_LISTENER_TIMEOUT"}:
        return "BLOCKED_OWNED_FRONTEND_READINESS"
    if code == "PROBE_FRONTEND_TEARDOWN_FAILED":
        return "BLOCKED_OWNED_FRONTEND_TEARDOWN"
    if code in {"PROBE_TEARDOWN_FAILED", "CAMPAIGN_TEARDOWN_FAILED"}:
        return "BLOCKED_RESOURCE_TEARDOWN"
    if code in {
        "PROBE_BACKEND_CORS_CONTROL_HTTP_FAILED",
        "PROBE_BACKEND_CORS_AUTHORITY_MISMATCH",
        "PROBE_CORS_CONTROL_NOT_DISCRIMINATING",
    }:
        return "BLOCKED_CORS_AUTHORITY_NOT_EFFECTIVE"
    if code == "REAL_BACKEND_LOGIN_BROWSER_TRANSPORT_FAILED":
        return "BLOCKED_REAL_LOGIN_BROWSER_TRANSPORT"
    if code and code.startswith("REAL_BACKEND_"):
        return "BLOCKED_REAL_BROWSER_TRANSPORT"
    if code == "PROBE_EVIDENCE_INVALID":
        return "BLOCKED_REAL_BROWSER_PROBE"
    return "BLOCKED_M17_PREREQUISITE"


def _owner_result(
    *,
    result: str,
    failure_code: str | None,
    frontend_generation: FrontendGeneration | None,
    frontend_ready: bool,
    frontend_stopped: bool,
    frontend_teardown_escalated: bool,
    lease: object | None,
    backend_generation: object | None,
    browser_started: bool,
    browser_completed: bool,
    frontend_origin_differs_from_legacy_fallback: bool,
    backend_cors_control_reached: bool,
    backend_cors_control_status200: bool,
    backend_cors_control_allow_origin_matches: bool,
    backend_stopped: bool,
    postgres_removed: bool,
    workspace_removed: bool,
) -> dict[str, object]:
    readiness = frontend_generation.readiness if frontend_generation else None
    return {
        "round": ROUND_ID,
        "result": result,
        "failureCode": failure_code,
        "frontendOwned": frontend_generation is not None,
        "frontendStarted": frontend_generation is not None,
        "frontendReady": frontend_ready,
        "frontendTcpObserved": bool(readiness and readiness.tcp_ever_ready),
        "frontendHttpObserved": bool(readiness and readiness.http_ever_ready),
        "frontendFirstTcpReadyMs": readiness.first_tcp_ready_ms if readiness else None,
        "frontendFirstHttpReadyMs": readiness.first_http_ready_ms if readiness else None,
        "frontendStartupClassification": readiness.startup_classification if readiness else None,
        "frontendUsedPreferredPort": bool(frontend_generation and frontend_generation.used_preferred_port),
        "frontendStopped": frontend_stopped,
        "frontendTeardownEscalated": frontend_teardown_escalated,
        "frontendOriginDiffersFromLegacyCorsFallback": frontend_origin_differs_from_legacy_fallback,
        "environmentPrepared": lease is not None,
        "databaseAuthenticated": lease is not None,
        "backendOwned": backend_generation is not None,
        "backendReady": backend_generation is not None,
        "backendCorsControlReached": backend_cors_control_reached,
        "backendCorsControlStatus200": backend_cors_control_status200,
        "backendCorsControlAllowOriginMatches": backend_cors_control_allow_origin_matches,
        "browserProbeStarted": browser_started,
        "browserProbeCompleted": browser_completed,
        "backendStopped": backend_stopped,
        "postgresRemoved": postgres_removed,
        "workspaceRemoved": workspace_removed,
        "retries": 0,
        "secretsRecorded": False,
    }


def run_probe(
    root: Path,
    frontend_preference: str,
    backend_url: str,
    backend_executable: Path,
    output_dir: Path,
    *,
    node_path: str | None = None,
    node_runner=subprocess.run,
    reservation_factory=None,
    frontend_process_factory=None,
    frontend_ready_waiter=None,
    cors_control=None,
) -> dict[str, object]:
    browser_output = output_dir / "browser-result.json"
    owner_output = output_dir / "owner-result.json"
    if browser_output.exists() or owner_output.exists():
        raise ProbeFailure("ARTIFACT_ROUND_ALREADY_EXISTS")

    frontend_generation = None
    frontend_ready = False
    frontend_stopped = False
    frontend_teardown_escalated = False
    lease = None
    backend_generation = None
    browser_started = False
    browser_completed = False
    frontend_origin_differs_from_legacy_fallback = False
    backend_cors_control_reached = False
    backend_cors_control_status200 = False
    backend_cors_control_allow_origin_matches = False
    backend_stopped = False
    postgres_removed = False
    workspace_removed = False
    failure_code: str | None = None
    browser_result: dict[str, object] | None = None
    reservation: PortReservation | None = None

    try:
        reservation_factory = reservation_factory or reserve_frontend_port
        frontend_process_factory = frontend_process_factory or subprocess.Popen
        frontend_ready_waiter = frontend_ready_waiter or wait_frontend_ready
        cors_control = cors_control or probe_backend_cors_authority
        preferred_frontend = validate_local_url(frontend_preference)
        backend_url = validate_local_url(backend_url)
        if not backend_executable.is_file() or backend_executable.is_symlink():
            raise ProbeFailure("PROBE_BACKEND_EXECUTABLE_UNAVAILABLE")
        node, ng_cli = resolve_frontend_tooling(root, node_path)

        preferred_port = urlsplit(preferred_frontend).port
        if preferred_port is None:
            raise ProbeFailure("PROBE_CONFIG_INVALID")
        reservation = reservation_factory(preferred_port)
        frontend_generation = spawn_frontend(
            root,
            node,
            ng_cli,
            reservation,
            process_factory=frontend_process_factory,
        )
        frontend_generation = frontend_ready_waiter(frontend_generation)
        frontend_ready = True

        lease = env_owner.prepare_environment(root, frontend_generation.url, backend_url, backend_executable)
        spec = campaign.BackendSpec(backend_executable, lease.workspace.cwd, backend_url)
        backend_generation = campaign.start_backend(spec, 1)
        frontend_origin_differs_from_legacy_fallback = frontend_generation.url != DEFAULT_FRONTEND_URL
        if not frontend_origin_differs_from_legacy_fallback:
            raise ProbeFailure("PROBE_CORS_CONTROL_NOT_DISCRIMINATING")
        backend_cors_control_reached = True
        try:
            backend_cors_control_status200, backend_cors_control_allow_origin_matches = cors_control(
                backend_url,
                frontend_generation.url,
            )
        except (OSError, http.client.HTTPException, TimeoutError):
            raise ProbeFailure("PROBE_BACKEND_CORS_CONTROL_HTTP_FAILED") from None
        if not backend_cors_control_status200:
            raise ProbeFailure("PROBE_BACKEND_CORS_CONTROL_HTTP_FAILED")
        if not backend_cors_control_allow_origin_matches:
            raise ProbeFailure("PROBE_BACKEND_CORS_AUTHORITY_MISMATCH")
        child_env = os.environ.copy()
        child_env.update(
            {
                "NANIKA_E2E_BASE_URL": frontend_generation.url,
                "NANIKA_E2E_BACKEND_URL": backend_url,
            }
        )
        browser_started = True
        try:
            completed = node_runner(
                [
                    node,
                    "frontend/tools/e2e-backend-routing.nanika-boundary-probe.mjs",
                    "--output",
                    str(browser_output),
                ],
                cwd=root,
                env=child_env,
                capture_output=True,
                text=True,
                check=False,
                shell=False,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            failure_code = "PROBE_BROWSER_TIMEOUT"
        else:
            browser_completed = True
            if browser_output.is_file():
                try:
                    browser_result = _safe_browser_result(browser_output)
                    if completed.returncode != 0 and browser_result["result"] == "PASS_REAL_BROWSER_BOUNDARY":
                        failure_code = "PROBE_EVIDENCE_INVALID"
                    elif completed.returncode != 0:
                        failure_code = str(browser_result["result"])
                except ProbeFailure as error:
                    failure_code = error.code
            else:
                failure_code = "PROBE_EVIDENCE_INVALID"
    except (ProbeFailure, env_owner.EnvironmentFailure, campaign.CampaignFailure) as error:
        failure_code = getattr(error, "code", "PROBE_EXECUTION_FAILED")
    finally:
        if backend_generation is not None:
            try:
                campaign.stop_backend(backend_generation)
                backend_stopped = True
            except campaign.CampaignFailure:
                failure_code = "PROBE_TEARDOWN_FAILED"
        if frontend_generation is not None:
            try:
                frontend_teardown_escalated = stop_frontend(frontend_generation)
                frontend_stopped = True
            except ProbeFailure:
                failure_code = "PROBE_FRONTEND_TEARDOWN_FAILED"
        if lease is not None:
            try:
                env_owner.remove_disposable_postgres(lease.postgres)
                postgres_removed = True
            except env_owner.EnvironmentFailure:
                failure_code = "PROBE_TEARDOWN_FAILED"
            try:
                env_owner.cleanup_runtime_workspace(lease.workspace)
                workspace_removed = True
            except env_owner.EnvironmentFailure:
                failure_code = "PROBE_TEARDOWN_FAILED"

    result = "PASS" if failure_code is None and browser_result and browser_result.get("result") == "PASS_REAL_BROWSER_BOUNDARY" else _result_for_failure(failure_code)
    owner_result = _owner_result(
        result=result,
        failure_code=failure_code,
        frontend_generation=frontend_generation,
        frontend_ready=frontend_ready,
        frontend_stopped=frontend_stopped,
        frontend_teardown_escalated=frontend_teardown_escalated,
        lease=lease,
        backend_generation=backend_generation,
        browser_started=browser_started,
        browser_completed=browser_completed,
        frontend_origin_differs_from_legacy_fallback=frontend_origin_differs_from_legacy_fallback,
        backend_cors_control_reached=backend_cors_control_reached,
        backend_cors_control_status200=backend_cors_control_status200,
        backend_cors_control_allow_origin_matches=backend_cors_control_allow_origin_matches,
        backend_stopped=backend_stopped,
        postgres_removed=postgres_removed,
        workspace_removed=workspace_removed,
    )
    write_json(owner_output, owner_result)
    if result != "PASS":
        raise ProbeFailure(failure_code or "PROBE_FAILED")
    return owner_result


def _m20_empty_artifact() -> dict[str, object]:
    return {
        "round": M20_ROUND_ID,
        "result": "PROBE_EVIDENCE_INVALID",
        "secretsRecorded": False,
        "login": dict(M20_EMPTY_LOGIN),
    }


def _m20_playwright_command(node: str, cli: Path, *, discovery: bool) -> list[str]:
    argv = [node, str(cli), "test", "--config=playwright.login-boundary.config.ts"]
    if discovery:
        argv.append("--list")
    return argv


def _m20_discovery_count(output: str) -> int | None:
    match = re.search(r"^Total:\s*(\d+)\s+tests?\s+in\s+\d+\s+files?\s*$", output, re.MULTILINE)
    return int(match.group(1)) if match else None


def _m20_write_owner_result(
    path: Path,
    *,
    result: str,
    failure_code: str | None,
    login: dict[str, object],
    frontend_generation: FrontendGeneration | None,
    frontend_ready: bool,
    frontend_stopped: bool,
    frontend_teardown_escalated: bool,
    lease: object | None,
    backend_generation: object | None,
    backend_stopped: bool,
    cors_reached: bool,
    cors_status200: bool,
    cors_origin_matches: bool,
    browser_started: bool,
    browser_completed: bool,
    fixture_provision_reached: bool,
    fixture_cleanup_completed: bool,
    postgres_removed: bool,
    workspace_removed: bool,
    hashes_match: bool | None,
) -> dict[str, object]:
    readiness = frontend_generation.readiness if frontend_generation else None
    payload = {
        "round": M20_ROUND_ID,
        "result": result if result in SAFE_M20_RESULTS else "PROBE_EVIDENCE_INVALID",
        "failureCode": failure_code,
        "frontendOwned": frontend_generation is not None,
        "frontendReady": frontend_ready,
        "frontendTcpObserved": bool(readiness and (readiness.tcp_ever_ready or readiness.http_ever_ready)),
        "frontendIndependentTcpProbeObserved": bool(readiness and readiness.tcp_ever_ready),
        "frontendHttpObserved": bool(readiness and readiness.http_ever_ready),
        "frontendStopped": frontend_stopped,
        "frontendTeardownEscalated": frontend_teardown_escalated,
        "frontendGenerations": int(frontend_generation is not None),
        "environmentPrepared": lease is not None,
        "backendOwned": backend_generation is not None,
        "backendReady": backend_generation is not None,
        "backendStopped": backend_stopped,
        "backendGenerations": int(backend_generation is not None),
        "corsControlReached": cors_reached,
        "corsControlStatus200": cors_status200,
        "corsControlOriginMatches": cors_origin_matches,
        "browserProbeStarted": browser_started,
        "browserProbeCompleted": browser_completed,
        "loginProbeInvocations": int(browser_started),
        "fixtureProvisionReached": fixture_provision_reached,
        "fixtureCleanupCompleted": fixture_cleanup_completed,
        "postgresRemoved": postgres_removed,
        "workspaceRemoved": workspace_removed,
        "protectedHashesMatch": hashes_match,
        "retries": 0,
        "secretsRecorded": False,
        "login": login,
    }
    write_json(path, payload)
    return payload


def run_angular_login_boundary_probe(
    root: Path,
    frontend_preference: str,
    backend_url: str,
    backend_executable: Path,
    artifact_root: Path,
    *,
    node_path: str | None = None,
    node_runner=subprocess.run,
    reservation_factory=None,
    frontend_process_factory=None,
    frontend_ready_waiter=None,
    cors_control=None,
) -> dict[str, object]:
    if artifact_root.exists():
        raise ProbeFailure("ARTIFACT_ROUND_ALREADY_EXISTS")
    if not _m20_baseline_ready(root):
        raise ProbeFailure("BLOCKED_M20_BASELINE_NOT_M19")

    frontend_preference = validate_local_url(frontend_preference)
    backend_url = validate_local_url(backend_url)
    if not backend_executable.is_file() or backend_executable.is_symlink():
        raise ProbeFailure("PROBE_BACKEND_EXECUTABLE_UNAVAILABLE")
    node, ng_cli = resolve_frontend_tooling(root, node_path)
    cli = root / "frontend" / "node_modules" / "@playwright" / "test" / "cli.js"
    fixture_candidates = (
        root / "backend" / "build" / "nanika_e2e_fixture.exe",
        root / "backend" / "build" / "Debug" / "nanika_e2e_fixture.exe",
        root / "backend" / "build" / "Release" / "nanika_e2e_fixture.exe",
    ) if os.name == "nt" else (
        root / "backend" / "build" / "nanika_e2e_fixture",
        root / "backend" / "build-e2e" / "nanika_e2e_fixture",
    )
    fixture_executable = next((path for path in fixture_candidates if path.is_file() and not path.is_symlink()), None)
    if not cli.is_file() or cli.is_symlink() or fixture_executable is None:
        raise ProbeFailure("PROBE_FRONTEND_TOOLING_UNAVAILABLE")

    discovery_dir = artifact_root / "discovery"
    real_dir = artifact_root / "real-probe"
    baseline_dir = artifact_root / "baseline"
    for directory in (discovery_dir, real_dir, baseline_dir):
        directory.mkdir(parents=True, exist_ok=False)

    login_output = real_dir / "login-result.json"
    owner_output = real_dir / "owner-result.json"
    frontend_generation = None
    frontend_ready = False
    frontend_stopped = False
    frontend_teardown_escalated = False
    lease = None
    backend_generation = None
    backend_stopped = False
    cors_reached = False
    cors_status200 = False
    cors_origin_matches = False
    browser_started = False
    browser_completed = False
    fixture_provision_reached = False
    fixture_cleanup_completed = False
    postgres_removed = False
    workspace_removed = False
    before_hashes = None
    after_hashes = None
    hashes_match: bool | None = None
    m19_tree_comparison: dict[str, bool] | None = None
    completed: subprocess.CompletedProcess[str] | None = None
    failure_code: str | None = None
    login_payload = _m20_empty_artifact()

    try:
        with tempfile.TemporaryDirectory(prefix="nanika-m20-discovery-") as discovery_output:
            discovery_env = os.environ.copy()
            discovery_env.update(
                {
                    "NANIKA_E2E_BASE_URL": frontend_preference,
                    "NANIKA_E2E_BACKEND_URL": backend_url,
                    "NANIKA_E2E_FIXTURE_EXE": str(fixture_executable),
                    "NANIKA_E2E_FIXTURE_CWD": discovery_output,
                    "NANIKA_E2E_STORAGE_PATH": discovery_output,
                    "NANIKA_E2E_STORAGE_ID": "0" * 64,
                    "NANIKA_M20_RESULT_PATH": str(login_output.resolve()),
                    "NANIKA_M20_PLAYWRIGHT_OUTPUT_DIR": discovery_output,
                }
            )
            discovery = node_runner(
                _m20_playwright_command(node, cli, discovery=True),
                cwd=root / "frontend",
                env=discovery_env,
                capture_output=True,
                text=True,
                check=False,
                shell=False,
                timeout=45,
            )
        discovered = _m20_discovery_count(f"{discovery.stdout or ''}\n{discovery.stderr or ''}")
        write_json(
            discovery_dir / "result.json",
            {
                "round": M20_ROUND_ID,
                "testsDiscovered": discovered if discovered is not None else 0,
                "workers": 1,
                "retries": 0,
                "canonicalSuiteTouched": False,
            },
        )
        if discovery.returncode != 0 or discovered != 1:
            failure_code = "BLOCKED_M20_DISCOVERY_INVALID"
        else:
            before_hashes = _m20_source_hashes(root)
            m19_tree_comparison = _m20_m19_tree_comparison(root)
            write_json(
                baseline_dir / "protected-hashes.json",
                {
                    "round": M20_ROUND_ID,
                    "m19RatificationReused": True,
                    "m19TreeHashesMatchAtM20Start": m19_tree_comparison,
                    "beforeRuntime": before_hashes,
                    "afterRuntime": None,
                },
            )

            reserve = reservation_factory or reserve_frontend_port
            spawn = frontend_process_factory or subprocess.Popen
            wait_ready = frontend_ready_waiter or wait_frontend_ready
            check_cors = cors_control or probe_backend_cors_authority
            reservation = None
            try:
                preferred_port = urlsplit(frontend_preference).port
                if preferred_port is None:
                    raise ProbeFailure("PROBE_CONFIG_INVALID")
                reservation = reserve(preferred_port)
                frontend_generation = spawn_frontend(
                    root,
                    node,
                    ng_cli,
                    reservation,
                    process_factory=spawn,
                )
                reservation = None
                try:
                    frontend_generation = wait_ready(frontend_generation)
                    frontend_ready = True
                except ProbeFailure:
                    failure_code = "BLOCKED_M20_FRONTEND_PRECONDITION_REGRESSION"

                if failure_code is None:
                    try:
                        lease = env_owner.prepare_environment(root, frontend_generation.url, backend_url, backend_executable)
                        backend_spec = campaign.BackendSpec(backend_executable, lease.workspace.cwd, backend_url)
                        backend_generation = campaign.start_backend(backend_spec, 1)
                    except (env_owner.EnvironmentFailure, campaign.CampaignFailure):
                        failure_code = "BLOCKED_M20_RUNTIME_PRECONDITION"

                if failure_code is None:
                    cors_reached = True
                    try:
                        cors_status200, cors_origin_matches = check_cors(backend_url, frontend_generation.url)
                    except (OSError, http.client.HTTPException, TimeoutError):
                        failure_code = "BLOCKED_M20_CORS_PRECONDITION_REGRESSION"
                    else:
                        if not cors_status200 or not cors_origin_matches:
                            failure_code = "BLOCKED_M20_CORS_PRECONDITION_REGRESSION"

                if failure_code is None:
                    child_env = os.environ.copy()
                    child_env.update(lease.e2e_environment)
                    child_env.update(
                        {
                            "NANIKA_E2E_BASE_URL": frontend_generation.url,
                            "NANIKA_E2E_BACKEND_URL": backend_url,
                            "NANIKA_E2E_FIXTURE_EXE": str(fixture_executable),
                            "NANIKA_M20_RESULT_PATH": str(login_output.resolve()),
                            "NANIKA_M20_PLAYWRIGHT_OUTPUT_DIR": str((lease.workspace.root / "playwright-output").resolve()),
                        }
                    )
                    child_env.pop("NANIKA_E2E_BACKEND_CWD", None)
                    browser_started = True
                    try:
                        completed = node_runner(
                            _m20_playwright_command(node, cli, discovery=False),
                            cwd=root / "frontend",
                            env=child_env,
                            capture_output=True,
                            text=True,
                            check=False,
                            shell=False,
                            timeout=60,
                        )
                        browser_completed = True
                    except subprocess.TimeoutExpired:
                        failure_code = "BLOCKED_M20_PROBE_TIMEOUT"
                    except OSError:
                        failure_code = "BLOCKED_M20_PROBE_START_FAILED"
            except (ProbeFailure, OSError):
                failure_code = "BLOCKED_M20_FRONTEND_PRECONDITION_REGRESSION"
            finally:
                if reservation is not None:
                    reservation.socket.close()
                if backend_generation is not None:
                    try:
                        campaign.stop_backend(backend_generation)
                        backend_stopped = True
                    except campaign.CampaignFailure:
                        failure_code = "BLOCKED_RESOURCE_TEARDOWN"
                if frontend_generation is not None:
                    try:
                        frontend_teardown_escalated = stop_frontend(frontend_generation)
                        frontend_stopped = True
                    except ProbeFailure:
                        failure_code = "BLOCKED_RESOURCE_TEARDOWN"
                if lease is not None:
                    try:
                        env_owner.remove_disposable_postgres(lease.postgres)
                        postgres_removed = True
                    except env_owner.EnvironmentFailure:
                        failure_code = "BLOCKED_RESOURCE_TEARDOWN"
                    try:
                        env_owner.cleanup_runtime_workspace(lease.workspace)
                        workspace_removed = True
                    except env_owner.EnvironmentFailure:
                        failure_code = "BLOCKED_RESOURCE_TEARDOWN"

    except (ProbeFailure, subprocess.TimeoutExpired, OSError):
        failure_code = "BLOCKED_M20_DISCOVERY_INVALID"

    if login_output.is_file():
        fixture_provision_reached = browser_started and browser_completed
        try:
            login_payload = _safe_m20_result(login_output)
        except ProbeFailure:
            failure_code = failure_code or "BLOCKED_M20_EVIDENCE_INVALID"
    else:
        write_json(login_output, login_payload)

    login_result = str(login_payload.get("result", "PROBE_EVIDENCE_INVALID"))
    if completed is not None:
        process_failure, fixture_cleanup_completed = _m20_process_outcome(
            completed,
            login_result,
            fixture_provision_reached,
        )
        if process_failure is not None:
            failure_code = process_failure

    if before_hashes is not None:
        try:
            after_hashes = _m20_source_hashes(root)
            hashes_match = before_hashes == after_hashes
        except ProbeFailure:
            hashes_match = False
        write_json(
            baseline_dir / "protected-hashes.json",
            {
                "round": M20_ROUND_ID,
                "m19RatificationReused": True,
                "m19TreeHashesMatchAtM20Start": m19_tree_comparison,
                "beforeRuntime": before_hashes,
                "afterRuntime": after_hashes,
                "allProtectedHashesMatchAfterProbe": hashes_match,
            },
        )
        if hashes_match is False:
            failure_code = "BLOCKED_M20_PROTECTED_SOURCE_CHANGED"

    if failure_code in {
        "BLOCKED_RESOURCE_TEARDOWN",
        "BLOCKED_M20_FIXTURE_CLEANUP_FAILED",
        "BLOCKED_M20_PROTECTED_SOURCE_CHANGED",
    }:
        owner_result_code = "PROBE_EVIDENCE_INVALID"
    else:
        owner_result_code = login_result if login_result in SAFE_M20_RESULTS else "PROBE_EVIDENCE_INVALID"

    owner_result = _m20_write_owner_result(
        owner_output,
        result=owner_result_code,
        failure_code=failure_code,
        login={"result": login_result, **login_payload.get("login", dict(M20_EMPTY_LOGIN))},
        frontend_generation=frontend_generation,
        frontend_ready=frontend_ready,
        frontend_stopped=frontend_stopped,
        frontend_teardown_escalated=frontend_teardown_escalated,
        lease=lease,
        backend_generation=backend_generation,
        backend_stopped=backend_stopped,
        cors_reached=cors_reached,
        cors_status200=cors_status200,
        cors_origin_matches=cors_origin_matches,
        browser_started=browser_started,
        browser_completed=browser_completed,
        fixture_provision_reached=fixture_provision_reached,
        fixture_cleanup_completed=fixture_cleanup_completed,
        postgres_removed=postgres_removed,
        workspace_removed=workspace_removed,
        hashes_match=hashes_match,
    )
    if failure_code is not None:
        raise ProbeFailure(failure_code)
    return owner_result


def main(argv: list[str] | None = None) -> int:
    root = repository_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=root / ".quality" / "b90-r1m19-angular-readiness" / "real-probe",
    )
    parser.add_argument("--characterize-frontend", action="store_true")
    parser.add_argument(
        "--characterization-output",
        type=Path,
        default=root / ".quality" / "b90-r1m19-angular-readiness" / "characterization" / "result.json",
    )
    parser.add_argument("--angular-login-boundary", action="store_true")
    parser.add_argument(
        "--m20-output",
        type=Path,
        default=root / ".quality" / "b90-r1m20-angular-login-boundary",
    )
    args = parser.parse_args(argv)
    if args.angular_login_boundary:
        frontend_preference = os.environ.get("NANIKA_E2E_BASE_URL", DEFAULT_FRONTEND_URL)
        backend_url = os.environ.get("NANIKA_E2E_BACKEND_URL", DEFAULT_BACKEND_URL)
        executable = Path(os.environ.get("NANIKA_E2E_BACKEND_EXE", root / "backend" / "build" / "savebox_server.exe"))
        try:
            result = run_angular_login_boundary_probe(
                root,
                frontend_preference,
                backend_url,
                executable,
                args.m20_output,
            )
        except (ProbeFailure, env_owner.EnvironmentFailure, campaign.CampaignFailure) as error:
            code = getattr(error, "code", "BLOCKED_M20_EVIDENCE_INVALID")
            print(json.dumps({"round": M20_ROUND_ID, "result": "BLOCKED", "failureCode": code}, sort_keys=True))
            return 1
        print(
            json.dumps(
                {
                    "round": M20_ROUND_ID,
                    "result": result["result"],
                    "failureCode": result["failureCode"],
                    "loginProbeInvocations": result["loginProbeInvocations"],
                    "retries": result["retries"],
                },
                sort_keys=True,
            )
        )
        return 0
    if args.characterize_frontend:
        try:
            payload = run_frontend_characterization(root, args.characterization_output)
            return 0 if payload["result"].startswith("PASS_") and payload["frontendStopped"] else 1
        except ProbeFailure:
            return 1
    frontend_preference = os.environ.get("NANIKA_E2E_BASE_URL", DEFAULT_FRONTEND_URL)
    backend_url = os.environ.get("NANIKA_E2E_BACKEND_URL", DEFAULT_BACKEND_URL)
    executable = Path(os.environ.get("NANIKA_E2E_BACKEND_EXE", root / "backend" / "build" / "savebox_server.exe"))

    try:
        run_probe(root, frontend_preference, backend_url, executable, args.output)
        return 0
    except (ProbeFailure, env_owner.EnvironmentFailure, campaign.CampaignFailure):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
