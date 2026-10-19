"""Fast contracts must fail PRs; optional browser smoke stays outside every-PR jobs."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class SecurityTrackACiTests(unittest.TestCase):
    def test_e2e_uses_ipv4_bound_backend_and_checks_login_first(self):
        workflow = (ROOT / '.github/workflows/quality-baseline.yml').read_text(encoding='utf-8')
        self.assertIn('NANIKA_BIND_ADDRESS=127.0.0.1', workflow)
        self.assertIn('export NANIKA_E2E_BASE_URL=http://127.0.0.1:4200', workflow)
        self.assertIn('CORS_ORIGIN=http://127.0.0.1:4200', workflow)
        self.assertIn('CORS_ALLOWED_ORIGINS=http://127.0.0.1:4200', workflow)
        self.assertIn('export NANIKA_E2E_BACKEND_URL=http://127.0.0.1:8080', workflow)
        self.assertNotIn('export NANIKA_E2E_BACKEND_URL=http://localhost:8080', workflow)
        self.assertLess(workflow.index('--config=playwright.ci-login.config.ts'),
                        workflow.index('python3 tools/quality/run_playwright.py'))
        between = workflow.split('--config=playwright.ci-login.config.ts', 1)[1].split('python3 tools/quality/run_playwright.py', 1)[0]
        self.assertIn('kill "$backend_pid"', between)
        self.assertIn('wait "$backend_pid"', between)
        self.assertIn('exec ./savebox_server', between)
        self.assertIn('wait_ready http://127.0.0.1:8080/health', between)
        config = (ROOT / 'frontend/playwright.ci-login.config.ts').read_text(encoding='utf-8')
        self.assertIn("testMatch: 'credential-login-boundary.spec.ts'", config)
        self.assertIn('retries: 0', config)

    def test_required_fast_security_gate_uses_existing_python(self):
        source = (ROOT / '.github/workflows/quality-baseline.yml').read_text(encoding='utf-8')
        self.assertRegex(source, r'pull_request:\s+branches:\s*\[\s*main\s*,\s*frontend\s*\]')
        gate = source.split('- name: Swagger, deployment, OpenAPI and recovery contracts', 1)[1].split('\n      - name:', 1)[0]
        self.assertIn('python3 -m unittest', gate)
        for module in ['test_deployment_security', 'test_openapi_contract', 'test_nanika_recovery',
                       'test_auth_memory_contract', 'test_security_track_a_ci']:
            self.assertIn('tools.quality.' + module, gate)
        for forbidden in ['continue-on-error', 'pip install', 'npm ci', 'run_browser_security_probe', 'run_c02_recovery_probe', 'swagger-csp-smoke']:
            self.assertNotIn(forbidden, gate)
        self.assertNotIn('swagger-csp-smoke', source)

    def test_auth_regressions_join_existing_backend_executable(self):
        cmake = (ROOT / 'backend/CMakeLists.txt').read_text(encoding='utf-8')
        workflow = (ROOT / '.github/workflows/backend-ci.yml').read_text(encoding='utf-8')
        self.assertRegex(workflow, r'pull_request:\s+branches:\s*\[\s*main\s*,\s*frontend\s*\]')
        self.assertIn('file(GLOB_RECURSE TEST_FILES CONFIGURE_DEPENDS "tests/*.cpp")', cmake)
        self.assertIn('add_executable(savebox_tests ${TEST_FILES} ${CORE_SOURCES})', cmake)
        self.assertIn('target_compile_definitions(savebox_tests PRIVATE NANIKA_TESTING=1)', cmake)
        self.assertNotIn('target_compile_definitions(savebox_server PRIVATE NANIKA_TESTING', cmake)
        self.assertIn('./savebox_tests --order rand --rng-seed 60101', workflow)
        self.assertEqual(workflow.count('IMGUR_CLIENT_ID=test-imgur-client-id'), 3,
                         'Each backend mock environment needs the required provider configuration')
        self.assertRegex(workflow, r'Build backend targets\s+run: \|\s+cmake --build backend/build-linux-ci')

        msvc = workflow.split('  backend-windows-msvc:', 1)[1].split('  backend-linux-coverage:', 1)[0]
        self.assertIn('VCPKG_DEFAULT_BINARY_CACHE: ${{ github.workspace }}\\vcpkg-binary-cache', msvc)
        self.assertIn('path: ${{ env.VCPKG_DEFAULT_BINARY_CACHE }}', msvc)
        self.assertIn("hashFiles('backend/vcpkg.json', 'backend/vcpkg-configuration.json')", msvc)
        self.assertIn('- name: Prepare vcpkg binary cache', msvc)
        self.assertIn('New-Item -ItemType Directory -Force -Path $env:VCPKG_DEFAULT_BINARY_CACHE', msvc)
        self.assertIn("Join-Path $env:VCPKG_INSTALLATION_ROOT 'scripts\\buildsystems\\vcpkg.cmake'", msvc)
        self.assertIn('-DCMAKE_TOOLCHAIN_FILE=', msvc)
        self.assertIn('-DVCPKG_TARGET_TRIPLET=x64-windows', msvc)
        self.assertIn('backend\\build-msvc\\vcpkg_installed\\x64-windows', msvc)
        self.assertIn('savebox_server savebox_tests nanika_e2e_fixture --parallel 2', msvc)
        self.assertIn('savebox_tests.exe --order rand --rng-seed 60102', msvc)
        self.assertNotIn('- name: Install native dependencies', msvc)
        self.assertNotIn('vcpkg install --x-manifest-root', msvc)


if __name__ == '__main__':
    unittest.main()
