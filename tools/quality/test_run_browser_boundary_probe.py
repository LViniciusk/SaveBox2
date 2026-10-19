from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tools.quality import run_browser_boundary_probe as owner


class FakeSocket:
    def __init__(self, *, bind_error: OSError | None = None, port: int = 4200) -> None:
        self.bind_error = bind_error
        self.port = port
        self.closed = False
        self.bindings: list[tuple[str, int]] = []

    def bind(self, address: tuple[str, int]) -> None:
        self.bindings.append(address)
        if self.bind_error:
            raise self.bind_error

    def getsockname(self) -> tuple[str, int]:
        return ("127.0.0.1", self.port)

    def close(self) -> None:
        self.closed = True


class FakeProcess:
    def __init__(self, *, exit_code: int | None = None) -> None:
        self.exit_code = exit_code
        self.terminated = False
        self.killed = False
        self.wait_calls = 0

    def poll(self) -> int | None:
        return self.exit_code

    def terminate(self) -> None:
        self.terminated = True
        self.exit_code = 0

    def wait(self, *, timeout: float) -> None:
        self.wait_calls += 1

    def kill(self) -> None:
        self.killed = True
        self.exit_code = -9


def make_project(root: Path, *, ng_cli: bool = True) -> tuple[Path, Path]:
    executable = root / "savebox_server.exe"
    executable.write_bytes(b"backend")
    if ng_cli:
        cli = root / "frontend" / "node_modules" / "@angular" / "cli" / "bin" / "ng.js"
        cli.parent.mkdir(parents=True)
        cli.write_text("// test cli", encoding="utf-8")
    return executable, root / "real-probe"


def valid_browser_result() -> dict[str, object]:
    return {
        "round": owner.ROUND_ID,
        "result": "PASS_REAL_BROWSER_BOUNDARY",
        "secretsRecorded": False,
        "frontend": {"navigationPassed": True},
        "routing": {},
        "health": {},
        "login": {},
    }


def valid_m20_result() -> dict[str, object]:
    return {
        "round": owner.M20_ROUND_ID,
        "result": "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN",
        "secretsRecorded": False,
        "login": {
            **owner.M20_EMPTY_LOGIN,
            "pageReady": True,
            "loginActionTriggered": True,
            "requestCount": 1,
            "methodPost": True,
            "bodyShapeValid": True,
            "fixtureUsernameMatches": True,
            "fixturePasswordMatches": True,
            "originMatches": True,
            "responseCount": 1,
            "responseObserved": True,
            "responseStatus": 200,
            "backendAuthorityMatches": True,
            "httpSemanticPassed": True,
            "finalPath": "/drive/home",
        },
    }


