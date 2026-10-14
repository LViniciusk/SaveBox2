import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from validate_ap06_r6_authorities import REQUIRED_TOOLS, BUNDLES, audit_authorities, read_source


class R6AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.history = self.root / '.quality/readiness-wave5-r2'
        self.history.mkdir(parents=True)
        self.sources = {path: b'frozen source' for path in REQUIRED_TOOLS}
        self.sources.update({path: data for path, data in [('frontend/dist/frontend/browser/a.js', b'transmux'), ('frontend/dist/frontend/browser/b.js', b'crypto')]})
        self.manifest = {path: hashlib.sha256(data).hexdigest() for path, data in self.sources.items() if path in REQUIRED_TOOLS}
        self.save('baseline/tooling-hashes.json', self.manifest)
        manifest_hash = hashlib.sha256((self.history / 'baseline/tooling-hashes.json').read_bytes()).hexdigest()
        self.save('tooling/freeze.json', {'status': 'FROZEN', 'toolingHashesSha256': manifest_hash})
        decision = {'status': 'PASS_AP06_R5_R2_EVIDENCE_COMPLETE', 'ap06': 'OPEN'}
        for mode, key in [('transmux-mse', 'plainTriage'), ('crypto-transmux-mse', 'cryptoTriage')]:
            raw = {'browserLaunches': 1, 'processSampleCalls': 8, 'runs': [{'browserVersion': '151.0.7922.34', 'playbackSessions': 18, 'samples': list(range(8)), 'functionalStatus': 'PASS', 'cleanupStatus': 'PASS'}]}
            self.save(f'triage/{mode}.raw.json', raw)
            decision[key] = {'rawSha256': hashlib.sha256((self.history / f'triage/{mode}.raw.json').read_bytes()).hexdigest(), 'classification': ('CRYPTO_' if key == 'cryptoTriage' else '') + 'TRANSMUX_MSE_DOES_NOT_REPRODUCE'}
        self.save('final/decision.json', decision)
        self.bundles = {'transmuxWorker': ('frontend/dist/frontend/browser/a.js', hashlib.sha256(b'transmux').hexdigest()), 'cryptoWorker': ('frontend/dist/frontend/browser/b.js', hashlib.sha256(b'crypto').hexdigest())}
        self.save('baseline/worker-authority.json', {'chromiumVersion': '151.0.7922.34', **{key: {'path': path, 'sha256': sha} for key, (path, sha) in self.bundles.items()}})

    def save(self, relative, data):
        path = self.history / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding='utf-8')

    def audit(self):
        return audit_authorities(self.root, lambda path: (self.sources.get(path), 'test-fixture'), bundles=self.bundles)

    def test_valid_authorities_allow_preparation_without_launching_browser(self):
        result = self.audit()
        self.assertEqual(result['status'], 'R5_R2_AUTHORITIES_VERIFIED')
        self.assertEqual(result['browserLaunches'], 0)
        self.assertEqual(result['conditions'], {'R6.1': 'NOT_RUN', 'R6.2': 'NOT_RUN', 'R6.3': 'NOT_RUN'})

    def test_missing_runner_stops_before_measurement(self):
        del self.sources['tools/quality/run_ap06_transmux_probe.py']
        result = self.audit()
        self.assertEqual(result['status'], 'BLOCKED_MISSING_R5_R2_AUTHORITY')
        self.assertIn('tools/quality/run_ap06_transmux_probe.py', result['unavailableAuthorities'])

    def test_hash_mismatch_never_accepts_candidate_as_frozen_source(self):
        self.sources['frontend/e2e-video/video-fixtures.ts'] = b'changed source'
        result = self.audit()
        self.assertEqual(result['status'], 'BLOCKED_MISSING_R5_R2_AUTHORITY')
        self.assertEqual(next(row['status'] for row in result['sources'] if row['path'].endswith('video-fixtures.ts')), 'HASH_MISMATCH')

    def test_corrupt_raw_stops_without_reclassifying_history(self):
        self.save('triage/transmux-mse.raw.json', {'runs': []})
        self.assertEqual(self.audit()['status'], 'BLOCKED_INVALID_R5_R2_AUTHORITY')

    def test_invalid_historical_session_count_stops(self):
        path = self.history / 'triage/transmux-mse.raw.json'
        raw = json.loads(path.read_text())
        raw['runs'][0]['playbackSessions'] = 17
        self.save('triage/transmux-mse.raw.json', raw)
        decision = json.loads((self.history / 'final/decision.json').read_text())
        decision['plainTriage']['rawSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.save('final/decision.json', decision)
        self.assertEqual(self.audit()['status'], 'BLOCKED_INVALID_R5_R2_AUTHORITY')

    def test_wrong_bundle_or_chromium_identity_stops(self):
        self.sources['frontend/dist/frontend/browser/b.js'] = b'wrong bundle'
        self.assertEqual(self.audit()['status'], 'BLOCKED_MISSING_R5_R2_AUTHORITY')
        self.save('baseline/worker-authority.json', {'chromiumVersion': '151.0.0.0'})
        self.assertEqual(self.audit()['status'], 'BLOCKED_INVALID_R5_R2_AUTHORITY')

    def test_missing_history_is_reported_without_writing_to_it(self):
        (self.history / 'final/decision.json').unlink()
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))
        self.assertEqual(self.audit()['status'], 'BLOCKED_MISSING_R5_R2_AUTHORITY')
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')))

    def test_manifest_cannot_request_arbitrary_file(self):
        self.manifest['../../private-key'] = '0' * 64
        self.save('baseline/tooling-hashes.json', self.manifest)
        self.save('tooling/freeze.json', {'status': 'FROZEN', 'toolingHashesSha256': hashlib.sha256((self.history / 'baseline/tooling-hashes.json').read_bytes()).hexdigest()})
        self.assertEqual(self.audit()['status'], 'BLOCKED_INVALID_R5_R2_AUTHORITY')

    def test_source_reader_rejects_traversal_and_untrusted_git_ref(self):
        with self.assertRaises(ValueError):
            read_source(self.root, '../private-key', None)
        with self.assertRaises(ValueError):
            read_source(self.root, next(iter(REQUIRED_TOOLS)), '--bad-ref')

    def test_expected_bundle_authorities_are_explicit(self):
        self.assertEqual(BUNDLES['transmuxWorker'][1], 'aadbab5d9bf4357ff7a7cdf92d81b53d62d25d4fa61e2480b85bd1d456de9dc6')
        self.assertEqual(BUNDLES['cryptoWorker'][1], 'ea645aefd0a14148aeaa7e95a672b446745f4a2436ae5c018549efd1fd94273b')


if __name__ == '__main__':
    unittest.main()
