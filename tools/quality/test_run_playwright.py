"""Unit tests for the canonical Playwright environment guard."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).parent))
import run_playwright  # noqa: E402


class RunPlaywrightTests(unittest.TestCase):
    def test_canonical_runner_owns_recovery_evidence_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "frontend").mkdir()
            captured: dict[str, object] = {}

            def child(command, **kwargs):
                captured.update(kwargs["env"])
                output = kwargs["env"].get("PLAYWRIGHT_OUTPUT_DIR")
                journal = kwargs["env"].get("NANIKA_RECOVERY_EVIDENCE_PATH")
                captured["outputExisted"] = bool(output and Path(output).is_dir())
                captured["journalExisted"] = bool(journal and Path(journal).exists())
                (root / ".quality" / "playwright" / "results.json").write_text("{}", encoding="utf-8")
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                run_playwright, "require_healthy"
            ), mock.patch.object(run_playwright.subprocess, "run", side_effect=child) as run:
                self.assertEqual(run_playwright.main(root), 0)
            run.assert_called_once()
            self.assertIn("PLAYWRIGHT_OUTPUT_DIR", captured)
            self.assertIn("NANIKA_RECOVERY_EVIDENCE_PATH", captured)
            output = Path(captured["PLAYWRIGHT_OUTPUT_DIR"])
            journal = Path(captured["NANIKA_RECOVERY_EVIDENCE_PATH"])
            self.assertTrue(output.is_absolute())
            self.assertTrue(journal.is_absolute())
            self.assertEqual(journal.parent, output)
            self.assertEqual(journal.name, "recovery-continuation.journal.jsonl")
            self.assertTrue(captured["outputExisted"])
            self.assertFalse(captured["journalExisted"])
            self.assertFalse(output.exists())

    def test_independent_invocations_replace_external_authorities_and_clean_both_roots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "frontend").mkdir()
            external = root / "caller-owned"
            external.mkdir()
            sentinel = external / "journal.jsonl"
            sentinel.write_text("preserve", encoding="utf-8")
            paths: list[tuple[Path, Path]] = []

            def child(command, **kwargs):
                env = kwargs["env"]
                output = Path(env["PLAYWRIGHT_OUTPUT_DIR"])
                journal = Path(env["NANIKA_RECOVERY_EVIDENCE_PATH"])
                self.assertTrue(output.is_dir())
                self.assertFalse(output.is_symlink())
                self.assertFalse(journal.exists())
                self.assertNotEqual(output, external)
                self.assertNotEqual(journal, sentinel)
                self.assertNotIn("NANIKA_BIND_ADDRESS", env)
                self.assertFalse(kwargs["shell"])
                self.assertEqual(command[1:], ["run", "e2e:chromium"])
                self.assertEqual(env["PLAYWRIGHT_JSON_REPORT"], "1")
                paths.append((output, journal))
                journal.write_text("disposable", encoding="utf-8")
                (root / ".quality" / "playwright" / "results.json").write_text("{}", encoding="utf-8")
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.dict(os.environ, {
                "PLAYWRIGHT_OUTPUT_DIR": str(external),
                "NANIKA_RECOVERY_EVIDENCE_PATH": str(sentinel),
                "NANIKA_BIND_ADDRESS": "0.0.0.0",
            }, clear=True), mock.patch.object(run_playwright, "require_healthy"), mock.patch.object(
                run_playwright.subprocess, "run", side_effect=child
            ) as run:
                self.assertEqual(run_playwright.main(root), 0)
                self.assertEqual(run_playwright.main(root), 0)
            self.assertEqual(run.call_count, 2)
            self.assertNotEqual(paths[0][0], paths[1][0])
            self.assertNotEqual(paths[0][1], paths[1][1])
            self.assertTrue(all(not output.exists() and not journal.exists() for output, journal in paths))
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")

    def test_runtime_output_is_cleaned_for_failure_exception_and_missing_report(self) -> None:
        for outcome in ("playwright_failed", "runner_error", "report_missing"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "frontend").mkdir()
                outputs: list[Path] = []

                def child(command, **kwargs):
                    output = Path(kwargs["env"]["PLAYWRIGHT_OUTPUT_DIR"])
                    outputs.append(output)
                    self.assertTrue(output.is_dir())
                    if outcome == "runner_error":
                        raise OSError("mock spawn failure")
                    if outcome == "playwright_failed":
                        (root / ".quality" / "playwright" / "results.json").write_text("{}", encoding="utf-8")
                    return subprocess.CompletedProcess(command, 1 if outcome == "playwright_failed" else 0)

                with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                    run_playwright, "require_healthy"
                ), mock.patch.object(run_playwright.subprocess, "run", side_effect=child) as run:
                    self.assertEqual(run_playwright.main(root), 1)
                run.assert_called_once()
                self.assertFalse(outputs[0].exists())
                status = json.loads((root / ".quality" / "playwright" / "run-status.json").read_text(encoding="utf-8"))
                self.assertEqual(status["outcome"], outcome)
                self.assertEqual(status["report_sha256"] is not None, outcome == "playwright_failed")

    def test_health_failure_never_allocates_runtime_evidence_or_starts_playwright(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                run_playwright, "require_healthy", side_effect=OSError("mock unavailable")
            ), mock.patch.object(run_playwright.tempfile, "TemporaryDirectory") as allocate, mock.patch.object(
                run_playwright.subprocess, "run"
            ) as run:
                self.assertEqual(run_playwright.main(Path(directory)), 1)
            allocate.assert_not_called()
            run.assert_not_called()

    def test_preexisting_journal_in_allocated_output_is_rejected_without_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            output.mkdir()
            (output / "recovery-continuation.journal.jsonl").write_text("preexisting", encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                run_playwright, "require_healthy"
            ), mock.patch.object(run_playwright.tempfile, "TemporaryDirectory") as allocate, mock.patch.object(
                run_playwright.subprocess, "run"
            ) as run:
                allocate.return_value.__enter__.return_value = str(output)
                self.assertEqual(run_playwright.main(root), 1)
            run.assert_not_called()

    def compose(self, root: Path, template: str = "${FRONTEND_PORT:-6742}") -> None:
        (root / "docker-compose.yml").write_text(
            f"services:\n  frontend:\n    ports:\n      - \"127.0.0.1:{template}:80\"\n",
            encoding="utf-8",
        )

    def test_default_deployment_port_is_read_from_compose(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.compose(root)
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(run_playwright.deployment_frontend_port(root), 6742)

    def test_environment_port_has_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.compose(root, "${FRONTEND_PORT:-6750}")
            with mock.patch.dict(os.environ, {"FRONTEND_PORT": "4300"}, clear=True):
                self.assertEqual(run_playwright.deployment_frontend_port(root), 4300)

    def test_dotenv_port_is_used_without_exposing_other_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.compose(root)
            dotenv = root / ".env"
            dotenv.write_text("DB_PASSWORD=hidden\nFRONTEND_PORT='4301'\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                run_playwright, "read_dotenv_value", wraps=run_playwright.read_dotenv_value
            ) as read:
                self.assertEqual(run_playwright.deployment_frontend_port(root), 4301)
            read.assert_called_once_with(dotenv, "FRONTEND_PORT")

    def test_loopback_deployment_port_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.compose(root)
            for host in ("localhost", "127.0.0.1", "[::1]"):
                with self.subTest(host=host):
                    with self.assertRaises(RuntimeError):
                        run_playwright.ensure_local_e2e_frontend_is_not_deployment_frontend(root, f"http://{host}:6742")

    def test_alternate_dev_port_and_non_loopback_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.compose(root)
            run_playwright.ensure_local_e2e_frontend_is_not_deployment_frontend(root, "http://localhost:4300")
            run_playwright.ensure_local_e2e_frontend_is_not_deployment_frontend(root, "http://192.0.2.10:6742")

    def test_child_receives_resolved_urls_and_json_report_flag(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "frontend").mkdir()
            with mock.patch.dict(
                os.environ,
                {
                    "NANIKA_E2E_BASE_URL": "http://localhost:4300",
                    "NANIKA_E2E_BACKEND_URL": "http://localhost:8080",
                    "NANIKA_E2E_STORAGE_PATH": "/tmp/nanika-e2e-storage",
                    "NANIKA_E2E_STORAGE_ID": "a" * 64,
                    "FRONTEND_PORT": "6742",
                },
                clear=True,
            ), mock.patch.object(run_playwright, "require_healthy"), mock.patch.object(
                run_playwright.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0),
            ) as run:
                self.assertEqual(run_playwright.main(root), 1)
            env = run.call_args.kwargs["env"]
            self.assertEqual(env["NANIKA_E2E_BASE_URL"], "http://localhost:4300")
            self.assertEqual(env["NANIKA_E2E_BACKEND_URL"], "http://localhost:8080")
            self.assertEqual(env["NANIKA_E2E_STORAGE_PATH"], "/tmp/nanika-e2e-storage")
            self.assertEqual(env["NANIKA_E2E_STORAGE_ID"], "a" * 64)
            self.assertEqual(env["PLAYWRIGHT_JSON_REPORT"], "1")

    def test_preflight_guard_runs_before_health_requests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.compose(root)
            with mock.patch.dict(os.environ, {"NANIKA_E2E_BASE_URL": "http://localhost:6742"}, clear=True), mock.patch.object(
                run_playwright, "require_healthy"
            ) as health:
                self.assertEqual(run_playwright.main(root), 1)
            health.assert_not_called()
            status = json.loads((root / ".quality" / "playwright" / "run-status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["outcome"], "preflight_failed")


if __name__ == "__main__":
    unittest.main()
