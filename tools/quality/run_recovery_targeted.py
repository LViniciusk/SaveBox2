"""Run one owned, disposable Chromium recovery test for B.90-R1.M27."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import tempfile
from pathlib import Path

import owned_frontend as frontend_owner
import run_playwright_campaign as campaign
import run_playwright_campaign_env as env_owner


ROUND = "B.90-R1.M27"
M26_OUTPUT = ".quality/b90-r1m26-recovery-terminal-state-semantics"
RECOVERY_JOURNAL_SCHEMA = 5
JOURNAL_NAME = "recovery-continuation.journal.jsonl"
MAX_JOURNAL_BYTES = 64 * 1024
MAX_JOURNAL_EVENTS = 64
PASS_CLASS = "PASS_RECOVERY_POST_UPLOAD_CONTINUATION"
BLOCKED_RESULTS = {
    "DOCKER_CLI_UNAVAILABLE": "BLOCKED_DOCKER_CLI_UNAVAILABLE",
    "DOCKER_DAEMON_UNAVAILABLE": "BLOCKED_DOCKER_DAEMON_UNAVAILABLE",
    "DOCKER_DAEMON_PROOF_INVALID": "BLOCKED_DOCKER_DAEMON_PROOF_INVALID",
    "PREEXISTING_RESOURCE_PROOF_UNAVAILABLE": "BLOCKED_PREEXISTING_RESOURCE_PROOF_UNAVAILABLE",
    "PREEXISTING_RESOURCE_PROOF_INVALID": "BLOCKED_PREEXISTING_RESOURCE_PROOF_INVALID",
    "BLOCKED_RECOVERY_DISCOVERY_INVALID": "BLOCKED_RECOVERY_DISCOVERY_INVALID",
    "OWNED_RUNTIME_PREREQUISITE_MISSING": "BLOCKED_RUNTIME_EXECUTABLE_MISSING",
}
SAFE_SETUP_FAILURES = set(BLOCKED_RESULTS) | {
    "BACKEND_EXECUTABLE_AUTHORITY_INVALID", "SOURCE_HASH_FAILED",
    "RUNTIME_BIND_AUTHORITY_INVALID", "RUNTIME_CONFIG_INVALID",
    "LISTENER_PROOF_UNAVAILABLE", "LISTENER_BIND_PROOF_FAILED",
    "HISTORICAL_ARTIFACT_CHANGED_FROM_ENTRY", "BACKEND_EXECUTABLE_CHANGED_FROM_ENTRY",
    "PRODUCTION_SOURCE_CHANGED_UNEXPECTEDLY", "SOURCE_CHANGED_OUTSIDE_M27_SCOPE",
    "PREEXISTING_POSTGRES_ADOPTION_REJECTED", "BACKEND_NOT_OWNED",
    "RECOVERY_EVIDENCE_OUTPUT_NOT_OWNED", "RECOVERY_EVIDENCE_PATH_ALREADY_EXISTS",
    "BIND_ADDRESS_DUPLICATE_CLIENT_ENV", "FRONTEND_NODE_UNAVAILABLE", "FRONTEND_TOOLING_UNAVAILABLE",
    "FRONTEND_PORT_ALLOCATION_FAILED", "FRONTEND_START_FAILED", "FRONTEND_EXITED_EARLY",
    "FRONTEND_LISTENER_TIMEOUT", "FRONTEND_HTTP_TIMEOUT",
}
PROTECTED_FILES = (
    "frontend/src/app/features/drive/state/drive.store.ts",
    "frontend/src/app/features/drive/state/drive.store.spec.ts",
    "frontend/src/app/features/drive/state/recovery-post-upload.integration.spec.ts",
    "frontend/src/app/features/drive/upload/upload-engine.service.ts",
    "frontend/src/app/features/drive/upload/upload-engine.service.spec.ts",
    "frontend/src/app/features/drive/upload/abortable-observable.ts",
    "frontend/src/app/features/drive/upload/abortable-observable.spec.ts",
    "frontend/src/app/features/drive/services/drive.service.ts",
    "frontend/e2e/recovery.spec.ts", "frontend/tools/e2e-recovery-diagnostics.mjs",
    "frontend/tools/e2e-recovery-diagnostics.d.mts", "frontend/tools/e2e-recovery-diagnostics.test.mjs",
    "tools/quality/run_recovery_targeted.py", "tools/quality/test_run_recovery_targeted.py",
    "tools/quality/owned_frontend.py", "tools/quality/run_playwright_campaign.py",
    "tools/quality/run_playwright_campaign_env.py", "backend/include/utils.hpp", "backend/src/main.cpp",
    "frontend/karma.conf.js", "frontend/tsconfig.json", "frontend/tsconfig.spec.json",
)


class TargetFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def discover_recovery(root: Path, node: str) -> dict[str, object]:
    temporary = Path(tempfile.mkdtemp(prefix="nanika-m27-discovery-"))
    env = os.environ.copy()
    env["PLAYWRIGHT_OUTPUT_DIR"] = str(temporary / "results")
    env.pop("PLAYWRIGHT_JSON_REPORT", None)
    command = [
        node, str(root / "frontend" / "node_modules" / "@playwright" / "test" / "cli.js"),
        "test", "e2e/recovery.spec.ts", "--list", "--project=chromium", "--workers=1", "--retries=0",
    ]
    try:
        completed = subprocess.run(command, cwd=root / "frontend", env=env, capture_output=True,
                                   text=True, check=False, timeout=30, shell=False)
    except (OSError, subprocess.SubprocessError):
        raise TargetFailure("BLOCKED_RECOVERY_DISCOVERY_INVALID") from None
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    matches = re.findall(r"(?im)^\s*Total:\s*(\d+)\s+tests?\s+in\s+(\d+)\s+files?\s*$", completed.stdout)
    if completed.returncode != 0 or len(matches) != 1 or matches[0] != ("1", "1"):
        raise TargetFailure("BLOCKED_RECOVERY_DISCOVERY_INVALID")
    return {"round": ROUND, "status": "PASS", "invocations": 1, "discovered": 1, "files": 1, "executed": 0,
            "project": "chromium", "workers": 1, "retries": 0}


def source_hashes(root: Path) -> dict[str, object]:
    try:
        shared = env_owner.capture_source_hashes(root)
        files: dict[str, str] = {}
        for relative in PROTECTED_FILES:
            path = root / relative
            if not path.is_file() or path.is_symlink():
                raise OSError
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        executables = {}
        for relative in ("backend/build/savebox_server.exe", "backend/build/nanika_e2e_fixture.exe"):
            path = root / relative
            if not path.is_file() or path.is_symlink():
                raise OSError
            executables[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        historical = {
            path.relative_to(root).as_posix(): env_owner._tree_sha256(root, path.relative_to(root).as_posix())
            for path in sorted((root / ".quality").iterdir())
            if re.fullmatch(r"b90-r1m(?:21|22|23|24|25|26)-[a-z0-9-]+", path.name) and path.is_dir()
        }
        return {"algorithm": "sha256", "files": files, "trees": shared["trees"],
                "sharedProtectedFiles": shared["files"], "runtimeExecutables": executables,
                "historicalArtifacts": historical}
    except (OSError, env_owner.EnvironmentFailure):
        raise TargetFailure("SOURCE_HASH_FAILED") from None


def verify_runtime_bind(
    workspace: env_owner.RuntimeWorkspace, backend_url: str, backend_executable: Path
) -> dict[str, object]:
    config_path = campaign.find_dotenv_upwards(workspace.cwd)
    values = campaign.read_dotenv(config_path) if config_path else {}
    address = values.get("NANIKA_BIND_ADDRESS")
    if config_path != workspace.env_file or address != "127.0.0.1":
        raise TargetFailure("RUNTIME_BIND_AUTHORITY_INVALID")
    config = campaign.validate_backend_spec(
        campaign.BackendSpec(backend_executable, workspace.cwd, backend_url), backend_url,
    )
    if not config.get("valid"):
        raise TargetFailure("RUNTIME_CONFIG_INVALID")
    return {"configAuthority": "nearest-ancestor-dotenv", "exactDotenv": True,
            "bindAddress": "127.0.0.1", "clientEnvironmentInjection": False,
            "secretValuesRecorded": False}


def _port_in_endpoint(endpoint: str, port: int) -> bool:
    return endpoint.endswith(f":{port}")


def owned_loopback_listener(port: int, pid: int, *, runner=subprocess.run) -> dict[str, object]:
    if os.name == "nt":
        command = ["netstat", "-ano", "-p", "tcp"]
    else:
        command = ["ss", "-H", "-ltnp", f"sport = :{port}"]
    try:
        result = runner(command, capture_output=True, text=True, check=False, shell=False)
    except OSError:
        raise TargetFailure("LISTENER_PROOF_UNAVAILABLE") from None
    if result.returncode != 0:
        raise TargetFailure("LISTENER_PROOF_UNAVAILABLE")
    owned: list[str] = []
    conflicting: list[str] = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if os.name == "nt":
            if len(fields) < 5 or fields[0].upper() != "TCP" or fields[3].upper() != "LISTENING":
                continue
            endpoint, state, owner_pid = fields[1], fields[3], fields[4]
        else:
            endpoint = next((field for field in fields if _port_in_endpoint(field, port)), "")
            match = re.search(r"pid=(\d+)", line)
            owner_pid = match.group(1) if match else ""
            state = fields[0] if fields else ""
            if not endpoint or state != "LISTEN":
                continue
        if not _port_in_endpoint(endpoint, port):
            continue
        if endpoint == f"127.0.0.1:{port}" and owner_pid == str(pid):
            owned.append(line)
        else:
            conflicting.append(line)
    if len(owned) != 1 or conflicting:
        raise TargetFailure("LISTENER_BIND_PROOF_FAILED")
    return {"listenerOwnedByProcess": True, "addressClass": "ipv4-loopback",
            "wildcardOrOtherListenerOnPort": False, "pidRecorded": False}


def probe_docker_runtime(*, which=None, runner=None) -> dict[str, bool]:
    executable = (which or shutil.which)("docker")
    if not executable:
        raise TargetFailure("DOCKER_CLI_UNAVAILABLE")
    try:
        completed = (runner or subprocess.run)(
            [executable, "version", "--format", "{{.Server.Version}}"],
            capture_output=True, text=True, check=False, timeout=15, shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise TargetFailure("DOCKER_DAEMON_UNAVAILABLE") from None
    if completed.returncode != 0:
        raise TargetFailure("DOCKER_DAEMON_UNAVAILABLE")
    if not isinstance(completed.stdout, str):
        raise TargetFailure("DOCKER_DAEMON_PROOF_INVALID")
    version = completed.stdout.strip()
    if not version or len(version) > 64 or not re.fullmatch(r"[0-9A-Za-z.+_-]+", version):
        raise TargetFailure("DOCKER_DAEMON_PROOF_INVALID")
    return {"cliAvailable": True, "daemonAvailable": True}


def container_snapshot(*, runner=None) -> dict[str, str]:
    runner = runner or subprocess.run
    try:
        completed = runner(["docker", "ps", "--all", "--no-trunc", "--format", "{{.ID}} {{.State}}"],
                           capture_output=True, text=True, check=False, timeout=15, shell=False)
    except (OSError, subprocess.SubprocessError):
        raise TargetFailure("PREEXISTING_RESOURCE_PROOF_UNAVAILABLE") from None
    if completed.returncode != 0:
        raise TargetFailure("PREEXISTING_RESOURCE_PROOF_UNAVAILABLE")
    result = {}
    for line in completed.stdout.splitlines():
        fields = line.split()
        if (len(fields) != 2 or not env_owner.CONTAINER_ID.fullmatch(fields[0])
                or fields[0] in result or fields[1] not in {"running", "exited", "paused", "created", "restarting", "removing", "dead"}):
            raise TargetFailure("PREEXISTING_RESOURCE_PROOF_INVALID")
        result[fields[0]] = fields[1]
    return result


EVENT_FIELDS: dict[str, dict[str, set[object] | type]] = {
    "phase-start": {"phase": {"initial", "recovery"}},
    "recovery-upload-start": {"phase": {"recovery"}},
    "instrumentation-installed": {"phase": {"initial", "recovery"}},
    "instrumentation-invalid": {"phase": {"initial", "recovery"}},
    "chunk-response": {"phase": {"initial", "recovery"}, "statusClass": {"2xx", "4xx", "5xx", "other"}},
    "chunk-finished": {"phase": {"initial", "recovery"}},
    "chunk-failed": {"phase": {"initial", "recovery"}},
    "chunk-observable-subscribed": {"phase": {"initial", "recovery"}},
    "chunk-observable-next": {"phase": {"initial", "recovery"}},
    "chunk-observable-complete": {"phase": {"initial", "recovery"}},
    "chunk-observable-error": {"phase": {"initial", "recovery"}},
    "store-progress-100": {"phase": {"initial", "recovery"}, "transferPresent": bool},
    "upload-engine-enter": {"phase": {"initial", "recovery"}},
    "upload-engine-resolved": {"phase": {"initial", "recovery"}},
    "upload-engine-rejected": {"phase": {"initial", "recovery"}},
    "run-upload-loop-enter": {"phase": {"initial", "recovery"}, "generationCurrent": bool},
    "run-upload-loop-resolved": {"phase": {"initial", "recovery"}, "generationCurrent": bool},
    "run-upload-loop-rejected": {"phase": {"initial", "recovery"}, "generationCurrent": bool},
    "terminal-success-applied": {
        "phase": {"recovery"}, "present": bool,
        "state": {"processing", "paused", "success", "error", "cancelled", "cancelling", "unknown"},
        "progressClass": {"0-49", "50-99", "100", "unknown"},
    },
    "store-state-snapshot": {
        "phase": {"initial", "recovery"}, "present": bool,
        "state": {"processing", "paused", "success", "error", "cancelled", "cancelling", "unknown"},
        "progressClass": {"0-49", "50-99", "100", "unknown"},
    },
    "dom-state-snapshot": {
        "phase": {"initial", "recovery"},
        "state": {"processing", "paused", "success", "error", "cancelled", "cancelling", "unknown"},
        "progressClass": {"0-49", "50-99", "100", "unknown"}, "matchingCards": int,
    },
    "dom-success-observed": {"phase": {"initial", "recovery"}},
    "dom-terminal-hidden": {"phase": {"recovery"}},
}

REQUIRED_EVENT_FIELDS = {
    "chunk-response": {"statusClass"},
    "store-state-snapshot": {"present", "state", "progressClass"},
    "terminal-success-applied": {"present", "state", "progressClass"},
    "dom-state-snapshot": {"state", "progressClass", "matchingCards"},
    "run-upload-loop-enter": {"generationCurrent"},
    "run-upload-loop-resolved": {"generationCurrent"},
    "run-upload-loop-rejected": {"generationCurrent"},
}
def _json_object_without_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(_: str) -> None:
    raise ValueError("non-standard JSON constant")


def _validate_journal_event(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict) or not isinstance(value.get("kind"), str):
        return None
    kind = value["kind"]
    if kind == "journal-truncated":
        return value if set(value) == {"kind"} else None
    schema = EVENT_FIELDS.get(kind)
    if schema is None or set(value) - ({"kind"} | set(schema)):
        return None
    required = {"phase"} | REQUIRED_EVENT_FIELDS.get(kind, set())
    if not required.issubset(value):
        return None
    for field, allowed in schema.items():
        if field not in value:
            if field == "phase":
                return None
            continue
        field_value = value[field]
        if isinstance(allowed, set):
            if type(field_value) is not str or field_value not in allowed:
                return None
        elif allowed is bool:
            if type(field_value) is not bool:
                return None
        elif allowed is int:
            if type(field_value) is not int or not 0 <= field_value <= 20:
                return None
    if kind in {"store-state-snapshot", "terminal-success-applied"} and not value["present"]:
        if value["state"] != "unknown" or value["progressClass"] != "unknown":
            return None
    return value


def _store_is_success(item: object) -> bool:
    return (isinstance(item, dict) and item.get("present") is True
            and item.get("state") == "success" and item.get("progressClass") == "100")


def _evidence_from_events(events: list[dict[str, object]]) -> dict[str, object] | None:
    if any(_validate_journal_event(event) is None for event in events):
        return None
    recovery = [event for event in events if event.get("phase") == "recovery"]
    has = lambda kind: any(event.get("kind") == kind for event in recovery)
    terminals = [index for index, event in enumerate(recovery) if event["kind"] == "terminal-success-applied"]
    if len(terminals) > 1:
        return None
    terminal_index = terminals[0] if terminals else -1
    terminal = recovery[terminal_index] if terminals else None
    terminal_store = {key: terminal[key] for key in ("present", "state", "progressClass")} if terminal else None
    store_success = _store_is_success(terminal_store)
    store_removed = store_regressed = False
    for index, event in enumerate(recovery):
        if event["kind"] in {"dom-success-observed", "dom-terminal-hidden"} and (not store_success or index <= terminal_index):
            return None
        if event["kind"] != "store-state-snapshot":
            continue
        if index <= terminal_index or terminal_index < 0 or not store_success:
            if _store_is_success(event):
                return None
            continue
        if not event["present"]:
            store_removed = True
        elif store_removed or not _store_is_success(event):
            store_regressed = True
    loop_entries = [event for event in recovery if event.get("kind") == "run-upload-loop-enter"]
    loop_exits = [event for event in recovery if event.get("kind") in {"run-upload-loop-resolved", "run-upload-loop-rejected"}]
    responses = [event for event in recovery if event.get("kind") == "chunk-response"]
    return {
        "networkResponse2xx": bool(responses and responses[0].get("statusClass") == "2xx"),
        "requestFinished": has("chunk-finished"),
        "observableSubscribed": has("chunk-observable-subscribed"),
        "observableNext": has("chunk-observable-next"),
        "observableComplete": has("chunk-observable-complete"),
        "observableError": has("chunk-observable-error"),
        "storeProgress100": has("store-progress-100"),
        "uploadEngineResolved": has("upload-engine-resolved"),
        "generationCurrentAtLoopEntry": loop_entries[0].get("generationCurrent") if loop_entries else None,
        "generationCurrentAtLoopExit": loop_exits[0].get("generationCurrent") if loop_exits else None,
        "runUploadLoopResolved": has("run-upload-loop-resolved"),
        "terminalSuccessApplied": bool(terminals),
        "terminalStore": terminal_store,
        "storeSuccessObserved": store_success,
        "storeRemovedAfterSuccess": store_removed,
        "storeRegressedAfterSuccess": store_regressed,
        "domSuccessObserved": has("dom-success-observed"),
        "domHiddenAfterSuccess": has("dom-terminal-hidden"),
    }


BOOLEAN_EVIDENCE_FIELDS = (
    "networkResponse2xx", "requestFinished", "observableSubscribed", "observableNext", "observableComplete",
    "observableError", "storeProgress100", "uploadEngineResolved", "runUploadLoopResolved",
    "terminalSuccessApplied", "storeSuccessObserved", "storeRemovedAfterSuccess", "storeRegressedAfterSuccess",
    "domSuccessObserved", "domHiddenAfterSuccess",
)


def classify_recovery_continuation(evidence: dict[str, object] | None) -> str:
    if not isinstance(evidence, dict) or any(type(evidence.get(key)) is not bool for key in BOOLEAN_EVIDENCE_FIELDS):
        return "M23_EVIDENCE_INVALID"
    if any(key not in evidence or (evidence[key] is not None and type(evidence[key]) is not bool)
           for key in ("generationCurrentAtLoopEntry", "generationCurrentAtLoopExit")):
        return "M23_EVIDENCE_INVALID"
    terminal = evidence.get("terminalStore")
    if "terminalStore" not in evidence or (terminal is not None and (
            not isinstance(terminal, dict) or set(terminal) != {"present", "state", "progressClass"}
            or _validate_journal_event({"kind": "terminal-success-applied", "phase": "recovery", **terminal}) is None)):
        return "M23_EVIDENCE_INVALID"
    if (evidence["terminalSuccessApplied"] != (terminal is not None)
            or evidence["storeSuccessObserved"] != _store_is_success(terminal)):
        return "M23_EVIDENCE_INVALID"
    if ((evidence["observableNext"] and not evidence["observableSubscribed"])
            or (evidence["observableComplete"] and not evidence["observableSubscribed"])
            or (evidence["observableError"] and not evidence["observableSubscribed"])
            or (evidence["storeProgress100"] and not evidence["observableNext"])
            or (evidence["observableError"] and any(evidence[key] for key in
                ("observableNext", "observableComplete", "storeProgress100", "uploadEngineResolved", "terminalSuccessApplied")))
            or (any(evidence[key] for key in ("domSuccessObserved", "domHiddenAfterSuccess",
                    "storeRemovedAfterSuccess", "storeRegressedAfterSuccess")) and not evidence["storeSuccessObserved"])):
        return "M23_EVIDENCE_INVALID"
    if not evidence["networkResponse2xx"]:
        return "M23_NETWORK_RESPONSE_NOT_OBSERVED"
    if not evidence["requestFinished"]:
        return "M23_TARGETED_TIMEOUT_UNCLASSIFIED"
    if not evidence["observableSubscribed"]:
        return "M23_HTTP_2XX_WITHOUT_OBSERVABLE_SUBSCRIPTION"
    if not evidence["observableNext"]:
        return "M23_HTTP_2XX_WITHOUT_OBSERVABLE_NEXT"
    if not evidence["storeProgress100"]:
        return "M23_OBSERVABLE_NEXT_WITHOUT_PROGRESS_100"
    if not evidence["uploadEngineResolved"]:
        return "M23_PROGRESS_100_WITH_ENGINE_UNRESOLVED"
    if evidence["generationCurrentAtLoopEntry"] is None or evidence["generationCurrentAtLoopExit"] is None:
        return "M23_EVIDENCE_INVALID"
    if evidence["generationCurrentAtLoopEntry"] is False or evidence["generationCurrentAtLoopExit"] is False:
        return "M23_ENGINE_RESOLVED_WITH_STALE_RUNTIME_GENERATION"
    if not evidence["runUploadLoopResolved"] or not evidence["terminalSuccessApplied"]:
        return "M23_ENGINE_RESOLVED_WITHOUT_TERMINAL_PUBLICATION"
    if not evidence["storeSuccessObserved"]:
        return "M23_TERMINAL_PUBLICATION_WITHOUT_STORE_SUCCESS"
    if evidence["storeRegressedAfterSuccess"]:
        return "M23_STORE_REGRESSED_AFTER_SUCCESS"
    if not evidence["domSuccessObserved"] and not (evidence["storeRemovedAfterSuccess"] and evidence["domHiddenAfterSuccess"]):
        return "M23_STORE_SUCCESS_WITHOUT_DOM_CONVERGENCE"
    return PASS_CLASS


def parse_recovery_journal(path: Path, output_dir: Path) -> dict[str, object]:
    invalid = {"journalValid": False, "journalMissing": False, "classifier": "M26_RECOVERY_EVIDENCE_INVALID"}
    if not path.is_absolute() or not output_dir.is_absolute() or path.name != JOURNAL_NAME:
        return invalid
    try:
        root_stat = output_dir.lstat()
        root = output_dir.resolve(strict=True)
        if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode) or path.parent != root:
            return invalid
    except OSError:
        return invalid
    try:
        journal_stat = path.lstat()
    except FileNotFoundError:
        return {"journalValid": False, "journalMissing": True, "classifier": "M26_RECOVERY_EVIDENCE_MISSING"}
    except OSError:
        return invalid
    if not stat.S_ISREG(journal_stat.st_mode) or stat.S_ISLNK(journal_stat.st_mode) or journal_stat.st_size > MAX_JOURNAL_BYTES:
        return invalid
    try:
        with path.open("rb") as journal_file:
            raw = journal_file.read(MAX_JOURNAL_BYTES + 1)
        if len(raw) > MAX_JOURNAL_BYTES:
            return invalid
        text = raw.decode("utf-8", errors="strict")
        if not text.endswith("\n"):
            return invalid
        lines = text[:-1].split("\n")
        if any(not line for line in lines) or not 1 <= len(lines) <= MAX_JOURNAL_EVENTS + 2:
            return invalid
        records = [json.loads(line, object_pairs_hook=_json_object_without_duplicates,
                              parse_constant=_reject_json_constant) for line in lines]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return invalid
    if not all(isinstance(record, dict) for record in records):
        return invalid
    if records[0] != {"schema": RECOVERY_JOURNAL_SCHEMA, "kind": "journal-start"} or type(records[0].get("schema")) is not int:
        return invalid
    events: list[dict[str, object]] = []
    truncated = False
    active_phase = None
    started_phases: set[str] = set()
    for record in records[1:]:
        if record.get("kind") == "journal-truncated":
            if truncated or set(record) != {"kind"} or len(events) != MAX_JOURNAL_EVENTS:
                return invalid
            truncated = True
            continue
        event = _validate_journal_event(record)
        if event is None or truncated:
            return invalid
        if event["kind"] == "phase-start":
            phase = str(event["phase"])
            if (phase in started_phases or (phase == "initial" and active_phase is not None)
                    or (phase == "recovery" and active_phase != "initial")):
                return invalid
            active_phase = phase
            started_phases.add(phase)
        elif event.get("phase") != active_phase:
            return invalid
        events.append(event)
    if len(events) > MAX_JOURNAL_EVENTS:
        return invalid
    evidence = _evidence_from_events(events)
    if evidence is None:
        return invalid
    return {"journalValid": True, "journalMissing": False,
            "classifier": "M23_EVIDENCE_INVALID" if truncated else classify_recovery_continuation(evidence), "evidence": evidence,
            "schema": RECOVERY_JOURNAL_SCHEMA,
            "eventCount": len(events), "truncated": truncated,
            "recoveryOperationStarted": any(event.get("kind") == "recovery-upload-start" for event in events),
            "instrumentationInstalled": any(event.get("kind") == "instrumentation-installed" and event.get("phase") == "recovery" for event in events),
            "instrumentationTransportFailed": any(event.get("kind") == "instrumentation-invalid" for event in events),
            "rawEventsRecorded": False, "secretsRecorded": False}


def summarize_report(stdout: str, exit_code: int | None) -> dict[str, object]:
    try:
        report = json.loads(stdout)
        stats = report.get("stats") if isinstance(report, dict) else None
        if not isinstance(stats, dict):
            raise ValueError
        result = {key: stats.get(key) for key in ("expected", "unexpected", "skipped", "flaky")}
        if any(type(value) is not int or value < 0 for value in result.values()):
            raise ValueError
    except (json.JSONDecodeError, ValueError):
        return {"round": ROUND, "status": "FAIL", "testOutcome": "FAIL", "exitCode": exit_code,
                "reportValid": False, "tests": None, "target": "recovery.spec.ts", "rawReportRecorded": False}
    passed = exit_code == 0 and result == {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}
    return {"round": ROUND, "status": "PASS" if passed else "FAIL",
            "testOutcome": "PASS" if passed else "FAIL", "exitCode": exit_code,
            "reportValid": True, "tests": result, "target": "recovery.spec.ts", "rawReportRecorded": False}


def _text_output(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value if isinstance(value, str) else ""


def run_playwright_once(command: list[str], cwd: Path, env: dict[str, str], *, timeout: int,
                        runner=None) -> dict[str, object]:
    runner = runner or subprocess.run
    try:
        completed = runner(command, cwd=cwd, env=env, capture_output=True, text=True,
                           check=False, timeout=timeout, shell=False)
    except subprocess.TimeoutExpired as error:
        return {"processOutcome": "PLAYWRIGHT_TIMEOUT", "stdout": _text_output(error.stdout or error.output),
                "exitCode": None, "browserProcessInvocations": 1, "retries": 0}
    except OSError:
        return {"processOutcome": "PLAYWRIGHT_START_FAILED", "stdout": "", "exitCode": None,
                "browserProcessInvocations": 0, "retries": 0}
    return {"processOutcome": "PLAYWRIGHT_EXITED", "stdout": completed.stdout,
            "exitCode": completed.returncode, "browserProcessInvocations": 1, "retries": 0}


def targeted_result(summary: dict[str, object], evidence: dict[str, object], *, cleanup_failure: str | None = None) -> dict[str, object]:
    classifier = evidence.get("classifier", "M26_RECOVERY_EVIDENCE_INVALID")
    if cleanup_failure:
        return {"result": "FAIL_TEARDOWN", "failureCode": cleanup_failure, "classifier": classifier}
    if not evidence.get("journalValid"):
        missing = evidence.get("journalMissing") is True
        return {"result": "FAIL_RECOVERY_EVIDENCE_MISSING" if missing else "FAIL_RECOVERY_EVIDENCE_INVALID",
                "failureCode": "M26_RECOVERY_EVIDENCE_MISSING" if missing else "M26_RECOVERY_EVIDENCE_INVALID",
                "classifier": "M26_RECOVERY_EVIDENCE_MISSING" if missing else "M26_RECOVERY_EVIDENCE_INVALID"}
    if not evidence.get("recoveryOperationStarted"):
        transport_failed = evidence.get("instrumentationTransportFailed") is True
        code = "BLOCKED_RECOVERY_EVIDENCE_TRANSPORT" if transport_failed else "RECOVERY_OPERATION_NOT_STARTED"
        return {"result": "BLOCKED", "failureCode": code, "classifier": code}
    if evidence.get("instrumentationTransportFailed") or evidence.get("instrumentationInstalled") is not True:
        return {"result": "BLOCKED", "failureCode": "BLOCKED_RECOVERY_INSTRUMENTATION_INVALID", "classifier": classifier}
    if classifier != PASS_CLASS:
        boundary = str(classifier).removeprefix("M23_")
        return {"result": f"CHARACTERIZED_RECOVERY_RUNTIME_{boundary}", "failureCode": classifier, "classifier": classifier}
    if (summary.get("status") != "PASS" or summary.get("processOutcome") != "PLAYWRIGHT_EXITED"
            or summary.get("exitCode") != 0 or summary.get("reportValid") is not True
            or summary.get("tests") != {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}
            or summary.get("browserProcessInvocations") != 1 or summary.get("retries") != 0):
        return {"result": "FAIL", "failureCode": "TARGET_RECOVERY_FAILED", "classifier": classifier}
    return {"result": "PASS_TARGETED_RECOVERY_WITH_DURABLE_EVIDENCE", "failureCode": "NONE", "classifier": classifier}


def formal_states(evidence: dict[str, object], recovery_started: bool, targeted_pass: bool,
                  *, deterministic_proven: bool = False) -> dict[str, str]:
    targeted_pass = targeted_pass and deterministic_proven
    classifier = evidence.get("classifier")
    valid_causal = (evidence.get("journalValid") is True and recovery_started
                    and isinstance(classifier, str)
                    and (classifier == PASS_CLASS or (classifier.startswith("M23_") and classifier != "M23_EVIDENCE_INVALID")))
    m23 = ("CLOSED_BY_M27_RUNTIME_RECLASSIFICATION" if valid_causal else
           "REOPENED_BY_M26_EVIDENCE_SEMANTICS / RUNTIME RECLASSIFICATION PENDING")
    if valid_causal and targeted_pass:
        m22 = "CHARACTERIZED_OPEN / HISTORICAL M21 FAILURE NOT REPRODUCED BY M27 TARGETED"
    elif valid_causal:
        m22 = "CHARACTERIZED_OPEN / " + ("CONTINUATION PASS; TARGETED NOT PASS" if classifier == PASS_CLASS
                                         else classifier.removeprefix("M23_"))
    else:
        m22 = "CHARACTERIZED_OPEN / HISTORICAL M21 FAILURE"
    return {"M21-F01": "CLOSED / PRESERVED", "M21-F02": "CLOSED / PRESERVED",
            "M22-H01": "CLOSED / PRESERVED", "M22-H02": "CLOSED / PRESERVED",
            "M24-F01": "CLOSED / PRESERVED", "M24-F02": "CLOSED_BY_M25_DURABLE_EVIDENCE / PRESERVED",
            "M23-F01": m23, "M22-F01": m22, "M25-H01": "CLOSED / PRESERVED",
            "M26-H01": "CLOSED_BY_TEMPORAL_EVIDENCE_SEMANTICS / PRESERVED",
            "M26-H02": "CLOSED_BY_APPLIED_TERMINAL_BOUNDARY / PRESERVED",
            "M26-F01": "CLOSED_BY_M27_SINGLE_TARGETED_RUNTIME_PASS" if targeted_pass and valid_causal else "OPEN",
            "M27-H01": "CLOSED" if deterministic_proven else "OPEN",
            "M27-H02": "CLOSED" if deterministic_proven else "OPEN",
            "M27-F01": "CLOSED" if targeted_pass and valid_causal else "CHARACTERIZED_OPEN" if recovery_started else "OPEN",
            "B90-F02": "OPEN", "B.90": "OPEN / NOT FROZEN", "B.91": "NOT STARTED"}


def render_final_report(
    decision: dict[str, object], *, discovery: dict[str, object], unit_evidence: dict[str, object],
    prerequisites: dict[str, object], runtime_proof: dict[str, object],
) -> str:
    passed = decision["result"] == "PASS_TARGETED_RECOVERY_WITH_DURABLE_EVIDENCE"
    facts = decision.get("evidence") or {}
    cleanup = decision["cleanup"]
    docker = prerequisites["docker"]
    status = lambda value: "NOT RUN" if value is None else "PASS" if value is True else "FAIL"
    docker_description = (
        "Docker CLI estava disponível. A query de server não provou daemon operacional. "
        "Nenhum recurso owned foi iniciado. Nenhum source freeze foi necessário porque nenhum runtime começou. "
        "Nenhum journal era esperado. Cleanup foi NOT APPLICABLE, não FAIL."
        if docker.get("daemonAvailable") is False else
        "A query read-only de server e o inventário possuem resultados distintos; nenhum daemon ou serviço foi iniciado pelo harness."
    )
    runtime_conclusion = (
        "M26 evidence semantics were runtime-confirmed. O recovery alcançou success/100, "
        "a apresentação terminal foi validada, o arquivo final permaneceu acessível e os bytes baixados "
        "coincidiram com o SHA-256 esperado. Nenhum production fix ocorreu."
        if passed else "A hipótese determinística M26 permanece preservada; esta rodada não aprovou o fechamento runtime."
    )
    return f"""# {ROUND}

