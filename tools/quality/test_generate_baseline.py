import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_baseline  # noqa: E402
import run_playwright  # noqa: E402


def report(*statuses: str) -> dict:
    return {"suites": [{"specs": [{"tests": [{"status": status} for status in statuses]}]}]}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class EvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.report_path = self.root / "results.json"
        self.status_path = self.root / "run-status.json"

    def tearDown(self) -> None:
        self.directory.cleanup()

    def status(self, outcome: str = "completed", exit_code: int = 0, report_hash: str | None = None) -> dict:
        return {
            "schema": 1,
            "outcome": outcome,
            "exit_code": exit_code,
            "report_sha256": report_hash,
            "started_at": "2026-08-14T00:00:00+00:00",
            "finished_at": "2026-08-14T00:00:01+00:00",
            "phase": "report",
        }

    def evaluate(self, statuses: tuple[str, ...], run_status: dict | None) -> dict:
        write_json(self.report_path, report(*statuses))
        if run_status is not None:
            write_json(self.status_path, run_status)
        return generate_baseline.e2e_summary(self.report_path, self.status_path)

    def test_stale_passing_report_without_status_is_not_green(self) -> None:
        summary = self.evaluate(("expected",) * 5, None)
        self.assertFalse(generate_baseline.e2e_is_green(summary))
        self.assertFalse(summary["status_valid"])

    def test_failed_current_status_cannot_inherit_passing_report(self) -> None:
        self.report_path.write_text(json.dumps(report(*(["expected"] * 5))), encoding="utf-8")
        summary = self.evaluate(("expected",) * 5, self.status("playwright_failed", 1, generate_baseline.file_sha256(self.report_path)))
        self.assertFalse(generate_baseline.e2e_is_green(summary))
        self.assertEqual(summary["outcome"], "playwright_failed")

    def test_hash_mismatch_is_not_green(self) -> None:
        summary = self.evaluate(("expected",) * 5, self.status(report_hash="0" * 64))
        self.assertFalse(generate_baseline.e2e_is_green(summary))
        self.assertFalse(summary["hash_match"])

    def test_missing_report_is_not_green(self) -> None:
        write_json(self.status_path, self.status(report_hash="0" * 64))
        summary = generate_baseline.e2e_summary(self.report_path, self.status_path)
        self.assertFalse(generate_baseline.e2e_is_green(summary))
        self.assertIsNone(summary["report_sha256"])

    def test_invalid_report_is_not_green(self) -> None:
        self.report_path.write_text("not json", encoding="utf-8")
        write_json(self.status_path, self.status(report_hash=generate_baseline.file_sha256(self.report_path)))
        summary = generate_baseline.e2e_summary(self.report_path, self.status_path)
        self.assertFalse(generate_baseline.e2e_is_green(summary))
        self.assertFalse(summary["report_valid"])

    def test_invalid_status_is_not_green(self) -> None:
        summary = self.evaluate(("expected",) * 5, {"schema": 1, "outcome": "completed"})
        self.assertFalse(generate_baseline.e2e_is_green(summary))

    def test_preflight_failure_is_not_green(self) -> None:
        summary = self.evaluate(("expected",) * 5, self.status("preflight_failed", 1, None))
        self.assertFalse(generate_baseline.e2e_is_green(summary))

    def test_exact_current_five_of_five_is_green(self) -> None:
        self.report_path.write_text(json.dumps(report(*(["expected"] * 5))), encoding="utf-8")
        write_json(self.status_path, self.status(report_hash=generate_baseline.file_sha256(self.report_path)))
        summary = generate_baseline.e2e_summary(self.report_path, self.status_path)
        self.assertTrue(generate_baseline.e2e_is_green(summary))

    def test_four_of_four_is_not_green(self) -> None:
        summary = self.evaluate(("expected",) * 4, self.status(report_hash=None))
        self.assertFalse(generate_baseline.e2e_is_green(summary))
        self.assertEqual(summary["total"], 4)

    def test_skipped_and_flaky_are_not_green(self) -> None:
        for statuses in (("expected",) * 4 + ("skipped",), ("expected",) * 4 + ("flaky",)):
            self.report_path.write_text(json.dumps(report(*statuses)), encoding="utf-8")
            write_json(self.status_path, self.status(report_hash=generate_baseline.file_sha256(self.report_path)))
            summary = generate_baseline.e2e_summary(self.report_path, self.status_path)
            self.assertFalse(generate_baseline.e2e_is_green(summary))

    def test_baseline_generator_preserves_history_and_scopes_to_b50_candidate(self) -> None:
        source = Path(generate_baseline.__file__).read_text(encoding="utf-8")
        self.assertIn("Rodada B.50", generate_baseline.QUALITY_SCOPE)
        self.assertIn("Google external finalize / unlink lifecycle authority", generate_baseline.QUALITY_SCOPE)
        self.assertIn("B.31–B.49 remain FROZEN FINAL / RATIFIED", generate_baseline.QUALITY_SCOPE)
        self.assertIn("B.50 is emitted as FROZEN FINAL / RATIFIED only when current final-freeze evidence is green", generate_baseline.QUALITY_SCOPE)
        self.assertIn("B.51 remains SELECTED / NOT STARTED", generate_baseline.QUALITY_SCOPE)
        self.assertIn('"b19_changes": [', source)
        self.assertIn('"b20_changes": [', source)
        self.assertIn('"b21_changes": [', source)
        self.assertIn('"b22_changes": [', source)
        self.assertIn('"b23_changes": [', source)
        self.assertIn('"b24_changes": [', source)
        self.assertIn('"b25_changes": [', source)
        self.assertIn('"b26_changes": [', source)
        self.assertIn('"b27_changes": [', source)
        self.assertIn('"b28_changes": [', source)
        self.assertIn('"b29_changes": [', source)
        self.assertIn('"b30_changes": [', source)
        self.assertIn('"b31_changes": [', source)
        self.assertIn('"b32_changes": [', source)
        self.assertIn('"b33_changes": [', source)
        self.assertIn('"b31_micro_freeze_changes": [', source)
        self.assertIn('"b32_final_micro_freeze_changes": [', source)
        self.assertIn('"b33_final_micro_freeze_changes": [', source)
        self.assertIn('"b33_final_micro_freeze_2_changes": [', source)
        self.assertIn('"b34_changes": [', source)
        self.assertIn('"b35_changes": [', source)
        self.assertIn('"b35_final_micro_freeze_1_changes": [', source)
        self.assertIn('"b36_changes": [', source)
        self.assertIn('"b37_changes": [', source)
        self.assertIn('"b38_changes": [', source)
        self.assertIn('"b39_changes": [', source)
        self.assertIn('"b40_changes": [', source)
        self.assertIn('"b41_changes": [', source)
        self.assertIn('"b42_changes": [', source)
        self.assertIn('"b42_final_test_harness_changes": [', source)
        self.assertIn('"b43_changes": [', source)
        self.assertIn('"b44_changes": [', source)
        self.assertIn('"b32_final_micro_freeze_2_changes": [', source)
        self.assertIn('"## B.19 Changes"', source)
        self.assertIn('"## B.20 Changes"', source)
        self.assertIn('"## B.21 Changes"', source)
        self.assertIn('"## B.22 Changes"', source)
        self.assertIn('"## B.23 Changes"', source)
        self.assertIn('"## B.24 Changes"', source)
        self.assertIn('"## B.25 Changes"', source)
        self.assertIn('"## B.26 Changes"', source)
        self.assertIn('"## B.27 Changes"', source)
        self.assertIn('"## B.28 Changes"', source)
        self.assertIn('"## B.29 Changes"', source)
        self.assertIn('"## B.30 Changes"', source)
        self.assertIn('"## B.31 Changes"', source)
        self.assertIn('"## B.32 Changes"', source)
        self.assertIn('"## B.33 Changes"', source)
        self.assertIn('"## B.31 Final Micro-Freeze Changes"', source)
        self.assertIn('"## B.32 Final Micro-Freeze Changes"', source)
        self.assertIn('"## B.32 Final Micro-Freeze #2 Changes"', source)
        self.assertIn('"## B.33 Final Micro-Freeze Changes"', source)
        self.assertIn('"## B.33 Final Micro-Freeze #2 Changes"', source)
        self.assertIn('"## B.34 Changes"', source)
        self.assertIn('"## B.35 Changes"', source)
        self.assertIn('"## B.35 Final Micro-Freeze #1 Changes"', source)
        self.assertIn('"## B.36 Changes"', source)
        self.assertIn('"## B.37 Changes"', source)
        self.assertIn('"## B.38 Changes"', source)
        self.assertIn('"## B.39 Changes"', source)
        self.assertIn('"## B.40 Changes"', source)
        self.assertIn('"## B.41 Changes"', source)
        self.assertIn('"## B.42 Changes"', source)
        self.assertIn('"## B.42 Final Test-Harness Micro-Gate Changes"', source)
        self.assertIn('"## B.43 Changes"', source)
        self.assertIn('"## B.44 Changes"', source)
        self.assertIn("generate_token(B) swallowed", source)
        self.assertIn("user_id, session_id", source)
        self.assertIn("FOR UPDATE", source)
        self.assertIn("same JTI", source)
        self.assertIn("B.35 FROZEN FINAL", source)
        self.assertIn("B.36 remains NOT STARTED", source)
        self.assertIn("TRUSTED PROXY BOUNDARY", source)
        self.assertIn("No production change was made before characterization", source)
        self.assertIn("B.35 final micro-freeze production targets", source)
        self.assertIn("B.12–B.29 remain FROZEN", source)
        self.assertIn("B.12–B.32 remain FROZEN", source)
        self.assertIn("B.34 is NOT STARTED", source)
        self.assertIn("Post-freeze source review finding", source)
        self.assertIn("Final micro-freeze characterization", source)
        self.assertIn("B.30 is FROZEN after the post-candidate characterization", source)
        self.assertIn("2d96e569776373f20d2fd136b1b0aa8ea81408e5f19ae10cecea7dba2d0c1b99", source)
        self.assertIn("75669922115fd9e2641d8fa5de63295d3d53be0508cc6b3be7f030a687be4abd", source)
        self.assertIn("b8f010062f70539dfd0c899361cdbc9f6c76752a8afe0d5aa04a45109567ec64", source)
        self.assertIn("d5cbc665b6cb78be69e3895ec4bf8ae06bc6a292c2464f69fe37426938806316", source)
        self.assertIn("Post-freeze independent B.31 source audit", source)
        self.assertIn("canonical-file orphan ownership", source)
        self.assertIn("B.31 FROZEN FINAL", source)
        self.assertIn("post-await state", source)
        self.assertIn("exactly-once", source)
        self.assertIn("canonical cleanup rejection ownership", source)
        self.assertIn("same rejection object", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.32 production targets.", source)
        self.assertIn("B.32 FROZEN FINAL", source)
        self.assertIn("GarbageCollector", source)
        self.assertIn("DELETE ... RETURNING", source)
        self.assertIn("cleanup refresh", source)
        self.assertIn("exact finalized storage IDs", source)
        self.assertIn("MUTATION DIAGNOSTIC", source)
        self.assertIn("Unauthorized unlink", source)
        self.assertIn("owner-scoped UPDATE ... RETURNING id", source)
        self.assertIn("selectively erases token and quota", source)
        self.assertIn("In-flight refresh RED", source)
        self.assertIn("stale cache", source)
        self.assertIn("FOR SHARE", source)
        self.assertIn("different-storage parallelism", source)
        self.assertIn("historical MUT-001", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.33 production targets.", source)
        self.assertIn("B.31 FROZEN FINAL, B.32 FROZEN FINAL, B.33 FROZEN FINAL", source)
        self.assertIn("TokenAccess::UnlinkCleanup", source)
        self.assertIn("mixed-authority", source)
        self.assertIn("cleanup-scoped warm token", source)
        self.assertIn("B.34 FROZEN FINAL", source)
        self.assertIn("B.35 and B.36 remain NOT STARTED", source)
        self.assertIn("B.37 is NOT SELECTED", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.34 production targets.", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.36 production targets.", source)
        self.assertIn("transaction-scoped advisory lock", source)
        self.assertIn("idx_external_storage_one_active_account", source)
        self.assertIn("one 200 and one 409", source)
        self.assertIn("B.37 production targets", source)
        self.assertIn("B.37 FROZEN FINAL", source)
        self.assertIn("B.38 is NOT STARTED", source)
        self.assertIn("B.38 FROZEN FINAL", source)
        self.assertIn("B.39 is NOT STARTED", source)
        self.assertIn("AUTH_DB_NOT_CONFIGURED", source)
        self.assertIn("b38_logout_failure_trigger", source)
        self.assertIn("Cookie clearing is performed only after server revocation succeeds", source)
        self.assertIn("request #15 returned 403", source)
        self.assertIn("B.39 FROZEN FINAL", source)
        self.assertIn("B.40 FROZEN FINAL", source)
        self.assertIn("B41-EVIDENCE-001", source)
        self.assertIn("B41-EVIDENCE-002", source)
        self.assertIn("B41-TEST-SEMANTICS-001", source)
        self.assertIn("deleted_at IS NOT NULL", source)
        self.assertIn("The B.41 total-quota characterization now genuinely marks", source)
        self.assertIn("seed 41021 PASS", source)
        self.assertIn("seed 41022 PASS", source)
        self.assertIn("seed 41023 PASS", source)
        self.assertIn("The nested-pool deadlock remains SOURCE-PROVEN REACHABLE", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.41 production targets.", source)
        self.assertIn("No additional B.41 production code change was required by the final evidence micro-gate.", source)
        self.assertIn("B.41 is FROZEN FINAL after completion of the missing multi-seed", source)
        self.assertIn("B.41 FROZEN FINAL", source)
        self.assertIn("B.42 FROZEN FINAL", source)
        self.assertIn("B.43 is NOT STARTED", source)
        self.assertIn("same-storage failure cohort was RED", source)
        self.assertIn("old owner cannot publish stale quota", source)
        self.assertIn("6cbb74adb0a770bcb484fb0a1e74ad5b1ff3e04a4f033bffe0ddc1c29149639b", source)
        self.assertIn("B42-TEST-CLEANUP-001", source)
        self.assertIn("B42-TEST-COHORT-CAUSALITY-001", source)
        self.assertIn("seed 42100", source)
        self.assertIn("seeds 42121, 42122 and 42123", source)
        self.assertIn("6856 assertions in 119 test cases", source)
        self.assertIn("No runtime production test seam is present. The quota follower observer and GoogleDriveQuotaTestProbe access exist only when NANIKA_TESTING is compiled into savebox_tests.", source)
        self.assertIn("The same-storage failure-cohort test now proves causally that all three followers captured the same F1 before the provider owner was released; one provider failure is shared by the entire cohort and a later independent call creates the next owner.", source)
        self.assertIn("No B.42 concurrency test retains a fatal assertion path that can bypass release of a blocking gate or join of a live std::thread.", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.42 production targets.", source)
        self.assertIn("B.42 is FROZEN FINAL after completion of the causal cohort-membership, fail-safe concurrency-harness and compile-time test-seam evidence.", source)
        self.assertIn("Existing JWT rejection after account soft-delete was GREEN against unmodified production and remained unchanged.", source)
        self.assertIn("Deleted-account local login returned an internal error because authenticate_user still selected tombstones", source)
        self.assertIn("Production run_cleanup did not make deleted-user file lifecycle reachable", source)
        self.assertIn("Mutation remained scoped only to format-bytes.ts; no mutation score is claimed for B.43 production targets.", source)
        self.assertIn("B.43 FINAL EVIDENCE MICRO-GATE mutation result", source)
        self.assertIn("15 total mutants, 14 killed, 0 survived, 1 compile error", source)
        self.assertIn("candidate MUT-001 survivor did not reproduce", source)
        self.assertIn("Soft-deleted JWT authority was GREEN", source)
        self.assertIn("same-provider OAuth tombstone was GREEN", source)
        self.assertIn("existing B.42 token and per-storage quota caches", source)
        self.assertIn("repeated-GC evidence uses one local file and one pending external blocker", source)
        self.assertIn("B.43 FINAL EVIDENCE MICRO-GATE accepted", source)
        self.assertIn("No B.43 production source was modified by the final evidence micro-gate.", source)
        self.assertIn("B.43 FROZEN FINAL", source)
        self.assertIn("B.44 local hard-delete commit authority", source)
        self.assertIn("B44_QUOTA_FAIL", source)
        self.assertIn("PRE characterization against unchanged production", source)
        self.assertIn("7018 assertions in 143 test cases", source)
        self.assertIn("ff41fb5db1a805e114972367b3c1e19e08db5c3ef7f53534076c22d8ff510499", source)
        self.assertIn("B.44 FROZEN FINAL", source)
        self.assertIn('"b45_changes": [', source)
        self.assertIn('"## B.45 Changes"', source)
        self.assertIn("B45-PLAINTEXT-SENTINEL.jpg", source)
        self.assertIn("B45-PART-HEADER-SENTINEL", source)
        self.assertIn("DETERMINISTIC RED", source)
        self.assertIn("generic dump of every multipart header", source)
        self.assertIn("avatar.png", source)
        self.assertIn("no mutation score is claimed for B.45 production targets", source)
        self.assertNotIn("backend preflight unavailable, recovery.spec.ts failed before the flow, 4/5 passed", source)
        self.assertIn("retained artifacts do not establish whether the earlier canonical invocation failed during preflight or entered Playwright", source)
        self.assertIn("no exact 4/5 count or failed-spec claim is made", source)
        self.assertIn("Current authoritative Playwright run completed 5/5", source)
        self.assertIn("B.45 FROZEN FINAL", source)
        self.assertIn('"b46_changes": [', source)
        self.assertIn('"## B.46 Changes"', source)
        self.assertIn("B46-POSTGRES-INGRESS-001", source)
        self.assertIn('postgres-db `ports: - \\\"5433:5432\\\"` block was removed', source)
        self.assertIn("active deployment/config consumer audit found no current use", source)
        self.assertIn("remaining 5433 literals exist only in B.46 historical evidence and baseline-regression assertions", source)
        self.assertNotIn("POST static source search found no 5433", source)
        self.assertIn("No B.46 mutation score is claimed", source)
        self.assertIn("B.47 and B.48 remain SELECTED / NOT STARTED", source)
        self.assertIn("B.47 active-name authority and non-destructive file replacement", source)
        self.assertIn('"b47_changes": [', source)
        self.assertIn('"## B.47 Changes"', source)
        self.assertIn("B46-EVIDENCE-SEARCH-001 is RESOLVED as an evidence-only preamble", source)
        self.assertIn("No ALTER compatibility path or legacy-schema detection was added", source)
        self.assertNotIn("fails closed when either legacy pg_constraint remains", source)
        self.assertIn("B47-REPLACEMENT-LOG-001 final micro-gate", source)
        self.assertIn("logs only the existing generic message plus error.status or 'unknown'", source)
        self.assertIn("timed out during the initial Karma dry-run", source)
        self.assertIn("current configured invocation completed successfully", source)
        self.assertIn("No mutation score is claimed for B.47 production targets", source)
        self.assertIn("B47-MUTATION-GATE-001 RESOLVED", source)
        self.assertIn("B.47 FROZEN FINAL / RATIFIED", source)
        self.assertIn("B.48 remains SELECTED / NOT STARTED", source)
        self.assertIn('"b48_changes": [', source)
        self.assertIn('"## B.48 Changes"', source)
        self.assertIn("select_batch_storages", source)
        self.assertIn("B.48 implementation is complete but is not FROZEN", source)
        self.assertIn("no mutation score is claimed for B.48 production targets", source)
        self.assertNotIn("mutation score is claimed for B.47 production targets", source.replace("No mutation score is claimed for B.47 production targets", ""))
        self.assertIn('"b48_final_micro_freeze_changes":', source)
        self.assertIn('"## B.48 Final Micro-Freeze Changes"', source)
        self.assertIn("B48-OPENAPI-CONTRACT-001 CLOSED", source)
        self.assertIn("stale database was historical candidate provenance", source)
        self.assertIn("No ALTER compatibility path or legacy-schema detection was added", source)
        self.assertIn("--b49-final-freeze", source)
        self.assertIn("B.48 FROZEN FINAL / RATIFIED", source)
        self.assertIn("B.31–B.48 are FROZEN FINAL / RATIFIED", source)
        self.assertIn('"b49_changes":', source)
        self.assertIn('"## B.49 Changes"', source)
        self.assertIn("B.49 FROZEN FINAL / RATIFIED", source)
        self.assertIn("B.31–B.49 are FROZEN FINAL / RATIFIED", source)
        self.assertIn("B.50 and B.51 remain SELECTED / NOT STARTED", source)
        self.assertIn("NEXT: B.50", source)
        self.assertIn("B.49 remains NOT SELECTED / NOT STARTED", source)
        self.assertIn("NEXT: FRESH BROAD AUDIT", source)
        self.assertIn("--b50-candidate", source)
        self.assertIn('"b50_changes":', source)
        self.assertIn('"## B.50 Changes"', source)
        self.assertIn("B.50 quality status: IMPLEMENTED — FROZEN CANDIDATE", source)

    def test_b50_final_freeze_cli_and_history_are_explicit(self) -> None:
        source = Path(generate_baseline.__file__).read_text(encoding="utf-8")
        self.assertIn("--b50-final-freeze", source)
        self.assertIn("B.49 final freeze, B.50 candidate and B.50 final freeze are mutually exclusive", source)
        self.assertIn('"b50_final_micro_freeze_changes":', source)
        self.assertIn('"## B.50 Final Micro-Freeze Changes"', source)
        self.assertIn("B.50 quality status: IMPLEMENTED — FROZEN CANDIDATE", source)
        self.assertIn("B.50 FROZEN FINAL / RATIFIED", source)
        self.assertIn("B.31–B.50 are FROZEN FINAL / RATIFIED", source)
        self.assertIn("NEXT: B.51 FINAL MICRO-FREEZE / RATIFICATION", source)

    def test_b50_final_freeze_cli_is_mutually_exclusive(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1",
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b50-candidate",
                "--b50-final-freeze",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)

    def test_b50_final_freeze_ready_accepts_green_evidence(self) -> None:
        self.assertTrue(generate_baseline.b50_final_freeze_ready(
            e2e={
                "status_valid": True,
                "report_valid": True,
                "current_run": True,
                "outcome": "completed",
                "exit_code": 0,
                "hash_match": True,
                "total": 5,
                "passed": 5,
                "failed": 0,
                "skipped": 0,
                "flaky": 0,
                "retries": 0,
            },
            frontend_coverage={"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            backend_coverage={"lines": 75.0},
            mutation={"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0},
            frontend_tests=1003,
            backend_cases=180,
            backend_assertions=7381,
        ))

    def test_b50_final_freeze_rejects_nonzero_retries(self) -> None:
        evidence = {
            "status_valid": True, "report_valid": True, "current_run": True,
            "outcome": "completed", "exit_code": 0, "hash_match": True,
            "total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 1,
        }
        self.assertFalse(generate_baseline.b50_final_freeze_ready(
            e2e=evidence,
            frontend_coverage={"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            backend_coverage={"lines": 75.0},
            mutation={"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0},
            frontend_tests=1003, backend_cases=180, backend_assertions=7381,
        ))

    def test_b50_final_freeze_rejects_invalid_current_run_provenance(self) -> None:
        base = {
            "status_valid": True, "report_valid": True, "current_run": True,
            "outcome": "completed", "exit_code": 0, "hash_match": True,
            "total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0,
        }
        kwargs = {
            "frontend_coverage": {"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            "backend_coverage": {"lines": 75.0},
            "mutation": {"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0},
            "frontend_tests": 1003, "backend_cases": 180, "backend_assertions": 7381,
        }
        for invalid in ({"current_run": False}, {"status_valid": False}, {"report_valid": False}, {"hash_match": False}, {"passed": 4, "failed": 1}):
            self.assertFalse(generate_baseline.b50_final_freeze_ready(e2e={**base, **invalid}, **kwargs))

    def test_b50_final_freeze_rejects_missing_counts_or_coverage(self) -> None:
        base = {
            "status_valid": True, "report_valid": True, "current_run": True,
            "outcome": "completed", "exit_code": 0, "hash_match": True,
            "total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0,
        }
        kwargs = {
            "e2e": base,
            "frontend_coverage": {"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            "backend_coverage": {"lines": 75.0},
            "mutation": {"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0},
            "frontend_tests": 1003, "backend_cases": 180, "backend_assertions": 7381,
        }
        for field, value in (("frontend_tests", 0), ("backend_cases", 0), ("backend_assertions", 0)):
            self.assertFalse(generate_baseline.b50_final_freeze_ready(**{**kwargs, field: value}))
        for coverage_data in (
            {"statements": None, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            {"statements": 80.0, "branches": None, "functions": 80.0, "lines": 82.0},
            {"statements": 80.0, "branches": 69.0, "functions": None, "lines": 82.0},
            {"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": None},
        ):
            self.assertFalse(generate_baseline.b50_final_freeze_ready(**{**kwargs, "frontend_coverage": coverage_data}))
        self.assertFalse(generate_baseline.b50_final_freeze_ready(**{**kwargs, "backend_coverage": {"lines": 49.9}}))

    def test_b50_final_freeze_rejects_mutation_regressions(self) -> None:
        base = {
            "status_valid": True, "report_valid": True, "current_run": True,
            "outcome": "completed", "exit_code": 0, "hash_match": True,
            "total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0, "retries": 0,
        }
        kwargs = {
            "e2e": base,
            "frontend_coverage": {"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            "backend_coverage": {"lines": 75.0},
            "frontend_tests": 1003, "backend_cases": 180, "backend_assertions": 7381,
        }
        for mutation in (
            {"status": "executed", "survived": 1, "no_coverage": 0, "timeout": 0},
            {"status": "executed", "survived": 0, "no_coverage": 1, "timeout": 0},
            {"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 1},
        ):
            self.assertFalse(generate_baseline.b50_final_freeze_ready(mutation=mutation, **kwargs))

    def test_b50_final_freeze_render_contains_ratification_status(self) -> None:
        subprocess.run([sys.executable, str(Path(generate_baseline.__file__).resolve()),
            "--root", str(self.root), "--frontend-tests", "0", "--backend-cases", "0",
            "--backend-assertions", "0", "--fixture-cases", "0", "--fixture-assertions", "0"],
            check=True, capture_output=True, text=True)
        payload = json.loads((self.root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
        payload["b50_final_micro_freeze_changes"] = [
            "B.50 FROZEN FINAL / RATIFIED",
            "B.31–B.50 are FROZEN FINAL / RATIFIED",
            "B.51 remains SELECTED / NOT STARTED",
            "NEXT: B.51 FINAL MICRO-FREEZE / RATIFICATION",
        ]
        rendered = generate_baseline.render(payload)
        self.assertIn("## B.50 Final Micro-Freeze Changes", rendered)
        self.assertIn("B.50 FROZEN FINAL / RATIFIED", rendered)
        self.assertIn("B.31–B.50 are FROZEN FINAL / RATIFIED", rendered)
        self.assertIn("NEXT: B.51 FINAL MICRO-FREEZE / RATIFICATION", rendered)

    def test_b53_candidate_readiness_is_focused_only(self) -> None:
        self.assertTrue(generate_baseline.b53_candidate_ready(backend_cases=2, backend_assertions=20))
        self.assertFalse(generate_baseline.b53_candidate_ready(backend_cases=0, backend_assertions=20))
        self.assertFalse(generate_baseline.b53_candidate_ready(backend_cases=2, backend_assertions=0))

    def test_b53_candidate_cli_emits_catch_up_and_defers_heavy_evidence(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1003",
                "--backend-cases", "182",
                "--backend-assertions", "7401",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b53-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads((self.root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
        rendered = (self.root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
        self.assertIn("B.53", payload["quality_scope"])
        self.assertEqual(payload["backend_gate"], "PASS: focused B.53 candidate gate; repository-wide heavy checkpoint deferred")
        self.assertTrue(payload["b51_final_micro_freeze_changes"])
        self.assertTrue(payload["b52_final_micro_freeze_changes"])
        self.assertIn("B.53 IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b53_changes"]))
        self.assertIn("## B.51 Final Micro-Freeze Changes", rendered)
        self.assertIn("## B.52 Final Micro-Freeze Changes", rendered)
        self.assertIn("## B.53 Changes", rendered)
        self.assertIn("HEAVY CHECKPOINT", " ".join(payload["b53_changes"]))
        self.assertIn("b50_changes", payload)

    def test_b53_candidate_is_mutually_exclusive_with_b50_modes(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1",
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b50-candidate",
                "--b53-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)

    def test_b54_candidate_readiness_is_focused_only(self) -> None:
        self.assertTrue(generate_baseline.b54_candidate_ready(backend_cases=6, backend_assertions=56))
        self.assertFalse(generate_baseline.b54_candidate_ready(backend_cases=0, backend_assertions=56))
        self.assertFalse(generate_baseline.b54_candidate_ready(backend_cases=6, backend_assertions=0))

    def test_b54_candidate_cli_preserves_b53_and_defers_heavy_evidence(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1003",
                "--backend-cases", "188",
                "--backend-assertions", "7457",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b54-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads((self.root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
        rendered = (self.root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
        self.assertIn("B.54", payload["quality_scope"])
        self.assertEqual(payload["backend_gate"], "PASS: focused B.54 candidate gate; repository-wide heavy checkpoint deferred")
        self.assertTrue(payload["b53_changes"])
        self.assertIn("B.54 IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b54_changes"]))
        self.assertIn("B.55 and B.56 remain SELECTED / NOT STARTED", " ".join(payload["b54_changes"]))
        self.assertIn("## B.53 Changes", rendered)
        self.assertIn("## B.54 Changes", rendered)
        self.assertIn("HEAVY CHECKPOINT", " ".join(payload["b54_changes"]))

    def test_b53_and_b54_candidate_modes_are_mutually_exclusive(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1",
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b53-candidate",
                "--b54-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)

    def test_b55_candidate_readiness_is_focused_only(self) -> None:
        self.assertTrue(generate_baseline.b55_candidate_ready(backend_cases=9, backend_assertions=58))
        self.assertFalse(generate_baseline.b55_candidate_ready(backend_cases=0, backend_assertions=58))
        self.assertFalse(generate_baseline.b55_candidate_ready(backend_cases=9, backend_assertions=0))

    def test_b55_candidate_cli_marks_focused_provenance_and_preserves_prior_rounds(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1003",
                "--backend-cases", "9",
                "--backend-assertions", "58",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b55-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads((self.root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
        rendered = (self.root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
        self.assertIn("B.55", payload["quality_scope"])
        self.assertEqual(payload["backend_gate"], "PASS: focused B.55 candidate gate; repository-wide heavy checkpoint deferred")
        self.assertTrue(payload["b53_changes"])
        self.assertTrue(payload["b54_changes"])
        self.assertIn("B.55 IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b55_changes"]))
        self.assertIn("FOCUSED CURRENT", payload["evidence_provenance"]["current_round"])
        self.assertEqual(payload["evidence_provenance"]["heavy_checkpoint"], "DEFERRED / NOT RERUN")
        self.assertIn("## Evidence Provenance", rendered)
        self.assertIn("## B.55 Changes", rendered)

    def test_b55_candidate_is_mutually_exclusive_with_b54(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(generate_baseline.__file__).resolve()),
                "--root", str(self.root),
                "--frontend-tests", "1",
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b54-candidate",
                "--b55-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)

    def test_b56_candidate_is_focused_and_bypasses_heavy_readers(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "7",
                "--backend-assertions", "49",
                "--b56-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "coverage", side_effect=AssertionError("coverage read")), \
                    mock.patch.object(generate_baseline, "backend_coverage", side_effect=AssertionError("backend coverage read")), \
                    mock.patch.object(generate_baseline, "mutation_summary", side_effect=AssertionError("mutation read")), \
                    mock.patch.object(generate_baseline, "e2e_summary", side_effect=AssertionError("e2e read")), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["tests"]["frontend_unit"], "NOT RUN")
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["evidence_provenance"]["full_frontend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["full_backend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["cppcheck_full"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["knip_full"], "NOT RUN")
            self.assertIn("B.56", payload["quality_scope"])

    def test_b56_candidate_ignores_stale_heavy_artifact_values(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_json(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", {
                "total": {"statements": {"pct": 999.0}, "branches": {"pct": 998.0}}
            })
            write_json(root / ".quality" / "backend-coverage.json", {"linepercent": 997.0})
            write_json(root / ".quality" / "mutation" / "mutation.json", {"files": {"stale": {"mutants": [{"status": "killed"}]}}})
            write_json(root / ".quality" / "playwright" / "results.json", report(*(["expected"] * 999)))
            write_json(root / ".quality" / "playwright" / "run-status.json", {
                "schema": 1,
                "outcome": "completed",
                "exit_code": 0,
                "report_sha256": "f" * 64,
                "started_at": "stale",
                "finished_at": "stale",
                "phase": "stale",
            })
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "7",
                "--backend-assertions", "49",
                "--b56-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertNotIn("999.0", rendered)
            self.assertNotIn("998.0", rendered)
            self.assertNotIn("997.0", rendered)
            self.assertIn("NOT RUN / NOT READ", rendered)

    def test_b56_candidate_requires_focused_counts_and_is_exclusive(self) -> None:
        script = str(Path(generate_baseline.__file__).resolve())
        missing = subprocess.run(
            [sys.executable, script, "--b56-candidate"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("focused backend", missing.stderr)

        conflict = subprocess.run(
            [
                sys.executable, script,
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b55-candidate",
                "--b56-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("mutually exclusive", conflict.stderr)

    def test_b57_candidate_is_focused_and_bypasses_heavy_readers(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "7",
                "--backend-assertions", "41",
                "--b57-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "coverage", side_effect=AssertionError("coverage read")), \
                    mock.patch.object(generate_baseline, "backend_coverage", side_effect=AssertionError("backend coverage read")), \
                    mock.patch.object(generate_baseline, "mutation_summary", side_effect=AssertionError("mutation read")), \
                    mock.patch.object(generate_baseline, "e2e_summary", side_effect=AssertionError("e2e read")), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["tests"]["backend_cases"], 7)
            self.assertEqual(payload["tests"]["backend_assertions"], 41)
            self.assertEqual(payload["backend_gate"], "PASS: focused B.57 candidate gate; repository-wide heavy checkpoint deferred")
            self.assertIn("B.57", payload["quality_scope"])
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["evidence_provenance"]["full_frontend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["full_backend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["cppcheck_full"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["knip_full"], "NOT RUN")
            self.assertTrue(payload["b56_changes"])
            self.assertIn("B.57 IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b57_changes"]))
            self.assertIn("## B.57 Changes", rendered)

    def test_b57_candidate_ignores_stale_heavy_artifact_values(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_json(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", {
                "total": {"statements": {"pct": 999.0}, "branches": {"pct": 998.0}}
            })
            write_json(root / ".quality" / "backend-coverage.json", {"linepercent": 997.0})
            write_json(root / ".quality" / "mutation" / "mutation.json", {"files": {"stale": {"mutants": [{"status": "killed"}]}}})
            write_json(root / ".quality" / "playwright" / "results.json", report(*(["expected"] * 999)))
            write_json(root / ".quality" / "playwright" / "run-status.json", {
                "schema": 1,
                "outcome": "completed",
                "exit_code": 0,
                "report_sha256": "f" * 64,
                "started_at": "stale",
                "finished_at": "stale",
                "phase": "stale",
            })
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "7",
                "--backend-assertions", "41",
                "--b57-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertNotIn("999.0", rendered)
            self.assertNotIn("998.0", rendered)
            self.assertNotIn("997.0", rendered)
            self.assertIn("NOT RUN / NOT READ", rendered)

    def test_b57_candidate_requires_focused_counts_and_is_exclusive(self) -> None:
        self.assertTrue(generate_baseline.b57_candidate_ready(backend_cases=7, backend_assertions=41))
        self.assertFalse(generate_baseline.b57_candidate_ready(backend_cases=0, backend_assertions=41))
        self.assertFalse(generate_baseline.b57_candidate_ready(backend_cases=7, backend_assertions=0))
        script = str(Path(generate_baseline.__file__).resolve())
        missing = subprocess.run(
            [sys.executable, script, "--b57-candidate"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("focused backend", missing.stderr)

        conflict = subprocess.run(
            [
                sys.executable, script,
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b56-candidate",
                "--b57-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("mutually exclusive", conflict.stderr)

    def test_b58_candidate_is_focused_and_bypasses_heavy_readers(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "9",
                "--backend-assertions", "54",
                "--b58-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "coverage", side_effect=AssertionError("coverage read")), \
                    mock.patch.object(generate_baseline, "backend_coverage", side_effect=AssertionError("backend coverage read")), \
                    mock.patch.object(generate_baseline, "mutation_summary", side_effect=AssertionError("mutation read")), \
                    mock.patch.object(generate_baseline, "e2e_summary", side_effect=AssertionError("e2e read")), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["tests"]["backend_cases"], 9)
            self.assertEqual(payload["tests"]["backend_assertions"], 54)
            self.assertEqual(payload["backend_gate"], "PASS: focused B.58 candidate gate; repository-wide heavy checkpoint deferred")
            self.assertIn("B.58", payload["quality_scope"])
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["evidence_provenance"]["full_frontend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["full_backend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["cppcheck_full"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["knip_full"], "NOT RUN")
            self.assertTrue(payload["b57_changes"])
            self.assertIn("B.58 is IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b57_changes"]))
            self.assertTrue(payload["b58_changes"])
            self.assertIn("## B.58 Changes", rendered)

    def test_b58_candidate_ignores_stale_heavy_artifact_values(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_json(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", {
                "total": {"statements": {"pct": 999.0}, "branches": {"pct": 998.0}}
            })
            write_json(root / ".quality" / "backend-coverage.json", {"linepercent": 997.0})
            write_json(root / ".quality" / "mutation" / "mutation.json", {"files": {"stale": {"mutants": [{"status": "killed"}]}}})
            write_json(root / ".quality" / "playwright" / "results.json", report(*(["expected"] * 999)))
            write_json(root / ".quality" / "playwright" / "run-status.json", {
                "schema": 1,
                "outcome": "completed",
                "exit_code": 0,
                "report_sha256": "f" * 64,
                "started_at": "stale",
                "finished_at": "stale",
                "phase": "stale",
            })
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "9",
                "--backend-assertions", "54",
                "--b58-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertNotIn("999.0", rendered)
            self.assertNotIn("998.0", rendered)
            self.assertNotIn("997.0", rendered)
            self.assertIn("NOT RUN / NOT READ", rendered)

    def test_b58_candidate_requires_focused_counts_and_is_exclusive(self) -> None:
        self.assertTrue(generate_baseline.b58_candidate_ready(backend_cases=9, backend_assertions=54))
        self.assertFalse(generate_baseline.b58_candidate_ready(backend_cases=0, backend_assertions=54))
        self.assertFalse(generate_baseline.b58_candidate_ready(backend_cases=9, backend_assertions=0))
        script = str(Path(generate_baseline.__file__).resolve())
        missing = subprocess.run(
            [sys.executable, script, "--b58-candidate"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("focused backend", missing.stderr)

        conflict = subprocess.run(
            [
                sys.executable, script,
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b57-candidate",
                "--b58-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("mutually exclusive", conflict.stderr)

    def test_b59_candidate_is_focused_and_bypasses_heavy_readers(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "7",
                "--backend-assertions", "86",
                "--b59-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "coverage", side_effect=AssertionError("coverage read")), \
                    mock.patch.object(generate_baseline, "backend_coverage", side_effect=AssertionError("backend coverage read")), \
                    mock.patch.object(generate_baseline, "mutation_summary", side_effect=AssertionError("mutation read")), \
                    mock.patch.object(generate_baseline, "e2e_summary", side_effect=AssertionError("e2e read")), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["tests"]["backend_cases"], 7)
            self.assertEqual(payload["tests"]["backend_assertions"], 86)
            self.assertEqual(payload["backend_gate"], "PASS: focused B.59 candidate gate; HC preflight green; heavy checkpoint ready / next")
            self.assertIn("B.59", payload["quality_scope"])
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["evidence_provenance"]["heavy_checkpoint"], "READY / NEXT / NOT RUN IN THIS EXECUTION")
            self.assertEqual(payload["evidence_provenance"]["full_frontend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["full_backend"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["cppcheck_full"], "NOT RUN")
            self.assertEqual(payload["evidence_provenance"]["knip_full"], "NOT RUN")
            self.assertTrue(payload["b58_changes"])
            self.assertIn("B.59 is IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b58_changes"]))
            self.assertIn("B.59 IMPLEMENTED CANDIDATE / LOCAL GREEN", " ".join(payload["b59_changes"]))
            self.assertIn("B.51-REGRESSION-HARNESS-STABILITY-001 CLOSED", " ".join(payload["b59_changes"]))
            self.assertIn("WINDOWS-TEST-PROCESS-HEAP-STABILITY-001 NOT REPRODUCED", " ".join(payload["b59_changes"]))
            self.assertIn("## B.59 Changes", rendered)

    def test_b59_candidate_ignores_stale_heavy_artifact_values(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_json(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", {
                "total": {"statements": {"pct": 999.0}, "branches": {"pct": 998.0}}
            })
            write_json(root / ".quality" / "backend-coverage.json", {"linepercent": 997.0})
            write_json(root / ".quality" / "mutation" / "mutation.json", {"files": {"stale": {"mutants": [{"status": "killed"}]}}})
            write_json(root / ".quality" / "playwright" / "results.json", report(*(["expected"] * 999)))
            write_json(root / ".quality" / "playwright" / "run-status.json", {
                "schema": 1,
                "outcome": "completed",
                "exit_code": 0,
                "report_sha256": "f" * 64,
                "started_at": "stale",
                "finished_at": "stale",
                "phase": "stale",
            })
            argv = [
                "generate_baseline.py",
                "--root", str(root),
                "--backend-cases", "7",
                "--backend-assertions", "86",
                "--b59-candidate",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["coverage"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["coverage"]["backend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["mutation"]["frontend"]["status"], "NOT RUN / NOT READ")
            self.assertEqual(payload["tests"]["e2e"]["status"], "NOT RUN / NOT READ")
            self.assertNotIn("999.0", rendered)
            self.assertNotIn("998.0", rendered)
            self.assertNotIn("997.0", rendered)

    def test_b59_candidate_requires_focused_counts_and_is_exclusive(self) -> None:
        self.assertTrue(generate_baseline.b59_candidate_ready(backend_cases=7, backend_assertions=86))
        self.assertFalse(generate_baseline.b59_candidate_ready(backend_cases=0, backend_assertions=86))
        self.assertFalse(generate_baseline.b59_candidate_ready(backend_cases=7, backend_assertions=0))
        script = str(Path(generate_baseline.__file__).resolve())
        missing = subprocess.run(
            [sys.executable, script, "--b59-candidate"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("focused backend", missing.stderr)

        conflict = subprocess.run(
            [
                sys.executable, script,
                "--backend-cases", "1",
                "--backend-assertions", "1",
                "--fixture-cases", "0",
                "--fixture-assertions", "0",
                "--b58-candidate",
                "--b59-candidate",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("mutually exclusive", conflict.stderr)

    def test_b59_final_freeze_ready_requires_complete_green_heavy_evidence(self) -> None:
        e2e = {
            "status_valid": True, "report_valid": True, "current_run": True,
            "outcome": "completed", "exit_code": 0, "hash_match": True,
            "total": 5, "passed": 5, "failed": 0, "skipped": 0, "flaky": 0,
            "retries": 0,
        }
        kwargs = {
            "e2e": e2e,
            "frontend_coverage": {"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            "backend_coverage": {"lines": 76.1, "branches": 40.0, "functions": 69.8},
            "mutation": {"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0},
            "frontend_tests": 1003, "backend_cases": 227, "backend_assertions": 7747,
            "fixture_cases": 4, "fixture_assertions": 15,
        }
        self.assertTrue(generate_baseline.b59_final_freeze_ready(**kwargs))
        for field, value in (("fixture_cases", 0), ("fixture_assertions", 0), ("backend_coverage", {"lines": 49.9}), ("frontend_tests", 0)):
            self.assertFalse(generate_baseline.b59_final_freeze_ready(**{**kwargs, field: value}))
        for invalid_e2e in ({"retries": 1}, {"hash_match": False}, {"passed": 4, "failed": 1}):
            self.assertFalse(generate_baseline.b59_final_freeze_ready(e2e={**e2e, **invalid_e2e}, **{key: value for key, value in kwargs.items() if key != "e2e"}))
        for mutation in (
            {"status": "executed", "survived": 1, "no_coverage": 0, "timeout": 0},
            {"status": "executed", "survived": 0, "no_coverage": 1, "timeout": 0},
            {"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 1},
        ):
            self.assertFalse(generate_baseline.b59_final_freeze_ready(mutation=mutation, **{key: value for key, value in kwargs.items() if key != "mutation"}))

    def test_b59_final_freeze_cli_requires_current_heavy_artifacts(self) -> None:
        script = str(Path(generate_baseline.__file__).resolve())
        with TemporaryDirectory() as temporary:
            result = subprocess.run(
                [
                    sys.executable, script,
                    "--root", temporary,
                    "--frontend-tests", "1003",
                    "--backend-cases", "227",
                    "--backend-assertions", "7747",
                    "--fixture-cases", "4",
                    "--fixture-assertions", "15",
                    "--b59-final-freeze",
                ],
                capture_output=True,
                text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("heavy evidence", result.stderr)

    def test_b59_final_freeze_cli_is_mutually_exclusive_with_candidates(self) -> None:
        script = str(Path(generate_baseline.__file__).resolve())
        result = subprocess.run(
            [
                sys.executable, script,
                "--backend-cases", "7",
                "--backend-assertions", "86",
                "--b59-candidate",
                "--b59-final-freeze",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)

    def test_b59_final_freeze_reads_current_reports_and_renders_ratification(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "docs" / "swagger.yaml").parent.mkdir(parents=True)
            (root / "docs" / "swagger.yaml").write_text("openapi: 3.0.0\n", encoding="utf-8")
            (root / "tools" / "quality" / "test_openapi_contract.py").parent.mkdir(parents=True)
            (root / "tools" / "quality" / "test_openapi_contract.py").write_text("# test\n", encoding="utf-8")
            write_json(root / ".quality" / "module-metrics.json", {"modules": []})
            (root / ".quality" / "cppcheck.xml").parent.mkdir(parents=True, exist_ok=True)
            (root / ".quality" / "cppcheck.xml").write_text("<results />\n", encoding="utf-8")
            write_json(root / ".quality" / "knip-normal.json", {"files": [], "exports": [], "types": [], "dependencies": [], "devDependencies": []})
            write_json(root / ".quality" / "knip-production.json", {"files": [], "dependencies": []})
            write_json(root / ".quality" / "knip-cycles.json", {"cycles": []})
            write_json(root / ".quality" / "mutation" / "mutation.json", {
                "config": {"mutate": ["src/app/shared/utils/format-bytes.ts"]},
                "files": {"format-bytes.ts": {"mutants": [{"status": "Killed"}] }},
            })
            write_json(root / "frontend" / "coverage" / "frontend" / "coverage-summary.json", {
                "total": {
                    "statements": {"pct": 80.04}, "branches": {"pct": 69.47},
                    "functions": {"pct": 80.83}, "lines": {"pct": 82.31},
                }
            })
            write_json(root / ".quality" / "backend-coverage.json", {"linepercent": 76.1, "branchpercent": 40.0, "functionpercent": 69.8})
            report_path = root / ".quality" / "playwright" / "results.json"
            write_json(report_path, report(*(["expected"] * 5)))
            write_json(root / ".quality" / "playwright" / "run-status.json", self.status(report_hash=generate_baseline.file_sha256(report_path)))

            argv = [
                "generate_baseline.py", "--root", str(root),
                "--frontend-tests", "1003", "--backend-cases", "227", "--backend-assertions", "7747",
                "--fixture-cases", "4", "--fixture-assertions", "15", "--b59-final-freeze",
            ]
            with mock.patch.object(generate_baseline.sys, "argv", argv), \
                    mock.patch.object(generate_baseline, "version", return_value="test"), \
                    mock.patch.object(generate_baseline.shutil, "which", return_value=None):
                generate_baseline.main()

            payload = json.loads((root / "docs" / "quality-baseline.json").read_text(encoding="utf-8"))
            rendered = (root / "docs" / "quality-baseline.md").read_text(encoding="utf-8")
            self.assertEqual(payload["backend_gate"], "PASS: HEAVY CHECKPOINT B.53–B.59; final ratification; B.31–B.59 FROZEN FINAL / RATIFIED; B.60+ NOT SELECTED; NEXT: FRESH BROAD AUDIT")
            self.assertIn("B.31–B.59 are FROZEN FINAL / RATIFIED", payload["quality_scope"])
            self.assertEqual(payload["tests"]["e2e"]["passed"], 5)
            self.assertFalse(any(item["id"] == "E2E-001" for item in payload["findings"]))
            self.assertTrue(payload["b53_changes"])
            self.assertTrue(payload["b59_changes"])
            self.assertTrue(payload["b59_final_freeze_changes"])
            self.assertIn("## B.53–B.59 Heavy Checkpoint / Final Freeze", rendered)
            self.assertIn("B.60+ NOT SELECTED", rendered)

    def test_b49_final_freeze_is_closed_only_with_current_green_evidence(self) -> None:
        green_e2e = {
            "status_valid": True,
            "report_valid": True,
            "current_run": True,
            "outcome": "completed",
            "exit_code": 0,
            "hash_match": True,
            "total": 5,
            "passed": 5,
            "failed": 0,
            "skipped": 0,
            "flaky": 0,
        }
        green_coverage = {"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0}
        green_backend = {"lines": 75.0, "branches": 39.0, "functions": 69.0}
        green_mutation = {"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0}
        self.assertTrue(generate_baseline.b49_final_freeze_ready(
            e2e=green_e2e,
            frontend_coverage=green_coverage,
            backend_coverage=green_backend,
            mutation=green_mutation,
            frontend_tests=1003,
            backend_cases=158,
            backend_assertions=7197,
        ))
        green_e2e["passed"] = 4
        green_e2e["failed"] = 1
        self.assertFalse(generate_baseline.b49_final_freeze_ready(
            e2e=green_e2e,
            frontend_coverage=green_coverage,
            backend_coverage=green_backend,
            mutation=green_mutation,
            frontend_tests=1003,
            backend_cases=158,
            backend_assertions=7197,
        ))
        green_e2e["passed"] = 5
        green_e2e["failed"] = 0
        for invalid in (
            {"current_run": False},
            {"hash_match": False},
        ):
            self.assertFalse(generate_baseline.b49_final_freeze_ready(
                e2e={**green_e2e, **invalid},
                frontend_coverage=green_coverage,
                backend_coverage=green_backend,
                mutation=green_mutation,
                frontend_tests=1003,
                backend_cases=158,
                backend_assertions=7197,
            ))
        self.assertFalse(generate_baseline.b49_final_freeze_ready(
            e2e=green_e2e,
            frontend_coverage=green_coverage,
            backend_coverage=green_backend,
            mutation=green_mutation,
            frontend_tests=0,
            backend_cases=158,
            backend_assertions=7197,
        ))
        self.assertFalse(generate_baseline.b49_final_freeze_ready(
            e2e=green_e2e,
            frontend_coverage=green_coverage,
            backend_coverage=green_backend,
            mutation=green_mutation,
            frontend_tests=1003,
            backend_cases=0,
            backend_assertions=0,
        ))

    def test_b50_candidate_uses_the_same_current_evidence_gate_without_ratifying_b50(self) -> None:
        green_e2e = {
            "status_valid": True,
            "report_valid": True,
            "current_run": True,
            "outcome": "completed",
            "exit_code": 0,
            "hash_match": True,
            "total": 5,
            "passed": 5,
            "failed": 0,
            "skipped": 0,
            "flaky": 0,
        }
        self.assertTrue(generate_baseline.b50_candidate_ready(
            e2e=green_e2e,
            frontend_coverage={"statements": 80.0, "branches": 69.0, "functions": 80.0, "lines": 82.0},
            backend_coverage={"lines": 75.0},
            mutation={"status": "executed", "survived": 0, "no_coverage": 0, "timeout": 0},
            frontend_tests=1003,
            backend_cases=168,
            backend_assertions=7248,
        ))


class RunnerTests(unittest.TestCase):
    def test_success_cleans_before_preflight_and_writes_hash(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / ".quality" / "playwright"
            evidence.mkdir(parents=True)
            (root / "frontend").mkdir()
            (evidence / "results.json").write_text("stale", encoding="utf-8")
            (evidence / "run-status.json").write_text("stale", encoding="utf-8")

            def preflight(_url: str) -> None:
                self.assertFalse((evidence / "results.json").exists())
                self.assertFalse((evidence / "run-status.json").exists())

            def run_process(_args: list[str], **kwargs: object) -> subprocess.CompletedProcess:
                (evidence / "results.json").write_text(json.dumps(report(*(["expected"] * 5))), encoding="utf-8")
                return subprocess.CompletedProcess([], 0)

            with mock.patch.object(run_playwright, "require_healthy", side_effect=preflight), mock.patch.object(run_playwright.subprocess, "run", side_effect=run_process):
                self.assertEqual(run_playwright.main(root), 0)

            status = json.loads((evidence / "run-status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["outcome"], "completed")
            self.assertEqual(status["exit_code"], 0)
            self.assertEqual(status["report_sha256"], run_playwright.sha256_file(evidence / "results.json"))
            self.assertEqual(set(status), {"schema", "outcome", "exit_code", "report_sha256", "started_at", "finished_at", "phase"})

    def test_preflight_failure_writes_status_without_old_report(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / ".quality" / "playwright"
            evidence.mkdir(parents=True)
            (root / "frontend").mkdir()
            (evidence / "results.json").write_text("stale", encoding="utf-8")
            with mock.patch.object(run_playwright, "require_healthy", side_effect=RuntimeError("offline")):
                self.assertEqual(run_playwright.main(root), 1)
            self.assertFalse((evidence / "results.json").exists())
            status = json.loads((evidence / "run-status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["outcome"], "preflight_failed")

    def test_playwright_failure_preserves_exit_code_and_current_hash(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / ".quality" / "playwright"
            (root / "frontend").mkdir(parents=True)

            def run_process(_args: list[str], **kwargs: object) -> subprocess.CompletedProcess:
                evidence.mkdir(parents=True, exist_ok=True)
                (evidence / "results.json").write_text("failed report", encoding="utf-8")
                return subprocess.CompletedProcess([], 7)

            with mock.patch.object(run_playwright, "require_healthy"), mock.patch.object(run_playwright.subprocess, "run", side_effect=run_process):
                self.assertEqual(run_playwright.main(root), 7)
            status = json.loads((evidence / "run-status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["outcome"], "playwright_failed")
            self.assertEqual(status["exit_code"], 7)

    def test_missing_report_fails_closed(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "frontend").mkdir(parents=True)
            with mock.patch.object(run_playwright, "require_healthy"), mock.patch.object(run_playwright.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
                self.assertEqual(run_playwright.main(root), 1)
            status = json.loads((root / ".quality" / "playwright" / "run-status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["outcome"], "report_missing")


if __name__ == "__main__":
    unittest.main()
