"""Shared, loopback-only lifecycle for an owned Angular development server."""

from __future__ import annotations

import http.client
import os
import shutil
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlsplit


DEFAULT_FRONTEND_PORT = 4200
FORMAL_FRONTEND_READINESS_TIMEOUT = 30.0
FRONTEND_READINESS_POLL_INTERVAL = 0.1
MAX_STARTUP_LOG_TAIL = 16 * 1024
STARTUP_CLASSIFICATIONS = frozenset(
    {
        "ANGULAR_IPV6_BIND_PERMISSION_DENIED",
        "ANGULAR_PORT_IN_USE",
        "ANGULAR_BUILD_FAILED",
        "ANGULAR_STARTUP_STILL_BUILDING",
        "ANGULAR_STARTUP_UNKNOWN",
    }
)


class FrontendOwnershipFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass
class PortReservation:
    socket: socket.socket
    port: int
    preferred: bool


@dataclass
class FrontendReadinessObservation:
    ready: bool
    process_alive_at_end: bool
    tcp_ever_ready: bool
    http_ever_ready: bool
    first_tcp_ready_ms: int | None
    first_http_ready_ms: int | None
    startup_classification: str | None


@dataclass
class FrontendGeneration:
    process: subprocess.Popen
    url: str
    port: int
    used_preferred_port: bool
    stdout_log: BinaryIO | None = None
    stderr_log: BinaryIO | None = None
    readiness: FrontendReadinessObservation | None = None


def preferred_frontend_port(raw: str) -> int:
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError:
        port = None
        parsed = urlsplit("")
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or "?" in raw
        or "#" in raw
    ):
        raise FrontendOwnershipFailure("FRONTEND_PREFERENCE_INVALID")
    return port


def resolve_frontend_tooling(
    root: Path,
    node_path: str | None = None,
    *,
    which=shutil.which,
) -> tuple[str, Path]:
    node = node_path or which("node")
    cli = root / "frontend" / "node_modules" / "@angular" / "cli" / "bin" / "ng.js"
    if not node:
        raise FrontendOwnershipFailure("FRONTEND_NODE_UNAVAILABLE")
    if not cli.is_file() or cli.is_symlink():
        raise FrontendOwnershipFailure("FRONTEND_TOOLING_UNAVAILABLE")
    return node, cli


def reserve_frontend_port(
    preferred_port: int = DEFAULT_FRONTEND_PORT,
    *,
    socket_factory=socket.socket,
) -> PortReservation:
    if not 1 <= preferred_port <= 65535:
        raise FrontendOwnershipFailure("FRONTEND_PORT_ALLOCATION_FAILED")
    preferred_socket = socket_factory(socket.AF_INET, socket.SOCK_STREAM)
    try:
        preferred_socket.bind(("127.0.0.1", preferred_port))
        return PortReservation(preferred_socket, preferred_port, True)
    except OSError:
        preferred_socket.close()

    dynamic_socket = socket_factory(socket.AF_INET, socket.SOCK_STREAM)
    try:
        dynamic_socket.bind(("127.0.0.1", 0))
        port = dynamic_socket.getsockname()[1]
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise OSError("invalid dynamic port")
        return PortReservation(dynamic_socket, port, False)
    except OSError as error:
        dynamic_socket.close()
        raise FrontendOwnershipFailure("FRONTEND_PORT_ALLOCATION_FAILED") from error


def spawn_frontend(
    root: Path,
    node: str,
    ng_cli: Path,
    reservation: PortReservation,
    *,
    process_factory=subprocess.Popen,
) -> FrontendGeneration:
    port = reservation.port
    preferred = reservation.preferred
    reservation.socket.close()
    stdout_log = tempfile.TemporaryFile(mode="w+b")
    try:
        stderr_log = tempfile.TemporaryFile(mode="w+b")
    except BaseException:
        stdout_log.close()
        raise
    try:
        process = process_factory(
            [node, str(ng_cli), "serve", "--host", "127.0.0.1", "--port", str(port)],
            cwd=root / "frontend",
            env=os.environ.copy(),
            stdout=stdout_log,
            stderr=stderr_log,
            shell=False,
        )
    except OSError as error:
        stdout_log.close()
        stderr_log.close()
        raise FrontendOwnershipFailure("FRONTEND_START_FAILED") from error
    except BaseException:
        stdout_log.close()
        stderr_log.close()
        raise
    return FrontendGeneration(process, f"http://127.0.0.1:{port}", port, preferred, stdout_log, stderr_log)


def frontend_tcp_reachable(
    generation: FrontendGeneration,
    *,
    connection_factory=socket.create_connection,
) -> bool:
    try:
        connection = connection_factory(("127.0.0.1", generation.port), timeout=0.25)
    except OSError:
        return False
    try:
        return True
    finally:
        connection.close()