## Resultado

Resultado **{decision['result']}**; código `{decision['failureCode']}`.
{runtime_conclusion}

## Estado de entrada

Working tree vivo é a autoridade; alterações preexistentes preservadas em `baseline/scope.json`.
M26-H01/H02 CLOSED, production RED NONE, reconciliation PASS; M26-F01 OPEN.
M23-F01 corrente: REOPENED_BY_M26_EVIDENCE_SEMANTICS / RUNTIME RECLASSIFICATION PENDING.
Histórico registrado permanece separado em `baseline/m26-authority.json`.

## M26 deterministic authority

M26 provou success/100 antes de reconciliation, remoção legítima do transfer, arquivo retido,
nenhum recovery recriado e FDK zerada. `drive.store.ts` permanece inalterado por hash.
M25 classification was historically valid under its classifier, but M26 proved that classifier
was temporally over-broad. Reclassificação runtime M27: **{decision.get('causalClassification') or 'NOT RUN'}**.
Schema 5, milestone aplicado e classifier temporal não foram alterados pela M27.

## H01 Docker prerequisite classification

CLI ausente, daemon indisponível, prova de server inválida, inventário indisponível e inventário inválido
possuem códigos distintos e testes com mocks. Nenhum stderr determina a classificação.
RED executado: `red/m27-h01.json`; correção restrita ao runner.

