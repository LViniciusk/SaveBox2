"""Testes unitários da autoridade da campanha canônica e do ambiente descartável."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).parent))
import run_playwright_campaign_env as env_owner  # noqa: E402
import run_recovery_targeted as recovery_owner  # noqa: E402


class EnvironmentOwnerTests(unittest.TestCase):
    def test_docker_and_inventory_failures_preserve_not_run_semantics_after_discovery(self) -> None:
        for code in (
            "DOCKER_CLI_UNAVAILABLE", "DOCKER_DAEMON_UNAVAILABLE", "DOCKER_DAEMON_PROOF_INVALID",
            "PREEXISTING_RESOURCE_PROOF_UNAVAILABLE", "PREEXISTING_RESOURCE_PROOF_INVALID",
        ):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = root / "output"
                events: list[str] = []

                def preflight(*args):
                    events.append("discovery")
                    return {"preferredFrontendPort": 4200, "discovery": {"testsDiscovered": 5, "executionStarted": False}}

                def docker():
                    events.append("docker")
                    if code.startswith("DOCKER_"):
                        raise recovery_owner.TargetFailure(code)
                    return {"cliAvailable": True, "daemonAvailable": True}

                def inventory():
                    events.append("inventory")
                    raise recovery_owner.TargetFailure(code)

                with mock.patch.object(env_owner, "repository_root", return_value=root), mock.patch.object(
                    env_owner, "preflight", side_effect=preflight
                ) as discover, mock.patch.object(recovery_owner, "probe_docker_runtime", side_effect=docker) as probe, mock.patch.object(
                    recovery_owner, "container_snapshot", side_effect=inventory
                ) as snapshot, mock.patch.object(env_owner, "capture_campaign_hashes") as freeze, mock.patch.object(
                    env_owner.frontend_owner, "spawn_frontend"
                ) as frontend, mock.patch.object(env_owner, "prepare_environment") as prepare, mock.patch.object(
                    env_owner.campaign, "run_campaign"
                ) as campaign:
                    self.assertEqual(env_owner.main(["--round-id", "B.90-R1.M28", "--output", str(output)]), 1)
                self.assertEqual(events, ["discovery", "docker"] + ([] if code.startswith("DOCKER_") else ["inventory"]))
                discover.assert_called_once()
                probe.assert_called_once()
                self.assertEqual(snapshot.call_count, 0 if code.startswith("DOCKER_") else 1)
                freeze.assert_not_called()
                frontend.assert_not_called()
                prepare.assert_not_called()
                campaign.assert_not_called()
                self.assertFalse((output / "source-freeze.json").exists())
                prerequisites = json.loads((output / "environment/runtime-prerequisites.json").read_text(encoding="utf-8"))
                self.assertEqual(prerequisites["result"], recovery_owner.BLOCKED_RESULTS[code])
                self.assertEqual(prerequisites["sourceFreeze"], "NOT_RUN")
                self.assertIsNone(prerequisites["sourceUnchangedAcrossRuntime"])
                self.assertEqual(prerequisites["ownedResourcesStarted"], 0)
                self.assertEqual(prerequisites["cleanupStatus"], "NOT_APPLICABLE")

    def test_discovery_failure_never_probes_docker_or_allocates_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            with mock.patch.object(env_owner, "repository_root", return_value=root), mock.patch.object(
                env_owner, "preflight", side_effect=env_owner.EnvironmentFailure("CAMPAIGN_CANONICAL_DISCOVERY_INVALID")
            ), mock.patch.object(recovery_owner, "probe_docker_runtime") as docker, mock.patch.object(
                env_owner, "capture_campaign_hashes"
            ) as freeze, mock.patch.object(env_owner, "prepare_environment") as prepare:
                self.assertEqual(env_owner.main(["--round-id", "B.90-R1.M28", "--output", str(output)]), 1)
            docker.assert_not_called()
            freeze.assert_not_called()
            prepare.assert_not_called()
            self.assertFalse(output.exists())

    def test_campaign_artifacts_are_create_new(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proof.json"
            env_owner.write_json(path, {"state": "initial"})
            with self.assertRaises(FileExistsError):
                env_owner.write_json(path, {"state": "replacement"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"state": "initial"})

    def test_final_inventory_change_or_loss_blocks_after_independent_frontend_cleanup(self) -> None:
        for final in ({"b" * 64: "exited"}, recovery_owner.TargetFailure("PREEXISTING_RESOURCE_PROOF_UNAVAILABLE")):
            with self.subTest(final=type(final).__name__), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = root / "output"
                generation = env_owner.frontend_owner.FrontendGeneration(
                    mock.Mock(), "http://127.0.0.1:43123", 43123, False
                )
                with mock.patch.object(env_owner, "repository_root", return_value=root), mock.patch.object(
                    env_owner, "preflight", return_value={"preferredFrontendPort": 4200, "discovery": {"testsDiscovered": 5}}
                ), mock.patch.object(recovery_owner, "probe_docker_runtime", return_value={"cliAvailable": True, "daemonAvailable": True}), mock.patch.object(
                    recovery_owner, "container_snapshot", side_effect=[{"b" * 64: "running"}, final]
                ) as inventory, mock.patch.object(
                    env_owner, "capture_campaign_hashes", return_value={"algorithm": "sha256", "files": {}, "trees": {}}
                ), mock.patch.object(env_owner.frontend_owner, "resolve_frontend_tooling", return_value=("node", root / "ng.js")), mock.patch.object(
                    env_owner.frontend_owner, "reserve_frontend_port", return_value=mock.Mock(socket=mock.Mock(), port=4200, preferred=True)
                ), mock.patch.object(env_owner.frontend_owner, "spawn_frontend", return_value=generation), mock.patch.object(
                    env_owner.frontend_owner, "wait_frontend_ready", side_effect=env_owner.frontend_owner.FrontendOwnershipFailure("FRONTEND_LISTENER_TIMEOUT")
                ), mock.patch.object(env_owner.frontend_owner, "stop_frontend", return_value=False) as stop, mock.patch.object(
                    env_owner, "prepare_environment"
                ) as prepare, mock.patch.object(env_owner.campaign, "run_campaign") as campaign:
                    self.assertEqual(env_owner.main(["--round-id", "B.90-R1.M28", "--output", str(output)]), 1)
                self.assertEqual(inventory.call_count, 2)
                stop.assert_called_once_with(generation)
                prepare.assert_not_called()
                campaign.assert_not_called()
                decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
                self.assertEqual(decision["result"], "BLOCKED_CANONICAL_RATIFICATION")
                if isinstance(final, dict):
                    self.assertEqual(decision["failureCode"], "PREEXISTING_RESOURCES_CHANGED")
                    self.assertIs(decision["ownership"]["userContainersPreserved"], False)
                else:
                    self.assertEqual(decision["failureCode"], "PREEXISTING_RESOURCE_PROOF_UNAVAILABLE")
                    self.assertIsNone(decision["ownership"]["userContainersPreserved"])
                self.assertEqual(decision["sourceRuntimeComparison"], "MATCH")
                environment = json.loads((output / "environment/result.json").read_text(encoding="utf-8"))
                self.assertEqual(environment["cleanupStatus"], "PASS")
                self.assertIsNone(environment["postgresRemoved"])

    def test_campaign_freeze_preserves_runtime_hashes_and_adds_m27_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = root / ".quality/b90-r1m27-recovery-runtime-closure"
            history.mkdir(parents=True)
            (history / "decision.json").write_text("{}", encoding="utf-8")
            snapshot = {"runtimeExecutables": {"backend.exe": "hash"}, "historicalArtifacts": {}}
            with mock.patch.object(recovery_owner, "source_hashes", return_value=snapshot):
                actual = env_owner.capture_campaign_hashes(root)
            self.assertEqual(actual["runtimeExecutables"], {"backend.exe": "hash"})
            relative = history.relative_to(root).as_posix()
            self.assertEqual(actual["historicalArtifacts"][relative], env_owner._tree_sha256(root, relative))
            self.assertIn("tools/quality/test_run_playwright.py", env_owner.PROTECTED_FILES)

    def test_ratification_requires_preexisting_resource_inventory_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            summary = {
                "plannedRuns": 5, "backendProcessesSpawned": 5, "backendGenerationsReady": 5,
                "canonicalRunsStarted": 5, "canonicalRunsCompleted": 5,
                "passedRuns": 5, "failedRuns": 0, "retries": 0, "stoppedEarly": False,
                "runs": [{
                    "canonical": {"total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0},
                    "backendTeardown": {"escalated": False},
                } for _ in range(5)],
            }
            hashes = {"algorithm": "sha256", "files": {}, "trees": {}}
            decision = env_owner.write_campaign_artifacts(
                output, round_id="B.90-R1.M28",
                environment={
                    "frontendOwned": True, "frontendReady": True, "frontendStopped": True,
                    "campaignUsedOwnedFrontend": True, "frontendGenerations": 1,
                    "postgresRemoved": True, "workspaceRemoved": True,
                },
                source_before=hashes, source_after=hashes, performance={},
                result="PASS", failure_code=None, summary=summary, teardown_ok=True,
            )
            self.assertEqual(decision["result"], "BLOCKED_CANONICAL_RATIFICATION")
            self.assertIsNone(decision["ownership"]["userContainersPreserved"])

    def credentials(self, password: str = "abcdef123456") -> env_owner.DatabaseCredentials:
        return env_owner.DatabaseCredentials("nanika_e2e", password, "nanika_e2e_m10_abcdef")

    def test_password_is_lowercase_hex_and_exactly_32_bytes_as_text(self) -> None:
        password = env_owner.make_database_credentials().password
        self.assertIsNotNone(re.fullmatch(r"[0-9a-f]{32}", password))
        self.assertNotRegex(password, r"[\s'\"=$`\\\r\n;|&%!]")

    def test_single_credential_feeds_docker_env_and_runtime_env(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = env_owner.create_runtime_workspace(root, storage_id="a" * 64)
            credentials = self.credentials("SUPER_SECRET_DB_PASSWORD")
            argv, child_env = env_owner.postgres_command("nanika-e2e-m10-abcdef123456", credentials)
            env_owner.write_runtime_env(workspace, credentials, 49123, 18082, "http://localhost:4200")
            runtime = env_owner.read_dotenv(workspace.env_file)
            self.assertEqual(child_env["POSTGRES_PASSWORD"], credentials.password)
            self.assertEqual(runtime["DB_PASSWORD"], credentials.password)
            self.assertEqual(runtime["NANIKA_BIND_ADDRESS"], "127.0.0.1")
            self.assertNotIn(credentials.password, argv)
            self.assertNotIn("SUPER_SECRET_DB_PASSWORD", json.dumps({"argv": argv}))

    def test_docker_argv_is_loopback_and_does_not_contain_password(self) -> None:
        argv, child_env = env_owner.postgres_command("nanika-e2e-m10-abcdef123456", self.credentials("abcdef123456"))
        self.assertIn("--env", argv)
        self.assertIn("POSTGRES_PASSWORD", argv)
        self.assertIn("127.0.0.1::5432", argv)
        self.assertNotIn("0.0.0.0", argv)
        self.assertNotIn("[::]", argv)
        self.assertNotIn("abcdef123456", argv)
        self.assertEqual(child_env["POSTGRES_PASSWORD"], "abcdef123456")
        self.assertNotIn("shell=True", Path(env_owner.__file__).read_text(encoding="utf-8"))

    def test_exact_container_id_is_the_only_teardown_target(self) -> None:
        calls: list[list[str]] = []

        def runner(argv, **kwargs):
            calls.append(argv)
            if argv[1:2] == ["run"]:
                return subprocess.CompletedProcess(argv, 0, "a" * 64 + "\n", "")
            if argv[1:3] == ["port", "a" * 64]:
                return subprocess.CompletedProcess(argv, 0, "127.0.0.1:49123\n", "")
            return subprocess.CompletedProcess(argv, 0, "", "")

        handle = env_owner.start_disposable_postgres(self.credentials(), runner=runner)
        env_owner.remove_disposable_postgres(handle, runner=runner)
        self.assertEqual(calls[-1], ["docker", "rm", "-f", "a" * 64])
        self.assertFalse(any(argv[1:3] == ["ps", "-a"] for argv in calls))

    def test_readiness_is_bounded_and_separate_from_authentication(self) -> None:
        calls = 0

        def runner(argv, **kwargs):
            nonlocal calls
            calls += 1
            return subprocess.CompletedProcess(argv, 0 if calls == 2 else 1, "", "")

        handle = env_owner.PostgresHandle("a" * 64, 49123, self.credentials())
        with mock.patch.object(env_owner.time, "sleep"):
            env_owner.wait_for_postgres(handle, runner=runner, timeout=1)
        self.assertEqual(calls, 2)

    def test_auth_probe_passes_only_for_select_one(self) -> None:
        handle = env_owner.PostgresHandle("a" * 64, 49123, self.credentials())
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "1\n", ""))
        self.assertTrue(env_owner.probe_database_credentials(handle, runner=runner))
        argv = runner.call_args.args[0]
        self.assertIn("--env", argv)
        self.assertIn("PGPASSWORD", argv)
        self.assertNotIn(handle.credentials.password, argv)

    def test_auth_probe_mismatch_fails_before_campaign(self) -> None:
        handle = env_owner.PostgresHandle("a" * 64, 49123, self.credentials("abcdef123456"))
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 1, "", "authentication failed"))
        with self.assertRaises(env_owner.EnvironmentFailure) as error:
            env_owner.probe_database_credentials(handle, runner=runner)
        self.assertEqual(error.exception.code, "CAMPAIGN_DATABASE_AUTH_FAILED")

    def test_runtime_password_mismatch_is_rejected_before_probe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = env_owner.create_runtime_workspace(Path(directory), storage_id="a" * 64)
            credentials = self.credentials("abcdef123456")
            env_owner.write_runtime_env(workspace, credentials, 49123, 18082, "http://localhost:4200")
            content = workspace.env_file.read_text(encoding="utf-8").replace("DB_PASSWORD=abcdef123456", "DB_PASSWORD=abcdef")
            workspace.env_file.write_text(content, encoding="utf-8")
            handle = env_owner.PostgresHandle("a" * 64, 49123, credentials)
            with self.assertRaises(env_owner.EnvironmentFailure) as error:
                env_owner._runtime_credentials(workspace, handle)
            self.assertEqual(error.exception.code, "CAMPAIGN_DATABASE_AUTH_FAILED")

    def test_prepare_environment_cleans_owned_resources_when_probe_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config" / "disposable_domains.txt").write_text("example.invalid\n", encoding="utf-8")
            executable = root / "savebox_server.exe"
            executable.write_bytes(b"binary")
            workspace = env_owner.create_runtime_workspace(Path(directory) / "workspace", storage_id="a" * 64)
            handle = env_owner.PostgresHandle("a" * 64, 49123, self.credentials())
            with mock.patch.object(env_owner, "start_disposable_postgres", return_value=handle), mock.patch.object(
                env_owner, "wait_for_postgres"
            ), mock.patch.object(env_owner, "probe_database_credentials", side_effect=env_owner.EnvironmentFailure("CAMPAIGN_DATABASE_AUTH_FAILED")), mock.patch.object(
                env_owner, "remove_disposable_postgres"
            ) as remove, mock.patch.object(env_owner, "cleanup_runtime_workspace") as cleanup, mock.patch.object(
                env_owner, "create_runtime_workspace", return_value=workspace
            ):
                with self.assertRaises(env_owner.EnvironmentFailure):
                    env_owner.prepare_environment(root, "http://localhost:4200", "http://127.0.0.1:18082", executable)
            remove.assert_called_once_with(handle)
            cleanup.assert_called_once_with(workspace)

    def test_runtime_storage_marker_is_64_hex_and_not_serialized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = env_owner.create_runtime_workspace(Path(directory))
            marker = workspace.storage_marker.read_text(encoding="utf-8")
            self.assertRegex(marker, r"\A[0-9a-f]{64}\Z")
            self.assertEqual(marker, workspace.storage_id)
            self.assertNotIn(marker, json.dumps(env_owner.workspace_summary(workspace)))

    def test_workspace_summary_uses_nearest_ancestor_config_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = env_owner.create_runtime_workspace(Path(directory))
            workspace.env_file.write_text("PORT=18082\n", encoding="utf-8")
            summary = env_owner.workspace_summary(workspace)
            self.assertEqual(summary["configAuthority"], "nearest-ancestor-dotenv")
            self.assertTrue(summary["nearestAncestorDotenv"])
            self.assertTrue(summary["fixtureCwdShared"])
            self.assertNotIn("../../.env", json.dumps(summary))

    def test_round_id_requires_formal_b90_m_round_and_has_no_default(self) -> None:
        self.assertEqual(env_owner.validate_round_id("B.90-R1.M21"), "B.90-R1.M21")
        for value in (None, "", "B.90-R1.M12-extra", "b.90-r1.m21", "B.90-R1", "../B.90-R1.M21"):
            with self.subTest(value=value), self.assertRaises(env_owner.EnvironmentFailure) as error:
                env_owner.validate_round_id(value)
            self.assertEqual(error.exception.code, "CAMPAIGN_ROUND_ID_INVALID")

    def test_missing_or_invalid_round_id_never_reaches_discovery_or_resources(self) -> None:
        for arguments in ([], ["--round-id"], ["--round-id", "wrong"]):
            with self.subTest(arguments=arguments), mock.patch.object(env_owner, "discover_canonical_tests") as discover, mock.patch.object(
                env_owner, "prepare_environment"
            ) as prepare:
                self.assertNotEqual(env_owner.main(arguments), 0)
            discover.assert_not_called()
            prepare.assert_not_called()

    def test_existing_artifact_root_is_rejected_before_discovery_or_docker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "already-there"
            output.mkdir()
            with mock.patch.object(env_owner, "repository_root", return_value=root), mock.patch.object(
                env_owner, "discover_canonical_tests"
            ) as discover, mock.patch.object(env_owner.shutil, "which") as which, mock.patch.object(
                env_owner, "prepare_environment"
            ) as prepare:
                result = env_owner.main(["--round-id", "B.90-R1.M21", "--output", str(output)])
            self.assertNotEqual(result, 0)
            self.assertTrue(output.is_dir())
            discover.assert_not_called()
            which.assert_not_called()
            prepare.assert_not_called()

    def test_preflight_rejects_invalid_discovery_before_docker_or_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "backend.exe"
            executable.write_bytes(b"backend")
            with mock.patch.object(env_owner.campaign, "endpoint_reachable", return_value=False), mock.patch.object(
                env_owner, "validate_playwright_config", return_value={"chromiumProject": True}
            ), mock.patch.object(
                env_owner, "discover_canonical_tests", return_value={"testsDiscovered": 4}
            ) as discover, mock.patch.object(env_owner.shutil, "which") as which, mock.patch.object(
                env_owner, "prepare_environment"
            ) as prepare:
                with self.assertRaises(env_owner.EnvironmentFailure) as error:
                    env_owner.preflight(
                        root,
                        "B.90-R1.M21",
                        5,
                        root / "new-output",
                        "http://localhost:4200",
                        "http://127.0.0.1:18082",
                        executable,
                    )
            self.assertEqual(error.exception.code, "CAMPAIGN_CANONICAL_DISCOVERY_INVALID")
            discover.assert_called_once()
            which.assert_not_called()
            prepare.assert_not_called()

    def test_preflight_runs_one_canonical_discovery_before_resource_creation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "backend.exe"
            executable.write_bytes(b"backend")
            discovery = {"testsDiscovered": 5, "workers": 1, "fullyParallel": False, "retries": 0, "executionStarted": False}
            with mock.patch.object(env_owner.campaign, "endpoint_reachable", return_value=False), mock.patch.object(
                env_owner, "validate_playwright_config", return_value={"chromiumProject": True}
            ), mock.patch.object(env_owner, "discover_canonical_tests", return_value=discovery) as discover, mock.patch.object(
                env_owner, "prepare_environment"
            ) as prepare:
                result = env_owner.preflight(
                    root,
                    "B.90-R1.M21",
                    5,
                    root / "new-output",
                    "http://localhost:4200",
                    "http://127.0.0.1:18082",
                    executable,
                )
            self.assertEqual(result["discovery"], discovery)
            self.assertEqual(result["preferredFrontendPort"], 4200)
            discover.assert_called_once()
            prepare.assert_not_called()

    def test_static_preflight_passes_without_a_running_frontend(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "backend.exe"
            executable.write_bytes(b"backend")
            with mock.patch.object(env_owner.campaign, "endpoint_reachable", return_value=False), mock.patch.object(
                env_owner, "validate_playwright_config", return_value={"chromiumProject": True}
            ), mock.patch.object(
                env_owner,
                "discover_canonical_tests",
                return_value={"testsDiscovered": 5, "executionStarted": False},
            ) as discover:
                result = env_owner.preflight(
                    root, "B.90-R1.M21", 5, root / "new-output", "http://127.0.0.1:4200",
                    "http://127.0.0.1:18082", executable,
                )
            self.assertEqual(result["preferredFrontendPort"], 4200)
            discover.assert_called_once()

    def test_owned_frontend_preference_rejects_non_ipv4_or_non_authority_inputs(self) -> None:
        self.assertEqual(env_owner._preferred_frontend_port("http://localhost:4300"), 4300)
        for url in (
            "https://127.0.0.1:4200", "http://[::1]:4200", "http://user@127.0.0.1:4200",
            "http://127.0.0.1:4200/path", "http://127.0.0.1:4200?x=1", "http://127.0.0.1",
        ):
            with self.subTest(url=url), self.assertRaises(env_owner.EnvironmentFailure) as error:
                env_owner._preferred_frontend_port(url)
            self.assertEqual(error.exception.code, "CAMPAIGN_FRONTEND_PREFERENCE_INVALID")

    def test_preflight_source_has_no_external_frontend_readiness_probe(self) -> None:
        source = Path(env_owner.__file__).read_text(encoding="utf-8")
        self.assertNotIn("_frontend_available", source)
        self.assertNotIn("from urllib.request import urlopen", source)

    def test_source_snapshot_includes_the_auxiliary_m20_playwright_config(self) -> None:
        self.assertIn("frontend/playwright.login-boundary.config.ts", env_owner.PROTECTED_FILES)

    def test_discovery_uses_canonical_npm_script_with_list_and_never_executes_specs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            completed = subprocess.CompletedProcess(
                ["npm"], 0, "Listing tests:\n  [chromium] › auth-vault.spec.ts\nTotal: 5 tests in 5 files\n", ""
            )
            runner = mock.Mock(return_value=completed)
            with mock.patch.object(env_owner.shutil, "which", return_value="npm.cmd") as which:
                result = env_owner.discover_canonical_tests(root, runner=runner)
            command = runner.call_args.args[0]
            self.assertEqual(command, ["npm.cmd", "run", "e2e:chromium", "--", "--list"])
            self.assertEqual(which.call_args.args[0], "npm.cmd")
            self.assertEqual(result["testsDiscovered"], 5)
            self.assertFalse(result["executionStarted"])
            self.assertNotIn("auth-vault.spec.ts", json.dumps(result))

    def test_artifact_decision_rejects_a_source_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "artifacts"
            output.mkdir()
            before = {"algorithm": "sha256", "files": {"source.ts": "a"}, "trees": {}}
            after = {"algorithm": "sha256", "files": {"source.ts": "b"}, "trees": {}}
            summary = {
                "passedRuns": 5,
                "canonicalRunsCompleted": 5,
                "failedRuns": 0,
                "runs": [{"canonical": {"passed": 5}} for _ in range(5)],
            }
            env_owner.write_campaign_artifacts(
                output,
                round_id="B.90-R1.M21",
                environment={},
                source_before=before,
                source_after=after,
                performance={"informationalOnly": True},
                result="PASS",
                failure_code=None,
                summary=summary,
                teardown_ok=True,
            )
            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            hashes = json.loads((output / "post" / "protected-hashes.json").read_text(encoding="utf-8"))
            self.assertEqual(decision["result"], "BLOCKED_CANONICAL_RATIFICATION")
            self.assertFalse(decision["sourceHashesMatch"])
            self.assertFalse(hashes["historicalHashesCompared"])
            self.assertFalse(hashes["matchesPreExecutionSnapshot"])
            self.assertTrue(hashes["protectedSourceChangedDuringExecution"])

    def test_two_started_and_stopped_backends_are_owned_even_when_campaign_stops_early(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "artifacts"
            output.mkdir()
            runs = [
                {
                    "index": 1,
                    "result": "PASS",
                    "canonical": {"total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0},
                    "backendTeardown": {"escalated": False},
                },
                {
                    "index": 2,
                    "result": "FAIL",
                    "failureCode": "CAMPAIGN_CANONICAL_FAILED",
                    "canonical": {"total": 5, "passed": 4, "failed": 1, "skipped": 0, "flaky": 0, "retries": 0},
                    "backendTeardown": {"escalated": False},
                },
            ]
            summary = {
                "plannedRuns": 5,
                "backendProcessesSpawned": 2,
                "backendGenerationsReady": 2,
                "canonicalRunsStarted": 2,
                "canonicalRunsCompleted": 2,
                "passedRuns": 1,
                "failedRuns": 1,
                "stoppedEarly": True,
                "retries": 0,
                "runs": runs,
            }
            env_owner.write_campaign_artifacts(
                output,
                round_id="B.90-R1.M22",
                environment={"postgresRemoved": True, "workspaceRemoved": True},
                source_before={"algorithm": "sha256", "files": {}, "trees": {}},
                source_after={"algorithm": "sha256", "files": {}, "trees": {}},
                performance={"informationalOnly": True},
                result="FAIL",
                failure_code="CAMPAIGN_CANONICAL_FAILED",
                summary=summary,
                teardown_ok=True,
            )

            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            report = (output / "final-report.md").read_text(encoding="utf-8")
            self.assertTrue(decision["ownership"]["allBackendsStopped"])
            self.assertEqual(decision["result"], "BLOCKED_CANONICAL_RATIFICATION")
            self.assertEqual(decision["findings"]["B90-F02"], "OPEN")
            self.assertEqual(decision["canonical"]["startedInvocations"], 2)
            self.assertEqual(decision["canonical"]["completedInvocations"], 2)
            self.assertEqual(decision["canonical"]["passedInvocations"], 1)
            self.assertEqual(decision["canonical"]["failedInvocations"], 1)
            self.assertEqual(decision["canonical"]["totalExecutions"], 10)
            self.assertEqual(decision["canonical"]["totalPassed"], 9)
            self.assertEqual(decision["canonical"]["totalFailed"], 1)
            self.assertIn("| 1 | PASS | 5/5 |", report)
            self.assertIn("| 2 | FAIL | 4/5 |", report)

    def test_started_backend_without_teardown_is_not_reported_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "artifacts"
            output.mkdir()
            env_owner.write_campaign_artifacts(
                output,
                round_id="B.90-R1.M22",
                environment={},
                source_before={"algorithm": "sha256", "files": {}, "trees": {}},
                source_after={"algorithm": "sha256", "files": {}, "trees": {}},
                performance={"informationalOnly": True},
                result="FAIL",
                failure_code="CAMPAIGN_CANONICAL_FAILED",
                summary={
                    "backendProcessesSpawned": 2,
                    "runs": [{"backendTeardown": {"escalated": False}}, {"result": "FAIL"}],
                },
                teardown_ok=True,
            )
            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            self.assertFalse(decision["ownership"]["allBackendsStopped"])

    def test_five_green_backend_generations_remain_all_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "artifacts"
            output.mkdir()
            env_owner.write_campaign_artifacts(
                output,
                round_id="B.90-R1.M22",
                environment={},
                source_before={"algorithm": "sha256", "files": {}, "trees": {}},
                source_after={"algorithm": "sha256", "files": {}, "trees": {}},
                performance={"informationalOnly": True},
                result="PASS",
                failure_code=None,
                summary={
                    "backendProcessesSpawned": 5,
                    "runs": [{"backendTeardown": {"escalated": False}} for _ in range(5)],
                },
                teardown_ok=True,
            )
            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            self.assertTrue(decision["ownership"]["allBackendsStopped"])

    def test_zero_spawned_backends_are_not_expanded_to_the_planned_run_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "artifacts"
            output.mkdir()
            env_owner.write_campaign_artifacts(
                output,
                round_id="B.90-R1.M22",
                environment={},
                source_before={"algorithm": "sha256", "files": {}, "trees": {}},
                source_after={"algorithm": "sha256", "files": {}, "trees": {}},
                performance={"informationalOnly": True},
                result="BLOCKED_PREFLIGHT",
                failure_code="CAMPAIGN_FRONTEND_NOT_READY",
                summary={"plannedRuns": 5, "backendProcessesSpawned": 0, "runs": []},
                teardown_ok=True,
            )
            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            self.assertEqual(decision["ownership"]["backendGenerations"], 0)
            self.assertTrue(decision["ownership"]["allBackendsStopped"])
            self.assertEqual(decision["result"], "BLOCKED_CANONICAL_RATIFICATION")

    def test_campaign_receives_isolated_storage_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = env_owner.RuntimeWorkspace(
                root,
                root / ".env",
                root / "work" / "run",
                root / "storage",
                root / "storage" / ".nanika-e2e-storage-id",
                "a" * 64,
            )
            lease = env_owner.EnvironmentLease(
                env_owner.PostgresHandle("a" * 64, 49123, self.credentials()),
                workspace,
                {"backendExecutablePresent": True},
                {
                    "NANIKA_E2E_STORAGE_PATH": str(workspace.storage_root),
                    "NANIKA_E2E_STORAGE_ID": workspace.storage_id,
                    "NANIKA_E2E_FIXTURE_CWD": str(workspace.cwd),
                },
            )
            seen: dict[str, str | None] = {}
            run_summary = {
                "result": "PASS", "plannedRuns": 5, "backendStartAttempts": 5,
                "backendProcessesSpawned": 5, "backendGenerationsReady": 5,
                "canonicalRunsStarted": 5, "canonicalRunsCompleted": 5,
                "passedRuns": 5, "failedRuns": 0, "retries": 0, "stoppedEarly": False,
                "runs": [
                    {
                        "index": index,
                        "result": "PASS",
                        "canonical": {"total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0},
                        "backendTeardown": {"escalated": False},
                    }
                    for index in range(1, 6)
                ],
            }
            readiness = env_owner.frontend_owner.FrontendReadinessObservation(True, True, False, True, None, 12, None)
            generation = env_owner.frontend_owner.FrontendGeneration(
                mock.Mock(), "http://127.0.0.1:43123", 43123, False, readiness=readiness
            )

            def campaign_stub(*args, **kwargs):
                seen.update({key: os.environ.get(key) for key in lease.e2e_environment})
                seen["NANIKA_E2E_BASE_URL"] = os.environ.get("NANIKA_E2E_BASE_URL")
                self.assertEqual(args[2], generation.url)
                self.assertEqual(kwargs["runs"], 5)
                self.assertEqual(kwargs["round_id"], "B.90-R1.M21")
                return run_summary

            output = root / "output"
            with mock.patch.dict(
                os.environ,
                {
                    "NANIKA_E2E_BACKEND_EXE": str(root / "savebox-server.exe"),
                    "NANIKA_E2E_STORAGE_PATH": "original-storage",
                    "NANIKA_E2E_STORAGE_ID": "b" * 64,
                    "NANIKA_E2E_FIXTURE_CWD": "original-fixture-cwd",
                    "NANIKA_E2E_BASE_URL": "http://localhost:4200",
                },
                clear=False,
            ), mock.patch.object(env_owner, "repository_root", return_value=root), mock.patch.object(
                env_owner, "preflight", return_value={"roundId": "B.90-R1.M21", "preferredFrontendPort": 4200, "discovery": {"testsDiscovered": 5, "workers": 1, "fullyParallel": False, "retries": 0, "executionStarted": False}}
            ) as preflight, mock.patch.object(
                env_owner, "capture_campaign_hashes", return_value={"algorithm": "sha256", "files": {}, "trees": {}}
            ), mock.patch.object(recovery_owner, "probe_docker_runtime", return_value={"cliAvailable": True, "daemonAvailable": True}) as docker_check, mock.patch.object(recovery_owner, "container_snapshot", side_effect=[{"b" * 64: "running"}, {"b" * 64: "running", "c" * 64: "created"}]) as inventory, mock.patch.object(
                env_owner.frontend_owner, "resolve_frontend_tooling", return_value=("node", root / "ng.js")
            ), mock.patch.object(
                env_owner.frontend_owner, "reserve_frontend_port", return_value=mock.Mock(socket=mock.Mock(), port=4200, preferred=True)
            ), mock.patch.object(
                env_owner.frontend_owner, "spawn_frontend", return_value=generation
            ), mock.patch.object(
                env_owner.frontend_owner, "wait_frontend_ready", return_value=generation
            ), mock.patch.object(
                env_owner.frontend_owner, "stop_frontend", return_value=False
            ) as stop_frontend, mock.patch.object(
                env_owner, "prepare_environment", return_value=lease
            ) as prepare, mock.patch.object(
                env_owner.campaign, "run_campaign", side_effect=campaign_stub
            ) as run_campaign, mock.patch.object(env_owner, "remove_disposable_postgres") as remove, mock.patch.object(
                env_owner, "cleanup_runtime_workspace"
            ) as cleanup:
                self.assertEqual(env_owner.main(["--round-id", "B.90-R1.M21", "--output", str(output)]), 0)
                self.assertEqual(os.environ["NANIKA_E2E_STORAGE_PATH"], "original-storage")
                self.assertEqual(os.environ["NANIKA_E2E_STORAGE_ID"], "b" * 64)
                self.assertEqual(os.environ["NANIKA_E2E_FIXTURE_CWD"], "original-fixture-cwd")
                self.assertEqual(os.environ["NANIKA_E2E_BASE_URL"], "http://localhost:4200")
            self.assertEqual({key: seen[key] for key in lease.e2e_environment}, lease.e2e_environment)
            self.assertNotIn("NANIKA_BIND_ADDRESS", lease.e2e_environment)
            self.assertNotIn("NANIKA_BIND_ADDRESS", seen)
            self.assertEqual(seen["NANIKA_E2E_BASE_URL"], generation.url)
            preflight.assert_called_once()
            docker_check.assert_called_once_with()
            self.assertEqual(inventory.call_count, 2)
            prepare.assert_called_once_with(root, generation.url, "http://127.0.0.1:18082", root / "savebox-server.exe")
            run_campaign.assert_called_once()
            stop_frontend.assert_called_once_with(generation)
            remove.assert_called_once_with(lease.postgres)
            cleanup.assert_called_once_with(lease.workspace)
            discovery = json.loads((output / "discovery" / "canonical.json").read_text(encoding="utf-8"))
            self.assertEqual(discovery["round"], "B.90-R1.M21")
            environment_result = (output / "environment" / "result.json").read_text(encoding="utf-8")
            self.assertNotIn("http://", environment_result)
            self.assertNotIn("43123", environment_result)
            pipeline = json.loads((output / "performance" / "pipeline.json").read_text(encoding="utf-8"))
            self.assertTrue(pipeline["informationalOnly"])
            self.assertIn("preflightMs", pipeline["pipeline"])
            self.assertIn("frontendStartupMs", pipeline["pipeline"])
            self.assertIn("frontendTeardownMs", pipeline["pipeline"])

    def test_frontend_readiness_failure_skips_postgres_and_stops_owned_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generation = env_owner.frontend_owner.FrontendGeneration(
                mock.Mock(), "http://127.0.0.1:43123", 43123, False
            )
            output = root / "output"
            with mock.patch.dict(os.environ, {"NANIKA_E2E_BACKEND_EXE": str(root / "backend.exe")}), mock.patch.object(
                env_owner, "repository_root", return_value=root
            ), mock.patch.object(
                env_owner, "preflight", return_value={"preferredFrontendPort": 4200, "discovery": {"testsDiscovered": 5}}
            ), mock.patch.object(
                env_owner, "capture_campaign_hashes", return_value={"algorithm": "sha256", "files": {}, "trees": {}}
            ), mock.patch.object(recovery_owner, "probe_docker_runtime", return_value={"cliAvailable": True, "daemonAvailable": True}), mock.patch.object(recovery_owner, "container_snapshot", return_value={"b" * 64: "running"}), mock.patch.object(
                env_owner.frontend_owner, "resolve_frontend_tooling", return_value=("node", root / "ng.js")
            ), mock.patch.object(
                env_owner.frontend_owner, "reserve_frontend_port", return_value=mock.Mock(socket=mock.Mock(), port=4200, preferred=True)
            ), mock.patch.object(
                env_owner.frontend_owner, "spawn_frontend", return_value=generation
            ), mock.patch.object(
                env_owner.frontend_owner,
                "wait_frontend_ready",
                side_effect=env_owner.frontend_owner.FrontendOwnershipFailure("FRONTEND_LISTENER_TIMEOUT"),
            ), mock.patch.object(env_owner.frontend_owner, "stop_frontend", return_value=False) as stop, mock.patch.object(
                env_owner, "prepare_environment"
            ) as prepare, mock.patch.object(env_owner.campaign, "run_campaign") as run_campaign:
                self.assertEqual(env_owner.main(["--round-id", "B.90-R1.M21", "--output", str(output)]), 1)
            prepare.assert_not_called()
            run_campaign.assert_not_called()
            stop.assert_called_once_with(generation)
            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            self.assertEqual(decision["result"], "BLOCKED_OWNED_FRONTEND_READINESS")
            self.assertFalse(decision["canonical"]["startedInvocations"])

    def test_campaign_teardown_attempts_workspace_and_frontend_after_database_cleanup_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = env_owner.RuntimeWorkspace(root, root / ".env", root / "work" / "run", root / "storage", root / "marker", "a" * 64)
            lease = env_owner.EnvironmentLease(
                env_owner.PostgresHandle("a" * 64, 49123, self.credentials()),
                workspace,
                {},
                {"NANIKA_E2E_STORAGE_PATH": str(workspace.storage_root)},
            )
            readiness = env_owner.frontend_owner.FrontendReadinessObservation(True, True, True, True, 1, 2, None)
            generation = env_owner.frontend_owner.FrontendGeneration(
                mock.Mock(), "http://127.0.0.1:43123", 43123, False, readiness=readiness
            )
            events: list[str] = []

            def fail_campaign(*_args, **_kwargs):
                events.append("campaign")
                raise env_owner.campaign.CampaignFailure("CAMPAIGN_CANONICAL_FAILED")

            def fail_postgres_cleanup(*_args):
                events.append("postgres")
                raise env_owner.EnvironmentFailure("CAMPAIGN_TEARDOWN_FAILED")

            output = root / "output"
            with mock.patch.dict(os.environ, {"NANIKA_E2E_BACKEND_EXE": str(root / "backend.exe")}), mock.patch.object(
                env_owner, "repository_root", return_value=root
            ), mock.patch.object(
                env_owner, "preflight", return_value={"preferredFrontendPort": 4200, "discovery": {"testsDiscovered": 5}}
            ), mock.patch.object(
                env_owner, "capture_campaign_hashes", return_value={"algorithm": "sha256", "files": {}, "trees": {}}
            ), mock.patch.object(recovery_owner, "probe_docker_runtime", return_value={"cliAvailable": True, "daemonAvailable": True}), mock.patch.object(recovery_owner, "container_snapshot", return_value={"b" * 64: "running"}), mock.patch.object(
                env_owner.frontend_owner, "resolve_frontend_tooling", return_value=("node", root / "ng.js")
            ), mock.patch.object(
                env_owner.frontend_owner, "reserve_frontend_port", return_value=mock.Mock(socket=mock.Mock(), port=4200, preferred=True)
            ), mock.patch.object(
                env_owner.frontend_owner, "spawn_frontend", return_value=generation
            ), mock.patch.object(env_owner.frontend_owner, "wait_frontend_ready", return_value=generation), mock.patch.object(
                env_owner, "prepare_environment", return_value=lease
            ), mock.patch.object(env_owner.campaign, "run_campaign", side_effect=fail_campaign), mock.patch.object(
                env_owner, "remove_disposable_postgres", side_effect=fail_postgres_cleanup
            ), mock.patch.object(
                env_owner, "cleanup_runtime_workspace", side_effect=lambda *_: events.append("workspace")
            ), mock.patch.object(
                env_owner.frontend_owner, "stop_frontend", side_effect=lambda *_: events.append("frontend") or False
            ):
                self.assertEqual(env_owner.main(["--round-id", "B.90-R1.M21", "--output", str(output)]), 1)
            self.assertEqual(events, ["campaign", "postgres", "workspace", "frontend"])
            environment = json.loads((output / "environment" / "result.json").read_text(encoding="utf-8"))
            self.assertFalse(environment["postgresRemoved"])
            self.assertTrue(environment["workspaceRemoved"])
            self.assertTrue(environment["frontendStopped"])
            decision = json.loads((output / "ratification-decision.json").read_text(encoding="utf-8"))
            self.assertEqual(decision["result"], "BLOCKED_RESOURCE_TEARDOWN")

    def test_stale_m12_provenance_is_absent_and_round_is_not_hardcoded(self) -> None:
        source = Path(env_owner.__file__).read_text(encoding="utf-8")
        self.assertNotIn("B.90-R1.M12", source)
        self.assertNotIn('"round": "B.', source)

    def test_source_hashes_are_relative_and_do_not_compare_m19_history(self) -> None:
        source = Path(env_owner.__file__).read_text(encoding="utf-8")
        self.assertIn('source_before.get("historicalArtifacts")', source)
        self.assertIn('"baseline" / "protected-hashes.json"', source)
        self.assertIn('"post" / "protected-hashes.json"', source)

    def test_protected_hash_snapshot_is_stable_relative_and_detects_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "src" / "module.cpp").write_text("before", encoding="utf-8")
            (root / "runner.py").write_text("runner", encoding="utf-8")
            with mock.patch.object(env_owner, "PROTECTED_TREES", ("src",)), mock.patch.object(
                env_owner, "PROTECTED_FILES", ("runner.py",)
            ):
                before = env_owner.capture_source_hashes(root)
                same = env_owner.capture_source_hashes(root)
                (root / "src" / "module.cpp").write_text("after", encoding="utf-8")
                after = env_owner.capture_source_hashes(root)
            self.assertEqual(before, same)
            self.assertNotEqual(before, after)
            self.assertEqual(set(before["files"]), {"runner.py"})
            self.assertEqual(set(before["trees"]), {"src"})
            self.assertNotIn(str(root), json.dumps(before))

    def test_source_does_not_use_global_user_container_teardown(self) -> None:
        source = Path(env_owner.__file__).read_text(encoding="utf-8")
        for forbidden in ("docker compose down", "docker restart nanika_api", "docker stop nanika_postgres", "docker rm nanika_postgres"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