def frontend_http_ready(
    generation: FrontendGeneration,
    *,
    connection_factory=http.client.HTTPConnection,
) -> bool:
    connection = None
    try:
        connection = connection_factory("127.0.0.1", generation.port, timeout=0.5)
        connection.request("GET", "/")
        response = connection.getresponse()
        response.read(16 * 1024)
        return 200 <= response.status < 400
    except (OSError, http.client.HTTPException, TimeoutError):
        return False
    finally:
        if connection is not None:
            connection.close()


def read_log_tail(stream: BinaryIO | None, limit: int = MAX_STARTUP_LOG_TAIL) -> bytes:
    if stream is None or getattr(stream, "closed", False):
        return b""
    limit = min(MAX_STARTUP_LOG_TAIL, max(0, limit))
    stream.flush()
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    stream.seek(max(0, size - limit))
    return stream.read(limit)


def classify_frontend_startup_output(stdout_tail: str, stderr_tail: str) -> str:
    output = f"{stdout_tail}\n{stderr_tail}".lower()
    if "eacces" in output and "::1" in output:
        return "ANGULAR_IPV6_BIND_PERMISSION_DENIED"
    if "eaddrinuse" in output:
        return "ANGULAR_PORT_IN_USE"
    if "application bundle generation failed" in output or "build failed" in output:
        return "ANGULAR_BUILD_FAILED"
    if "building..." in output or "building application" in output:
        return "ANGULAR_STARTUP_STILL_BUILDING"
    return "ANGULAR_STARTUP_UNKNOWN"


def _frontend_startup_classification(generation: FrontendGeneration) -> str:
    stdout_tail = read_log_tail(generation.stdout_log).decode("utf-8", errors="replace")
    stderr_tail = read_log_tail(generation.stderr_log).decode("utf-8", errors="replace")
    classification = classify_frontend_startup_output(stdout_tail, stderr_tail)
    return classification if classification in STARTUP_CLASSIFICATIONS else "ANGULAR_STARTUP_UNKNOWN"


def observe_frontend_readiness(
    generation: FrontendGeneration,
    *,
    timeout: float,
    clock=None,
    sleeper=None,
    tcp_probe=None,
    http_probe=None,
) -> FrontendReadinessObservation:
    clock = clock or time.monotonic
    sleeper = sleeper or time.sleep
    tcp_probe = tcp_probe or frontend_tcp_reachable
    http_probe = http_probe or frontend_http_ready
    started_at = clock()
    deadline = started_at + timeout
    first_tcp_ready_ms = None
    first_http_ready_ms = None

    while True:
        if generation.process.poll() is not None:
            observation = FrontendReadinessObservation(
                False,
                False,
                first_tcp_ready_ms is not None,
                first_http_ready_ms is not None,
                first_tcp_ready_ms,
                first_http_ready_ms,
                _frontend_startup_classification(generation),
            )
            generation.readiness = observation
            return observation

        elapsed_ms = round((clock() - started_at) * 1000)
        if first_tcp_ready_ms is None and tcp_probe(generation):
            first_tcp_ready_ms = elapsed_ms
        if first_http_ready_ms is None and http_probe(generation):
            first_http_ready_ms = elapsed_ms
            observation = FrontendReadinessObservation(
                True,
                generation.process.poll() is None,
                first_tcp_ready_ms is not None,
                True,
                first_tcp_ready_ms,
                first_http_ready_ms,
                None,
            )
            generation.readiness = observation
            return observation

        now = clock()
        if now >= deadline:
            observation = FrontendReadinessObservation(
                False,
                generation.process.poll() is None,
                first_tcp_ready_ms is not None,
                False,
                first_tcp_ready_ms,
                None,
                _frontend_startup_classification(generation),
            )
            generation.readiness = observation
            return observation
        sleeper(min(FRONTEND_READINESS_POLL_INTERVAL, max(0.0, deadline - now)))


def wait_frontend_ready(
    generation: FrontendGeneration,
    *,
    timeout: float = FORMAL_FRONTEND_READINESS_TIMEOUT,
    clock=None,
    sleeper=None,
    readiness_observer=None,
) -> FrontendGeneration:
    observe = readiness_observer or observe_frontend_readiness
    observation = observe(generation, timeout=timeout, clock=clock, sleeper=sleeper)
    if observation.ready:
        return generation
    if not observation.process_alive_at_end:
        code = "FRONTEND_EXITED_EARLY"
    elif not observation.tcp_ever_ready:
        code = "FRONTEND_LISTENER_TIMEOUT"
    else:
        code = "FRONTEND_HTTP_TIMEOUT"
    raise FrontendOwnershipFailure(code)


def close_frontend_logs(generation: FrontendGeneration) -> None:
    for stream in (generation.stdout_log, generation.stderr_log):
        if stream is not None and not getattr(stream, "closed", False):
            stream.close()


def stop_frontend(generation: FrontendGeneration) -> bool:
    process = generation.process
    try:
        if process.poll() is not None:
            return False
        process.terminate()
        try:
            process.wait(timeout=5)
            return False
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            return True
    except (OSError, subprocess.SubprocessError) as error:
        raise FrontendOwnershipFailure("FRONTEND_TEARDOWN_FAILED") from error
    finally:
        close_frontend_logs(generation)
