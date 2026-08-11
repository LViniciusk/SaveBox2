"""Unit tests for the bounded local test matrix."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


sys.path.insert(0, str(Path(__file__).parent))
import run_test_matrix as matrix  # noqa: E402


PASS = {"status": "passed", "exit_code": 0}
FAIL = {"status": "failed", "exit_code": 1, "stages": [{"status": "failed", "exit_code": 1, "name": "mutation"}]}


class TestMatrixTests(unittest.TestCase):
    def test_fast_frontend_has_one_unit_run_only(self) -> None:
        commands = matrix.frontend_commands("Fast")
        self.assertEqual([name for name, _ in commands], ["unit"])
        self.assertEqual(commands[0][1][1:], ["test", "--", "--watch=false", "--browsers=ChromeHeadless"])

    def test_full_frontend_deduplicates_unit_run(self) -> None:
        commands = matrix.frontend_commands("Full")
        self.assertEqual([name for name, _ in commands], ["coverage", "mutation"])
        self.assertEqual(commands[0][1][1:3], ["run", "test:coverage"])
        self.assertEqual(commands[1][1][1:3], ["run", "quality:mutation"])
        self.assertFalse(any(command[1] == "test" for _, command in commands))

    def test_profiles_and_shards_are_bounded(self) -> None:
        self.assertEqual(matrix.validate_profile("Fast"), "Fast")
        self.assertEqual(matrix.validate_profile("Full"), "Full")
        for invalid in ("fast", "Heavy"):
            with self.assertRaises(ValueError):
                matrix.validate_profile(invalid)
        with self.assertRaises(ValueError):
            matrix.validate_shard_count(5)

    def test_lanes_overlap_causally_without_sleep(self) -> None:
        backend_entered = threading.Event()
        frontend_observed_backend = threading.Event()
        release = threading.Event()

        def backend() -> dict[str, object]:
            backend_entered.set()
            self.assertTrue(release.wait(timeout=2))
            return PASS

        def frontend() -> dict[str, object]:
            self.assertTrue(backend_entered.wait(timeout=2))
            frontend_observed_backend.set()
            release.set()
            return PASS

        lanes = matrix.run_parallel_lanes(backend, frontend)
        self.assertTrue(frontend_observed_backend.is_set())
        self.assertEqual(lanes["backend"]["status"], "passed")
        self.assertEqual(lanes["frontend"]["status"], "passed")

    def test_serial_mode_preserves_order(self) -> None:
        order: list[str] = []

        def backend() -> dict[str, object]:
            order.append("backend")
            return PASS

        def frontend() -> dict[str, object]:
            order.append("frontend")
            return PASS

        matrix.run_parallel_lanes(backend, frontend, serial=True)
        self.assertEqual(order, ["backend", "frontend"])

    def test_lane_exception_is_red_and_does_not_escape_or_retry(self) -> None:
        calls = 0

        def backend() -> dict[str, object]:
            nonlocal calls
            calls += 1
            raise RuntimeError("internal detail must not be logged")

        lanes = matrix.run_parallel_lanes(backend, lambda: PASS)
        self.assertEqual(calls, 1)
        self.assertEqual(lanes["backend"]["status"], "failed")
        self.assertNotIn("internal detail", str(lanes["backend"]))

    def test_playwright_runs_only_after_both_full_lanes_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            args = SimpleNamespace(root=root, profile="Full", backend_shards=2, backend_seed=60201, backend_binary=binary, serial=False)
            with mock.patch.object(matrix, "execute_backend", return_value=PASS) as backend, mock.patch.object(matrix, "run_frontend_lane", return_value=PASS) as frontend, mock.patch.object(matrix, "run_playwright", return_value=PASS) as playwright:
                code, payload = matrix.run_matrix(args)
            self.assertEqual(code, 0)
            self.assertEqual(payload["playwright"]["status"], "passed")
            backend.assert_called_once()
            frontend.assert_called_once()
            playwright.assert_called_once()

    def test_failed_lane_blocks_playwright_and_propagates_exit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            args = SimpleNamespace(root=root, profile="Full", backend_shards=2, backend_seed=60201, backend_binary=binary, serial=False)
            with mock.patch.object(matrix, "execute_backend", return_value=FAIL), mock.patch.object(matrix, "run_frontend_lane", return_value=PASS), mock.patch.object(matrix, "run_playwright") as playwright:
                code, payload = matrix.run_matrix(args)
            self.assertEqual(code, 1)
            self.assertEqual(payload["playwright"]["status"], "not_run")
            playwright.assert_not_called()
            self.assertEqual(payload["first_failure"]["lane"], "backend")

    def test_frontend_failure_also_blocks_playwright(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            args = SimpleNamespace(root=root, profile="Full", backend_shards=2, backend_seed=60201, backend_binary=binary, serial=False)
            with mock.patch.object(matrix, "execute_backend", return_value=PASS), mock.patch.object(matrix, "run_frontend_lane", return_value=FAIL), mock.patch.object(matrix, "run_playwright") as playwright:
                code, payload = matrix.run_matrix(args)
            self.assertEqual(code, 1)
            self.assertEqual(payload["first_failure"]["lane"], "frontend")
            playwright.assert_not_called()

    def test_playwright_status_artifact_is_preserved_as_raw_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_root = root / "run"

            def run_and_write_status(*_: object, **__: object) -> dict[str, object]:
                status_path = root / ".quality" / "playwright" / "run-status.json"
                status_path.parent.mkdir(parents=True)
                status_path.write_text(
                    json.dumps({
                        "outcome": "playwright_failed",
                        "exit_code": 1,
                        "report_sha256": "abc123",
                        "phase": "playwright",
                        "started_at": "start",
                        "finished_at": "finish",
                        "status_valid": True,
                        "secret": "must not be copied",
                    }),
                    encoding="utf-8",
                )
                return {"command": ["py", "runner"], "status": "failed", "exit_code": 1, "duration_seconds": 1.0, "log": run_root / "log"}

            with mock.patch.object(matrix, "run_logged_command", side_effect=run_and_write_status):
                result = matrix.run_playwright(root, run_root)
            self.assertEqual(result["provenance"]["outcome"], "playwright_failed")
            self.assertEqual(result["provenance"]["phase"], "playwright")
            self.assertEqual(result["provenance"]["report_sha256"], "abc123")
            self.assertNotIn("status_valid", result["provenance"])
            self.assertNotIn("secret", result["provenance"])

    def test_playwright_status_reader_handles_preflight_and_invalid_or_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = root / ".quality" / "playwright" / "run-status.json"
            status.parent.mkdir(parents=True)
            status.write_text(json.dumps({"outcome": "preflight_failed", "phase": "preflight", "report_sha256": None}), encoding="utf-8")
            self.assertEqual(matrix.read_playwright_status(root)["phase"], "preflight")
            status.write_text("not json", encoding="utf-8")
            self.assertIsNone(matrix.read_playwright_status(root))
            status.unlink()
            self.assertIsNone(matrix.read_playwright_status(root))

    def test_playwright_process_exit_remains_authoritative_without_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            args = SimpleNamespace(root=root, profile="Full", backend_shards=2, backend_seed=60201, backend_binary=binary, serial=False)
            failed_playwright = {"status": "failed", "exit_code": 1, "provenance": {"outcome": "completed", "exit_code": 0, "phase": "report"}}
            with mock.patch.object(matrix, "execute_backend", return_value=PASS), mock.patch.object(matrix, "run_frontend_lane", return_value=PASS), mock.patch.object(
                matrix, "run_playwright", return_value=failed_playwright
            ) as playwright:
                code, payload = matrix.run_matrix(args)
            self.assertEqual(code, 1)
            self.assertEqual(payload["first_failure"]["lane"], "playwright")
            playwright.assert_called_once()


if __name__ == "__main__":
    unittest.main()