## H02 NOT RUN semantics

RED executado: `red/m27-h02.json`.
True significa fato provado; false significa fato negativo observado; null significa não executado ou não provado.
Source runtime: **{decision['sourceRuntimeComparison']}**; cleanup: **{cleanup['cleanupStatus']}**;
journal: **{decision['journalStatus']}**. Ausência esperada de journal não é MISSING.

## Reused gates

Node diagnostics **{unit_evidence['nodeTests']}/{unit_evidence['nodeTests']} REUSED_BY_HASH**.
Frontend focado **{unit_evidence['frontendTests']}/{unit_evidence['frontendTests']} REUSED_BY_HASH**,
com árvore frontend/src e todos os inputs/configs registrados iguais aos da M26.
Backend e fixture executáveis REUSED_BY_HASH; bind authority PRESERVED_BY_HASH.
Autoridade: `baseline/reused-gates.json`. Nenhuma suite histórica inteira foi declarada reutilizada.

## Runner unit tests

`python -m unittest discover -s tools/quality -p test_run_recovery_targeted.py`:
**{unit_evidence['runnerTests']} PASS**. Runner tests M27 foram executados, não reutilizados.
`python -m py_compile tools/quality/run_recovery_targeted.py tools/quality/test_run_recovery_targeted.py`: PASS.
`git diff --check`, security e lean review: `unit/preflight-review.json`.
Interpretador local Python disponível; nenhuma instalação foi corrigida.

