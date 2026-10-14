"""Fast contracts must fail PRs; optional browser smoke stays outside every-PR jobs."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class SecurityTrackACiTests(unittest.TestCase):
    def test_required_fast_security_gate_uses_existing_python(self):
        source = (ROOT / '.github/workflows/quality-baseline.yml').read_text(encoding='utf-8')
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
        self.assertIn('file(GLOB_RECURSE TEST_FILES CONFIGURE_DEPENDS "tests/*.cpp")', cmake)
        self.assertIn('add_executable(savebox_tests ${TEST_FILES} ${CORE_SOURCES})', cmake)
        self.assertIn('target_compile_definitions(savebox_tests PRIVATE NANIKA_TESTING=1)', cmake)
        self.assertNotIn('target_compile_definitions(savebox_server PRIVATE NANIKA_TESTING', cmake)
        self.assertIn('./savebox_tests --order rand --rng-seed 60101', workflow)


if __name__ == '__main__':
    unittest.main()
