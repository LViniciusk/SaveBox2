"""Keep test-only crypto seams out of production and guard each sensitive lifetime."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class AuthMemoryContract(unittest.TestCase):
    def test_sensitive_lifetimes_are_guarded(self):
        source = (ROOT / 'backend/src/Services/AuthService.cpp').read_text(encoding='utf-8')
        for name, end, value in [('apply_pepper', 'hash_password', 'pre_hash'),
                                 ('hash_password', 'verify_password', 'peppered_password'),
                                 ('verify_password', 'generate_uuid_v4', 'peppered_password')]:
            body = source.split('AuthService::' + name + '(', 1)[1].split('AuthService::' + end + '(', 1)[0]
            self.assertRegex(body, rf'ScopedMemoryWipe\s+\w+\({value}(?:\)|\.data\(\))')
        hash_body = source.split('AuthService::hash_password(', 1)[1].split('AuthService::verify_password(', 1)[0]
        self.assertRegex(hash_body, r'ScopedMemoryWipe\s+\w+\(hashed, sizeof\(hashed\)\)')


if __name__ == '__main__':
    unittest.main()