## Discovery

**{discovery.get('status', 'NOT RUN')}**; invocations **{discovery.get('invocations', 0)}**;
**{discovery.get('discovered', 0)} test / {discovery.get('files', 0)} file / 0 executions**.
Comando local: `node frontend/node_modules/@playwright/test/cli.js test e2e/recovery.spec.ts --list --project=chromium --workers=1 --retries=0`.
Discovery ocorre antes de Docker e não é repetida pela targeted.

## Docker runtime prerequisite

{docker_description}
CLI: **{status(docker.get('cliAvailable'))}**; daemon: **{status(docker.get('daemonAvailable'))}**.
Query: `docker version --format`; apenas booleans persistidos, sem versão, path, stdout ou stderr.
Autoridade: `targeted/runtime-prerequisites.json`. Nenhum fallback PostgreSQL foi criado.

## Preexisting resource inventory

Estado: **{decision['preexistingResourceInventory']}**.
Somente identitySha256 e state; sem nome, image, labels, ports, mounts ou paths.
Preservação por inventário: **{status(cleanup['userResourcesPreserved'])}**.
Mutação de recursos preexistentes pelo owner: **{decision['preexistingResourcesMutatedByOwner']}**.

## Source freeze

**{decision['sourceFreeze']}**. Somente após gates, discovery, Docker e inventário verdes.
Quando capturado, `targeted/source-freeze.json` protege sources, executáveis e histórico M21–M26.
Nenhum source edit após freeze; nenhum patch pós-targeted.

