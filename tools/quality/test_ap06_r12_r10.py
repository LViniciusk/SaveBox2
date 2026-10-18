import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import run_ap06_r12_r2 as factorial
from ap06_authorities import sha256
from run_readiness_wave1 import Wave, WaveFailure


class PlaywrightIdentityPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.output = self.root / '.quality' / 'readiness-wave12-r10-factorial'
        (self.output / 'baseline').mkdir(parents=True)
        self.manifest = self.output / 'baseline' / 'browser-identity.json'
        self.manifest.write_text(json.dumps({'playwrightVersion': '1.62.1',
            'chromiumVersion': '151.0.7922.34'}), encoding='utf-8')
        self.identity = json.loads(self.manifest.read_text(encoding='utf-8'))
        self.wave = _Wave(self.root, self.output, self.manifest)

    def tearDown(self):
        self.temp.cleanup()

    def test_gate_uses_campaign_node_frontend_and_environment_without_reserving(self):
        receipt = {'status': 'PASS', 'head': 'a' * 40, 'manifestSha256': sha256(self.manifest),
            'playwrightVersion': '1.62.1', 'chromiumVersion': '151.0.7922.34', 'scientificChromium': 0,
            'reservationCreated': False, 'launchAttempts': 0, 'retries': 0}
        self.wave.output_text = json.dumps(receipt)

        result = factorial.verify_r10_playwright_identity_preflight(self.wave,
            {'AP06_BROWSER_IDENTITY': str(self.manifest), 'TEMP': 'private-temp', 'TMP': 'private-temp'})

        self.assertEqual(result, receipt)
        self.assertEqual(self.wave.saved['baseline/playwright-identity-preflight.json'], receipt)
        self.assertEqual(self.wave.call[0], 'r12-r10-playwright-identity')

        self.assertEqual(self.wave.call[1], ['node.exe', 'tools/ap06-r12-identity-preflight.mjs'])
        self.assertEqual(self.wave.call[2], self.root / 'frontend')
        self.assertEqual(self.wave.call[3]['TEMP'], 'private-temp')
        self.assertEqual(self.wave.call[3]['TMP'], 'private-temp')
        self.assertEqual(self.wave.call[3]['AP06_R12R10_HEAD'], 'a' * 40)
        self.assertFalse(self.wave.call[4])

    def test_mismatch_stops_after_saving_sanitized_receipt(self):
        receipt = {'status': 'STOP', 'failureClass': 'AP06_BROWSER_IDENTITY_MISMATCH',
            'changedFields': ['installationFiles'], 'scientificChromium': 0,
            'reservationCreated': False, 'launchAttempts': 0, 'retries': 0}
        self.wave.output_text = json.dumps(receipt)

        with self.assertRaisesRegex(WaveFailure, 'R12R10_PLAYWRIGHT_IDENTITY_INVALID'):
            factorial.verify_r10_playwright_identity_preflight(self.wave, {})

        self.assertEqual(self.wave.saved['baseline/playwright-identity-preflight.json'], receipt)
        self.assertFalse(any('reservation' in name.lower() for name in self.wave.saved))

    @patch('ap06_browser_identity.verify_identity')
    def test_offline_ready_rechecks_manifest_app_and_real_resolver_before_launch(self, verify_identity):
        receipt = {'status': 'PASS', 'head': 'a' * 40, 'manifestSha256': sha256(self.manifest),
            'playwrightVersion': '1.62.1', 'chromiumVersion': '151.0.7922.34', 'scientificChromium': 0,
            'reservationCreated': False, 'launchAttempts': 0, 'retries': 0}
        self.wave.save('baseline/playwright-identity-preflight.json', receipt)
        self.wave.save('tooling/app-products.json', {'status': 'PASS'})
        self.wave.save('baseline/offline-ready.json', {'status': 'R12R10_OFFLINE_READY',
            'implementationHead': 'a' * 40, 'appProductsSha256': sha256(self.output/'tooling/app-products.json'),
            'reservationCreated': False, 'launchAttempts': 0, 'browserLaunches': 0, 'retries': 0,
            'playwrightIdentityPreflightSha256': sha256(self.output/'baseline/playwright-identity-preflight.json')})
        self.wave.output_text = json.dumps(receipt)

        factorial.verify_r10_offline_ready(self.wave,
            {'AP06_BROWSER_IDENTITY': str(self.manifest)}, self.identity)

        verify_identity.assert_called_once_with(self.identity)
        self.assertEqual(self.wave.call[0], 'r12-r10-playwright-identity')


class WaveCommandTests(unittest.TestCase):
    def test_nonzero_identity_gate_output_is_recorded_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);wave = Wave(root);wave.output = root/'out';wave.temp = root/'logs';wave.temp.mkdir()
            command = [sys.executable, '-c', 'print("sanitized gate result"); raise SystemExit(7)']

            output = wave.command('identity-gate', command, root, wave.env, check=False)

            self.assertEqual(output.strip(), 'sanitized gate result')
            artifact = json.loads((wave.output/'pipeline/commands/identity-gate.json').read_text(encoding='utf-8'))
            self.assertEqual((artifact['status'], artifact['exitCode'], artifact['logPersisted']), ('FAIL', 7, False))


class _Wave:
    def __init__(self, root, output, manifest):
        self.root, self.output, self.manifest = root, output, manifest
        self.node = 'node.exe'
        self.output_text, self.call, self.saved = '', None, {}

    def git(self, *args):
        return 'a' * 40

    def command(self, name, command, cwd, environment, check=True):
        self.call = (name, command, cwd, environment, check)
        return self.output_text

    def save(self, name, value):
        self.saved[name] = value
        target = self.output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value), encoding='utf-8')


if __name__ == '__main__':
    unittest.main()
