import copy
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest

from ap06_authorities import private_permissions, sha256
from ap06_key_custody import custody_context, protect, seal_runtime_credentials, verify_runtime_key_custody
import run_ap06_r12_r2 as factorial


@unittest.skipUnless(os.name == 'nt', 'DPAPI CurrentUser requires Windows')
class RuntimeCustodyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.baseline = Path(self.temp.name)
        private_permissions(self.baseline, create=True)
        self.identity, self.manifest = 'a' * 64, 'b' * 64
        self.campaign = 'AP-06-R12-R9-factorial'
        self.credentials = {'accounts.local.json': [{'username': 'synthetic'}],
            'player-auth.local.json': {'password': 'synthetic-test-only'},
            'backend-runtime.local.json': {'cwd': 'owned-runtime'}}
        self.receipt = seal_runtime_credentials(self.baseline, self.identity, self.manifest, self.campaign, self.credentials)
        self.blob = self.baseline / 'runtime-credentials.dpapi'
        self.context = custody_context(self.identity, self.manifest)

    def tearDown(self):
        self.temp.cleanup()

    def verify(self, receipt=None, context=None, blob=None):
        return verify_runtime_key_custody(blob or self.blob, context or self.context,
            self.receipt if receipt is None else receipt, self.manifest, self.identity, self.campaign, self.credentials)

    def test_independent_readback_and_plaintext_absence(self):
        self.assertEqual(self.verify()['status'], 'PASS')
        self.assertEqual({p.name for p in self.baseline.iterdir()}, {
            'runtime-credentials.dpapi', 'runtime-credentials-custody.json', 'runtime-credentials-readback.json'})
        for path in self.baseline.iterdir():
            self.assertNotIn(b'synthetic-test-only', path.read_bytes())

    def test_byte_copy_and_independent_seal_have_distinct_valid_receipts(self):
        target = self.baseline / 'copy.dpapi'
        target.write_bytes(self.blob.read_bytes())
        self.assertEqual(self.verify(blob=target)['status'], 'PASS')
        target.write_bytes(protect(json.dumps(self.credentials).encode(), self.context))
        self.assertNotEqual(sha256(target), self.receipt['protectedSha256'])
        with self.assertRaisesRegex(ValueError, 'CUSTODY_MISMATCH'):
            self.verify(blob=target)
        own_receipt = dict(self.receipt, protectedSha256=sha256(target), protectedBytes=target.stat().st_size,
            provenance='independent synthetic test seal; semantic comparison required')
        self.assertEqual(self.verify(receipt=own_receipt, blob=target)['status'], 'PASS')

    def test_corruption_missing_truncation_and_invalid_unseal(self):
        original = self.blob.read_bytes()
        for content in (original[:-1], original[:20], original[:-1] + bytes([original[-1] ^ 1]), b''):
            self.blob.write_bytes(content)
            with self.assertRaisesRegex(ValueError, 'CUSTODY_MISMATCH'):
                self.verify()
        self.blob.write_bytes(b'not-dpapi')
        plausible = dict(self.receipt, protectedSha256=sha256(self.blob), protectedBytes=self.blob.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'UNSEAL_FAILED'):
            self.verify(receipt=plausible)
        self.blob.unlink()
        with self.assertRaisesRegex(ValueError, 'CUSTODY_MISMATCH'):
            self.verify()

    def test_context_receipt_and_semantic_binding(self):
        for key, value in [('status', 'STOP'), ('campaign', 'AP-06-R12-R8-factorial'), ('identity', 'c'*64),
                ('manifestSha256', 'c'*64), ('protectedSha256', 'c'*64), ('protectedBytes', 1),
                ('independentProcess', False), ('scope', 'LocalMachine')]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'CUSTODY_MISMATCH'):
                self.verify(receipt=dict(self.receipt, **{key: value}))
        for key, value, reason in [('userSid', 'S-1-0-0', 'UNSEAL_FAILED'),
                ('identity', 'c'*64, 'IDENTITY_MISMATCH'), ('manifestSha256', 'c'*64, 'MANIFEST_MISMATCH')]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, reason):
                self.verify(context=dict(self.context, **{key: value}))
        altered = copy.deepcopy(self.credentials)
        altered['player-auth.local.json']['password'] = 'different'
        self.blob.write_bytes(protect(json.dumps(altered).encode(), self.context))
        receipt = dict(self.receipt, protectedSha256=sha256(self.blob), protectedBytes=self.blob.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'UNSEAL_FAILED'):
            self.verify(receipt=receipt)

    def test_reparse_point_rejected(self):
        link = self.baseline / 'link.dpapi'
        try:
            link.symlink_to(self.blob)
        except OSError:
            self.skipTest('Windows symlink privilege unavailable')
        with self.assertRaisesRegex(ValueError, 'CUSTODY_MISMATCH'):
            self.verify(blob=link)


class ErrorContractTests(unittest.TestCase):
    def test_stage_allowlist_sanitizes_private_errors(self):
        for stage, expected in factorial.R9_FAILURES.items():
            with self.subTest(stage=stage):
                error = factorial.r9_failure(stage, ValueError('private token and path'))
                self.assertEqual(error.failure_class, expected)
                self.assertFalse(error.reservation_created)
                self.assertEqual(error.launch_attempts, 0)
                self.assertNotIn('private', str(error))
        cleanup = RuntimeError('MEDIA_SERVER_CLEANUP_FAILED')
        self.assertEqual(factorial.r9_failure('offline-media-server', cleanup).failure_class, 'R12R9_CLEANUP_FAILED')
        cleanup.__context__ = OSError('private primary failure')
        combined = factorial.r9_failure('offline-media-server', cleanup)
        self.assertEqual(combined.failure_class, 'R12R9_BACKEND_NOT_READY')
        self.assertEqual(combined.cleanup_failure_class, 'R12R9_CLEANUP_FAILED')