## Owned runtime

Recursos iniciados: **{cleanup['ownedResourcesStarted']}**.
Angular: **{decision['ownedGenerations']['frontend']}**; PostgreSQL: **{decision['ownedGenerations']['postgres']}**;
backend: **{decision['ownedGenerations']['backend']}**; workspace: **{decision['ownedGenerations']['workspace']}**.
Listener proof: **{runtime_proof.get('status', 'NOT RUN')}**. Bind IPv4 loopback, ownership pelo processo,
autoridade dotenv mais próxima; nenhuma injeção de bind no browser.

## Single recovery targeted

Invocations **{decision['browserProcessInvocations']}**; retries **0**; workers **1**; Chromium; recovery spec único.
Processo **{decision['processOutcome']}**; teste **{decision['testOutcome']}**.
Timeouts existentes preservados; nenhum retry, smoke, sleep novo ou segunda execução.

## Durable temporal evidence

Journal **{decision['journalStatus']}**; validade **{status(decision['journalValid'])}**;
schema **{decision.get('schema') if decision.get('schema') is not None else 'NOT RUN'}**;
classifier **{decision.get('causalClassification') or 'NOT RUN'}**.
Fatos temporais: terminal aplicado **{json.dumps(facts.get('terminalSuccessApplied'))}**;
store success **{json.dumps(facts.get('storeSuccessObserved'))}**;
removal after success **{json.dumps(facts.get('storeRemovedAfterSuccess'))}**;
regression **{json.dumps(facts.get('storeRegressedAfterSuccess'))}**;
DOM hidden after success **{json.dumps(facts.get('domHiddenAfterSuccess'))}**.
Parse antes do cleanup: **{status(decision['journalParsedBeforeWorkspaceCleanup'])}**.
Journal bruto permanece somente na workspace disposable e é removido com ela.

## Final file integrity

Meu Drive: arquivo visível, download funcional e SHA-256 exato:
**{'PASS' if decision['fileIntegrityVerified'] is True else 'NOT PROVEN' if decision['fileIntegrityVerified'] is False else 'NOT RUN'}**,
autoridade nas assertions originais do E2E.
Classifier PASS sozinho nunca aprova o resultado funcional.

## Ownership and teardown

Cleanup **{cleanup['cleanupStatus']}**; requerido **{cleanup['cleanupRequired']}**.
Frontend **{status(cleanup['frontendStopped'])}**; backend **{status(cleanup['backendStopped'])}**;
PostgreSQL **{status(cleanup['postgresRemoved'])}**; workspace **{status(cleanup['workspaceRemoved'])}**.
Ausência de recurso implica NOT APPLICABLE; teardown tenta todos os recursos owned independentemente.
Falha de teardown sobrepõe PASS. PostgreSQL removido por exact ID, nunca por nome/pattern.

## Source integrity

Entry integrity **{decision['entryIntegrity']}**; runtime comparison **{decision['sourceRuntimeComparison']}**.
`sourceUnchangedAcrossRuntime`: **{json.dumps(decision['sourceUnchangedAcrossRuntime'])}**.
`productionRecoverySourceChanged`: **{decision['productionRecoverySourceChanged']}**.
Histórico e executáveis protegidos; nenhum Git mutation ou reconstrução via XML.
Prova final: `post/protected-hashes.json`.

## Security review

Artifacts create-new. Sem secrets, raw stdout/stderr, Docker pipe/path, path pessoal,
username, token, senha DB, URL completa, nome real de arquivo ou array bruto de eventos.
Journal schema 5 preserva exclusive create, regular file, no symlink, localização owned,
UTF-8 estrito, duplicate-key rejection, allowlists e limites 64 eventos/64 KiB.

## Performance / avoided gates

Node e frontend reutilizados por hashes integrais; backend não rebuilt.
Nenhuma instalação, coverage, mutation, full suite, probe histórico ou canonical 5×.
Canônica **NOT RUN**; AP-07/AP-09 **NOT STARTED**.

## Formal state

{chr(10).join(f'- {key}: **{value}**' for key, value in decision['formalStates'].items())}

## Handoff

