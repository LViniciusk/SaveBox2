"""Unit tests for the stdlib-only backend process sharder."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


sys.path.insert(0, str(Path(__file__).parent))
import run_backend_shards as runner  # noqa: E402


REPORT = """<?xml version="1.0"?>
<Catch2TestRun>
  <TestCase name="case-a"><OverallResult success="true" /></TestCase>
  <TestCase name="case-b"><OverallResult success="true" /></TestCase>
  <OverallResults successes="7" failures="0" expectedFailures="0" skips="0" />
  <OverallResultsCases successes="2" failures="0" expectedFailures="0" skips="0" />
</Catch2TestRun>
"""


class BackendShardRunnerTests(unittest.TestCase):
    def test_database_names_are_unique_and_bounded(self) -> None:
        self.assertEqual(runner.safe_database_name("a1b2c3", 0), "nanika_shard_a1b2c3_0")
        self.assertNotEqual(runner.safe_database_name("a1b2c3", 0), runner.safe_database_name("a1b2c3", 1))
        self.assertTrue(runner.is_safe_database_name("nanika_shard_a1b2c3_3"))
        for unsafe in ("test_db", "postgres", "foo-bar", "../../x"):
            self.assertFalse(runner.is_safe_database_name(unsafe))

    def test_invalid_shard_count_is_rejected(self) -> None:
        for count in (0, 5, -1):
            with self.assertRaises(ValueError):
                runner.validate_shard_count(count)

    def test_only_explicit_loopback_hosts_are_local(self) -> None:
        for host in ("127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"):
            self.assertTrue(runner.is_local_database_host({"DB_HOST": host}), host)
        for host in ("10.0.0.10", "192.168.1.50", "postgres.example.com", "db.internal"):
            self.assertFalse(runner.is_local_database_host({"DB_HOST": host}), host)
        self.assertTrue(runner.is_local_database_host({}))

    def test_dotenv_and_shard_overrides_do_not_log_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env = root / ".env"
            env.write_text("DB_NAME=base\nDB_PASSWORD=secret\nNANIKA_STORAGE_PATH=old\n", encoding="utf-8")
            blocklist = root / "disposable_domains.txt"
            blocklist.write_text("example.invalid\n", encoding="utf-8")
            config = runner.read_dotenv(env)
            shard_root = root / "run" / "backend" / "shard-0"
            cwd = runner.create_shard_workspace(shard_root, config, "nanika_shard_a1b2c3_0", blocklist)
            shard_env = runner.read_dotenv(shard_root / ".env")
            self.assertEqual(shard_env["DB_PASSWORD"], "secret")
            self.assertEqual(shard_env["DB_NAME"], "nanika_shard_a1b2c3_0")
            self.assertEqual(shard_env["NANIKA_STORAGE_PATH"], "./savebox_storage/")
            self.assertEqual((cwd / "../../.env").resolve(), (shard_root / ".env").resolve())
            self.assertEqual(
                (cwd / "../../config/disposable_domains.txt").resolve(),
                (shard_root / "config" / "disposable_domains.txt").resolve(),
            )
            self.assertEqual((shard_root / "config" / "disposable_domains.txt").read_text(encoding="utf-8"), "example.invalid\n")
            report = runner._process_summary(
                runner.ShardResult(0, "nanika_shard_a1b2c3_0", "backend/shard-0/work/run", root / "log", root / "report", 0.1, 0, None, False, {"cases": 2, "assertions": 7, "case_failures": 0, "assertion_failures": 0, "expected_failures": 0, "names": ["case-a", "case-b"]}),
                root,
            )
            self.assertNotIn("secret", str(report))

    def test_native_db_arguments_keep_password_out_of_argv(self) -> None:
        admin = runner.PostgresAdmin("native", createdb="createdb", dropdb="dropdb")
        config = {"DB_USER": "tester", "DB_PASSWORD": "secret", "DB_HOST": "127.0.0.1", "DB_PORT": "5433"}
        command, environment = runner._admin_command(admin, "create", "nanika_shard_a1b2c3_0", config)
        self.assertNotIn("secret", command)
        self.assertEqual(environment["PGPASSWORD"], "secret")
        self.assertIn("--owner", command)
        with mock.patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            runner.create_database(admin, "nanika_shard_a1b2c3_0", config, Path("."))
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertNotIn("secret", str(run.call_args.args[0]))

    def test_docker_provider_uses_argv_and_internal_name(self) -> None:
        admin = runner.PostgresAdmin("docker", docker="docker", compose_service="postgres-db")
        command, environment = runner._admin_command(admin, "drop", "nanika_shard_a1b2c3_1", {"DB_USER": "tester", "DB_PASSWORD": "secret"})
        self.assertEqual(command[:5], ["docker", "compose", "exec", "-T", "postgres-db"])
        self.assertIn("dropdb", command)
        self.assertNotIn("secret", command)
        self.assertNotIn("secret", environment)
        with self.assertRaises(ValueError):
            runner._admin_command(admin, "drop", "postgres", {"DB_USER": "tester"})

    def test_catch2_capabilities_and_command_use_same_seed(self) -> None:
        help_result = SimpleNamespace(stdout="--shard-count N --shard-index I", stderr="", returncode=0)
        reporter_result = SimpleNamespace(stdout="XML: compact", stderr="", returncode=0)
        with mock.patch.object(runner.subprocess, "run", side_effect=[help_result, reporter_result]):
            capabilities = runner.detect_catch2_capabilities(Path("savebox_tests.exe"), Path("."))
        self.assertTrue(capabilities.native_sharding)
        self.assertTrue(capabilities.xml_reporter)
        command = runner.build_shard_command(Path("savebox_tests.exe"), Path("report.xml"), 60201, 2, 1, capabilities)
        self.assertIn("--rng-seed", command)
        self.assertEqual(command[command.index("--rng-seed") + 1], "60201")
        self.assertEqual(command[command.index("--shard-count") + 1], "2")
        self.assertEqual(command[command.index("--shard-index") + 1], "1")

    def test_missing_native_sharding_falls_back_to_one_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            run_root = runner.create_run_root(root)
            result = runner.ShardResult(0, "base-existing", "backend/build", run_root / "logs" / "log", run_root / "reports" / "report", 0.1, 0, None, False, {"cases": 1, "case_successes": 1, "case_failures": 0, "assertions": 1, "assertion_successes": 1, "assertion_failures": 0, "expected_failures": 0, "names": ["case-a"]})
            with mock.patch.object(runner, "detect_catch2_capabilities", return_value=runner.Catch2Capabilities(False, True)), mock.patch.object(runner, "_single_process", return_value=[result]):
                output = runner.execute_backend(root, binary, 2, 60201, run_root)
        self.assertEqual(output["effective_shards"], 1)
        self.assertEqual(output["reason"], "catch2_native_sharding_unavailable")
        self.assertEqual(output["status"], "passed")

    def test_remote_database_disables_provisioning_before_provider_discovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".env").write_text("DB_USER=tester\nDB_NAME=base\nDB_HOST=postgres.example.com\n", encoding="utf-8")
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            run_root = runner.create_run_root(root)
            result = runner.ShardResult(0, "base-existing", "backend/build", run_root / "logs" / "log", run_root / "reports" / "report", 0.1, 0, None, False, {"cases": 1, "case_successes": 1, "case_failures": 0, "assertions": 1, "assertion_successes": 1, "assertion_failures": 0, "expected_failures": 0, "names": ["case-a"]})
            with mock.patch.object(runner, "discover_postgres_admin") as discover, mock.patch.object(runner, "create_database") as create, mock.patch.object(runner, "drop_database") as drop, mock.patch.object(runner, "_single_process", return_value=[result]) as single:
                output = runner.execute_backend(root, binary, 2, 60201, run_root)
        self.assertEqual(output["effective_shards"], 1)
        self.assertEqual(output["reason"], "remote_database_sharding_disabled")
        discover.assert_not_called()
        create.assert_not_called()
        drop.assert_not_called()
        single.assert_called_once()

    def test_xml_parser_aggregates_and_rejects_duplicates_or_missing_reports(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first.xml"
            first.write_text(REPORT, encoding="utf-8")
            parsed = runner.parse_catch_report(first)
            self.assertEqual(parsed["cases"], 2)
            self.assertEqual(parsed["assertions"], 7)
            duplicate = root / "duplicate.xml"
            duplicate.write_text(REPORT.replace('name="case-b"', 'name="case-a"'), encoding="utf-8")
            with self.assertRaises(ValueError):
                runner.parse_catch_report(duplicate)
            with self.assertRaises(ValueError):
                runner.parse_catch_report(root / "missing.xml")
            second = root / "second.xml"
            second.write_text(REPORT.replace('name="case-a"', 'name="case-c"').replace('name="case-b"', 'name="case-d"'), encoding="utf-8")
            results = [
                runner.ShardResult(0, "db0", "cwd0", root / "l0", first, 0.1, 0, None, False, parsed),
                runner.ShardResult(1, "db1", "cwd1", root / "l1", second, 0.1, 0, None, False, runner.parse_catch_report(second)),
            ]
            aggregate = runner.aggregate_reports(results)
            self.assertEqual(aggregate["cases"], 4)
            self.assertEqual(aggregate["assertions"], 14)
            overlapping = dataclasses_replace(results[1], report=parsed)
            with self.assertRaises(ValueError):
                runner.aggregate_reports([results[0], overlapping])

    def test_child_failure_is_not_retried_and_cleanup_runs_once(self) -> None:
        failed_report = {"cases": 1, "case_successes": 0, "case_failures": 1, "assertions": 1, "assertion_successes": 0, "assertion_failures": 1, "expected_failures": 0, "names": ["case-a"]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            (root / "config" / "disposable_domains.txt").write_text("example.invalid\n", encoding="utf-8")
            (root / ".env").write_text("DB_USER=tester\nDB_NAME=base\n", encoding="utf-8")
            binary = root / "savebox_tests.exe"
            binary.write_text("fake", encoding="utf-8")
            run_root = runner.create_run_root(root)
            failed = runner.ShardResult(0, "nanika_shard_a1b2c3_0", "backend/shard-0/work/run", run_root / "logs" / "log", run_root / "reports" / "report", 0.1, 1, None, False, failed_report)
            admin = runner.PostgresAdmin("native", createdb="createdb", dropdb="dropdb")
            with mock.patch.object(runner, "detect_catch2_capabilities", return_value=runner.Catch2Capabilities(True, True)), mock.patch.object(runner, "discover_postgres_admin", return_value=admin), mock.patch.object(runner, "create_database") as create, mock.patch.object(runner, "drop_database") as drop, mock.patch.object(runner, "_run_processes", return_value=[failed]) as processes:
                output = runner.execute_backend(root, binary, 2, 60201, run_root)
        self.assertEqual(output["status"], "failed")
        self.assertEqual(processes.call_count, 1)
        self.assertEqual(create.call_count, 2)
        self.assertEqual(drop.call_count, 2)

    def test_windows_exception_status_is_normalized(self) -> None:
        with mock.patch.object(runner.os, "name", "nt"):
            code_hex, aborted = runner.normalize_exit_code(-1073740940)
        self.assertEqual(code_hex, "0xC0000374")
        self.assertTrue(aborted)

    def test_one_shard_command_does_not_add_shard_flags(self) -> None:
        command = runner.build_shard_command(Path("savebox_tests"), Path("report.xml"), 60201, 1, 0, runner.Catch2Capabilities(False, True))
        self.assertNotIn("--shard-count", command)
        self.assertNotIn("--shard-index", command)


def dataclasses_replace(value: runner.ShardResult, **changes: object) -> runner.ShardResult:
    return runner.dataclasses.replace(value, **changes)


if __name__ == "__main__":
    unittest.main()
