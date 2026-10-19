import json
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

import ap06_authorities as authorities


class AuthoritiesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source'; self.source.mkdir()
        self.root = Path(self.temp.name) / 'persistent'
        self.identity = secrets.token_hex(32)
        authorities.initialize(self.root, self.identity)
        (self.source / 'sample').write_bytes(b'private synthetic evidence')
        self.manifest = {'files': [{'path': 'sample', 'size': (self.source/'sample').stat().st_size,
                                   'sha256': authorities.sha256(self.source/'sample')}]}

    def publish(self):
        return authorities.publish_authorities(self.source, self.root, self.manifest, self.identity, 'test')

    def test_publish_readback_idempotent_and_independent(self):
        self.assertEqual(self.publish()['status'], 'PASS')
        self.assertEqual(self.publish()['status'], 'PASS')
        (self.source/'sample').unlink()
        self.assertEqual(authorities.verify_publication(self.root, self.identity, 'test'), self.manifest)

    def test_source_hash_and_size_mismatch(self):
        for key, value in [('size', 0), ('sha256', '0'*64)]:
            with self.subTest(key=key):
                old = self.manifest['files'][0][key]; self.manifest['files'][0][key] = value
                with self.assertRaisesRegex(ValueError, 'HASH_OR_SIZE'): self.publish()
                self.manifest['files'][0][key] = old

    def test_copy_failure_cannot_publish_receipt(self):
        with patch.object(authorities.shutil, 'copyfileobj', side_effect=OSError('disk error')):
            with self.assertRaises(OSError): self.publish()
        self.assertFalse((self.root/'manifests/test.json').exists())
        self.assertFalse(list(self.root.glob('.staging-*')))

    def test_unowned_and_wrong_marker_rejected(self):
        unowned = self.source/'unowned'; unowned.mkdir()
        with self.assertRaises((ValueError, FileNotFoundError)):
            authorities.initialize(unowned, self.identity)
        (self.root/'.owned-ap06-r9-r2').write_text('0'*64)
        with self.assertRaisesRegex(ValueError, 'OWNERSHIP'): self.publish()

    def test_immutable_destination_and_tamper_rejected(self):
        self.publish(); (self.root/'sample').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'CONTENT_CONFLICT'): self.publish()
        with self.assertRaisesRegex(ValueError, 'HASH_OR_SIZE'):
            authorities.verify_publication(self.root, self.identity, 'test')

    def test_relative_escape_and_duplicate_rejected(self):
        for path in ['../escape', 'C:/escape', 'a/../escape', 'a\\escape', '/escape']:
            with self.assertRaises(ValueError): authorities.relative_path(path)
        self.manifest['files'] *= 2
        with self.assertRaisesRegex(ValueError, 'PATH_SET'): self.publish()

    def test_intermediate_junction_rejected(self):
        link = Path(self.temp.name)/'junction'
        import os, subprocess
        if os.name == 'nt':
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(self.root)], check=True, capture_output=True)
        else: link.symlink_to(self.root, target_is_directory=True)
        try:
            with self.assertRaisesRegex(ValueError, 'REPARSE'):
                authorities.checked_path(link/'child'/'file')
        finally: link.rmdir() if os.name == 'nt' else link.unlink()

    def test_r16_campaign_authority_isolation(self):
        r16_root = Path(self.temp.name) / 'persistent-r16'
        identity = secrets.token_hex(32)
        authorities.initialize(r16_root, identity, campaign='AP-06-R12-R16-native')
        self.assertTrue((r16_root / '.owned-ap06-r12-r16-native').is_file())
        self.assertEqual((r16_root / '.owned-ap06-r12-r16-native').read_text(encoding='ascii'), identity)
        meta = json.loads((r16_root / 'authority.json').read_text())
        self.assertEqual(meta.get('campaign'), 'AP-06-R12-R16-native')
        # Isolation: markers from R9, R10, R13, R14 do not exist in R16 authority
        for camp, marker in authorities.CAMPAIGNS.items():
            if camp != 'AP-06-R12-R16-native':
                self.assertFalse((r16_root / marker).exists())
        # Publish and readback in R16 authority
        res = authorities.publish_authorities(self.source, r16_root, self.manifest, identity, 'r16-test')
        self.assertEqual(res['status'], 'PASS')
        readback = authorities.verify_publication(r16_root, identity, 'r16-test')
        self.assertEqual(readback, self.manifest)


if __name__ == '__main__': unittest.main()