{'Próxima rodada: B.90-R1.M28 canonical 5× ratification.' if passed else 'Próxima rodada depende da fronteira registrada; nenhum workaround ou retry nesta rodada.'}
B90-F02 OPEN; B.90 OPEN / NOT FROZEN; B.91 NOT STARTED.
"""


def verify_unit_evidence(output: Path, root: Path) -> dict[str, object]:
    try:
        m26 = root / M26_OUTPUT
        node = json.loads((m26 / "unit" / "node-diagnostics.json").read_text(encoding="utf-8"))
        runner = json.loads((output / "unit" / "runner.json").read_text(encoding="utf-8"))
        frontend = json.loads((m26 / "unit" / "frontend-reconciliation.json").read_text(encoding="utf-8"))
        compile_gate = json.loads((output / "unit" / "pycompile.json").read_text(encoding="utf-8"))
        review = json.loads((output / "unit" / "preflight-review.json").read_text(encoding="utf-8"))
        reused = json.loads((output / "baseline" / "reused-gates.json").read_text(encoding="utf-8"))
        reds = [json.loads((output / "red" / f"m27-h{number:02}.json").read_text(encoding="utf-8"))
                for number in (1, 2)]
    except (OSError, json.JSONDecodeError):
        raise TargetFailure("UNIT_EVIDENCE_MISSING_OR_INVALID") from None
    for item, round_id in ((node, "B.90-R1.M26"), (frontend, "B.90-R1.M26"),
                           (runner, ROUND), (compile_gate, ROUND), (review, ROUND), (reused, ROUND)):
        if not isinstance(item, dict) or item.get("round") != round_id or item.get("status") != "PASS":
            raise TargetFailure("UNIT_EVIDENCE_NOT_GREEN")
    if (type(node.get("tests")) is not int or type(node.get("passed")) is not int
            or node["tests"] <= 0 or node["tests"] != node["passed"] or node.get("failed") != 0 or node.get("skipped") != 0):
        raise TargetFailure("NODE_DIAGNOSTICS_TESTS_NOT_GREEN")
    if (type(runner.get("tests")) is not int or type(runner.get("passed")) is not int
            or runner["tests"] <= 0 or runner["tests"] != runner["passed"] or runner.get("failed") != 0 or runner.get("skipped") != 0):
        raise TargetFailure("PYTHON_RUNNER_TESTS_NOT_GREEN")
    if (type(frontend.get("passed")) is not int or frontend["passed"] <= 0
            or frontend.get("tests") != frontend["passed"]
            or frontend.get("deterministicReconciliationPassed") is not True
            or frontend.get("failed") != 0 or frontend.get("refreshTrueTests") != 1):
        raise TargetFailure("DETERMINISTIC_RECONCILIATION_NOT_GREEN")
    if any(not isinstance(red, dict) or red.get("round") != ROUND or red.get("status") != "PRE_PATCH_RED"
           or red.get("finding") != f"M27-H{index:02}" or red.get("exitCode") != 1
           for index, red in enumerate(reds, 1)):
        raise TargetFailure("PRE_PATCH_RED_NOT_RECORDED")
    if (review.get("diffCheck") != "PASS" or review.get("securityReview") != "PASS"
            or review.get("leanReview") != "PASS"
            or reused.get("node", {}).get("sourceHashes") != node.get("sourceHashes")
            or reused.get("frontend", {}).get("sourceHashes") != frontend.get("sourceHashes")
            or reused.get("frontend", {}).get("sourceTreeHash") != frontend.get("sourceTreeHash")):
        raise TargetFailure("UNIT_EVIDENCE_NOT_GREEN")
    required_sources = (
        (node, ("frontend/tools/e2e-recovery-diagnostics.mjs", "frontend/tools/e2e-recovery-diagnostics.test.mjs")),
        (runner, ("tools/quality/run_recovery_targeted.py", "tools/quality/test_run_recovery_targeted.py",
                  "tools/quality/owned_frontend.py", "tools/quality/run_playwright_campaign.py", "tools/quality/run_playwright_campaign_env.py")),
        (compile_gate, ("tools/quality/run_recovery_targeted.py", "tools/quality/test_run_recovery_targeted.py")),
        (review, ("tools/quality/run_recovery_targeted.py", "tools/quality/test_run_recovery_targeted.py")),
        (frontend, ("frontend/angular.json", "frontend/karma.conf.js", "frontend/tsconfig.json",
                    "frontend/tsconfig.spec.json", "frontend/package.json", "frontend/package-lock.json")),
    )
    for gate, paths in required_sources:
        expected = gate.get("sourceHashes")
        if not isinstance(expected, dict) or any(
                expected.get(relative) != hashlib.sha256((root / relative).read_bytes()).hexdigest() for relative in paths):
            raise TargetFailure("UNIT_SOURCE_HASH_MISMATCH")
    if frontend.get("sourceTreeHash") != env_owner.capture_source_hashes(root)["trees"]["frontend/src"]:
        raise TargetFailure("UNIT_SOURCE_HASH_MISMATCH")
    return {"status": "PASS", "nodeTests": node["tests"], "runnerTests": runner["tests"],
            "frontendTests": frontend["passed"], "pyCompile": compile_gate["status"],
            "prePatchRed": "M27-H01/H02 PRE_PATCH_RED", "deterministicReconciliationPassed": True}


def sources_match_entry(entry: dict[str, object], current: dict[str, object]) -> bool:
    allowed = {"tools/quality/run_recovery_targeted.py", "tools/quality/test_run_recovery_targeted.py"}
    return (all(entry.get(key) == current.get(key) for key in
                ("trees", "sharedProtectedFiles", "runtimeExecutables", "historicalArtifacts"))
            and {key: value for key, value in entry["files"].items() if key not in allowed}
            == {key: value for key, value in current["files"].items() if key not in allowed})


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / ".quality" / "b90-r1m27-recovery-runtime-closure")
    args = parser.parse_args(argv)
    output = args.output if args.output.is_absolute() else root / args.output
    expected_outputs = (
        "targeted/source-freeze.json", "discovery/recovery.json",
        "targeted/process-result.json", "targeted/continuation-evidence.json",
        "targeted/owner-result.json", "post/protected-hashes.json", "targeted/runtime-proof.json",
        "targeted/runtime-prerequisites.json", "baseline/preexisting-resources.json",
        "decision.json", "final-report.md",
    )
    if any((output / path).exists() for path in expected_outputs):
        print("BLOCKED: ARTIFACTS_ALREADY_EXIST")
        return 1
    try:
        scope = json.loads((output / "baseline" / "scope.json").read_text(encoding="utf-8"))
        entry = json.loads((output / "baseline" / "protected-hashes.json").read_text(encoding="utf-8"))
        authority = json.loads((output / "baseline" / "m26-authority.json").read_text(encoding="utf-8"))
        if scope.get("round") != ROUND or scope.get("artifactDirectoryAbsentAtEntry") is not True:
            raise TargetFailure("BLOCKED_ARTIFACT_ROUND_ALREADY_EXISTS")
        if (authority.get("round") != ROUND or authority.get("authorityRound") != "B.90-R1.M26"
                or authority.get("liveTreeMatchesM26Post") is not True):
            raise TargetFailure("BASELINE_MISSING_OR_INVALID")
        unit_evidence = verify_unit_evidence(output, root)
    except TargetFailure as error:
        print(f"BLOCKED: {error.code}")
        return 1
    except (OSError, ValueError, TypeError):
        print("BLOCKED: BASELINE_MISSING_OR_INVALID")
        return 1
    owned_frontend = None
    owned_backend = None
    lease = None
    frontend_stopped = backend_stopped = postgres_removed = workspace_removed = None
    discovery: dict[str, object] = {"status": "NOT RUN"}
    before = after = None
    runtime_proof: dict[str, object] = {"status": "NOT RUN"}
    process_result: dict[str, object] = {"processOutcome": "NOT RUN", "browserProcessInvocations": 0, "retries": 0}
    run_summary: dict[str, object] = {"status": "NOT RUN", "reportValid": None}
    evidence: dict[str, object] = {"journalStatus": "NOT_RUN", "journalValid": None,
                                  "journalMissing": None, "schema": None, "classifier": None}
    failure = "TARGET_NOT_STARTED"
    cleanup_failure = None
    source_unchanged = None
    source_frozen = False
    source_comparison = "NOT_RUN"
    entry_integrity = "NOT_PROVEN"
    browser_invoked = False
    recovery_started = False
    journal_parsed_before_cleanup = None
    preexisting_containers = None
    user_resources_preserved = None
    docker: dict[str, bool | None] = {"cliAvailable": None, "daemonAvailable": None}
    production_recovery_changed = None
    result = "BLOCKED"
    backend_executable = Path(os.environ.get(
        "NANIKA_E2E_BACKEND_EXE", root / "backend" / "build" / "savebox_server.exe"
    )).resolve()
    fixture_executable = (root / "backend" / "build" / "nanika_e2e_fixture.exe").resolve()
    node = shutil.which("node")
    try:
        if not node or not backend_executable.is_file() or not fixture_executable.is_file():
            raise TargetFailure("OWNED_RUNTIME_PREREQUISITE_MISSING")
        if backend_executable != (root / "backend/build/savebox_server.exe").resolve():
            raise TargetFailure("BACKEND_EXECUTABLE_AUTHORITY_INVALID")
        _, ng_cli = frontend_owner.resolve_frontend_tooling(root, node)
        playwright_cli = root / "frontend/node_modules/@playwright/test/cli.js"
        if playwright_cli.is_symlink() or not playwright_cli.is_file():
            raise TargetFailure("OWNED_RUNTIME_PREREQUISITE_MISSING")
        env_owner.validate_playwright_config(root / "frontend" / "playwright.config.ts")
        discovery = {"round": ROUND, "status": "FAIL", "invocations": 1,
                     "discovered": None, "files": None, "executed": 0, "retries": 0}
        try:
            discovery = discover_recovery(root, node)
        finally:
            write_json(output / "discovery" / "recovery.json", discovery)
        try:
            docker = probe_docker_runtime()
        except TargetFailure as error:
            docker["cliAvailable"] = error.code != "DOCKER_CLI_UNAVAILABLE"
            docker["daemonAvailable"] = False if error.code == "DOCKER_DAEMON_UNAVAILABLE" else None
            raise
        preexisting_containers = container_snapshot()
        write_json(output / "baseline" / "preexisting-resources.json", {
            "round": ROUND, "readOnlyInventory": True, "containers": [
                {"identitySha256": hashlib.sha256(identity.encode()).hexdigest(), "state": state}
                for identity, state in sorted(preexisting_containers.items())
            ], "personalPathsRecorded": False,
        })
        before = source_hashes(root)
        if before.get("historicalArtifacts", {}) != entry.get("historicalArtifacts"):
            raise TargetFailure("HISTORICAL_ARTIFACT_CHANGED_FROM_ENTRY")
        if before.get("runtimeExecutables") != entry.get("runtimeExecutables"):
            raise TargetFailure("BACKEND_EXECUTABLE_CHANGED_FROM_ENTRY")
        production_recovery_changed = (
            before["files"]["frontend/src/app/features/drive/state/drive.store.ts"]
            != entry["files"]["frontend/src/app/features/drive/state/drive.store.ts"]
        )
        if production_recovery_changed:
            raise TargetFailure("PRODUCTION_SOURCE_CHANGED_UNEXPECTEDLY")
        if not sources_match_entry(entry, before):
            raise TargetFailure("SOURCE_CHANGED_OUTSIDE_M27_SCOPE")
        entry_integrity = "PASS"
        write_json(output / "targeted" / "source-freeze.json", {"round": ROUND, "phase": "SOURCE_FREEZE", **before})
        source_frozen = True
        print(json.dumps({"round": ROUND, "phase": "SOURCE_FREEZE", "productionRecoverySourceChanged": False}), flush=True)
        reservation = None
        try:
            reservation = frontend_owner.reserve_frontend_port(4200)
            owned_frontend = frontend_owner.spawn_frontend(root, node, ng_cli, reservation)
        finally:
            if reservation is not None:
                reservation.socket.close()
        frontend_owner.wait_frontend_ready(owned_frontend)
        frontend_listener = owned_loopback_listener(owned_frontend.port, owned_frontend.process.pid)
        backend_url = f"http://127.0.0.1:{_free_loopback_port()}"
        lease = env_owner.prepare_environment(root, owned_frontend.url, backend_url, backend_executable)
        if lease.postgres.container_id in preexisting_containers:
            raise TargetFailure("PREEXISTING_POSTGRES_ADOPTION_REJECTED")
        bind_evidence = verify_runtime_bind(lease.workspace, backend_url, backend_executable)
        spec = campaign.BackendSpec(backend_executable, lease.workspace.cwd, backend_url)
        validated = campaign.validate_backend_spec(spec, backend_url)
        previous_bind = os.environ.pop("NANIKA_BIND_ADDRESS", None)
        try:
            owned_backend = campaign.spawn_backend(spec, 1, validated_config=validated)
        finally:
            if previous_bind is not None:
                os.environ["NANIKA_BIND_ADDRESS"] = previous_bind
        if owned_backend.owned is not True:
            raise TargetFailure("BACKEND_NOT_OWNED")
        owned_backend = campaign.wait_backend_ready(owned_backend)
        listener_evidence = owned_loopback_listener(url_port(backend_url), owned_backend.process.pid)
        runtime_proof = {"status": "PASS", **bind_evidence, **listener_evidence,
                         "listenerOwnedByBackend": listener_evidence["listenerOwnedByProcess"],
                         "frontendListenerOwnedByFrontend": frontend_listener["listenerOwnedByProcess"],
                         "frontendAddressClass": frontend_listener["addressClass"],
                         "healthCheck": "PASS", "backendGeneration": 1, "frontendGeneration": 1,
                         "postgresDisposable": lease.summary["postgres"]["owned"],
                         "backendRebuilt": False}
        write_json(output / "targeted" / "runtime-proof.json", runtime_proof)

        playwright_env = os.environ.copy()
        playwright_env.pop("NANIKA_BIND_ADDRESS", None)
        playwright_output_dir = lease.workspace.root / "playwright-output"
        workspace_root = lease.workspace.root.resolve(strict=True)
        playwright_output_dir.mkdir()
        if playwright_output_dir.is_symlink() or playwright_output_dir.resolve(strict=True).parent != workspace_root:
            raise TargetFailure("RECOVERY_EVIDENCE_OUTPUT_NOT_OWNED")
        journal_path = playwright_output_dir / JOURNAL_NAME
        if journal_path.exists() or journal_path.is_symlink():
            raise TargetFailure("RECOVERY_EVIDENCE_PATH_ALREADY_EXISTS")
        playwright_env.update({
            "NANIKA_E2E_BASE_URL": owned_frontend.url,
            "NANIKA_E2E_BACKEND_URL": backend_url,
            "NANIKA_E2E_BACKEND_CWD": str(lease.workspace.cwd),
            "NANIKA_E2E_FIXTURE_CWD": str(lease.workspace.cwd),
            "NANIKA_E2E_FIXTURE_EXE": str(fixture_executable),
            "PLAYWRIGHT_OUTPUT_DIR": str(playwright_output_dir.resolve(strict=True)),
            "NANIKA_RECOVERY_EVIDENCE_PATH": str(journal_path),
        })
        playwright_env.update(lease.e2e_environment)
        if "NANIKA_BIND_ADDRESS" in lease.e2e_environment or "NANIKA_BIND_ADDRESS" in playwright_env:
            raise TargetFailure("BIND_ADDRESS_DUPLICATE_CLIENT_ENV")
        command = [node, str(root / "frontend" / "node_modules" / "@playwright" / "test" / "cli.js"),
                   "test", "e2e/recovery.spec.ts", "--project=chromium", "--workers=1", "--retries=0", "--reporter=json"]
        process_result = run_playwright_once(command, root / "frontend", playwright_env, timeout=210)
        browser_invoked = process_result["browserProcessInvocations"] == 1
        if process_result["processOutcome"] == "PLAYWRIGHT_EXITED":
            run_summary = summarize_report(str(process_result.pop("stdout")), process_result["exitCode"])
        elif process_result["processOutcome"] == "PLAYWRIGHT_TIMEOUT":
            run_summary = summarize_report(str(process_result.pop("stdout")), None)
        else:
            process_result.pop("stdout", None)
            run_summary = {"round": ROUND, "status": "FAIL", "exitCode": None,
                           "testOutcome": "FAIL",
                           "reportValid": False, "tests": None, "target": "recovery.spec.ts",
                           "rawReportRecorded": False}
        if browser_invoked:
            evidence = parse_recovery_journal(journal_path, playwright_output_dir.resolve(strict=True))
            evidence["journalStatus"] = ("VALID" if evidence.get("journalValid") is True else
                                         "MISSING" if evidence.get("journalMissing") is True else "INVALID")
            journal_parsed_before_cleanup = True
        recovery_started = evidence.get("recoveryOperationStarted") is True
        run_summary.update({
            "processOutcome": process_result["processOutcome"],
            "browserProcessInvocations": process_result["browserProcessInvocations"],
            "retries": 0,
            "recoveryOperationStarted": recovery_started,
        })
        if process_result["processOutcome"] == "PLAYWRIGHT_START_FAILED":
            failure = "TARGET_PLAYWRIGHT_START_FAILED"
        else:
            targeted_outcome = targeted_result(run_summary, evidence)
            failure = str(targeted_outcome["failureCode"])
    except (TargetFailure, frontend_owner.FrontendOwnershipFailure) as error:
        failure = error.code if error.code in SAFE_SETUP_FAILURES else "TARGET_ORCHESTRATION_FAILED"
    except (campaign.CampaignFailure, env_owner.EnvironmentFailure):
        failure = "OWNED_RUNTIME_SETUP_FAILED"
    except Exception:
        failure = "TARGET_ORCHESTRATION_FAILED"
    finally:
        if owned_backend is not None and owned_backend.owned is True:
            backend_stopped = False
            try:
                campaign.stop_backend(owned_backend)
                backend_stopped = owned_backend.process.poll() is not None
                if not backend_stopped:
                    raise TargetFailure("OWNED_BACKEND_TEARDOWN_FAILED")
            except Exception:
                failure = cleanup_failure = "OWNED_BACKEND_TEARDOWN_FAILED"
        if lease is not None:
            if preexisting_containers is not None and lease.postgres.container_id not in preexisting_containers:
                postgres_removed = False
                try:
                    env_owner.remove_disposable_postgres(lease.postgres)
                    postgres_removed = True
                except Exception:
                    failure = cleanup_failure = "OWNED_POSTGRES_TEARDOWN_FAILED"
            workspace_removed = False
            try:
                env_owner.cleanup_runtime_workspace(lease.workspace)
                workspace_removed = not lease.workspace.root.exists()
                if not workspace_removed:
                    raise TargetFailure("OWNED_WORKSPACE_TEARDOWN_FAILED")
            except Exception:
                failure = cleanup_failure = "OWNED_WORKSPACE_TEARDOWN_FAILED"
        if owned_frontend is not None:
            frontend_stopped = False
            try:
                frontend_owner.stop_frontend(owned_frontend)
                frontend_stopped = owned_frontend.process.poll() is not None
                if not frontend_stopped:
                    raise TargetFailure("OWNED_FRONTEND_TEARDOWN_FAILED")
            except Exception:
                failure = cleanup_failure = "OWNED_FRONTEND_TEARDOWN_FAILED"
        owned_generations = {
            "frontend": int(owned_frontend is not None),
            "backend": int(owned_backend is not None and owned_backend.owned is True),
            "postgres": int(postgres_removed is not None), "workspace": int(lease is not None),
        }
        owned_resources_started = sum(owned_generations.values())
        if preexisting_containers is not None:
            try:
                current_containers = container_snapshot()
                user_resources_preserved = all(current_containers.get(identity) == state
                                               for identity, state in preexisting_containers.items())
                if postgres_removed is not None:
                    postgres_removed = postgres_removed and lease.postgres.container_id not in current_containers
                    if not postgres_removed:
                        raise TargetFailure("OWNED_POSTGRES_TEARDOWN_FAILED")
                if not user_resources_preserved:
                    raise TargetFailure("PREEXISTING_RESOURCES_CHANGED")
            except TargetFailure as error:
                failure = cleanup_failure = error.code
        try:
            after = source_hashes(root)
            entry_integrity = "PASS" if sources_match_entry(entry, after) else "FAIL"
            if source_frozen and owned_resources_started:
                source_unchanged = before == after
                source_comparison = "MATCH" if source_unchanged else "MISMATCH"
            production_recovery_changed = (
                after["files"]["frontend/src/app/features/drive/state/drive.store.ts"]
                != entry["files"]["frontend/src/app/features/drive/state/drive.store.ts"]
            )
            write_json(output / "post" / "protected-hashes.json", {"round": ROUND, "phase": "POST_CLEANUP", **after})
        except TargetFailure:
            if source_frozen:
                failure = "SOURCE_HASH_FAILED"
                if owned_resources_started:
                    source_comparison = "NOT_PROVEN"
        if source_frozen and after is not None and before != after and cleanup_failure is None:
            failure = "SOURCE_CHANGED_AFTER_FREEZE"
        cleanup_pass = (cleanup_failure is None and all(value is not False for value in
                        (backend_stopped, postgres_removed, workspace_removed, frontend_stopped)))
        cleanup = {"ownedResourcesStarted": owned_resources_started,
                   "cleanupRequired": owned_resources_started > 0,
                   "cleanupStatus": "NOT_APPLICABLE" if not owned_resources_started else "PASS" if cleanup_pass else "FAIL",
                   "frontendStopped": frontend_stopped, "backendStopped": backend_stopped,
                   "postgresRemoved": postgres_removed, "workspaceRemoved": workspace_removed,
                   "userResourcesPreserved": user_resources_preserved}
        if browser_invoked:
            decision = targeted_result(
                run_summary, evidence,
                cleanup_failure=cleanup_failure or (None if cleanup_pass and user_resources_preserved is True
                                                    else "OWNED_RESOURCE_TEARDOWN_INCOMPLETE"),
            )
            if not journal_parsed_before_cleanup:
                decision = {"result": "FAIL_RECOVERY_EVIDENCE_INVALID", "failureCode": "JOURNAL_PARSE_ORDER_NOT_PROVEN"}
            if source_unchanged is not True and cleanup_failure is None:
                failure = "SOURCE_CHANGED_AFTER_FREEZE" if source_unchanged is False else "SOURCE_HASH_FAILED"
                result = "FAIL_SOURCE_INTEGRITY"
            else:
                failure = str(decision["failureCode"])
                result = str(decision["result"])
        elif cleanup_failure:
            result = "FAIL_TEARDOWN"
        elif source_frozen and after is not None and before != after:
            result = "FAIL_SOURCE_INTEGRITY"
            failure = "SOURCE_CHANGED_AFTER_FREEZE"
        elif source_frozen and after is None:
            result = "FAIL_SOURCE_INTEGRITY"
            failure = "SOURCE_HASH_FAILED"
        elif entry_integrity == "FAIL":
            result = "FAIL_SOURCE_INTEGRITY"
            failure = "PRODUCTION_SOURCE_CHANGED_UNEXPECTEDLY" if production_recovery_changed else "SOURCE_CHANGED_OUTSIDE_M27_SCOPE"
        else:
            result = BLOCKED_RESULTS.get(failure, "BLOCKED")
        process_artifact = {
            **run_summary,
            "round": ROUND,
            "targetedInvocations": process_result.get("browserProcessInvocations", 0),
            "recoveryOperationStarted": recovery_started,
            "retries": 0,
        }
        write_json(output / "targeted" / "process-result.json", process_artifact)
        write_json(output / "targeted" / "continuation-evidence.json", evidence)
        write_json(output / "targeted" / "owner-result.json", {
            "round": ROUND, **cleanup,
            "bindAddressClientInjection": False,
            "listenerAddressClass": runtime_proof.get("addressClass"),
            "journalStatus": evidence["journalStatus"], "journalValid": evidence.get("journalValid"),
            "journalParsedBeforeWorkspaceCleanup": journal_parsed_before_cleanup,
            "diagnosticAttachmentRequired": False,
            "preexistingResourceInventory": "CAPTURED" if preexisting_containers is not None else "NOT_AVAILABLE",
            "preexistingResourcesMutatedByOwner": False,
            "onlyOwnedProcessHandlesStopped": True, "ownedGenerations": owned_generations,
            "rawOutputRecorded": False,
        })
        prerequisites = {
            "round": ROUND, "docker": docker, "discoveryPassed": discovery.get("status") == "PASS",
            "blockingPrerequisite": failure if failure in BLOCKED_RESULTS else None,
            "ownedResourcesStarted": owned_resources_started, "rawOutputRecorded": False,
        }
        write_json(output / "targeted" / "runtime-prerequisites.json", prerequisites)
        formal = formal_states(
            evidence, recovery_started,
            result == "PASS_TARGETED_RECOVERY_WITH_DURABLE_EVIDENCE",
            deterministic_proven=unit_evidence["deterministicReconciliationPassed"],
        )
        decision_payload = {
            "round": ROUND, "result": result, "failureCode": failure,
            "entryIntegrity": entry_integrity,
            "sourceRuntimeComparison": source_comparison,
            "sourceUnchangedAcrossRuntime": source_unchanged,
            "sourceFreeze": "CAPTURED" if source_frozen else "NOT_RUN",
            "discovery": discovery.get("status", "NOT RUN"),
            "browserProcessInvocations": process_result.get("browserProcessInvocations", 0),
            "processOutcome": process_result.get("processOutcome"),
            "testOutcome": run_summary.get("testOutcome", run_summary.get("status")),
            "recoveryOperationStarted": recovery_started, "retries": 0,
            "journalStatus": evidence["journalStatus"], "journalValid": evidence.get("journalValid"),
            "causalClassification": evidence.get("classifier"),
            "evidenceDurability": {"schemaAuthority": "B.90-R1.M26", "schema": RECOVERY_JOURNAL_SCHEMA,
                                   "journalAuthority": True, "attachmentRequired": False},
            "formalStates": formal,
            "productionRecoverySourceChanged": production_recovery_changed,
            "backendBindChanged": any(after["files"].get(path) != entry["files"].get(path)
                                     for path in ("backend/include/utils.hpp", "backend/src/main.cpp")) if after else None,
            "schema": evidence.get("schema"), "evidence": evidence.get("evidence"),
            "journalParsedBeforeWorkspaceCleanup": journal_parsed_before_cleanup,
            "fileIntegrityVerified": run_summary.get("status") == "PASS" if browser_invoked else None,
            "cleanup": cleanup, "ownedGenerations": owned_generations,
            "preexistingResourcesMutatedByOwner": False,
            "preexistingResourceInventory": "CAPTURED" if preexisting_containers is not None else "NOT_AVAILABLE",
            "canonical5x": "NOT RUN", "coverage": "NOT RUN / NOT REQUIRED",
            "mutation": "NOT RUN / OUT OF SCOPE", "secretsRecorded": False,
        }
        write_json(output / "decision.json", decision_payload)
        report = render_final_report(decision_payload, discovery=discovery, unit_evidence=unit_evidence,
                                     prerequisites=prerequisites, runtime_proof=runtime_proof)
        with (output / "final-report.md").open("x", encoding="utf-8") as report_file:
            report_file.write(report)
    print(json.dumps({"round": ROUND, "result": result, "failureCode": failure,
                      "classifier": evidence.get("classifier"), "sourceUnchanged": source_unchanged}, sort_keys=True))
    return 0 if result == "PASS_TARGETED_RECOVERY_WITH_DURABLE_EVIDENCE" else 1


def url_port(url: str) -> int:
    port = campaign.parse_local_url(url)[1]
    return port


if __name__ == "__main__":
    raise SystemExit(main())
