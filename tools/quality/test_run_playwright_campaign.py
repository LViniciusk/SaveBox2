"""Testes unitários do isolamento da campanha canônica B.90-R1.M9."""

from __future__ import annotations

import json
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).parent))
import run_playwright_campaign as campaign  # noqa: E402


class FakeProcess:
    next_pid = 10_000

    def __init__(self) -> None:
        self.pid = FakeProcess.next_pid
        FakeProcess.next_pid += 1
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class RunPlaywrightCampaignTests(unittest.TestCase):
    def make_spec(self, root: Path) -> campaign.BackendSpec:
        cwd = root / "runtime" / "work" / "run"
        cwd.mkdir(parents=True)
        (cwd.parent.parent / ".env").write_text(
            "PORT=18082\n"
            "DB_NAME=nanika_e2e_b90_r1m9\n"
            "DB_HOST=127.0.0.1\n"
            "DB_PORT=25435\n"
            "TRUST_PROXY_HEADERS=false\n"
            "NANIKA_STORAGE_PATH=../../../storage\n"
            "NANIKA_E2E_STORAGE_ID=fixture-marker\n",
            encoding="utf-8",
        )
        executable = root / "savebox_server.exe"
        executable.write_bytes(b"same-production-binary")
        return campaign.BackendSpec(executable, cwd, "http://127.0.0.1:18082")

    def write_evidence(
        self,
        root: Path,
        *,
        expected: int = 5,
        unexpected: int = 0,
        skipped: int = 0,
        flaky: int = 0,
        outcome: str = "completed",
        exit_code: int = 0,
    ) -> None:
        evidence = root / ".quality" / "playwright"
        evidence.mkdir(parents=True, exist_ok=True)
        report = {"stats": {"expected": expected, "unexpected": unexpected, "skipped": skipped, "flaky": flaky}}
        report_path = evidence / "results.json"
        report_path.write_text(json.dumps(report), encoding="utf-8")
        status = {
            "schema": 1,
            "outcome": outcome,
            "exit_code": exit_code,
            "report_sha256": campaign.sha256_file(report_path),
            "phase": "report",
        }
        (evidence / "run-status.json").write_text(json.dumps(status), encoding="utf-8")

    def test_rejects_non_loopback_backend(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            with self.assertRaises(campaign.CampaignFailure) as error:
                campaign.validate_backend_spec(spec, "https://example.invalid:18082")
            self.assertEqual(error.exception.code, "CAMPAIGN_ENV_INVALID")

    def test_rejects_missing_executable_and_incompatible_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            spec.executable.unlink()
            with self.assertRaises(campaign.CampaignFailure):
                campaign.validate_backend_spec(spec, spec.url)

    def test_config_authority_uses_nearest_ancestor_without_legacy_relative_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            result = campaign.validate_backend_spec(spec, spec.url)
            authority = result["configAuthority"]
            self.assertEqual(authority["mode"], "nearest-ancestor-dotenv")
            self.assertTrue(authority["nearestAncestorDotenv"])
            self.assertNotIn("../../.env", json.dumps(result))

    def test_config_authority_rejects_invalid_nearest_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            config_path = spec.cwd.parent.parent / ".env"
            config_path.unlink()
            config_path.mkdir()
            with self.assertRaises(campaign.CampaignFailure) as error:
                campaign.validate_backend_spec(spec, spec.url)
            self.assertEqual(error.exception.code, "CAMPAIGN_CONFIG_INVALID")

    def test_dotenv_resolver_is_missing_and_bounded_without_recursion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root
            for index in range(33):
                nested /= "x"
            nested.mkdir(parents=True)
            self.assertIsNone(campaign.find_dotenv_upwards(root / "absent"))
            (root / ".env").write_text("PORT=18082\n", encoding="utf-8")
            self.assertIsNone(campaign.find_dotenv_upwards(nested))

    def test_dotenv_resolver_rejects_symlink_candidate_when_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root / "nested"
            nested.mkdir()
            target = root / "real.env"
            target.write_text("PORT=18082\n", encoding="utf-8")
            candidate = nested / ".env"
            try:
                candidate.symlink_to(target)
            except OSError:
                self.skipTest("symlink creation unavailable in this test environment")
            with self.assertRaises(campaign.CampaignFailure) as error:
                campaign.find_dotenv_upwards(nested)
            self.assertEqual(error.exception.code, "CAMPAIGN_CONFIG_INVALID")

    def test_start_waits_for_health_and_owns_exact_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            child = FakeProcess()
            with mock.patch.object(campaign, "endpoint_reachable", return_value=False), mock.patch.object(
                campaign, "endpoint_ready", side_effect=[False, True]
            ), mock.patch.object(campaign.time, "sleep"):
                generation = campaign.start_backend(spec, 1, process_factory=lambda *args, **kwargs: child)
            self.assertIs(generation.process, child)
            self.assertTrue(generation.owned)
            campaign.stop_backend(generation)
            self.assertTrue(child.terminated)
            self.assertFalse(child.killed)

    def test_executable_hash_is_resolved_before_spawning_backend(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            with mock.patch.object(campaign, "endpoint_reachable", return_value=False), mock.patch.object(
                campaign, "sha256_file", side_effect=OSError("hash unavailable")
            ):
                spawn = mock.Mock()
                with self.assertRaises(campaign.CampaignFailure):
                    campaign.spawn_backend(spec, 1, validated_config={"valid": True}, process_factory=spawn)
            spawn.assert_not_called()

    def test_rejects_preexisting_health_before_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            with mock.patch.object(campaign, "endpoint_reachable", return_value=True), mock.patch.object(
                campaign.subprocess, "Popen"
            ) as spawn:
                with self.assertRaises(campaign.CampaignFailure) as error:
                    campaign.start_backend(spec, 1)
            self.assertEqual(error.exception.code, "CAMPAIGN_BACKEND_ALREADY_RUNNING")
            spawn.assert_not_called()

    def test_terminate_timeout_kills_only_owned_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            child = FakeProcess()
            child.wait = mock.Mock(side_effect=[subprocess.TimeoutExpired("owned-child", 1), -9])
            generation = campaign.BackendGeneration(1, child, "now", campaign.sha256_file(spec.executable), True)
            result = campaign.stop_backend(generation)
            self.assertTrue(child.terminated)
            self.assertTrue(child.killed)
            self.assertTrue(result["escalated"])

    def test_campaign_requires_fresh_generation_and_stops_on_first_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            children = [FakeProcess(), FakeProcess()]
            starts: list[int] = []
            stops: list[int] = []
            calls = 0

            def start(*args, **kwargs):
                starts.append(len(starts) + 1)
                child = children[len(starts) - 1]
                generation = campaign.BackendGeneration(len(starts), child, "now", "hash", True)
                return generation

            def runner(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    self.write_evidence(root)
                    return subprocess.CompletedProcess(args[0], 0)
                self.write_evidence(root, expected=4, unexpected=1, outcome="playwright_failed", exit_code=1)
                return subprocess.CompletedProcess(args[0], 1)

            def stop(generation, **kwargs):
                stops.append(generation.generation)
                return {"escalated": False}

            with mock.patch.object(campaign, "validate_backend_spec", return_value={"valid": True}), mock.patch.object(
                campaign, "endpoint_reachable", return_value=False
            ), mock.patch.object(campaign, "spawn_backend", side_effect=start), mock.patch.object(
                campaign, "wait_backend_ready", side_effect=lambda generation: generation
            ), mock.patch.object(campaign, "stop_backend", side_effect=stop):
                result = campaign.run_campaign(root, spec, "http://localhost:4200", root / "archive", runs=5, runner=runner)
            self.assertEqual(starts, [1, 2])
            self.assertEqual(stops, [1, 2])
            self.assertEqual(calls, 2)
            self.assertTrue(result["stoppedEarly"])
            self.assertEqual(result["backendStartAttempts"], 2)
            self.assertEqual(result["backendProcessesSpawned"], 2)
            self.assertEqual(result["backendGenerationsReady"], 2)
            self.assertEqual(result["canonicalRunsStarted"], 2)
            self.assertEqual(result["canonicalRunsCompleted"], 2)
            self.assertEqual(result["passedRuns"], 1)
            self.assertEqual(result["failedRuns"], 1)
            self.assertEqual(result["runs"][1]["result"], "FAIL")
            self.assertEqual(result["runs"][1]["failureCode"], "CAMPAIGN_CANONICAL_FAILED")
            self.assertEqual(result["runs"][1]["canonical"]["total"], 5)
            self.assertEqual(result["runs"][1]["canonical"]["passed"], 4)
            self.assertEqual(result["runs"][1]["canonical"]["failed"], 1)
            self.assertFalse((root / "archive" / "run-03").exists())

    def test_valid_failed_canonical_evidence_preserves_stats(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_evidence(root, expected=4, unexpected=1, outcome="playwright_failed", exit_code=1)

            evidence = campaign.archive_and_validate(
                root,
                root / "archive",
                subprocess.CompletedProcess(["playwright"], 1),
            )

            self.assertTrue(evidence["evidenceValid"])
            self.assertFalse(evidence["canonicalPass"])
            self.assertEqual(
                {key: evidence[key] for key in ("total", "passed", "failed", "skipped", "flaky", "retries")},
                {"total": 5, "passed": 4, "failed": 1, "skipped": 0, "flaky": 0, "retries": 0},
            )

    def test_exit_zero_with_skipped_canonical_test_is_valid_but_not_a_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_evidence(root, expected=4, skipped=1)

            evidence = campaign.archive_and_validate(
                root,
                root / "archive",
                subprocess.CompletedProcess(["playwright"], 0),
            )

            self.assertTrue(evidence["evidenceValid"])
            self.assertFalse(evidence["canonicalPass"])
            self.assertEqual(evidence["total"], 5)
            self.assertEqual(evidence["passed"], 4)
            self.assertEqual(evidence["skipped"], 1)

    def test_process_status_and_outcome_contradictions_fail_closed(self) -> None:
        cases = (
            ("playwright_failed", 1, 0),
            ("completed", 1, 1),
            ("playwright_failed", 0, 0),
        )
        for outcome, status_exit, process_exit in cases:
            with self.subTest(outcome=outcome, status_exit=status_exit, process_exit=process_exit), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.write_evidence(root, outcome=outcome, exit_code=status_exit)
                with self.assertRaises(campaign.CampaignFailure) as error:
                    campaign.archive_and_validate(root, root / "archive", subprocess.CompletedProcess([], process_exit))
                self.assertEqual(error.exception.code, "CAMPAIGN_EVIDENCE_INVALID")

    def test_report_hash_mismatch_remains_a_distinct_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_evidence(root)
            status_path = root / ".quality" / "playwright" / "run-status.json"
            status = json.loads(status_path.read_text(encoding="utf-8"))
            status["report_sha256"] = "0" * 64
            status_path.write_text(json.dumps(status), encoding="utf-8")

            with self.assertRaises(campaign.CampaignFailure) as error:
                campaign.archive_and_validate(root, root / "archive", subprocess.CompletedProcess([], 0))
            self.assertEqual(error.exception.code, "CAMPAIGN_EVIDENCE_HASH_MISMATCH")

    def test_invalid_report_json_remains_evidence_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_evidence(root)
            report_path = root / ".quality" / "playwright" / "results.json"
            report_path.write_text("{invalid", encoding="utf-8")
            status_path = root / ".quality" / "playwright" / "run-status.json"
            status = json.loads(status_path.read_text(encoding="utf-8"))
            status["report_sha256"] = campaign.sha256_file(report_path)
            status_path.write_text(json.dumps(status), encoding="utf-8")

            with self.assertRaises(campaign.CampaignFailure) as error:
                campaign.archive_and_validate(root, root / "archive", subprocess.CompletedProcess([], 0))
            self.assertEqual(error.exception.code, "CAMPAIGN_EVIDENCE_INVALID")

    def test_report_and_status_json_roots_must_be_objects(self) -> None:
        for invalid_root in ("report-array", "status-array"):
            with self.subTest(invalid_root=invalid_root), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.write_evidence(root)
                report_path = root / ".quality" / "playwright" / "results.json"
                status_path = root / ".quality" / "playwright" / "run-status.json"
                if invalid_root == "report-array":
                    report_path.write_text("[]", encoding="utf-8")
                    status = json.loads(status_path.read_text(encoding="utf-8"))
                    status["report_sha256"] = campaign.sha256_file(report_path)
                    status_path.write_text(json.dumps(status), encoding="utf-8")
                else:
                    status_path.write_text("[]", encoding="utf-8")

                with self.assertRaises(campaign.CampaignFailure) as error:
                    campaign.archive_and_validate(root, root / "archive", subprocess.CompletedProcess([], 0))
                self.assertEqual(error.exception.code, "CAMPAIGN_EVIDENCE_INVALID")

    def test_spawned_backend_that_never_becomes_ready_never_starts_canonical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            child = FakeProcess()
            generation = campaign.BackendGeneration(1, child, "now", "hash", True, spec.url)
            with mock.patch.object(campaign, "validate_backend_spec", return_value={"valid": True}), mock.patch.object(
                campaign, "spawn_backend", return_value=generation
            ), mock.patch.object(
                campaign, "wait_backend_ready", side_effect=campaign.CampaignFailure("CAMPAIGN_BACKEND_HEALTH_TIMEOUT")
            ), mock.patch.object(campaign, "stop_backend", return_value={"escalated": False}) as stop, mock.patch.object(
                campaign.subprocess, "run"
            ) as runner:
                result = campaign.run_campaign(root, spec, "http://localhost:4200", root / "archive", runs=1, runner=runner)
            self.assertEqual(result["backendStartAttempts"], 1)
            self.assertEqual(result["backendProcessesSpawned"], 1)
            self.assertEqual(result["backendGenerationsReady"], 0)
            self.assertEqual(result["canonicalRunsStarted"], 0)
            self.assertEqual(result["canonicalRunsCompleted"], 0)
            runner.assert_not_called()
            stop.assert_called_once_with(generation)

    def test_spawned_backend_is_owned_before_process_artifact_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            generation = campaign.BackendGeneration(1, FakeProcess(), "now", "hash", True, spec.url)
            write_json = campaign.write_json

            def write(path: Path, payload: object) -> None:
                if path.name == "backend-process.json":
                    raise campaign.CampaignFailure("CAMPAIGN_ARTIFACT_WRITE_FAILED")
                write_json(path, payload)

            with mock.patch.object(campaign, "validate_backend_spec", return_value={"valid": True}), mock.patch.object(
                campaign, "spawn_backend", return_value=generation
            ), mock.patch.object(campaign, "write_json", side_effect=write), mock.patch.object(
                campaign, "stop_backend", return_value={"escalated": False}
            ) as stop:
                result = campaign.run_campaign(root, spec, "http://127.0.0.1:4200", root / "archive", runs=1)

            self.assertEqual(result["backendProcessesSpawned"], 1)
            self.assertEqual(result["runs"][0]["failureCode"], "CAMPAIGN_ARTIFACT_WRITE_FAILED")
            self.assertIn("backendTeardown", result["runs"][0])
            stop.assert_called_once_with(generation)

    def test_ready_generation_starts_exactly_one_canonical_runner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            child = FakeProcess()
            generation = campaign.BackendGeneration(1, child, "now", "hash", True, spec.url)
            expected_path = str(root / "isolated-storage")
            expected_id = "a" * 64

            def runner(*args, **kwargs):
                self.assertEqual(kwargs["cwd"], root)
                self.assertFalse(kwargs["check"])
                self.assertEqual(kwargs["env"]["NANIKA_E2E_STORAGE_PATH"], expected_path)
                self.assertEqual(kwargs["env"]["NANIKA_E2E_STORAGE_ID"], expected_id)
                self.write_evidence(root)
                return subprocess.CompletedProcess(args[0], 0)

            with mock.patch.dict(
                os.environ,
                {"NANIKA_E2E_STORAGE_PATH": expected_path, "NANIKA_E2E_STORAGE_ID": expected_id},
                clear=False,
            ), mock.patch.object(campaign, "validate_backend_spec", return_value={"valid": True}), mock.patch.object(
                campaign, "spawn_backend", return_value=generation
            ), mock.patch.object(campaign, "wait_backend_ready", return_value=generation), mock.patch.object(
                campaign, "stop_backend", return_value={"escalated": False}
            ):
                result = campaign.run_campaign(root, spec, "http://localhost:4200", root / "archive", runs=1, runner=runner)
            self.assertEqual(result["backendGenerationsReady"], 1)
            self.assertEqual(result["canonicalRunsStarted"], 1)
            self.assertEqual(result["canonicalRunsCompleted"], 1)

    def test_direct_cli_prints_current_campaign_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "savebox_server.exe"
            cwd = root / "runtime"
            executable.write_bytes(b"backend")
            cwd.mkdir()
            summary = {
                "result": "PASS",
                "plannedRuns": 1,
                "backendStartAttempts": 1,
                "backendProcessesSpawned": 1,
                "backendGenerationsReady": 1,
                "canonicalRunsStarted": 1,
                "canonicalRunsCompleted": 1,
                "passedRuns": 1,
                "failedRuns": 0,
                "retries": 0,
                "stoppedEarly": False,
                "runs": [],
            }
            output = io.StringIO()
            with mock.patch.dict(
                os.environ,
                {
                    "NANIKA_E2E_BACKEND_EXE": str(executable),
                    "NANIKA_E2E_BACKEND_CWD": str(cwd),
                    "NANIKA_E2E_BACKEND_URL": "http://127.0.0.1:18082",
                },
                clear=False,
            ), mock.patch.object(campaign, "repository_root", return_value=root), mock.patch.object(
                campaign, "run_campaign", return_value=summary
            ), redirect_stdout(output):
                result = campaign.main(["--runs", "1", "--output", str(root / "archive")])
            printed = json.loads(output.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(printed["canonicalRunsCompleted"], 1)
            self.assertNotIn("completedRuns", printed)

    def test_campaign_archives_each_green_run_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            children = [FakeProcess(), FakeProcess()]
            counter = iter(children)

            def runner(*args, **kwargs):
                self.write_evidence(root)
                return subprocess.CompletedProcess(args[0], 0)

            with mock.patch.object(campaign, "validate_backend_spec", return_value={"valid": True}), mock.patch.object(
                campaign, "endpoint_reachable", return_value=False
            ), mock.patch.object(
                campaign, "spawn_backend", side_effect=lambda *args, **kwargs: campaign.BackendGeneration(
                    kwargs.get("generation", 1), next(counter), "now", "hash", True
                )
            ), mock.patch.object(campaign, "wait_backend_ready", side_effect=lambda generation: generation), mock.patch.object(
                campaign, "stop_backend", return_value={"escalated": False}
            ):
                result = campaign.run_campaign(root, spec, "http://localhost:4200", root / "archive", runs=2, runner=runner)
            self.assertEqual(result["passedRuns"], 2)
            for index in (1, 2):
                self.assertTrue((root / "archive" / f"run-{index:02d}" / "results.json").is_file())
                self.assertTrue((root / "archive" / f"run-{index:02d}" / "run-status.json").is_file())
                self.assertTrue(result["runs"][index - 1]["canonical"]["evidenceValid"])
                self.assertTrue(result["runs"][index - 1]["canonical"]["canonicalPass"])

    def test_five_run_campaign_reuses_preflight_config_and_records_informational_timing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            config = {"valid": True, "configAuthority": {"secretValuesRecorded": False}}
            generations: list[campaign.BackendGeneration] = []
            canonical_calls: list[int] = []
            stopped: list[int] = []

            def spawn(_spec, index, *, validated_config, **_kwargs):
                self.assertEqual(validated_config, config)
                generation = campaign.BackendGeneration(index, FakeProcess(), "now", "sha256", True)
                generations.append(generation)
                return generation

            def runner(argv, **_kwargs):
                canonical_calls.append(len(canonical_calls) + 1)
                self.write_evidence(root)
                return subprocess.CompletedProcess(argv[0], 0)

            with mock.patch.object(campaign, "validate_backend_spec", return_value=config) as validate, mock.patch.object(
                campaign, "spawn_backend", side_effect=spawn
            ) as spawn_backend, mock.patch.object(
                campaign, "wait_backend_ready", side_effect=lambda generation: generation
            ), mock.patch.object(
                campaign, "stop_backend", side_effect=lambda generation: stopped.append(generation.generation) or {"escalated": False}
            ):
                result = campaign.run_campaign(
                    root,
                    spec,
                    "http://localhost:4200",
                    root / "archive",
                    runs=5,
                    round_id="B.90-R1.M21",
                    runner=runner,
                )

            self.assertEqual(result["result"], "PASS")
            self.assertEqual(result["round"], "B.90-R1.M21")
            self.assertEqual(result["passedRuns"], 5)
            self.assertEqual(result["canonicalRunsCompleted"], 5)
            self.assertEqual(result["retries"], 0)
            self.assertEqual(validate.call_count, 1)
            self.assertEqual(spawn_backend.call_count, 5)
            self.assertEqual(canonical_calls, [1, 2, 3, 4, 5])
            self.assertEqual(stopped, [1, 2, 3, 4, 5])
            self.assertNotIn("DB_PASSWORD", json.dumps(result))
            self.assertNotIn("18082", json.dumps(result))
            for run in result["runs"]:
                self.assertGreaterEqual(run["backendStartupMs"], 0)
                self.assertGreaterEqual(run["canonicalMs"], 0)
                self.assertGreaterEqual(run["backendTeardownMs"], 0)
                self.assertGreaterEqual(run["totalMs"], 0)

    def test_invalid_evidence_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / ".quality" / "playwright"
            evidence.mkdir(parents=True)
            (evidence / "results.json").write_text("{}", encoding="utf-8")
            (evidence / "run-status.json").write_text(json.dumps({"outcome": "completed", "exit_code": 0}), encoding="utf-8")
            with self.assertRaises(campaign.CampaignFailure) as error:
                campaign.archive_and_validate(root, root / "archive", subprocess.CompletedProcess([], 0))
            self.assertIn(error.exception.code, {"CAMPAIGN_EVIDENCE_INVALID", "CAMPAIGN_EVIDENCE_HASH_MISMATCH"})

    def test_campaign_result_does_not_serialize_secrets_or_absolute_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = self.make_spec(root)
            with mock.patch.object(campaign, "validate_backend_spec", return_value={"valid": True}), mock.patch.object(
                campaign, "endpoint_reachable", return_value=False
            ), mock.patch.object(
                campaign, "start_backend", return_value=campaign.BackendGeneration(1, FakeProcess(), "now", "hash", True)
            ), mock.patch.object(campaign, "stop_backend", return_value={"escalated": False}):
                def runner(*args, **kwargs):
                    self.write_evidence(root)
                    return subprocess.CompletedProcess(args[0], 0)

                result = campaign.run_campaign(root, spec, "http://localhost:4200", root / "archive", runs=1, runner=runner)
            serialized = json.dumps(result)
            self.assertNotIn("SUPER_SECRET_PASSWORD", serialized)
            self.assertNotIn("C:\\Users\\SecretUser", serialized)

    def test_runner_uses_explicit_argv_without_shell(self) -> None:
        source = Path(campaign.__file__).read_text(encoding="utf-8")
        self.assertNotIn("shell=True", source)
        self.assertIn("tools/quality/run_playwright.py", source)


if __name__ == "__main__":
    unittest.main()
