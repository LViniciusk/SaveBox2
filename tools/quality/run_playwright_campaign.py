"""Run independent canonical Playwright invocations with owned backends."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import urlopen


LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
REPORT_NAME = "results.json"
STATUS_NAME = "run-status.json"
CANONICAL_TESTS = 5


class CampaignFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class BackendSpec:
    executable: Path
    cwd: Path
    url: str


@dataclass(frozen=True)
class BackendGeneration:
    generation: int
    process: object
    started_at: str
    executable_sha256: str
    owned: bool
    url: str | None = None
    executable_name: str = "savebox_server.exe"
    ready_at: str | None = None


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_local_url(url: str) -> tuple[str, int]:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError as error:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID") from error
    if parsed.scheme not in {"http", "https"} or host not in LOCAL_HOSTS or port is None:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    return host, port


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
            value = value[1:-1]
        values[key] = value
    return values


def find_dotenv_upwards(start: Path) -> Path | None:
    """Resolve the nearest readable regular .env without following candidates."""
    current = Path(os.path.abspath(os.fspath(start)))
    for _ in range(33):
        candidate = current / ".env"
        try:
            metadata = candidate.lstat()
        except FileNotFoundError:
            metadata = None
        except OSError as error:
            raise CampaignFailure("CAMPAIGN_CONFIG_INVALID") from error

        if metadata is not None:
            if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                raise CampaignFailure("CAMPAIGN_CONFIG_INVALID")
            try:
                with candidate.open("rb"):
                    pass
            except OSError as error:
                raise CampaignFailure("CAMPAIGN_CONFIG_INVALID") from error
            return candidate

        parent = current.parent
        if parent == current:
            return None
        current = parent
    return None


def validate_backend_spec(spec: BackendSpec, backend_url: str | None = None) -> dict[str, object]:
    url = backend_url or spec.url
    _, port = parse_local_url(url)
    executable = spec.executable.resolve()
    cwd = spec.cwd.resolve()
    if not executable.is_file() or executable.is_symlink():
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    if not cwd.is_dir() or cwd.is_symlink() or len(cwd.parents) < 2:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    config_path = find_dotenv_upwards(cwd)
    if config_path is None:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    try:
        values = read_dotenv(config_path)
    except OSError as error:
        raise CampaignFailure("CAMPAIGN_CONFIG_INVALID") from error
    db_port = values.get("DB_PORT", "")
    config_valid = (
        values.get("PORT") == str(port)
        and values.get("DB_NAME", "").startswith("nanika_e2e_")
        and values.get("DB_HOST")
        and db_port.isdigit()
        and values.get("TRUST_PROXY_HEADERS", "").lower() == "false"
        and values.get("NANIKA_STORAGE_PATH")
        and values.get("NANIKA_E2E_STORAGE_ID")
    )
    if not config_valid:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    return {
        "valid": True,
        "configAuthority": {
            "mode": "nearest-ancestor-dotenv",
            "nearestAncestorDotenv": True,
            "filePrecedesProcessEnvironment": True,
            "configExists": True,
            "configRegular": True,
            "portMatchesBackendUrl": True,
            "isolatedDatabaseName": True,
            "dbPortValid": True,
            "trustProxyHeadersFalse": True,
            "isolatedStorageConfigured": True,
            "storageIdentityPresent": True,
            "secretValuesRecorded": False,
        },
    }


def endpoint_reachable(url: str) -> bool:
    try:
        with urlopen(f"{url.rstrip('/')}/health", timeout=0.5):
            return True
    except HTTPError:
        return True
    except (OSError, URLError, TimeoutError):
        return False


def endpoint_ready(url: str) -> bool:
    try:
        with urlopen(f"{url.rstrip('/')}/health", timeout=0.5) as response:
            return response.status == 200
    except (OSError, URLError, TimeoutError):
        return False


def _stop_process(process: object, timeout: float = 2.0) -> dict[str, bool]:
    if process.poll() is not None:
        return {"escalated": False}
    process.terminate()
    try:
        process.wait(timeout=timeout)
        return {"escalated": False}
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)
        return {"escalated": True}


def spawn_backend(
    spec: BackendSpec,
    generation: int,
    *,
    validated_config: dict[str, object] | None = None,
    process_factory=subprocess.Popen,
) -> BackendGeneration:
    if validated_config is None:
        validate_backend_spec(spec, spec.url)
    if endpoint_reachable(spec.url):
        raise CampaignFailure("CAMPAIGN_BACKEND_ALREADY_RUNNING")
    try:
        started_at = now_utc()
        executable_sha256 = sha256_file(spec.executable)
    except OSError:
        raise CampaignFailure("CAMPAIGN_BACKEND_START_FAILED") from None
    try:
        process = process_factory(
            [str(spec.executable.resolve())],
            cwd=str(spec.cwd.resolve()),
            env=os.environ.copy(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
    except OSError as error:
        raise CampaignFailure("CAMPAIGN_BACKEND_START_FAILED") from error
    return BackendGeneration(generation, process, started_at, executable_sha256, True, spec.url, spec.executable.name)


def wait_backend_ready(generation: BackendGeneration, *, timeout: float = 15.0) -> BackendGeneration:
    if not generation.url:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if generation.process.poll() is not None:
            _stop_process(generation.process)
            raise CampaignFailure("CAMPAIGN_BACKEND_EXITED_EARLY")
        if endpoint_ready(generation.url):
            return BackendGeneration(
                generation.generation,
                generation.process,
                generation.started_at,
                generation.executable_sha256,
                generation.owned,
                generation.url,
                generation.executable_name,
                now_utc(),
            )
        time.sleep(0.1)
    _stop_process(generation.process)
    raise CampaignFailure("CAMPAIGN_BACKEND_HEALTH_TIMEOUT")


def start_backend(
    spec: BackendSpec,
    generation: int,
    *,
    process_factory=subprocess.Popen,
    timeout: float = 15.0,
) -> BackendGeneration:
    spawned = spawn_backend(spec, generation, process_factory=process_factory)
    return wait_backend_ready(spawned, timeout=timeout)


def stop_backend(generation: BackendGeneration) -> dict[str, bool]:
    if not generation.owned:
        raise CampaignFailure("CAMPAIGN_BACKEND_STOP_FAILED")
    try:
        return _stop_process(generation.process)
    except (OSError, subprocess.SubprocessError):
        raise CampaignFailure("CAMPAIGN_BACKEND_STOP_FAILED") from None


def _canonical_stats(report: dict[str, object]) -> dict[str, int]:
    stats = report.get("stats")
    if not isinstance(stats, dict):
        raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID")
    values: dict[str, int] = {}
    for key in ("expected", "unexpected", "skipped", "flaky"):
        value = stats.get(key)
        if not isinstance(value, int):
            raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID")
        values[key] = value
    retries = 0
    for suite in report.get("suites", []):
        if not isinstance(suite, dict):
            continue
        for spec in suite.get("specs", []):
            if not isinstance(spec, dict):
                continue
            for test in spec.get("tests", []):
                if not isinstance(test, dict):
                    continue
                for result in test.get("results", []):
                    if isinstance(result, dict):
                        retry = result.get("retry", 0)
                        if isinstance(retry, int):
                            retries = max(retries, retry)
    return {
        "total": sum(values.values()),
        "passed": values["expected"],
        "failed": values["unexpected"],
        "skipped": values["skipped"],
        "flaky": values["flaky"],
        "retries": retries,
    }


def archive_and_validate(root: Path, archive_dir: Path, completed: subprocess.CompletedProcess[object]) -> dict[str, object]:
    source_dir = root / ".quality" / "playwright"
    report = source_dir / REPORT_NAME
    status = source_dir / STATUS_NAME
    if not report.is_file() or not status.is_file():
        raise CampaignFailure("CAMPAIGN_EVIDENCE_MISSING")
    archive_dir.mkdir(parents=True, exist_ok=True)
    archived_report = archive_dir / REPORT_NAME
    archived_status = archive_dir / STATUS_NAME
    if archived_report.exists() or archived_status.exists():
        raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID")
    shutil.copyfile(report, archived_report)
    shutil.copyfile(status, archived_status)
    report_hash = sha256_file(report)
    if sha256_file(archived_report) != report_hash or sha256_file(archived_status) != sha256_file(status):
        raise CampaignFailure("CAMPAIGN_EVIDENCE_HASH_MISMATCH")
    try:
        report_json = json.loads(report.read_text(encoding="utf-8"))
        status_json = json.loads(status.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID") from None
    if not isinstance(report_json, dict) or not isinstance(status_json, dict):
        raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID")
    if status_json.get("report_sha256") != report_hash:
        raise CampaignFailure("CAMPAIGN_EVIDENCE_HASH_MISMATCH")
    status_exit = status_json.get("exit_code")
    outcome = status_json.get("outcome")
    if isinstance(status_exit, bool) or not isinstance(status_exit, int) or status_exit != completed.returncode:
        raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID")
    if (status_exit == 0 and outcome != "completed") or (status_exit != 0 and outcome != "playwright_failed"):
        raise CampaignFailure("CAMPAIGN_EVIDENCE_INVALID")
    stats = _canonical_stats(report_json)
    canonical_pass = status_exit == 0 and stats == {
        "total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0,
    }
    return {
        "evidenceValid": True,
        "canonicalPass": canonical_pass,
        "outcome": outcome,
        "exitCode": status_exit,
        "reportSha256": report_hash,
        **stats,
    }


def _backend_payload(generation: BackendGeneration, config: dict[str, object]) -> dict[str, object]:
    return {
        "generation": generation.generation,
        "pid": getattr(generation.process, "pid", None),
        "processSpawned": True,
        "ownedByCampaign": generation.owned,
        "backendReady": generation.ready_at is not None,
        "startedAt": generation.started_at,
        "executable": generation.executable_name,
        "executableSha256": generation.executable_sha256,
        "configAuthority": config.get("configAuthority", {}),
        **({"readyAt": generation.ready_at} if generation.ready_at else {}),
    }


def run_campaign(
    root: Path,
    spec: BackendSpec,
    frontend_url: str,
    output_dir: Path,
    *,
    runs: int = 5,
    round_id: str | None = None,
    runner=subprocess.run,
) -> dict[str, object]:
    if not 1 <= runs <= 5:
        raise CampaignFailure("CAMPAIGN_ENV_INVALID")
    config = validate_backend_spec(spec, spec.url)
    run_records: list[dict[str, object]] = []
    backend_start_attempts = 0
    backend_processes_spawned = 0
    backend_generations_ready = 0
    canonical_runs_started = 0
    canonical_runs_completed = 0
    passed_runs = 0
    failed_runs = 0
    stopped_early = False
    for index in range(1, runs + 1):
        run_started = time.perf_counter()
        startup_started = run_started
        canonical_ms = 0.0
        teardown_ms = 0.0
        run_dir = output_dir / f"run-{index:02d}"
        run_dir.mkdir(parents=True, exist_ok=False)
        generation: BackendGeneration | None = None
        record: dict[str, object] = {"index": index, "result": "FAIL"}
        try:
            backend_start_attempts += 1
            spawned = spawn_backend(spec, index, validated_config=config)
            backend_processes_spawned += 1
            generation = spawned
            write_json(run_dir / "backend-process.json", _backend_payload(spawned, config))
            generation = wait_backend_ready(generation)
            backend_generations_ready += 1
            record["backendStartupMs"] = round((time.perf_counter() - startup_started) * 1000, 3)
            write_json(run_dir / "backend-process.json", _backend_payload(generation, config))
            child_env = os.environ.copy()
            child_env["NANIKA_E2E_BASE_URL"] = frontend_url.rstrip("/")
            child_env["NANIKA_E2E_BACKEND_URL"] = spec.url.rstrip("/")
            canonical_runs_started += 1
            canonical_started = time.perf_counter()
            completed = runner(
                [sys.executable, "tools/quality/run_playwright.py"],
                cwd=root,
                env=child_env,
                check=False,
            )
            canonical_ms = round((time.perf_counter() - canonical_started) * 1000, 3)
            record["canonicalMs"] = canonical_ms
            canonical_runs_completed += 1
            canonical = archive_and_validate(root, run_dir, completed)
            record["canonical"] = canonical
            if canonical["canonicalPass"]:
                record["result"] = "PASS"
                passed_runs += 1
            else:
                record["failureCode"] = "CAMPAIGN_CANONICAL_FAILED"
                failed_runs += 1
        except CampaignFailure as error:
            record["failureCode"] = error.code
            failed_runs += 1
            stopped_early = index < runs
        finally:
            if generation is not None:
                teardown_started = time.perf_counter()
                try:
                    teardown = stop_backend(generation)
                    record["backendTeardown"] = teardown
                except CampaignFailure as error:
                    record["failureCode"] = error.code
                    if record.get("result") == "PASS":
                        passed_runs -= 1
                        failed_runs += 1
                        record["result"] = "FAIL"
                    stopped_early = index < runs
                process_payload = run_dir / "backend-process.json"
                if process_payload.is_file():
                    payload = json.loads(process_payload.read_text(encoding="utf-8"))
                    payload["stoppedAt"] = now_utc()
                    payload["teardownEscalated"] = bool(record.get("backendTeardown", {}).get("escalated", False))
                    write_json(process_payload, payload)
                teardown_ms = round((time.perf_counter() - teardown_started) * 1000, 3)
            record.setdefault("backendStartupMs", round((time.perf_counter() - startup_started) * 1000, 3))
            record.setdefault("canonicalMs", canonical_ms)
            record["backendTeardownMs"] = teardown_ms
            record["totalMs"] = round((time.perf_counter() - run_started) * 1000, 3)
        run_records.append(record)
        if record.get("result") != "PASS":
            stopped_early = index < runs
            break
    summary = {
        **({"round": round_id} if round_id is not None else {}),
        "result": "PASS" if passed_runs == runs else "FAIL",
        "plannedRuns": runs,
        "backendStartAttempts": backend_start_attempts,
        "backendProcessesSpawned": backend_processes_spawned,
        "backendGenerationsReady": backend_generations_ready,
        "canonicalRunsStarted": canonical_runs_started,
        "canonicalRunsCompleted": canonical_runs_completed,
        "passedRuns": passed_runs,
        "failedRuns": failed_runs,
        "retries": 0,
        "stoppedEarly": stopped_early,
        "totalMs": round(sum(float(record["totalMs"]) for record in run_records), 3),
        "runs": run_records,
    }
    write_json(output_dir / "campaign-summary.json", summary)
    return summary


def main(argv: list[str] | None = None) -> int:
    root = repository_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--output", type=Path, default=root / ".quality" / "playwright-campaign")
    args = parser.parse_args(argv)
    try:
        executable = Path(os.environ["NANIKA_E2E_BACKEND_EXE"])
        cwd = Path(os.environ["NANIKA_E2E_BACKEND_CWD"])
        backend_url = os.environ.get("NANIKA_E2E_BACKEND_URL", "http://127.0.0.1:18082").rstrip("/")
        frontend_url = os.environ.get("NANIKA_E2E_BASE_URL", "http://localhost:4200").rstrip("/")
        spec = BackendSpec(executable, cwd, backend_url)
        write_json(
            args.output / "campaign-plan.json",
            {
                "plannedRuns": args.runs,
                "testsPerRun": CANONICAL_TESTS,
                "retries": 0,
                "workers": 1,
                "fullyParallel": False,
                "stopOnFirstFailedInvocation": True,
                "freshBackendProcessPerInvocation": True,
                "singleRunAuthority": "tools/quality/run_playwright.py",
                "backendExecutable": executable.name,
                "backendUrl": backend_url,
            },
        )
        summary = run_campaign(root, spec, frontend_url, args.output, runs=args.runs)
    except (KeyError, CampaignFailure):
        return 1
    print(json.dumps({key: summary[key] for key in ("result", "plannedRuns", "canonicalRunsCompleted", "passedRuns", "failedRuns", "retries")}, sort_keys=True))
    return 0 if summary["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
