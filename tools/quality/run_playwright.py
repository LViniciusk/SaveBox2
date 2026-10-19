"""Run the canonical Playwright E2E gate and write current-run evidence."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen


REPORT_NAME = "results.json"
STATUS_NAME = "run-status.json"
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
FRONTEND_PORT_PATTERN = re.compile(r"\$\{\s*FRONTEND_PORT:-([0-9]+)\s*\}")


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_status(path: Path, *, outcome: str, exit_code: int, started_at: str, report_sha256: str | None, phase: str) -> None:
    payload = {
        "schema": 1,
        "outcome": outcome,
        "exit_code": exit_code,
        "report_sha256": report_sha256,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "phase": phase,
    }
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def require_healthy(url: str) -> None:
    with urlopen(url, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {url}")


def read_dotenv_value(path: Path, key: str) -> str | None:
    if not path.is_file():
        return None
    prefix = f"{key}="
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or not line.startswith(prefix):
            continue
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value
    return None


def valid_port(value: str | None) -> int | None:
    try:
        port = int(value) if value is not None else 0
    except ValueError:
        return None
    return port if 1 <= port <= 65535 else None


def deployment_frontend_port(root: Path) -> int | None:
    for value in (os.environ.get("FRONTEND_PORT"), read_dotenv_value(root / ".env", "FRONTEND_PORT")):
        port = valid_port(value)
        if port is not None:
            return port
    try:
        compose = (root / "docker-compose.yml").read_text(encoding="utf-8")
    except OSError:
        return None
    match = FRONTEND_PORT_PATTERN.search(compose)
    return valid_port(match.group(1)) if match else None


def ensure_local_e2e_frontend_is_not_deployment_frontend(root: Path, frontend_url: str) -> None:
    try:
        parsed = urlsplit(frontend_url)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        return
    if hostname not in LOCAL_HOSTS:
        return
    if port is None:
        port = {"http": 80, "https": 443}.get(parsed.scheme)
    deployment_port = deployment_frontend_port(root)
    if port is not None and deployment_port is not None and port == deployment_port:
        raise RuntimeError(
            "Canonical local E2E requires the Angular development frontend; "
            "the configured base URL matches the Docker deployment frontend port."
        )


def main(root: Path | None = None) -> int:
    root = (root or repository_root()).resolve()
    evidence_dir = root / ".quality" / "playwright"
    report_path = evidence_dir / REPORT_NAME
    status_path = evidence_dir / STATUS_NAME
    evidence_dir.mkdir(parents=True, exist_ok=True)
    report_path.unlink(missing_ok=True)
    status_path.unlink(missing_ok=True)
    started_at = datetime.now(timezone.utc).isoformat()

    try:
        backend_url = os.environ.get("NANIKA_E2E_BACKEND_URL", "http://localhost:8080").rstrip("/")
        frontend_url = os.environ.get("NANIKA_E2E_BASE_URL", "http://localhost:4200").rstrip("/")
        ensure_local_e2e_frontend_is_not_deployment_frontend(root, frontend_url)
        require_healthy(f"{backend_url}/health")
        require_healthy(f"{frontend_url}/")
    except Exception as error:
        write_status(status_path, outcome="preflight_failed", exit_code=1, started_at=started_at, report_sha256=None, phase="preflight")
        print(f"E2E preflight failed: {error}", file=sys.stderr)
        return 1

    env = os.environ.copy()
    env["PLAYWRIGHT_JSON_REPORT"] = "1"
    env["NANIKA_E2E_BASE_URL"] = frontend_url
    env["NANIKA_E2E_BACKEND_URL"] = backend_url
    env.pop("NANIKA_BIND_ADDRESS", None)
    npm = "npm.cmd" if os.name == "nt" else "npm"
    try:
        with tempfile.TemporaryDirectory(prefix="nanika-canonical-playwright-") as temporary:
            runtime_output = Path(temporary).resolve()
            recovery_journal = runtime_output / "recovery-continuation.journal.jsonl"
            if (
                not runtime_output.is_absolute()
                or not runtime_output.is_dir()
                or Path(temporary).is_symlink()
                or recovery_journal.exists()
                or recovery_journal.is_symlink()
            ):
                raise RuntimeError("CANONICAL_RECOVERY_EVIDENCE_AUTHORITY_INVALID")
            env["PLAYWRIGHT_OUTPUT_DIR"] = str(runtime_output)
            env["NANIKA_RECOVERY_EVIDENCE_PATH"] = str(recovery_journal)
            completed = subprocess.run(
                [npm, "run", "e2e:chromium"], cwd=root / "frontend", env=env, check=False, shell=False
            )
    except Exception as error:
        write_status(status_path, outcome="runner_error", exit_code=1, started_at=started_at, report_sha256=None, phase="playwright")
        print(f"E2E runner failed: {error}", file=sys.stderr)
        return 1

    report_hash = sha256_file(report_path) if report_path.is_file() else None
    if completed.returncode != 0:
        write_status(status_path, outcome="playwright_failed", exit_code=completed.returncode, started_at=started_at, report_sha256=report_hash, phase="playwright")
        return completed.returncode
    if report_hash is None:
        write_status(status_path, outcome="report_missing", exit_code=1, started_at=started_at, report_sha256=None, phase="report")
        print(f"Playwright did not generate {report_path}", file=sys.stderr)
        return 1

    write_status(status_path, outcome="completed", exit_code=0, started_at=started_at, report_sha256=report_hash, phase="report")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
