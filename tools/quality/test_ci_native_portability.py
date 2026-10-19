import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class NativePortabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.backend_workflow = (ROOT / ".github" / "workflows" / "backend-ci.yml").read_text(encoding="utf-8")
        cls.frontend_workflow = (ROOT / ".github" / "workflows" / "frontend-ci.yml").read_text(encoding="utf-8")
        cls.cmake = (ROOT / "backend" / "CMakeLists.txt").read_text(encoding="utf-8")
        cls.manifest = (ROOT / "backend" / "vcpkg.json").read_text(encoding="utf-8")

    def test_backend_linux_gcc_job_is_explicit_and_normal(self) -> None:
        self.assertRegex(self.backend_workflow, r"(?m)^  backend-linux-gcc:\s*$")
        self.assertIn("name: Backend / Linux GCC", self.backend_workflow)
        self.assertIn("runs-on: ubuntu-24.04", self.backend_workflow)
        self.assertIn("CMAKE_CXX_COMPILER_ID.*GNU", self.backend_workflow)
        self.assertIn("savebox_server savebox_tests nanika_e2e_fixture", self.backend_workflow)
        self.assertIn("--rng-seed 60101", self.backend_workflow)

    def test_backend_windows_job_is_native_msvc(self) -> None:
        self.assertRegex(self.backend_workflow, r"(?m)^  backend-windows-msvc:\s*$")
        self.assertIn("name: Backend / Windows MSVC", self.backend_workflow)
        self.assertIn("runs-on: windows-2022", self.backend_workflow)
        self.assertIn('Ninja Multi-Config', self.backend_workflow)
        self.assertIn('CMAKE_CXX_COMPILER_ID.*MSVC', self.backend_workflow)
        self.assertNotIn("msys2/setup-msys2", self.backend_workflow)
        self.assertNotIn("MinGW Makefiles", self.backend_workflow)
        self.assertNotIn("mingw-w64", self.backend_workflow)
        self.assertNotIn("gcc.exe", self.backend_workflow)
        self.assertNotIn("g++.exe", self.backend_workflow)
        self.assertIn("--rng-seed 60102", self.backend_workflow)
        self.assertIn("$vcpkgRoot\\debug\\bin;$vcpkgRoot\\bin", self.backend_workflow)

    def test_msvc_cache_uses_pinned_actions_and_embedded_debug_symbols(self) -> None:
        job = self.backend_workflow.split("  backend-windows-msvc:", 1)[1].split("  backend-linux-coverage:", 1)[0]
        self.assertIn('SCCACHE_GHA_ENABLED: "true"', job)
        self.assertIn('ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756', job)
        self.assertIn('mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba', job)
        self.assertIn('version: "v0.16.0"', job)
        self.assertIn("arch: x64", job)
        self.assertIn("vsversion: '2022'", job)
        self.assertLess(job.index('Prepare vcpkg binary cache'), job.index('Setup MSVC'))
        self.assertLess(job.index('Setup MSVC'), job.index('Setup sccache'))
        self.assertNotIn('-A x64', job)
        for option in ('CMAKE_CXX_COMPILER=cl', 'CMAKE_CXX_COMPILER_LAUNCHER=sccache',
                       'CMAKE_POLICY_DEFAULT_CMP0141=NEW', 'CMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded'):
            self.assertIn('-D' + option, job)
        self.assertIn('CMAKE_CXX_COMPILER_ID.*MSVC', job)
        self.assertIn('ninja -C backend/build-msvc -f build-Debug.ninja -t commands', job)
        self.assertIn("$commands -match 'sccache.*cl\\.exe'", job)
        self.assertIn('/Z7', job)
        self.assertIn('ACTIONS_RESULTS_URL -or -not $env:ACTIONS_RUNTIME_TOKEN', job)
        self.assertNotIn('actions: write', job)

    def test_msvc_cache_statistics_and_native_failures_remain_visible(self) -> None:
        job = self.backend_workflow.split("  backend-windows-msvc:", 1)[1].split("  backend-linux-coverage:", 1)[0]
        self.assertIn('timeout-minutes: 60', job)
        self.assertIn('if ($LASTEXITCODE -ne 0) { throw "MSVC CMake configuration failed" }', job)
        self.assertIn('if ($buildExitCode -ne 0) { throw "MSVC native build failed" }', job)
        self.assertIn('MSVC backend tests failed with exit code $LASTEXITCODE', job)
        self.assertIn('savebox_server savebox_tests nanika_e2e_fixture --parallel 2', job)
        self.assertIn('sccache --zero-stats', job)
        stats = job.split('- name: Show sccache stats', 1)[1].split('- name: Stop native PostgreSQL', 1)[0]
        self.assertIn('if: always()', stats)
        self.assertIn('sccache --show-stats --stats-format=json', stats)
        self.assertIn('$stats.compile_requests -le 0', stats)
        self.assertIn('$stats | ConvertTo-Json -Depth 5', stats)
        self.assertNotIn('Write-Output $statsJson', stats)
        self.assertNotIn('continue-on-error', job)

    def test_backend_coverage_remains_a_separate_linux_gate(self) -> None:
        self.assertRegex(self.backend_workflow, r"(?m)^  backend-linux-coverage:\s*$")
        self.assertIn("runs-on: ubuntu-24.04", self.backend_workflow)
        self.assertIn("ENABLE_COVERAGE=ON", self.backend_workflow)
        self.assertIn("--fail-under-line 50", self.backend_workflow)

    def test_frontend_has_explicit_linux_and_windows_jobs(self) -> None:
        self.assertRegex(self.frontend_workflow, r"(?m)^  frontend-linux:\s*$")
        self.assertRegex(self.frontend_workflow, r"(?m)^  frontend-windows:\s*$")
        self.assertIn("name: Frontend / Linux", self.frontend_workflow)
        self.assertIn("name: Frontend / Windows", self.frontend_workflow)
        self.assertIn("runs-on: ubuntu-24.04", self.frontend_workflow)
        self.assertIn("runs-on: windows-2022", self.frontend_workflow)
        self.assertEqual(self.frontend_workflow.count("npm ci"), 2)
        self.assertEqual(self.frontend_workflow.count("npm run quality:mp4-resource:test"), 2)
        self.assertEqual(self.frontend_workflow.count("npm run build"), 2)

    def test_workflows_use_current_environment_names_and_fixed_seeds(self) -> None:
        self.assertNotIn("SAVEBOX_JWT_SECRET", self.backend_workflow)
        self.assertNotIn("SAVEBOX_STORAGE_PATH", self.backend_workflow)
        self.assertIn("NANIKA_JWT_SECRET", self.backend_workflow)
        self.assertIn("NANIKA_STORAGE_PATH", self.backend_workflow)
        self.assertNotIn("--rng-seed time", self.backend_workflow)

    def test_cmake_separates_msvc_mingw_and_linux_dependency_paths(self) -> None:
        self.assertRegex(
            self.cmake,
            re.compile(r"if\(MSVC\).*?find_package\(.*CONFIG REQUIRED\).*?elseif\(WIN32\).*?find_package\(PkgConfig REQUIRED\).*?else\(", re.S),
        )
        self.assertNotRegex(self.cmake, r"^find_package\(PkgConfig REQUIRED\)", re.M)
        self.assertIn("find_package(libpqxx CONFIG REQUIRED)", self.cmake)
        self.assertIn("find_package(unofficial-sodium CONFIG REQUIRED)", self.cmake)
        self.assertIn("find_package(cpr CONFIG REQUIRED)", self.cmake)
        self.assertIn("find_package(asio CONFIG REQUIRED)", self.cmake)
        self.assertIn("find_package(nlohmann_json CONFIG REQUIRED)", self.cmake)

    def test_cmake_uses_compiler_specific_asio_and_warning_flags(self) -> None:
        self.assertIn("function(configure_asio_compat", self.cmake)
        self.assertIn("/UASIO_NO_DEPRECATED", self.cmake)
        self.assertIn("/UBOOST_ASIO_NO_DEPRECATED", self.cmake)
        self.assertIn("-UASIO_NO_DEPRECATED", self.cmake)
        self.assertIn("-UBOOST_ASIO_NO_DEPRECATED", self.cmake)
        self.assertNotRegex(self.cmake, r"target_compile_options\(savebox_(?:server|tests) PRIVATE -UASIO")
        self.assertIn("/utf-8", self.cmake)

    def test_msvc_manifest_declares_direct_config_dependencies_without_crow(self) -> None:
        for dependency in ("nlohmann-json", "libpqxx", "libsodium", "cpr", "openssl", "catch2", "asio"):
            self.assertIn(f'"{dependency}"', self.manifest)
        self.assertNotIn('"crow"', self.manifest)

    def test_required_jobs_are_hard_gates_with_native_targets(self) -> None:
        for job in ("backend-linux-gcc", "backend-windows-msvc", "frontend-linux", "frontend-windows"):
            self.assertRegex(self.backend_workflow + self.frontend_workflow, rf"(?m)^  {re.escape(job)}:\s*$")
        self.assertNotIn("continue-on-error: true", self.backend_workflow + self.frontend_workflow)
        self.assertIn("savebox_tests", self.backend_workflow)
        self.assertIn("nanika_e2e_fixture", self.backend_workflow)

    def test_normal_backend_jobs_run_full_suite_once_without_fixture_rerun(self) -> None:
        linux_job = self.backend_workflow.split("  backend-linux-gcc:", 1)[1].split("  backend-windows-msvc:", 1)[0]
        msvc_job = self.backend_workflow.split("  backend-windows-msvc:", 1)[1].split("  backend-linux-coverage:", 1)[0]
        self.assertEqual(linux_job.count("./savebox_tests --order rand"), 1)
        self.assertEqual(msvc_job.count("savebox_tests.exe --order rand"), 1)
        self.assertNotIn('"[e2e-fixture]"', linux_job)
        self.assertNotIn('"[e2e-fixture]"', msvc_job)
        self.assertIn("nanika_e2e_fixture", linux_job)
        self.assertIn("nanika_e2e_fixture", msvc_job)

    def test_dockerignore_excludes_generated_msvc_vcpkg_tree_only(self) -> None:
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")
        ignored = {
            line.strip().rstrip("/")
            for line in dockerignore.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        self.assertIn("backend/vcpkg_installed", ignored)
        self.assertNotIn("backend/src", ignored)

    def test_modified_workflows_use_read_only_permissions_and_safe_triggers(self) -> None:
        for workflow in (self.backend_workflow, self.frontend_workflow):
            self.assertIn("permissions:\n  contents: read", workflow)
            self.assertIn("workflow_dispatch:", workflow)
            self.assertNotIn("pull_request_target", workflow)
            self.assertNotIn("windows-latest", workflow)


if __name__ == "__main__":
    unittest.main()
