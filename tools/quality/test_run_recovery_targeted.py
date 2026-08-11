"""Focused tests for the M27 recovery owner and schema-5 evidence boundaries."""

from __future__ import annotations

import json
import hashlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from types import SimpleNamespace
from contextlib import ExitStack

sys.path.insert(0, str(Path(__file__).parent))
import run_recovery_targeted as target


class RecoveryTargetTests(unittest.TestCase):
    def test_reporter_is_stats_only_and_cannot_be_causal_authority(self) -> None:
        report = {"stats": {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0},
                  "attachments": [{"name": "recovery-diagnostic", "body": "SECRET_SENTINEL"}]}
        summary = target.summarize_report(json.dumps(report), 0)
        self.assertEqual(summary["status"], "PASS")
        self.assertTrue(summary["reportValid"])
        self.assertNotIn("SECRET_SENTINEL", json.dumps(summary))

    def test_invalid_report_is_separate_from_journal_classification(self) -> None:
        summary = target.summarize_report("not-json", 1)
        self.assertEqual(summary["status"], "FAIL")
        self.assertFalse(summary["reportValid"])

    def test_loopback_listener_requires_exact_address_and_owned_pid(self) -> None:
        output = "  TCP    127.0.0.1:18082     0.0.0.0:0      LISTENING       1234\n"
        runner = mock.Mock(return_value=type("Result", (), {"returncode": 0, "stdout": output})())
        with mock.patch.object(target.os, "name", "nt"):
            evidence = target.owned_loopback_listener(18082, 1234, runner=runner)
        self.assertTrue(evidence["listenerOwnedByProcess"])

    def test_wildcard_listener_is_rejected(self) -> None:
        output = "  TCP    0.0.0.0:18082     0.0.0.0:0      LISTENING       1234\n"
        runner = mock.Mock(return_value=type("Result", (), {"returncode": 0, "stdout": output})())
        with mock.patch.object(target.os, "name", "nt"):
            with self.assertRaises(target.TargetFailure) as error:
                target.owned_loopback_listener(18082, 1234, runner=runner)
        self.assertEqual(error.exception.code, "LISTENER_BIND_PROOF_FAILED")


class DockerRuntimeTests(unittest.TestCase):
    def test_missing_cli_does_not_query_server(self) -> None:
        which, runner = mock.Mock(return_value=None), mock.Mock()
        with self.assertRaises(target.TargetFailure) as error:
            target.probe_docker_runtime(which=which, runner=runner)
        self.assertEqual(error.exception.code, "DOCKER_CLI_UNAVAILABLE")
        which.assert_called_once_with("docker")
        runner.assert_not_called()

    def test_nonzero_server_exit_is_daemon_unavailable_without_stderr_inspection(self) -> None:
        runner = mock.Mock(return_value=SimpleNamespace(returncode=1, stdout="", stderr="UNSAFE_SENTINEL"))
        with self.assertRaises(target.TargetFailure) as error:
            target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
        self.assertEqual(error.exception.code, "DOCKER_DAEMON_UNAVAILABLE")
        self.assertNotIn("UNSAFE_SENTINEL", str(error.exception))
        runner.assert_called_once()

    def test_server_exceptions_are_daemon_unavailable(self) -> None:
        for exception in (OSError("UNSAFE_SENTINEL"), subprocess.TimeoutExpired("docker", 15)):
            runner = mock.Mock(side_effect=exception)
            with self.assertRaises(target.TargetFailure) as error:
                target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
            self.assertEqual(error.exception.code, "DOCKER_DAEMON_UNAVAILABLE")
            self.assertNotIn("UNSAFE_SENTINEL", str(error.exception))

    def test_empty_server_proof_is_invalid(self) -> None:
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=" \n"))
        with self.assertRaises(target.TargetFailure) as error:
            target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
        self.assertEqual(error.exception.code, "DOCKER_DAEMON_PROOF_INVALID")

    def test_malformed_server_proof_is_invalid(self) -> None:
        for output in ("29.1\n29.2", "C:/UNSAFE_SENTINEL", "1" * 65, None):
            runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=output))
            with self.assertRaises(target.TargetFailure) as error:
                target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
            self.assertEqual(error.exception.code, "DOCKER_DAEMON_PROOF_INVALID")

    def test_valid_read_only_server_proof_persists_only_booleans(self) -> None:
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout="29.1.0-beta.1+build\n"))
        proof = target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
        self.assertEqual(proof, {"cliAvailable": True, "daemonAvailable": True})
        self.assertEqual(runner.call_args.args[0], ["docker", "version", "--format", "{{.Server.Version}}"])
        self.assertEqual(runner.call_args.kwargs["timeout"], 15)
        self.assertFalse(runner.call_args.kwargs["shell"])
        self.assertNotIn("29.1", json.dumps(proof))

    def test_daemon_proof_then_valid_inventory(self) -> None:
        runner = mock.Mock(side_effect=[SimpleNamespace(returncode=0, stdout="29.1.0"),
                                        SimpleNamespace(returncode=0, stdout="a" * 64 + " running\n")])
        target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
        self.assertEqual(target.container_snapshot(runner=runner), {"a" * 64: "running"})
        self.assertEqual(runner.call_count, 2)

    def test_daemon_proof_then_inventory_failure_stays_distinct(self) -> None:
        runner = mock.Mock(side_effect=[SimpleNamespace(returncode=0, stdout="29.1.0"),
                                        SimpleNamespace(returncode=1, stdout="", stderr="UNSAFE_SENTINEL")])
        target.probe_docker_runtime(which=lambda name: "docker", runner=runner)
        with self.assertRaises(target.TargetFailure) as error:
            target.container_snapshot(runner=runner)
        self.assertEqual(error.exception.code, "PREEXISTING_RESOURCE_PROOF_UNAVAILABLE")


class DurableRecoveryJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.path = self.root / "recovery-continuation.journal.jsonl"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def complete_events() -> list[dict[str, object]]:
        return [
            {"kind": "phase-start", "phase": "initial"},
            {"kind": "phase-start", "phase": "recovery"},
            {"kind": "instrumentation-installed", "phase": "recovery"},
            {"kind": "recovery-upload-start", "phase": "recovery"},
            {"kind": "chunk-response", "phase": "recovery", "statusClass": "2xx"},
            {"kind": "chunk-finished", "phase": "recovery"},
            {"kind": "chunk-observable-subscribed", "phase": "recovery"},
            {"kind": "chunk-observable-next", "phase": "recovery"},
            {"kind": "store-progress-100", "phase": "recovery"},
            {"kind": "upload-engine-resolved", "phase": "recovery"},
            {"kind": "run-upload-loop-enter", "phase": "recovery", "generationCurrent": True},
            {"kind": "run-upload-loop-resolved", "phase": "recovery", "generationCurrent": True},
            {"kind": "terminal-success-applied", "phase": "recovery", "present": True, "state": "success", "progressClass": "100"},
            {"kind": "store-state-snapshot", "phase": "recovery", "present": True, "state": "success", "progressClass": "100"},
            {"kind": "dom-success-observed", "phase": "recovery"},
        ]

    def write_journal(self, events: list[dict[str, object]]) -> None:
        records = [{"schema": target.RECOVERY_JOURNAL_SCHEMA, "kind": "journal-start"}, *events]
        self.path.write_text("".join(json.dumps(item) + "\n" for item in records), encoding="utf-8")

    def test_valid_journal_classifies_even_when_report_has_no_attachment(self) -> None:
        self.write_journal(self.complete_events())
        report = {"stats": {"expected": 0, "unexpected": 1, "skipped": 0, "flaky": 0}}
        summary = target.summarize_report(json.dumps(report), 1)
        evidence = target.parse_recovery_journal(self.path, self.root)
        self.assertEqual(summary["status"], "FAIL")
        self.assertEqual(evidence["classifier"], target.PASS_CLASS)
        self.assertTrue(evidence["journalValid"])

    def test_success_then_removed_with_dom_hidden_is_temporal_pass(self) -> None:
        events = [event for event in self.complete_events() if event["kind"] != "dom-success-observed"]
        events.extend([
            {"kind": "store-state-snapshot", "phase": "recovery", "present": False, "state": "unknown", "progressClass": "unknown"},
            {"kind": "dom-terminal-hidden", "phase": "recovery"},
        ])
        self.write_journal(events)
        parsed = target.parse_recovery_journal(self.path, self.root)
        self.assertEqual(parsed["classifier"], target.PASS_CLASS)
        self.assertTrue(parsed["evidence"]["storeRemovedAfterSuccess"])
        self.assertTrue(parsed["evidence"]["domHiddenAfterSuccess"])
        self.assertEqual(parsed["schema"], target.RECOVERY_JOURNAL_SCHEMA)

    def test_terminal_payload_is_the_success_authority(self) -> None:
        for state, present, progress in (("paused", True, "50-99"), ("unknown", False, "unknown")):
            events = [event for event in self.complete_events() if event["kind"] not in {"store-state-snapshot", "dom-success-observed"}]
            for event in events:
                if event["kind"] == "terminal-success-applied":
                    event.update(present=present, state=state, progressClass=progress)
            self.write_journal(events)
            parsed = target.parse_recovery_journal(self.path, self.root)
            self.assertEqual(parsed["classifier"], "M23_TERMINAL_PUBLICATION_WITHOUT_STORE_SUCCESS")
            self.assertFalse(parsed["evidence"]["storeSuccessObserved"])
            contradictory = {**parsed["evidence"], "storeSuccessObserved": True}
            self.assertEqual(target.classify_recovery_continuation(contradictory), "M23_EVIDENCE_INVALID")
            self.write_journal([*events, {"kind": "store-state-snapshot", "phase": "recovery",
                                        "present": True, "state": "success", "progressClass": "100"}])
            self.assertFalse(target.parse_recovery_journal(self.path, self.root)["journalValid"])

    def test_store_regression_and_reappearance_fail_closed(self) -> None:
        for state in ("paused", "processing", "error", "cancelled"):
            for removed in (False, True):
                with self.subTest(state=state, removed=removed):
                    events = self.complete_events()
                    if removed:
                        events.extend([
                            {"kind": "store-state-snapshot", "phase": "recovery", "present": False, "state": "unknown", "progressClass": "unknown"},
                            {"kind": "dom-terminal-hidden", "phase": "recovery"},
                        ])
                    events.append({"kind": "store-state-snapshot", "phase": "recovery", "present": True,
                                   "state": state, "progressClass": "50-99"})
                    self.write_journal(events)
                    parsed = target.parse_recovery_journal(self.path, self.root)
                    self.assertTrue(parsed["journalValid"])
                    self.assertEqual(parsed["classifier"], "M23_STORE_REGRESSED_AFTER_SUCCESS")

    def test_absence_without_success_cannot_pass(self) -> None:
        events = [event for event in self.complete_events()
                  if event["kind"] not in {"terminal-success-applied", "store-state-snapshot", "dom-success-observed"}]
        events.append({"kind": "store-state-snapshot", "phase": "recovery", "present": False,
                       "state": "unknown", "progressClass": "unknown"})
        self.write_journal(events)
        self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"],
                         "M23_ENGINE_RESOLVED_WITHOUT_TERMINAL_PUBLICATION")

    def test_hidden_or_dom_success_without_applied_store_success_is_invalid(self) -> None:
        for kind in ("dom-terminal-hidden", "dom-success-observed"):
            for before in (True, False):
                events = [event for event in self.complete_events()
                          if event["kind"] not in {"terminal-success-applied", "store-state-snapshot", "dom-success-observed"}]
                events.insert(2 if before else len(events), {"kind": kind, "phase": "recovery"})
                self.write_journal(events)
                self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")
        events = self.complete_events()
        events.insert(2, {"kind": "dom-terminal-hidden", "phase": "recovery"})
        self.write_journal(events)
        self.assertFalse(target.parse_recovery_journal(self.path, self.root)["journalValid"])

    def test_contradictory_synthetic_milestones_are_invalid(self) -> None:
        empty = target._evidence_from_events([])
        for changes in (
            {"observableNext": True}, {"observableComplete": True}, {"storeProgress100": True},
            {"domSuccessObserved": True}, {"domHiddenAfterSuccess": True}, {"storeRemovedAfterSuccess": True},
            {"networkResponse2xx": "true"}, {"generationCurrentAtLoopEntry": 1},
        ):
            self.assertEqual(target.classify_recovery_continuation({**empty, **changes}), "M23_EVIDENCE_INVALID")
        self.assertEqual(target.classify_recovery_continuation({}), "M23_EVIDENCE_INVALID")
        self.write_journal([*self.complete_events(), {"kind": "chunk-observable-error", "phase": "recovery"}])
        self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"], "M23_EVIDENCE_INVALID")

    def test_schema_duplicate_keys_utf8_and_unsafe_fields_are_invalid(self) -> None:
        self.write_journal(self.complete_events())
        valid = self.path.read_bytes()
        cases = [
            valid.replace(b'"schema": 5', b'"schema": 4'),
            valid.replace(b'"schema": 5', b'"schema": 5, "schema": 5'),
            valid.replace(b'"state": "success"', b'"state": "success", "state": "success"'),
            valid.replace(b'"state": "success"', b'"state": "UNSAFE_SENTINEL"'),
            valid.replace(b'"state": "success"', b'"state": []'),
            valid.replace(b'"state": "success", ', b''),
            valid.replace(b'"present": true', b'"present": 1'),
            valid.replace(b'"kind": "terminal-success-applied"', b'"kind": "terminal-success-published"'),
            valid.replace(b'"kind": "terminal-success-applied"', b'"kind": "terminal-success-applied", "filename": "UNSAFE_SENTINEL"'),
            valid + b'\xff\n',
            b'\xef\xbb\xbf' + valid,
            valid[:-1],
        ]
        for content in cases:
            self.path.write_bytes(content)
            parsed = target.parse_recovery_journal(self.path, self.root)
            self.assertEqual(parsed["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")
            self.assertNotIn("UNSAFE_SENTINEL", json.dumps(parsed))

    def test_phase_duplicate_terminal_and_malformed_truncation_are_invalid(self) -> None:
        prefix = self.complete_events()[:2]
        capped = [*prefix, *[{"kind": "chunk-finished", "phase": "recovery"} for _ in range(62)]]
        cases = [
            [prefix[1], prefix[0]],
            [*self.complete_events(), prefix[0]],
            [*self.complete_events(), next(event for event in self.complete_events() if event["kind"] == "terminal-success-applied")],
            [*prefix, {"kind": "journal-truncated"}],
            [*capped, {"kind": "journal-truncated", "extra": True}],
            [*capped, {"kind": "journal-truncated"}, {"kind": "chunk-finished", "phase": "recovery"}],
            [*capped, {"kind": "chunk-finished", "phase": "recovery"}],
        ]
        for events in cases:
            self.write_journal(events)
            self.assertFalse(target.parse_recovery_journal(self.path, self.root)["journalValid"])

    def test_node_python_semantic_and_schema_parity(self) -> None:
        cases = [[], self.complete_events(), self.complete_events()[:8]]
        hidden = [event for event in self.complete_events() if event["kind"] != "dom-success-observed"]
        hidden.extend([
            {"kind": "store-state-snapshot", "phase": "recovery", "present": False, "state": "unknown", "progressClass": "unknown"},
            {"kind": "dom-terminal-hidden", "phase": "recovery"},
        ])
        cases.append(hidden)
        for state in ("paused", "processing", "error", "cancelled"):
            cases.append([*hidden, {"kind": "store-state-snapshot", "phase": "recovery", "present": True,
                                   "state": state, "progressClass": "50-99"}])
        cases.append([self.complete_events()[0], self.complete_events()[1],
                      {"kind": "dom-terminal-hidden", "phase": "recovery"}])
        script = """
import { readFileSync } from 'node:fs';
import { RECOVERY_JOURNAL_SCHEMA, evidenceFromRecoveryEvents, classifyRecoveryContinuation } from './frontend/tools/e2e-recovery-diagnostics.mjs';
const cases = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify({schema: RECOVERY_JOURNAL_SCHEMA, cases: cases.map(events => {
  const evidence = evidenceFromRecoveryEvents(events);
  return { evidence, classifier: classifyRecoveryContinuation(evidence) };
})}));
"""
        completed = subprocess.run(["node", "--input-type=module", "-e", script],
                                   input=json.dumps(cases), cwd=Path(__file__).resolve().parents[2],
                                   capture_output=True, text=True, check=False, timeout=15, shell=False)
        self.assertEqual(completed.returncode, 0)
        node = json.loads(completed.stdout)
        self.assertEqual(node["schema"], target.RECOVERY_JOURNAL_SCHEMA)
        for events, actual in zip(cases, node["cases"], strict=True):
            evidence = target._evidence_from_events(events)
            self.assertEqual(actual, {"evidence": evidence, "classifier": target.classify_recovery_continuation(evidence)})

    def test_valid_partial_journal_keeps_exact_causal_classification(self) -> None:
        self.write_journal(self.complete_events()[:8])
        evidence = target.parse_recovery_journal(self.path, self.root)
        self.assertEqual(evidence["classifier"], "M23_OBSERVABLE_NEXT_WITHOUT_PROGRESS_100")
        self.assertTrue(evidence["journalValid"])

    def test_valid_journal_without_input_operation_is_not_counted_as_recovery(self) -> None:
        self.write_journal([
            {"kind": "phase-start", "phase": "initial"},
            {"kind": "phase-start", "phase": "recovery"},
            {"kind": "instrumentation-installed", "phase": "recovery"},
        ])
        evidence = target.parse_recovery_journal(self.path, self.root)
        self.assertTrue(evidence["journalValid"])
        self.assertFalse(evidence["recoveryOperationStarted"])
        decision = target.targeted_result({"status": "FAIL"}, evidence)
        self.assertEqual(decision["result"], "BLOCKED")
        self.assertEqual(decision["failureCode"], "RECOVERY_OPERATION_NOT_STARTED")

    def test_instrumentation_transport_failure_blocks_before_recovery(self) -> None:
        self.write_journal([
            {"kind": "phase-start", "phase": "initial"},
            {"kind": "instrumentation-invalid", "phase": "initial"},
        ])
        evidence = target.parse_recovery_journal(self.path, self.root)
        decision = target.targeted_result({"status": "FAIL"}, evidence)
        self.assertEqual(decision["result"], "BLOCKED")
        self.assertEqual(decision["failureCode"], "BLOCKED_RECOVERY_EVIDENCE_TRANSPORT")

    def test_formal_states_close_only_boundaries_supported_by_runtime_evidence(self) -> None:
        missing = target.formal_states(
            {"journalValid": False, "classifier": "M26_RECOVERY_EVIDENCE_MISSING"}, False, False,
        )
        self.assertEqual(missing["M24-F02"], "CLOSED_BY_M25_DURABLE_EVIDENCE / PRESERVED")
        self.assertEqual(missing["M23-F01"], "REOPENED_BY_M26_EVIDENCE_SEMANTICS / RUNTIME RECLASSIFICATION PENDING")
        passed = target.formal_states(
            {"journalValid": True, "classifier": target.PASS_CLASS}, True, True, deterministic_proven=True,
        )
        self.assertEqual(passed["M24-F02"], "CLOSED_BY_M25_DURABLE_EVIDENCE / PRESERVED")
        self.assertEqual(passed["M23-F01"], "CLOSED_BY_M27_RUNTIME_RECLASSIFICATION")
        self.assertEqual(passed["M26-F01"], "CLOSED_BY_M27_SINGLE_TARGETED_RUNTIME_PASS")
        self.assertEqual(passed["M27-F01"], "CLOSED")
        self.assertEqual(passed["B90-F02"], "OPEN")

    def test_blank_and_unterminated_jsonl_records_fail_closed(self) -> None:
        for content in ('{"schema":5,"kind":"journal-start"}\n\n',
                        '{"schema":5,"kind":"journal-start"}'):
            self.path.write_text(content, encoding="utf-8")
            self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"],
                             "M26_RECOVERY_EVIDENCE_INVALID")

    def test_missing_and_invalid_journals_are_distinct(self) -> None:
        missing = target.parse_recovery_journal(self.path, self.root)
        self.assertEqual(missing["classifier"], "M26_RECOVERY_EVIDENCE_MISSING")
        report_pass = {"status": "PASS", "processOutcome": "PLAYWRIGHT_EXITED"}
        self.assertEqual(target.targeted_result(report_pass, missing)["failureCode"], "M26_RECOVERY_EVIDENCE_MISSING")
        self.path.write_text('{"kind":"journal-start"}\n', encoding="utf-8")
        invalid = target.parse_recovery_journal(self.path, self.root)
        self.assertEqual(invalid["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")

    def test_malformed_unknown_oversized_and_outside_journals_fail_closed(self) -> None:
        for content in ('{"schema":5,"kind":"journal-start"}\n{',
                        '{"schema":5,"kind":"journal-start"}\n{"kind":"surprise"}\n',
                        '{"schema":5,"kind":"journal-start"}\n' + ' ' * (65 * 1024)):
            self.path.write_text(content, encoding="utf-8")
            self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")
        self.write_journal(self.complete_events())
        outside = self.root.parent / self.path.name
        self.assertEqual(target.parse_recovery_journal(outside, self.root)["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")

    def test_timeout_keeps_valid_journal_and_invokes_browser_once_without_retry(self) -> None:
        timeout = subprocess.TimeoutExpired(["node", "playwright"], 210, output=b"partial reporter")
        with mock.patch.object(target.subprocess, "run", side_effect=timeout) as run:
            process = target.run_playwright_once(["node", "playwright"], self.root, {}, timeout=210)
        self.write_journal(self.complete_events()[:8])
        evidence = target.parse_recovery_journal(self.path, self.root)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(process["processOutcome"], "PLAYWRIGHT_TIMEOUT")
        self.assertEqual(process["retries"], 0)
        self.assertEqual(evidence["classifier"], "M23_OBSERVABLE_NEXT_WITHOUT_PROGRESS_100")

    def test_complete_report_captured_at_timeout_is_valid_but_still_a_test_failure(self) -> None:
        report = json.dumps({"stats": {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}})
        summary = target.summarize_report(report, None)
        self.assertTrue(summary["reportValid"])
        self.assertEqual(summary["testOutcome"], "FAIL")
        self.assertEqual(summary["status"], "FAIL")

    def test_truncation_marker_is_valid_but_unknown_fields_are_not(self) -> None:
        capped = [
            {"kind": "phase-start", "phase": "initial"},
            {"kind": "phase-start", "phase": "recovery"},
            *[{"kind": "chunk-finished", "phase": "recovery"} for _ in range(62)],
        ]
        self.write_journal([*capped, {"kind": "journal-truncated"}])
        self.assertTrue(target.parse_recovery_journal(self.path, self.root)["truncated"])
        self.write_journal([{**self.complete_events()[0], "filename": "SECRET_SENTINEL"}])
        self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")

    def test_valid_truncation_cannot_prove_final_temporal_state(self) -> None:
        events = self.complete_events()
        events.extend([{"kind": "chunk-finished", "phase": "recovery"} for _ in range(64 - len(events))])
        self.write_journal([*events, {"kind": "journal-truncated"}])
        parsed = target.parse_recovery_journal(self.path, self.root)
        self.assertTrue(parsed["journalValid"])
        self.assertTrue(parsed["truncated"])
        self.assertEqual(parsed["classifier"], "M23_EVIDENCE_INVALID")

    def test_timeout_process_summary_does_not_promote_a_causal_pass(self) -> None:
        self.write_journal(self.complete_events())
        evidence = target.parse_recovery_journal(self.path, self.root)
        summary = {"status": "FAIL", "processOutcome": "PLAYWRIGHT_TIMEOUT", "reportValid": False}
        self.assertEqual(target.targeted_result(summary, evidence)["result"], "FAIL")
        self.assertEqual(target.targeted_result(summary, evidence)["classifier"], target.PASS_CLASS)

    def test_cleanup_failure_overrides_pass_without_erasing_causal_evidence(self) -> None:
        evidence = {"journalValid": True, "classifier": target.PASS_CLASS}
        summary = {"status": "PASS", "processOutcome": "PLAYWRIGHT_EXITED", "reportValid": True}
        result = target.targeted_result(summary, evidence, cleanup_failure="OWNED_BACKEND_TEARDOWN_FAILED")
        self.assertEqual(result["result"], "FAIL_TEARDOWN")
        self.assertEqual(result["classifier"], target.PASS_CLASS)

    def test_symlink_journal_is_rejected(self) -> None:
        target_path = self.root / "target.jsonl"
        target_path.write_text('{"schema":5,"kind":"journal-start"}\n', encoding="utf-8")
        try:
            os.symlink(target_path, self.path)
        except (OSError, NotImplementedError):
            original = Path.lstat
            def link_stat(candidate):
                if candidate == self.path:
                    return os.stat_result((0o120777, 0, 0, 1, 0, 0, 1, 0, 0, 0))
                return original(candidate)
            with mock.patch.object(Path, "lstat", link_stat):
                self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")
            return
        self.assertEqual(target.parse_recovery_journal(self.path, self.root)["classifier"], "M26_RECOVERY_EVIDENCE_INVALID")


class RecoveryOwnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.output = self.root / ".quality/b90-r1m27-recovery-runtime-closure"
        target.write_json(self.output / "baseline/scope.json", {
            "round": target.ROUND, "artifactDirectoryAbsentAtEntry": True,
        })
        self.hashes = {"files": {"frontend/src/app/features/drive/state/drive.store.ts": "entry"}, "historicalArtifacts": {}}
        target.write_json(self.output / "baseline/protected-hashes.json", self.hashes)
        target.write_json(self.output / "baseline/m26-authority.json", {
            "round": target.ROUND, "authorityRound": "B.90-R1.M26", "liveTreeMatchesM26Post": True,
        })
        build = self.root / "backend/build"
        build.mkdir(parents=True)
        for name in ("savebox_server.exe", "nanika_e2e_fixture.exe"):
            (build / name).write_bytes(b"test fixture only")
        cli = self.root / "frontend/node_modules/@playwright/test/cli.js"
        cli.parent.mkdir(parents=True)
        cli.write_text("test fixture only")
        self.workspace = self.root / "owned-workspace"
        self.workspace.mkdir()
        self.preexisting = "a" * 64
        self.owned_container = "b" * 64
        self.frontend = SimpleNamespace(url="http://127.0.0.1:4201", port=4201,
                                        process=mock.Mock(pid=1234))
        self.backend = SimpleNamespace(owned=True, process=mock.Mock(pid=5678))
        self.frontend.process.poll.return_value = self.backend.process.poll.return_value = 0
        self.lease = SimpleNamespace(
            workspace=SimpleNamespace(root=self.workspace, cwd=self.workspace),
            postgres=SimpleNamespace(container_id=self.owned_container), e2e_environment={},
            summary={"postgres": {"owned": True}},
        )
        self.log = []
        self.lifecycle = []
        events = DurableRecoveryJournalTests.complete_events()
        self.evidence = {
            "journalValid": True, "journalMissing": False, "classifier": target.PASS_CLASS,
            "evidence": target._evidence_from_events(events), "schema": target.RECOVERY_JOURNAL_SCHEMA,
            "eventCount": len(events), "truncated": False, "recoveryOperationStarted": True,
            "instrumentationInstalled": True, "instrumentationTransportFailed": False,
        }
        self.unit = {"status": "PASS", "nodeTests": 21, "runnerTests": 1, "frontendTests": 119,
                     "pyCompile": "PASS", "prePatchRed": "M27-H01/H02 PRE_PATCH_RED",
                     "deterministicReconciliationPassed": True}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def execute_owner(self, *, failed_test=False, cleanup_failure=False, changed_source=False, adopted_postgres=False,
                      unowned_backend=False, docker_offline=False, discovery_failed=False, inventory_failure=None,
                      start_failed=False, missing_journal=False, preexisting_changed=False, external_container=False,
                      post_hash_failure=False):
        if adopted_postgres:
            self.lease.postgres.container_id = self.preexisting
        if unowned_backend:
            self.backend.owned = False
        stats = {"expected": 0 if failed_test else 1, "unexpected": 1 if failed_test else 0,
                 "skipped": 0, "flaky": 0}
        process = {"processOutcome": "PLAYWRIGHT_EXITED", "stdout": json.dumps({"stats": stats}),
                   "exitCode": 1 if failed_test else 0, "browserProcessInvocations": 1, "retries": 0}
        if start_failed:
            process.update(processOutcome="PLAYWRIGHT_START_FAILED", stdout="", exitCode=None, browserProcessInvocations=0)
        if missing_journal:
            self.evidence = {"journalValid": False, "journalMissing": True,
                             "classifier": "M26_RECOVERY_EVIDENCE_MISSING"}
        def parse(*args):
            self.assertTrue(self.workspace.exists())
            self.log.append("parse")
            return self.evidence
        def cleanup(workspace):
            if not (adopted_postgres or unowned_backend or start_failed):
                self.assertIn("parse", self.log)
            self.log.append("workspace-cleanup")
            self.assertTrue(workspace.root.is_relative_to(self.root))
            target.shutil.rmtree(workspace.root)
        after = {"files": {"frontend/src/app/features/drive/state/drive.store.ts": "changed"}} if changed_source else self.hashes
        if post_hash_failure:
            after = target.TargetFailure("SOURCE_HASH_FAILED")
        def step(name, value):
            def observe(*args, **kwargs):
                self.lifecycle.append(name)
                if isinstance(value, Exception):
                    raise value
                return value
            return observe
        inventories = iter([
            target.TargetFailure(inventory_failure) if inventory_failure else {self.preexisting: "running"},
            {self.preexisting: "exited" if preexisting_changed else "running",
             **({"c" * 64: "running"} if external_container else {})},
        ])
        def inventory():
            return step("inventory", next(inventories))()
        original_write = target.write_json
        def write(path, payload):
            if path.name == "source-freeze.json":
                self.lifecycle.append("freeze")
            original_write(path, payload)
        with ExitStack() as stack:
            patches = [
                (target, "__file__", str(self.root / "tools/quality/run_recovery_targeted.py")),
                (target, "verify_unit_evidence", mock.Mock(side_effect=step("unit", self.unit))),
                (target, "write_json", mock.Mock(side_effect=write)),
                (target, "source_hashes", mock.Mock(side_effect=[self.hashes, after])),
                (target, "discover_recovery", mock.Mock(side_effect=step("discovery", target.TargetFailure("BLOCKED_RECOVERY_DISCOVERY_INVALID") if discovery_failed else {"status": "PASS", "invocations": 1, "discovered": 1, "files": 1, "executed": 0}))),
                (target, "container_snapshot", mock.Mock(side_effect=inventory)),
                (target, "verify_runtime_bind", mock.Mock(return_value={"bindAddress": "127.0.0.1"})),
                (target, "owned_loopback_listener", mock.Mock(return_value={"listenerOwnedByProcess": True, "addressClass": "ipv4-loopback"})),
                (target, "run_playwright_once", mock.Mock(return_value=process)),
                (target, "parse_recovery_journal", mock.Mock(side_effect=parse)),
                (target.shutil, "which", mock.Mock(side_effect=lambda name: name)),
                (target.env_owner, "validate_playwright_config", mock.Mock()),
                (target.env_owner, "prepare_environment", mock.Mock(side_effect=step("environment", self.lease))),
                (target.env_owner, "remove_disposable_postgres", mock.Mock()),
                (target.env_owner, "cleanup_runtime_workspace", mock.Mock(side_effect=cleanup)),
                (target.frontend_owner, "resolve_frontend_tooling", mock.Mock(return_value=("node", self.root / "ng.js"))),
                (target.frontend_owner, "reserve_frontend_port", mock.Mock(return_value=SimpleNamespace(socket=mock.Mock()))),
                (target.frontend_owner, "spawn_frontend", mock.Mock(side_effect=step("frontend", self.frontend))),
                (target.frontend_owner, "wait_frontend_ready", mock.Mock()),
                (target.frontend_owner, "stop_frontend", mock.Mock()),
                (target.campaign, "validate_backend_spec", mock.Mock(return_value={"valid": True})),
                (target.campaign, "spawn_backend", mock.Mock(return_value=self.backend)),
                (target.campaign, "wait_backend_ready", mock.Mock(return_value=self.backend)),
                (target.campaign, "stop_backend", mock.Mock(side_effect=RuntimeError("test failure") if cleanup_failure else None)),
            ]
            handles = {}
            for module, name, replacement in patches:
                handles[(module.__name__, name)] = stack.enter_context(mock.patch.object(module, name, replacement))
            if docker_offline:
                stack.enter_context(mock.patch.object(target.subprocess, "run", side_effect=step("docker", SimpleNamespace(returncode=1, stdout="", stderr="UNSAFE_SENTINEL"))))
            else:
                handles[(target.__name__, "probe_docker_runtime")] = stack.enter_context(mock.patch.object(
                    target, "probe_docker_runtime", mock.Mock(side_effect=step("docker", {"cliAvailable": True, "daemonAvailable": True}))))
            stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
            stack.enter_context(mock.patch("sys.stdout", new=io.StringIO()))
            exit_code = target.main(["--output", str(self.output)])
        decision = json.loads((self.output / "decision.json").read_text())
        return exit_code, decision, handles

    def test_m27_h01_daemon_failure_has_precise_prerequisite_classification(self) -> None:
        code, decision, _ = self.execute_owner(docker_offline=True)
        self.assertEqual(code, 1)
        self.assertEqual(decision["failureCode"], "DOCKER_DAEMON_UNAVAILABLE")
        self.assertEqual(decision["result"], "BLOCKED_DOCKER_DAEMON_UNAVAILABLE")

    def test_m27_h02_runtime_not_run_is_unknown_not_false(self) -> None:
        code, decision, _ = self.execute_owner(docker_offline=True)
        self.assertEqual(code, 1)
        self.assertIsNone(decision["sourceUnchangedAcrossRuntime"])
        self.assertIsNone(decision["journalValid"])
        self.assertIsNone(decision["causalClassification"])
        self.assertEqual(decision["sourceRuntimeComparison"], "NOT_RUN")
        self.assertEqual(decision["sourceFreeze"], "NOT_RUN")
        self.assertEqual(decision["journalStatus"], "NOT_RUN")
        self.assertEqual(decision["cleanup"]["cleanupStatus"], "NOT_APPLICABLE")
        self.assertEqual(decision["cleanup"]["ownedResourcesStarted"], 0)
        self.assertFalse(decision["cleanup"]["cleanupRequired"])
        self.assertIsNone(decision["cleanup"]["userResourcesPreserved"])
        self.assertFalse(decision["preexistingResourcesMutatedByOwner"])
        self.assertEqual(decision["preexistingResourceInventory"], "NOT_AVAILABLE")
        for field in ("frontendStopped", "backendStopped", "postgresRemoved", "workspaceRemoved"):
            self.assertIsNone(decision["cleanup"][field])
        report = (self.output / "final-report.md").read_text(encoding="utf-8")
        self.assertNotIn("MISMATCH", report)
        self.assertIn("Cleanup foi NOT APPLICABLE", report)

    def test_docker_offline_runs_discovery_once_then_stops_before_inventory_or_resources(self) -> None:
        _, decision, calls = self.execute_owner(docker_offline=True)
        self.assertEqual(self.lifecycle, ["unit", "discovery", "docker"])
        calls[(target.__name__, "discover_recovery")].assert_called_once()
        for module, name in ((target.__name__, "container_snapshot"), (target.__name__, "run_playwright_once"),
                             (target.__name__, "parse_recovery_journal"), ("owned_frontend", "spawn_frontend"),
                             ("run_playwright_campaign_env", "prepare_environment"), ("run_playwright_campaign", "spawn_backend")):
            calls[(module, name)].assert_not_called()
        self.assertFalse((self.output / "targeted/source-freeze.json").exists())
        self.assertEqual(decision["browserProcessInvocations"], 0)
        self.assertEqual(decision["discovery"], "PASS")
        self.assertNotIn("UNSAFE_SENTINEL", (self.output / "decision.json").read_text())
        self.assertNotIn("UNSAFE_SENTINEL", (self.output / "targeted/runtime-prerequisites.json").read_text())

    def test_invalid_discovery_stops_before_docker_or_resources(self) -> None:
        _, decision, calls = self.execute_owner(discovery_failed=True)
        self.assertEqual(decision["result"], "BLOCKED_RECOVERY_DISCOVERY_INVALID")
        self.assertEqual(self.lifecycle, ["unit", "discovery"])
        calls[(target.__name__, "probe_docker_runtime")].assert_not_called()
        calls[(target.__name__, "container_snapshot")].assert_not_called()
        calls[("owned_frontend", "spawn_frontend")].assert_not_called()
        calls[("run_playwright_campaign_env", "prepare_environment")].assert_not_called()
        self.assertEqual(decision["sourceFreeze"], "NOT_RUN")

    def test_inventory_failure_after_daemon_proof_is_a_distinct_block(self) -> None:
        _, decision, calls = self.execute_owner(inventory_failure="PREEXISTING_RESOURCE_PROOF_UNAVAILABLE")
        self.assertEqual(decision["result"], "BLOCKED_PREEXISTING_RESOURCE_PROOF_UNAVAILABLE")
        self.assertEqual(self.lifecycle, ["unit", "discovery", "docker", "inventory"])
        calls[(target.__name__, "probe_docker_runtime")].assert_called_once()
        calls[(target.__name__, "container_snapshot")].assert_called_once()
        calls[("owned_frontend", "spawn_frontend")].assert_not_called()
        self.assertEqual(decision["cleanup"]["cleanupStatus"], "NOT_APPLICABLE")

    def test_invalid_inventory_blocks_without_freeze(self) -> None:
        _, decision, _ = self.execute_owner(inventory_failure="PREEXISTING_RESOURCE_PROOF_INVALID")
        self.assertEqual(decision["result"], "BLOCKED_PREEXISTING_RESOURCE_PROOF_INVALID")
        self.assertFalse((self.output / "targeted/source-freeze.json").exists())

    def test_unknown_prerequisite_code_is_not_reflected_in_artifacts(self) -> None:
        _, decision, _ = self.execute_owner(inventory_failure="UNSAFE_SENTINEL")
        self.assertEqual(decision["failureCode"], "TARGET_ORCHESTRATION_FAILED")
        self.assertNotIn("UNSAFE_SENTINEL", (self.output / "decision.json").read_text())

    def test_missing_journal_after_browser_started_is_failure_not_not_run(self) -> None:
        _, decision, calls = self.execute_owner(missing_journal=True)
        self.assertEqual(decision["browserProcessInvocations"], 1)
        self.assertEqual(decision["journalStatus"], "MISSING")
        self.assertIs(decision["journalValid"], False)
        self.assertEqual(decision["failureCode"], "M26_RECOVERY_EVIDENCE_MISSING")
        calls[(target.__name__, "parse_recovery_journal")].assert_called_once()
        self.assertEqual(decision["cleanup"]["cleanupStatus"], "PASS")

    def test_browser_start_failed_requires_cleanup_but_no_journal(self) -> None:
        _, decision, calls = self.execute_owner(start_failed=True)
        self.assertEqual(decision["failureCode"], "TARGET_PLAYWRIGHT_START_FAILED")
        self.assertEqual(decision["browserProcessInvocations"], 0)
        self.assertEqual(decision["journalStatus"], "NOT_RUN")
        self.assertIsNone(decision["journalValid"])
        self.assertIsNone(decision["causalClassification"])
        self.assertIsNone(decision["journalParsedBeforeWorkspaceCleanup"])
        calls[(target.__name__, "parse_recovery_journal")].assert_not_called()
        self.assertEqual(decision["cleanup"]["cleanupStatus"], "PASS")
        self.assertEqual(decision["sourceRuntimeComparison"], "MATCH")

    def test_changed_preexisting_container_state_fails_closed(self) -> None:
        _, decision, calls = self.execute_owner(preexisting_changed=True)
        self.assertEqual(decision["failureCode"], "PREEXISTING_RESOURCES_CHANGED")
        self.assertIs(decision["cleanup"]["userResourcesPreserved"], False)
        calls[("run_playwright_campaign_env", "remove_disposable_postgres")].assert_called_once_with(self.lease.postgres)

    def test_external_new_container_is_preserved_without_becoming_owned(self) -> None:
        code, decision, calls = self.execute_owner(external_container=True)
        self.assertEqual(code, 0)
        self.assertIs(decision["cleanup"]["userResourcesPreserved"], True)
        calls[("run_playwright_campaign_env", "remove_disposable_postgres")].assert_called_once_with(self.lease.postgres)

    def test_missing_backend_executable_blocks_without_build_or_discovery(self) -> None:
        (self.root / "backend/build/savebox_server.exe").unlink()
        _, decision, calls = self.execute_owner()
        self.assertEqual(decision["result"], "BLOCKED_RUNTIME_EXECUTABLE_MISSING")
        calls[(target.__name__, "discover_recovery")].assert_not_called()
        calls[(target.__name__, "probe_docker_runtime")].assert_not_called()
        calls[("owned_frontend", "spawn_frontend")].assert_not_called()

    def test_single_invocation_zero_retries_parse_before_cleanup_and_complete_teardown(self) -> None:
        code, decision, calls = self.execute_owner()
        self.assertEqual(code, 0)
        self.assertEqual(decision["result"], "PASS_TARGETED_RECOVERY_WITH_DURABLE_EVIDENCE")
        run = calls[("run_recovery_targeted", "run_playwright_once")]
        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertEqual(command.count("e2e/recovery.spec.ts"), 1)
        self.assertIn("--workers=1", command)
        self.assertIn("--retries=0", command)
        self.assertIn("--project=chromium", command)
        self.assertEqual(decision["browserProcessInvocations"], 1)
        self.assertEqual(decision["retries"], 0)
        self.assertEqual(decision["sourceRuntimeComparison"], "MATCH")
        self.assertIs(decision["sourceUnchangedAcrossRuntime"], True)
        self.assertEqual(decision["cleanup"]["cleanupStatus"], "PASS")
        self.assertEqual(decision["cleanup"]["ownedResourcesStarted"], 4)
        self.assertEqual(decision["ownedGenerations"], {"frontend": 1, "backend": 1, "postgres": 1, "workspace": 1})
        self.assertTrue(decision["journalParsedBeforeWorkspaceCleanup"])
        self.assertEqual(self.log, ["parse", "workspace-cleanup"])
        self.assertTrue(all(decision["cleanup"].values()))
        self.assertTrue(decision["fileIntegrityVerified"])
        calls[("owned_frontend", "stop_frontend")].assert_called_once_with(self.frontend)
        calls[("run_playwright_campaign", "stop_backend")].assert_called_once_with(self.backend)
        calls[("run_playwright_campaign_env", "remove_disposable_postgres")].assert_called_once_with(self.lease.postgres)
        for module, name in (("owned_frontend", "spawn_frontend"), ("run_playwright_campaign_env", "prepare_environment"),
                             ("run_playwright_campaign", "spawn_backend"), ("run_recovery_targeted", "parse_recovery_journal"),
                             ("run_recovery_targeted", "discover_recovery"), ("run_recovery_targeted", "probe_docker_runtime"),
                             ("run_playwright_campaign_env", "cleanup_runtime_workspace")):
            calls[(module, name)].assert_called_once()
        self.assertEqual(calls[(target.__name__, "container_snapshot")].call_count, 2)
        self.assertEqual(self.lifecycle[:6], ["unit", "discovery", "docker", "inventory", "freeze", "frontend"])

    def test_classifier_pass_plus_playwright_failure_is_not_targeted_pass(self) -> None:
        code, decision, calls = self.execute_owner(failed_test=True)
        self.assertEqual(code, 1)
        self.assertEqual(decision["failureCode"], "TARGET_RECOVERY_FAILED")
        self.assertEqual(decision["causalClassification"], target.PASS_CLASS)
        self.assertFalse(decision["fileIntegrityVerified"])
        self.assertTrue(all(decision["cleanup"].values()))
        calls[("run_recovery_targeted", "run_playwright_once")].assert_called_once()
        self.assertEqual(decision["formalStates"]["M26-F01"], "OPEN")
        self.assertEqual(decision["formalStates"]["M27-F01"], "CHARACTERIZED_OPEN")
        self.assertEqual(decision["formalStates"]["M23-F01"], "CLOSED_BY_M27_RUNTIME_RECLASSIFICATION")
        calls[("run_playwright_campaign_env", "prepare_environment")].assert_called_once()
        calls[("run_playwright_campaign_env", "cleanup_runtime_workspace")].assert_called_once()
        calls[(target.__name__, "parse_recovery_journal")].assert_called_once()

    def test_cleanup_failure_tries_all_other_resources_and_overrides_pass(self) -> None:
        code, decision, calls = self.execute_owner(cleanup_failure=True)
        self.assertEqual(code, 1)
        self.assertEqual(decision["result"], "FAIL_TEARDOWN")
        self.assertEqual(decision["failureCode"], "OWNED_BACKEND_TEARDOWN_FAILED")
        for module, name in (("owned_frontend", "stop_frontend"),
                             ("run_playwright_campaign_env", "remove_disposable_postgres"),
                             ("run_playwright_campaign_env", "cleanup_runtime_workspace")):
            calls[(module, name)].assert_called_once()
        self.assertEqual(decision["formalStates"]["M26-F01"], "OPEN")
        self.assertEqual(decision["cleanup"]["cleanupStatus"], "FAIL")
        self.assertIs(decision["cleanup"]["backendStopped"], False)

    def test_source_hash_mismatch_overrides_apparent_pass(self) -> None:
        code, decision, _ = self.execute_owner(changed_source=True)
        self.assertEqual(code, 1)
        self.assertEqual(decision["failureCode"], "SOURCE_CHANGED_AFTER_FREEZE")
        self.assertEqual(decision["formalStates"]["M26-F01"], "OPEN")
        self.assertEqual(decision["sourceRuntimeComparison"], "MISMATCH")
        self.assertIs(decision["sourceUnchangedAcrossRuntime"], False)

    def test_unavailable_post_hashes_are_not_reported_as_a_mismatch(self) -> None:
        _, decision, _ = self.execute_owner(post_hash_failure=True)
        self.assertEqual(decision["result"], "FAIL_SOURCE_INTEGRITY")
        self.assertEqual(decision["failureCode"], "SOURCE_HASH_FAILED")
        self.assertEqual(decision["sourceRuntimeComparison"], "NOT_PROVEN")
        self.assertIsNone(decision["sourceUnchangedAcrossRuntime"])

    def test_preexisting_postgres_is_never_removed_or_adopted(self) -> None:
        code, decision, calls = self.execute_owner(adopted_postgres=True)
        self.assertEqual(code, 1)
        calls[("run_playwright_campaign_env", "remove_disposable_postgres")].assert_not_called()
        calls[("run_recovery_targeted", "run_playwright_once")].assert_not_called()
        self.assertTrue(decision["cleanup"]["userResourcesPreserved"])

    def test_unknown_backend_process_is_never_stopped(self) -> None:
        code, decision, calls = self.execute_owner(unowned_backend=True)
        self.assertEqual(code, 1)
        calls[("run_playwright_campaign", "stop_backend")].assert_not_called()
        calls[("run_recovery_targeted", "run_playwright_once")].assert_not_called()
        self.assertTrue(decision["cleanup"]["userResourcesPreserved"])

    def test_preexisting_resource_inventory_is_read_only_and_fail_closed(self) -> None:
        runner = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=self.preexisting + " running\n"))
        self.assertEqual(target.container_snapshot(runner=runner), {self.preexisting: "running"})
        self.assertEqual(runner.call_args.args[0][:3], ["docker", "ps", "--all"])
        for output in ("UNSAFE_SENTINEL running\n", self.preexisting + " SECRET\n",
                       self.preexisting + " running\n" + self.preexisting + " running\n"):
            runner.return_value.stdout = output
            with self.assertRaises(target.TargetFailure) as error:
                target.container_snapshot(runner=runner)
            self.assertEqual(error.exception.code, "PREEXISTING_RESOURCE_PROOF_INVALID")

    def test_artifact_write_is_exclusive(self) -> None:
        path = self.output / "exclusive.json"
        target.write_json(path, {"state": "initial"})
        with self.assertRaises(FileExistsError):
            target.write_json(path, {"state": "replacement"})
        self.assertEqual(json.loads(path.read_text()), {"state": "initial"})

    def test_unit_source_hash_mismatch_blocks_before_freeze(self) -> None:
        paths = (
            "frontend/tools/e2e-recovery-diagnostics.mjs", "frontend/tools/e2e-recovery-diagnostics.test.mjs",
            "tools/quality/run_recovery_targeted.py", "tools/quality/test_run_recovery_targeted.py",
            "tools/quality/owned_frontend.py", "tools/quality/run_playwright_campaign.py", "tools/quality/run_playwright_campaign_env.py",
            "frontend/angular.json", "frontend/karma.conf.js", "frontend/tsconfig.json", "frontend/tsconfig.spec.json",
            "frontend/package.json", "frontend/package-lock.json",
        )
        hashes = {}
        for relative in paths:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"unit input")
            hashes[relative] = hashlib.sha256(b"unit input").hexdigest()
        gate = {"round": target.ROUND, "status": "PASS", "tests": 1, "passed": 1, "failed": 0,
                "skipped": 0, "sourceHashes": hashes, "sourceTreeHash": "tree",
                "deterministicReconciliationPassed": True, "refreshTrueTests": 1,
                "diffCheck": "PASS", "securityReview": "PASS", "leanReview": "PASS"}
        for name in ("runner", "pycompile", "preflight-review"):
            target.write_json(self.output / "unit" / (name + ".json"), gate)
        for name in ("node-diagnostics", "frontend-reconciliation"):
            target.write_json(self.root / target.M26_OUTPUT / "unit" / (name + ".json"), {**gate, "round": "B.90-R1.M26"})
        target.write_json(self.output / "baseline/reused-gates.json", {
            "round": target.ROUND, "status": "PASS", "node": {"sourceHashes": hashes},
            "frontend": {"sourceHashes": hashes, "sourceTreeHash": "tree"},
        })
        for number in (1, 2):
            target.write_json(self.output / "red" / f"m27-h{number:02}.json", {
                "round": target.ROUND, "status": "PRE_PATCH_RED", "finding": f"M27-H{number:02}", "exitCode": 1,
            })
        with mock.patch.object(target.env_owner, "capture_source_hashes", return_value={"trees": {"frontend/src": "tree"}}):
            self.assertEqual(target.verify_unit_evidence(self.output, self.root)["status"], "PASS")
            (self.root / paths[0]).write_bytes(b"changed after unit")
            with self.assertRaises(target.TargetFailure) as error:
                target.verify_unit_evidence(self.output, self.root)
            self.assertEqual(error.exception.code, "UNIT_SOURCE_HASH_MISMATCH")
        self.assertFalse((self.output / "targeted/source-freeze.json").exists())

    def test_invalid_discovery_blocks_before_browser_execution(self) -> None:
        runner = SimpleNamespace(returncode=0, stdout="Total: 2 tests in 1 file")
        with mock.patch.object(target.subprocess, "run", return_value=runner) as call:
            with self.assertRaises(target.TargetFailure) as error:
                target.discover_recovery(self.root, "node")
        self.assertEqual(error.exception.code, "BLOCKED_RECOVERY_DISCOVERY_INVALID")
        call.assert_called_once()
        self.assertIn("--list", call.call_args.args[0])
        self.assertIn("--retries=0", call.call_args.args[0])



if __name__ == "__main__":
    unittest.main()