@unittest.skipUnless(os.environ.get('AP06_R9_LIVE_INTEGRATION') == '1', 'Opt in to the owned live R9 laboratory')
class LivePipelineTests(unittest.TestCase):
    def test_real_offline_gates_complete_simulated_browser_and_freeze_contract(self):
        from run_readiness_wave1 import Wave
        from run_ap06_integration_probe import read
        from run_ap06_transport_probe import media_server
        from run_ap06_r9 import validate_freeze_preflight
        from test_ap06_r12_r2 import complete_raw
        previous = factorial.OUTPUT, factorial.CAMPAIGN, factorial.PUBLISHER
        root = Path(__file__).resolve().parents[2]
        factorial.configure_campaign('.quality/readiness-wave12-r9-factorial', root/'tools/quality/run_ap06_r12_r9.py', 'AP-06-R12-R9-factorial')
        wave = Wave(root)
        wave.output = root/factorial.OUTPUT
        directory = wave.output/'tooling/offline-simulation'
        directory.mkdir(exist_ok=True)
        try:
            with tempfile.TemporaryDirectory() as temporary:
                wave.temp = Path(temporary)
                env, assets, files, _ = factorial.prepare_scientific_preflight(wave,
                    require_ci=os.environ.get('AP06_R9_REQUIRE_CI') == '1')
                mapping = read(wave.output/'baseline/backend-authority.json')['fileMapping']
                fixtures = read(wave.output/'fixtures/manifest.json')
                ranges = read(wave.output/'baseline/workload.json')['rangesPerCycle']
                conditions = {}
                for condition in factorial.CONDITIONS:
                    raw, _, _ = complete_raw(condition)
                    run = raw['runs'][0]
                    network = run['rangeNetwork']
                    network['requests'] = network['requests'][:9]
                    for row, (_, wanted_range) in zip(network['requests'], ranges):
                        row['range'] = wanted_range
                        row['fileId'] = mapping[row['fixture']]['fileId']
                        row['url'] = f"http://127.0.0.1:42187/files/{row['fileId']}/download"
                        row['headers']['content-range'] = 'bytes '+wanted_range.removeprefix('bytes=')+'/'+str(fixtures[row['fixture']]['ciphertextBytes'])
                    backend = {'pendingGets': 0, 'rows': [{'fileId': row['fileId'], 'status': 206} for row in network['requests']]}
                    conditions[condition] = {'network': network, 'backend': backend, 'counters': run['samples'][1]['counters']}
                config = directory/'config.json'
                config.write_text(json.dumps({'conditions': conditions, 'proof': factorial.expected_proof('r10.1'),
                    'identityOutput': str(directory/'identity.json')}))
                env.update(AP06_R9_SIMULATION=str(config), AP06_R7_UNIT_OUTPUT=str(directory/'raw.json'))
                (directory/'reservation.simulated.json').write_text(json.dumps({'simulated': True, 'scientificChromium': 0}))
                with media_server(files, True, 'application/octet-stream', assets, port=42088) as (origin, _):
                    env['AP06_R5_MEDIA_ORIGIN'] = origin
                    result = subprocess.run([wave.node, '--test', 'tools/ap06-r12-r9-preflight.test.mjs'], cwd=root/'frontend',
                        env=env, capture_output=True, text=True, timeout=120)
                (directory/'node-test.log').write_text(result.stdout+result.stderr)
                self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                unit = read(directory/'raw.json')
                identity = read(directory/'identity.json')
                self.assertTrue(factorial.validate_preflight_receipt(wave, unit, identity))
                validate_freeze_preflight(wave, unit, factorial.OUTPUT)
                for mutate in (lambda r: r['multiplexedContract'].update(fixtureHash='bad'),
                        lambda r: r['multiplexedContract']['workerHashes'].update(crypto='bad'),
                        lambda r: r.update(appProducts={}), lambda r: r.update(status='FAIL')):
                    bad = copy.deepcopy(unit)
                    mutate(bad)
                    with self.assertRaises(RuntimeError):
                        validate_freeze_preflight(wave, bad, factorial.OUTPUT)
                for mutate in (lambda r: r.pop('handleRelease'),
                        lambda r: r['processExitAudit'].update(registeredProcessCount=0),
                        lambda r: r['browserIdentity']['after'].update(processCreationTime=0),
                        lambda r: r['cases'].pop(), lambda r: r['routingCounters']['r12r2.0'].update(payloadxhrCount=0)):
                    bad = copy.deepcopy(unit)
                    mutate(bad)
                    with self.assertRaises((RuntimeError, ValueError)):
                        factorial.validate_preflight_receipt(wave, bad, identity)
                wave.save('baseline/offline-integration.json', {'status': 'PASS', 'realDpapiBuildBackendMediaOs': True,
                    'simulatedChromiumCdp': True, 'cases': 5, 'attestations': 2, 'processesClosed': 4,
                    'receiptRoundtrip': 'PASS', 'primaryFailureSurvivesContextCleanup': True, 'freezeConsumerRoundtrip': 'PASS', 'negativeReceiptsRejected': 9,
                    'scientificChromium': 0, 'trackedTreeSha256': factorial.tracked_tree_sha(wave), 'rawSha256': sha256(directory/'raw.json')})
        finally:
            factorial.OUTPUT, factorial.CAMPAIGN, factorial.PUBLISHER = previous


if __name__ == '__main__':
    unittest.main()