class BrowserBoundaryProbeOwnerTests(unittest.TestCase):
    def test_m20_tcp_telemetry_distinguishes_independent_probe_from_http_transport(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            readiness = owner.FrontendReadinessObservation(True, True, False, True, None, 12, None)
            frontend = owner.FrontendGeneration(
                FakeProcess(), "http://127.0.0.1:4200", 4200, True, readiness=readiness
            )
            payload = owner._m20_write_owner_result(
                Path(directory) / "owner-result.json",
                result="PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN",
                failure_code=None,
                login=owner.M20_EMPTY_LOGIN,
                frontend_generation=frontend,
                frontend_ready=True,
                frontend_stopped=True,
                frontend_teardown_escalated=False,
                lease=object(),
                backend_generation=object(),
                backend_stopped=True,
                cors_reached=True,
                cors_status200=True,
                cors_origin_matches=True,
                browser_started=True,
                browser_completed=True,
                fixture_provision_reached=True,
                fixture_cleanup_completed=True,
                postgres_removed=True,
                workspace_removed=True,
                hashes_match=True,
            )
            self.assertTrue(payload["frontendTcpObserved"])
            self.assertFalse(payload["frontendIndependentTcpProbeObserved"])
            self.assertTrue(payload["frontendHttpObserved"])

    def test_m19_raw_cli_mode_still_uses_the_original_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "m19-output"
            with patch.object(owner, "repository_root", return_value=root), patch.object(owner, "run_probe") as run:
                self.assertEqual(owner.main(["--output", str(output)]), 0)
            run.assert_called_once_with(
                root,
                owner.os.environ.get("NANIKA_E2E_BASE_URL", owner.DEFAULT_FRONTEND_URL),
                owner.os.environ.get("NANIKA_E2E_BACKEND_URL", owner.DEFAULT_BACKEND_URL),
                Path(owner.os.environ.get("NANIKA_E2E_BACKEND_EXE", root / "backend" / "build" / "savebox_server.exe")),
                output,
            )

    def test_m20_command_isolated_from_canonical_and_does_not_override_retry_policy(self) -> None:
        command = owner._m20_playwright_command("node.exe", Path("cli.js"), discovery=False)
        self.assertEqual(command, ["node.exe", "cli.js", "test", "--config=playwright.login-boundary.config.ts"])
        self.assertNotIn("--retries", command)
        self.assertNotIn("playwright.config.ts", command[-1])
        self.assertEqual(owner._m20_discovery_count("Total: 1 test in 1 file"), 1)
        self.assertEqual(owner._m20_discovery_count("Total: 5 tests in 1 file"), 5)

    def test_m20_config_isolated_with_one_worker_zero_retries_and_safe_outputs(self) -> None:
        config = owner.repository_root() / "frontend" / "playwright.login-boundary.config.ts"
        source = config.read_text(encoding="utf-8")
        self.assertIn("testDir: './e2e-probe'", source)
        self.assertIn("workers: 1", source)
        self.assertIn("retries: 0", source)
        self.assertIn("timeout: 30_000", source)
        self.assertIn("reporter: [['list']]", source)
        self.assertIn("required('NANIKA_E2E_BASE_URL')", source)
        self.assertIn("required('NANIKA_E2E_BACKEND_URL')", source)
        self.assertNotIn("NANIKA_E2E_BASE_URL'] ??", source)
        self.assertNotIn("trace: 'on'", source)
        self.assertNotIn("video: 'on'", source)

    def test_safe_m20_result_accepts_allowlisted_header_presence_field(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "result.json"
            payload = valid_m20_result()
            payload["login"]["authorizationHeaderPresent"] = False
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(owner._safe_m20_result(path)["result"], "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN")

    def test_safe_m20_result_rejects_url_and_credential_value_leaks(self) -> None:
        for leaked in (
            "https://host.invalid",
            "Bearer abc",
            "Authorization: token",
            "Set-Cookie: jwt=secret",
            "JWT-secret",
            "password=secret",
            "username@example.test",
            "C:\\Users\\person",
            "/Users/person",
            "/home/person",
        ):
            with self.subTest(leaked=leaked), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "result.json"
                payload = valid_m20_result()
                payload["login"]["leak"] = leaked
                path.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(owner.ProbeFailure) as error:
                    owner._safe_m20_result(path)
                self.assertEqual(error.exception.code, "PROBE_EVIDENCE_INVALID")

    def test_safe_m20_result_rejects_round_and_result_mismatch(self) -> None:
        for change in ({"round": "wrong"}, {"result": "UNKNOWN"}, {"secretsRecorded": True}, {"login": None}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "result.json"
                payload = valid_m20_result()
                payload.update(change)
                path.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(owner.ProbeFailure) as error:
                    owner._safe_m20_result(path)
                self.assertEqual(error.exception.code, "PROBE_EVIDENCE_INVALID")

    def test_m20_playwright_exit_must_match_the_safe_result(self) -> None:
        passed = subprocess.CompletedProcess([], 0, "", "")
        failed = subprocess.CompletedProcess([], 1, "", "")
        self.assertEqual(
            owner._m20_process_outcome(passed, "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN", True),
            (None, True),
        )
        self.assertEqual(
            owner._m20_process_outcome(failed, "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN", True),
            ("BLOCKED_M20_EVIDENCE_INVALID", False),
        )
        self.assertEqual(
            owner._m20_process_outcome(passed, "LOGIN_HTTP_SEMANTIC_FAILURE", True),
            ("BLOCKED_M20_EVIDENCE_INVALID", False),
        )

    def test_fixture_cleanup_failure_overrides_a_pass(self) -> None:
        completed = subprocess.CompletedProcess([], 1, "E2E fixture cleanup failed (FIXTURE_CLEANUP_FAILED)", "")
        self.assertEqual(
            owner._m20_process_outcome(completed, "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN", True),
            ("BLOCKED_M20_FIXTURE_CLEANUP_FAILED", False),
        )

    def test_m20_probe_owns_one_real_login_and_exact_resource_teardown(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable = root / "savebox_server.exe"
            executable.write_bytes(b"backend")
            cli = root / "frontend" / "node_modules" / "@playwright" / "test" / "cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("// local cli", encoding="utf-8")
            angular_cli = root / "frontend" / "node_modules" / "@angular" / "cli" / "bin" / "ng.js"
            angular_cli.parent.mkdir(parents=True)
            angular_cli.write_text("// local angular cli", encoding="utf-8")
            fixture = root / "backend" / "build" / "nanika_e2e_fixture.exe"
            fixture.parent.mkdir(parents=True)
            fixture.write_bytes(b"fixture")
            output = root / ".quality" / "b90-r1m20-angular-login-boundary"
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:48123", 48123, False)
            workspace = SimpleNamespace(root=root / "workspace", cwd=root / "workspace" / "work", storage_root=root / "workspace" / "storage")
            lease = SimpleNamespace(
                postgres="owned-postgres",
                workspace=workspace,
                e2e_environment={
                    "NANIKA_E2E_FIXTURE_CWD": str(workspace.cwd),
                    "NANIKA_E2E_STORAGE_PATH": str(workspace.storage_root),
                    "NANIKA_E2E_STORAGE_ID": "a" * 64,
                },
            )
            backend = object()
            events: list[str] = []
            calls = 0

            def node_runner(argv, **kwargs):
                nonlocal calls
                calls += 1
                if "--list" in argv:
                    events.append("discovery")
                    return SimpleNamespace(returncode=0, stdout="Total: 1 test in 1 file", stderr="")
                events.append("playwright")
                self.assertEqual(kwargs["env"]["NANIKA_E2E_BASE_URL"], generation.url)
                self.assertEqual(kwargs["env"]["NANIKA_E2E_BACKEND_URL"], "http://127.0.0.1:18082")
                self.assertNotIn("username", kwargs["env"])
                self.assertNotIn("password", kwargs["env"])
                result_path = Path(kwargs["env"]["NANIKA_M20_RESULT_PATH"])
                result_path.write_text(json.dumps(valid_m20_result()), encoding="utf-8")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            hashes = {"files": {"probe": "unchanged"}, "trees": {}}
            with patch.object(owner, "_m20_baseline_ready", return_value=True), \
                 patch.object(owner, "_m20_source_hashes", return_value=hashes), \
                 patch.object(owner, "shutil") as shutil_module, \
                 patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", side_effect=lambda *_args, **_kwargs: events.append("frontend") or generation), \
                 patch.object(owner, "wait_frontend_ready", side_effect=lambda value: events.append("ready") or value), \
                 patch.object(owner.env_owner, "prepare_environment", side_effect=lambda *_args: events.append("environment") or lease), \
                 patch.object(owner.campaign, "start_backend", side_effect=lambda *_args: events.append("backend") or backend), \
                 patch.object(owner, "probe_backend_cors_authority", side_effect=lambda *_args: events.append("cors") or (True, True)), \
                 patch.object(owner.campaign, "stop_backend", side_effect=lambda *_args: events.append("stop-backend") or {}), \
                 patch.object(owner, "stop_frontend", side_effect=lambda *_args: events.append("stop-frontend") or False), \
                 patch.object(owner.env_owner, "remove_disposable_postgres", side_effect=lambda *_args: events.append("remove-postgres")), \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace", side_effect=lambda *_args: events.append("remove-workspace")):
                shutil_module.which.return_value = "node.exe"
                result = owner.run_angular_login_boundary_probe(
                    root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                    node_path="node.exe", node_runner=node_runner,
                )

            self.assertEqual(result["result"], "PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN")
            self.assertEqual(result["loginProbeInvocations"], 1)
            self.assertEqual(result["retries"], 0)
            self.assertEqual(calls, 2)  # isolated discovery plus exactly one actual probe
            self.assertEqual(
                events,
                ["discovery", "frontend", "ready", "environment", "backend", "cors", "playwright", "stop-backend", "stop-frontend", "remove-postgres", "remove-workspace"],
            )
            self.assertTrue(result["fixtureProvisionReached"])
            self.assertTrue(result["fixtureCleanupCompleted"])

    def test_tcp_probe_reports_success_and_always_closes_connection(self) -> None:
        class Connection:
            closed = False

            def close(self) -> None:
                self.closed = True

        connection = Connection()
        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
        self.assertTrue(owner.frontend_tcp_reachable(generation, connection_factory=lambda *_args, **_kwargs: connection))
        self.assertTrue(connection.closed)
        self.assertFalse(
            owner.frontend_tcp_reachable(
                generation,
                connection_factory=Mock(side_effect=ConnectionRefusedError()),
            )
        )

    def test_http_probe_accepts_success_and_redirect_and_closes_connection(self) -> None:
        class Response:
            def __init__(self, status: int) -> None:
                self.status = status

            def read(self, _limit: int) -> bytes:
                return b"ok"

        class Connection:
            def __init__(self, status: int) -> None:
                self.response = Response(status)
                self.closed = False
                self.request_args = None

            def request(self, *args, **kwargs) -> None:
                self.request_args = (args, kwargs)

            def getresponse(self) -> Response:
                return self.response

            def close(self) -> None:
                self.closed = True

        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
        for status in (200, 302):
            connection = Connection(status)
            self.assertTrue(owner.frontend_http_ready(generation, connection_factory=lambda *_a, **_k: connection))
            self.assertEqual(connection.request_args[0], ("GET", "/"))
            self.assertTrue(connection.closed)

    def test_http_probe_rejects_client_error_and_transport_failure(self) -> None:
        class Response:
            status = 404

            def read(self, _limit: int) -> bytes:
                return b"missing"

        class Connection:
            closed = False

            def request(self, *_args, **_kwargs) -> None:
                pass

            def getresponse(self) -> Response:
                return Response()

            def close(self) -> None:
                self.closed = True

        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
        connection = Connection()
        self.assertFalse(owner.frontend_http_ready(generation, connection_factory=lambda *_a, **_k: connection))
        self.assertTrue(connection.closed)
        self.assertFalse(
            owner.frontend_http_ready(
                generation,
                connection_factory=Mock(side_effect=TimeoutError()),
            )
        )

    def test_readiness_observes_tcp_then_http_with_elapsed_times(self) -> None:
        class Clock:
            value = 0.0

            def __call__(self) -> float:
                return self.value

            def sleep(self, duration: float) -> None:
                self.value += duration

        clock = Clock()
        process = FakeProcess()
        generation = owner.FrontendGeneration(process, "http://127.0.0.1:48123", 48123, False)
        observation = owner.observe_frontend_readiness(
            generation,
            timeout=10,
            clock=clock,
            sleeper=clock.sleep,
            tcp_probe=lambda _generation: clock.value >= 2,
            http_probe=lambda _generation: clock.value >= 5,
        )
        self.assertTrue(observation.ready)
        self.assertEqual(observation.first_tcp_ready_ms, 2000)
        self.assertGreaterEqual(observation.first_http_ready_ms, 5000)
        self.assertLessEqual(observation.first_http_ready_ms, 5100)
        self.assertTrue(process.poll() is None)

    def test_characterization_distinguishes_late_readiness_and_listener_failures(self) -> None:
        late = owner.FrontendReadinessObservation(True, True, True, True, 38_000, 41_000, None)
        timely = owner.FrontendReadinessObservation(True, True, True, True, 2_000, 5_000, None)
        no_listener = owner.FrontendReadinessObservation(False, True, False, False, None, None, "ANGULAR_STARTUP_UNKNOWN")
        tcp_only = owner.FrontendReadinessObservation(False, True, True, False, 2_000, None, "ANGULAR_STARTUP_STILL_BUILDING")
        exited = owner.FrontendReadinessObservation(False, False, False, False, None, None, "ANGULAR_BUILD_FAILED")
        self.assertEqual(owner.characterization_result(late), "PASS_AFTER_FORMAL_DEADLINE")
        self.assertEqual(owner.characterization_result(timely), "PASS_WITHIN_FORMAL_DEADLINE")
        self.assertEqual(owner.characterization_result(no_listener), "LISTENER_NEVER_OPENED")
        self.assertEqual(owner.characterization_result(tcp_only), "HTTP_NEVER_READY")
        self.assertEqual(owner.characterization_result(exited), "PROCESS_EXITED")

    def test_readiness_timeout_with_no_listener_is_distinct(self) -> None:
        class Clock:
            value = 0.0

            def __call__(self) -> float:
                return self.value

            def sleep(self, duration: float) -> None:
                self.value += duration

        clock = Clock()
        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
        observation = owner.observe_frontend_readiness(
            generation,
            timeout=0.2,
            clock=clock,
            sleeper=clock.sleep,
            tcp_probe=lambda _generation: False,
            http_probe=lambda _generation: False,
        )
        self.assertFalse(observation.ready)
        self.assertTrue(observation.process_alive_at_end)
        self.assertFalse(observation.tcp_ever_ready)
        self.assertEqual(owner.characterization_result(observation), "LISTENER_NEVER_OPENED")

    def test_readiness_tcp_without_http_is_distinct(self) -> None:
        class Clock:
            value = 0.0

            def __call__(self) -> float:
                return self.value

            def sleep(self, duration: float) -> None:
                self.value += duration

        clock = Clock()
        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
        observation = owner.observe_frontend_readiness(
            generation,
            timeout=0.2,
            clock=clock,
            sleeper=clock.sleep,
            tcp_probe=lambda _generation: True,
            http_probe=lambda _generation: False,
        )
        self.assertTrue(observation.tcp_ever_ready)
        self.assertFalse(observation.http_ever_ready)
        self.assertEqual(owner.characterization_result(observation), "HTTP_NEVER_READY")

    def test_readiness_process_exit_classification_is_safe(self) -> None:
        class ExitedProcess(FakeProcess):
            def poll(self) -> int | None:
                return 1

        log = tempfile.TemporaryFile(mode="w+b")
        log.write(b"Application bundle generation failed: private build output")
        log.seek(0)
        generation = owner.FrontendGeneration(
            ExitedProcess(), "http://127.0.0.1:48123", 48123, False, stderr_log=log
        )
        observation = owner.observe_frontend_readiness(
            generation,
            timeout=1,
            clock=lambda: 0,
            sleeper=lambda _duration: None,
            tcp_probe=lambda _generation: False,
            http_probe=lambda _generation: False,
        )
        self.assertEqual(observation.startup_classification, "ANGULAR_BUILD_FAILED")
        self.assertEqual(owner.characterization_result(observation), "PROCESS_EXITED")
        owner.close_frontend_logs(generation)

    def test_startup_classifier_returns_only_safe_allowlisted_categories(self) -> None:
        cases = (
            ("listen EACCES permission denied ::1:4200", "", "ANGULAR_IPV6_BIND_PERMISSION_DENIED"),
            ("", "EADDRINUSE", "ANGULAR_PORT_IN_USE"),
            ("Application bundle generation failed", "", "ANGULAR_BUILD_FAILED"),
            ("Building...", "", "ANGULAR_STARTUP_STILL_BUILDING"),
            (r"C:\Users\SecretUser PASSWORD=SUPER_SECRET", "", "ANGULAR_STARTUP_UNKNOWN"),
        )
        for stdout, stderr, expected in cases:
            with self.subTest(expected=expected):
                actual = owner.classify_frontend_startup_output(stdout, stderr)
                self.assertEqual(actual, expected)
                self.assertIn(actual, owner.STARTUP_CLASSIFICATIONS)
                self.assertNotIn("SecretUser", actual)
                self.assertNotIn("SUPER_SECRET", actual)

    def test_log_tail_is_bounded_and_generation_logs_close_idempotently(self) -> None:
        first = tempfile.TemporaryFile(mode="w+b")
        second = tempfile.TemporaryFile(mode="w+b")
        first.write(b"x" * (owner.MAX_STARTUP_LOG_TAIL + 100))
        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False, first, second)
        self.assertEqual(len(owner.read_log_tail(first)), owner.MAX_STARTUP_LOG_TAIL)
        owner.close_frontend_logs(generation)
        owner.close_frontend_logs(generation)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)

    def test_success_readiness_does_not_read_or_classify_logs(self) -> None:
        generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
        with patch.object(owner, "observe_frontend_readiness", return_value=owner.FrontendReadinessObservation(True, True, True, True, 1, 2, None)), \
             patch.object(owner, "_frontend_startup_classification", side_effect=AssertionError):
            self.assertIs(owner.wait_frontend_ready(generation), generation)

    def test_frontend_spawn_uses_owned_logs_not_pipes_and_failure_closes_them(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = root / "frontend" / "ng.js"
            cli.parent.mkdir()
            cli.write_text("// test cli", encoding="utf-8")
            calls = []

            def process_factory(_argv, **kwargs):
                calls.append(kwargs)
                return FakeProcess()

            generation = owner.spawn_frontend(
                root, "node.exe", cli, owner.PortReservation(FakeSocket(), 4200, True), process_factory=process_factory
            )
            self.assertIsNot(calls[0]["stdout"], subprocess.PIPE)
            self.assertIsNot(calls[0]["stderr"], subprocess.PIPE)
            self.assertIsNot(calls[0]["stdout"], subprocess.DEVNULL)
            self.assertIsNot(calls[0]["stderr"], subprocess.DEVNULL)
            owner.stop_frontend(generation)
            self.assertTrue(generation.stdout_log.closed)
            self.assertTrue(generation.stderr_log.closed)

            with self.assertRaises(owner.ProbeFailure):
                owner.spawn_frontend(
                    root,
                    "node.exe",
                    cli,
                    owner.PortReservation(FakeSocket(), 4200, True),
                    process_factory=Mock(side_effect=OSError("private detail")),
                )

    def test_spawn_failure_closes_both_temporary_log_handles(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = root / "ng.js"
            cli.write_text("// test cli", encoding="utf-8")
            opened = []
            original_temporary_file = tempfile.TemporaryFile

            def temporary_file(*args, **kwargs):
                stream = original_temporary_file(*args, **kwargs)
                opened.append(stream)
                return stream

            with patch.object(owner.tempfile, "TemporaryFile", side_effect=temporary_file):
                with self.assertRaises(owner.ProbeFailure):
                    owner.spawn_frontend(
                        root,
                        "node.exe",
                        cli,
                        owner.PortReservation(FakeSocket(), 4200, True),
                        process_factory=Mock(side_effect=OSError("private detail")),
                    )
            self.assertEqual(len(opened), 2)
            self.assertTrue(all(stream.closed for stream in opened))

    def test_characterization_owns_one_frontend_and_skips_backend_environment_and_browser(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = root / "frontend" / "node_modules" / "@angular" / "cli" / "bin" / "ng.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("// test cli", encoding="utf-8")
            output = root / "characterization" / "result.json"
            generation = owner.FrontendGeneration(FakeProcess(), "http://127.0.0.1:48123", 48123, False)
            observation = owner.FrontendReadinessObservation(True, True, True, True, 100, 200, None)
            with patch.object(owner.shutil, "which", return_value="node.exe"), \
                 patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(port=48123), 48123, False)) as reserve, \
                 patch.object(owner, "spawn_frontend", return_value=generation) as spawn, \
                 patch.object(owner, "observe_frontend_readiness", return_value=observation) as observe, \
                 patch.object(owner, "stop_frontend", return_value=False) as stop, \
                 patch.object(owner.env_owner, "prepare_environment", side_effect=AssertionError), \
                 patch.object(owner.campaign, "start_backend", side_effect=AssertionError):
                payload = owner.run_frontend_characterization(root, output)
            reserve.assert_called_once()
            spawn.assert_called_once()
            observe.assert_called_once()
            stop.assert_called_once_with(generation)
            self.assertEqual(payload["result"], "PASS_WITHIN_FORMAL_DEADLINE")
            self.assertEqual(payload["retries"], 0)
            self.assertFalse(payload["rawLogsRecorded"])
            self.assertFalse(payload["absolutePathsRecorded"])
            serialized = output.read_text(encoding="utf-8")
            self.assertNotIn(str(root), serialized)
            self.assertNotIn("48123", serialized)

    def test_server_cors_control_uses_health_and_exact_owned_origin(self) -> None:
        class FakeResponse:
            status = 200

            def getheader(self, name: str) -> str | None:
                return "http://127.0.0.1:48123" if name == "Access-Control-Allow-Origin" else None

            def read(self, _limit: int) -> bytes:
                return b"ok"

        class FakeConnection:
            def __init__(self) -> None:
                self.request_args = None
                self.closed = False

            def request(self, *args, **kwargs) -> None:
                self.request_args = (args, kwargs)

            def getresponse(self) -> FakeResponse:
                return FakeResponse()

            def close(self) -> None:
                self.closed = True

        connection = FakeConnection()
        status_ok, origin_ok = owner.probe_backend_cors_authority(
            "http://127.0.0.1:18082",
            "http://127.0.0.1:48123",
            connection_factory=lambda *_args, **_kwargs: connection,
        )

        self.assertTrue(status_ok)
        self.assertTrue(origin_ok)
        self.assertEqual(connection.request_args[0], ("GET", "/health"))
        self.assertEqual(connection.request_args[1]["headers"]["Origin"], "http://127.0.0.1:48123")
        self.assertTrue(connection.closed)

    def test_preferred_and_dynamic_port_reservations_are_loopback_only(self) -> None:
        preferred = FakeSocket(port=4200)
        result = owner.reserve_frontend_port(socket_factory=lambda *_: preferred)
        self.assertEqual(result.port, 4200)
        self.assertTrue(result.preferred)
        self.assertEqual(preferred.bindings, [("127.0.0.1", 4200)])

        occupied = FakeSocket(bind_error=OSError("busy"))
        dynamic = FakeSocket(port=48123)
        sockets = iter((occupied, dynamic))
        result = owner.reserve_frontend_port(socket_factory=lambda *_: next(sockets))
        self.assertEqual(result.port, 48123)
        self.assertFalse(result.preferred)
        self.assertTrue(occupied.closed)
        self.assertEqual(dynamic.bindings, [("127.0.0.1", 0)])

    def test_frontend_spawn_uses_direct_angular_argv_and_no_shell(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ng_cli = root / "frontend" / "ng.js"
            ng_cli.parent.mkdir()
            ng_cli.write_text("// test cli", encoding="utf-8")
            sock = FakeSocket()
            process = FakeProcess()
            calls = []

            def process_factory(argv, **kwargs):
                calls.append((argv, kwargs))
                return process

            generation = owner.spawn_frontend(
                root,
                "node.exe",
                ng_cli,
                owner.PortReservation(sock, 4200, True),
                process_factory=process_factory,
            )
            self.assertEqual(calls[0][0], ["node.exe", str(ng_cli), "serve", "--host", "127.0.0.1", "--port", "4200"])
            self.assertFalse(calls[0][1]["shell"])
            self.assertEqual(calls[0][1]["cwd"], root / "frontend")
            self.assertTrue(sock.closed)
            self.assertTrue(generation.used_preferred_port)

    def test_missing_node_stops_before_frontend_or_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            with patch.object(owner, "shutil") as shutil_module, \
                 patch.object(owner, "reserve_frontend_port") as reserve, \
                 patch.object(owner.env_owner, "prepare_environment") as prepare:
                shutil_module.which.return_value = None
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output)
            reserve.assert_not_called()
            prepare.assert_not_called()
            result = json.loads((output / "owner-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["failureCode"], "PROBE_NODE_UNAVAILABLE")

    def test_missing_angular_cli_stops_before_frontend_or_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root, ng_cli=False)
            with patch.object(owner, "reserve_frontend_port") as reserve, \
                 patch.object(owner.env_owner, "prepare_environment") as prepare:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output, node_path="node.exe")
            reserve.assert_not_called()
            prepare.assert_not_called()
            result = json.loads((output / "owner-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["failureCode"], "PROBE_FRONTEND_TOOLING_UNAVAILABLE")

    def test_frontend_exit_early_does_not_allocate_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess(exit_code=1)
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True)
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment") as prepare:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output, node_path="node.exe")
            prepare.assert_not_called()
            self.assertEqual(json.loads((output / "owner-result.json").read_text(encoding="utf-8"))["result"], "BLOCKED_OWNED_FRONTEND_START")

    def test_frontend_readiness_timeout_stops_exact_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True)
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", side_effect=owner.ProbeFailure("PROBE_FRONTEND_HEALTH_TIMEOUT")), \
                 patch.object(owner.env_owner, "prepare_environment") as prepare:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output, node_path="node.exe")
            prepare.assert_not_called()
            self.assertTrue(process.terminated)

    def test_environment_failure_stops_frontend_without_backend_or_browser(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True)
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", side_effect=owner.env_owner.EnvironmentFailure("ENV_FAIL")), \
                 patch.object(owner.campaign, "start_backend") as start:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output, node_path="node.exe")
            start.assert_not_called()
            self.assertTrue(process.terminated)

    def test_backend_failure_cleans_frontend_postgres_and_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", return_value=lease), \
                 patch.object(owner.campaign, "start_backend", side_effect=owner.campaign.CampaignFailure("START_FAILED")), \
                 patch.object(owner.env_owner, "remove_disposable_postgres") as remove_db, \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace") as cleanup:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output, node_path="node.exe")
            remove_db.assert_called_once_with(lease.postgres)
            cleanup.assert_called_once_with(lease.workspace)
            self.assertTrue(process.terminated)

    def test_cors_control_mismatch_blocks_browser_and_cleans_resources(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:48123", 48123, False)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            backend = object()
            cors_control = Mock(return_value=(True, False))
            browser = Mock()
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", return_value=lease), \
                 patch.object(owner.campaign, "start_backend", return_value=backend), \
                 patch.object(owner.campaign, "stop_backend") as stop_backend, \
                 patch.object(owner.env_owner, "remove_disposable_postgres") as remove_db, \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace") as cleanup:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(
                        root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                        node_path="node.exe", cors_control=cors_control, node_runner=browser,
                    )

            result = json.loads((output / "owner-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["result"], "BLOCKED_CORS_AUTHORITY_NOT_EFFECTIVE")
            self.assertEqual(result["failureCode"], "PROBE_BACKEND_CORS_AUTHORITY_MISMATCH")
            self.assertTrue(result["backendCorsControlReached"])
            self.assertTrue(result["backendCorsControlStatus200"])
            self.assertFalse(result["backendCorsControlAllowOriginMatches"])
            cors_control.assert_called_once()
            browser.assert_not_called()
            stop_backend.assert_called_once_with(backend)
            remove_db.assert_called_once_with(lease.postgres)
            cleanup.assert_called_once_with(lease.workspace)

    def test_cors_control_http_failure_blocks_browser(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:48123", 48123, False)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            backend = object()
            cors_control = Mock(return_value=(False, False))
            browser = Mock()
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", return_value=lease), \
                 patch.object(owner.campaign, "start_backend", return_value=backend), \
                 patch.object(owner.campaign, "stop_backend"), \
                 patch.object(owner.env_owner, "remove_disposable_postgres"), \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace"):
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(
                        root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                        node_path="node.exe", cors_control=cors_control, node_runner=browser,
                    )

            result = json.loads((output / "owner-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["failureCode"], "PROBE_BACKEND_CORS_CONTROL_HTTP_FAILED")
            self.assertTrue(result["backendCorsControlReached"])
            self.assertFalse(result["backendCorsControlStatus200"])
            browser.assert_not_called()
            cors_control.assert_called_once()

    def test_cors_control_connection_failure_is_safe_and_does_not_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:48123", 48123, False)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            backend = object()
            cors_control = Mock(side_effect=OSError("hidden detail"))
            browser = Mock()
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", return_value=lease), \
                 patch.object(owner.campaign, "start_backend", return_value=backend), \
                 patch.object(owner.campaign, "stop_backend"), \
                 patch.object(owner.env_owner, "remove_disposable_postgres"), \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace"):
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(
                        root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                        node_path="node.exe", cors_control=cors_control, node_runner=browser,
                    )

            result = json.loads((output / "owner-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["failureCode"], "PROBE_BACKEND_CORS_CONTROL_HTTP_FAILED")
            self.assertEqual(result["retries"], 0)
            cors_control.assert_called_once()
            browser.assert_not_called()

    def test_legacy_localhost_origin_is_not_discriminating(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://localhost:4200", 4200, True)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            backend = object()
            cors_control = Mock(return_value=(True, True))
            browser = Mock()
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", return_value=lease), \
                 patch.object(owner.campaign, "start_backend", return_value=backend), \
                 patch.object(owner.campaign, "stop_backend"), \
                 patch.object(owner.env_owner, "remove_disposable_postgres"), \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace"):
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(
                        root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                        node_path="node.exe", cors_control=cors_control, node_runner=browser,
                    )

            result = json.loads((output / "owner-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["failureCode"], "PROBE_CORS_CONTROL_NOT_DISCRIMINATING")
            cors_control.assert_not_called()
            browser.assert_not_called()

    def test_browser_failure_cleans_every_owned_resource_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            backend = object()
            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", return_value=generation), \
                 patch.object(owner, "wait_frontend_ready", return_value=generation), \
                 patch.object(owner.env_owner, "prepare_environment", return_value=lease), \
                 patch.object(owner.campaign, "start_backend", return_value=backend), \
                 patch.object(owner.campaign, "stop_backend") as stop_backend, \
                 patch.object(owner.env_owner, "remove_disposable_postgres") as remove_db, \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace") as cleanup:
                with self.assertRaises(owner.ProbeFailure):
                    owner.run_probe(
                        root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                        node_path="node.exe",
                        cors_control=lambda *_args: (True, True),
                        node_runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=1),
                    )
            stop_backend.assert_called_once_with(backend)
            remove_db.assert_called_once_with(lease.postgres)
            cleanup.assert_called_once_with(lease.workspace)
            self.assertTrue(process.terminated)

    def test_success_has_one_generation_and_propagates_owned_authority_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            executable, output = make_project(root)
            process = FakeProcess()
            generation = owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True)
            lease = SimpleNamespace(postgres=object(), workspace=SimpleNamespace(cwd=root / "cwd"))
            backend = object()
            events: list[str] = []

            def prepare(*args):
                events.append("prepare")
                self.assertEqual(args[1], "http://127.0.0.1:4200")
                return lease

            def start(*_args):
                events.append("backend")
                return backend

            def cors_control(*_args):
                events.append("cors-control")
                return True, True

            def node_runner(argv, **kwargs):
                events.append("browser")
                self.assertEqual(kwargs["env"]["NANIKA_E2E_BASE_URL"], "http://127.0.0.1:4200")
                self.assertEqual(kwargs["env"]["NANIKA_E2E_BACKEND_URL"], "http://127.0.0.1:18082")
                self.assertNotIn("CORS_ALLOWED_ORIGINS", kwargs["env"])
                self.assertNotIn("CORS_ORIGIN", kwargs["env"])
                path = Path(argv[argv.index("--output") + 1])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(valid_browser_result()), encoding="utf-8")
                return SimpleNamespace(returncode=0)

            with patch.object(owner, "reserve_frontend_port", return_value=owner.PortReservation(FakeSocket(), 4200, True)), \
                 patch.object(owner, "spawn_frontend", side_effect=lambda *args, **kwargs: events.append("frontend") or generation), \
                 patch.object(owner, "wait_frontend_ready", side_effect=lambda value: events.append("ready") or value), \
                 patch.object(owner.env_owner, "prepare_environment", side_effect=prepare), \
                 patch.object(owner.campaign, "start_backend", side_effect=start), \
                 patch.object(owner.campaign, "stop_backend", side_effect=lambda value: events.append("stop-backend")), \
                 patch.object(owner, "stop_frontend", side_effect=lambda value: events.append("stop-frontend") or False), \
                 patch.object(owner.env_owner, "remove_disposable_postgres", side_effect=lambda value: events.append("remove-db")), \
                 patch.object(owner.env_owner, "cleanup_runtime_workspace", side_effect=lambda value: events.append("cleanup")):
                result = owner.run_probe(
                    root, "http://localhost:4200", "http://127.0.0.1:18082", executable, output,
                    node_path="node.exe", node_runner=node_runner, cors_control=cors_control,
                )

            self.assertEqual(result["result"], "PASS")
            self.assertTrue(result["frontendUsedPreferredPort"])
            self.assertEqual(events, ["frontend", "ready", "prepare", "backend", "cors-control", "browser", "stop-backend", "stop-frontend", "remove-db", "cleanup"])
            self.assertEqual(result["retries"], 0)

    def test_frontend_teardown_normal_does_not_kill(self) -> None:
        process = FakeProcess()
        escalated = owner.stop_frontend(owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True))
        self.assertFalse(escalated)
        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)

    def test_frontend_teardown_escalates_once_when_wait_times_out(self) -> None:
        process = FakeProcess()
        process.wait = Mock(side_effect=[subprocess.TimeoutExpired("node", 5), None])
        escalated = owner.stop_frontend(owner.FrontendGeneration(process, "http://127.0.0.1:4200", 4200, True))
        self.assertTrue(escalated)
        self.assertTrue(process.killed)
        self.assertEqual(process.wait.call_count, 2)

    def test_safe_result_scanner_rejects_urls_and_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "browser-result.json"
            payload = valid_browser_result()
            payload["routing"] = {"leak": "http://localhost:4200"}
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(owner.ProbeFailure) as error:
                owner._safe_browser_result(path)
            self.assertEqual(error.exception.code, "PROBE_EVIDENCE_INVALID")


if __name__ == "__main__":
    unittest.main()
