"""Fail closed on direct CPR calls without an explicit finite total timeout."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
CALL = re.compile(r'\bcpr::(?:Get|Post|Delete|Put|Patch|Head|Options)\s*\(')
# Hide comments/literals before matching code; digit separators remain code.
LITERAL = re.compile(
    r'//[^\n]*|/\*[\s\S]*?\*/|R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|'
    r'"(?:\\.|[^"\\])*"|(?<![\w])\'(?:\\.|[^\'\\])*\''
)


def direct_calls(source):
    code = LITERAL.sub(lambda match: re.sub(r'[^\n]', ' ', match[0]), source)
    for match in CALL.finditer(code):
        depth, end = 1, match.end()
        while depth and end < len(code):
            depth += (code[end] == '(') - (code[end] == ')')
            end += 1
        if depth:
            raise ValueError('UNBALANCED_CPR_INVOCATION')
        yield code[match.start():end], code[:match.start()].count('\n') + 1, code


def finite_timeout(call, code):
    # A timeout inside a nested call is not a timeout argument of this call.
    timeouts = []
    for match in re.finditer(r'\bcpr::Timeout\s*\{\s*([\w\']+)\s*\}', call):
        prefix = call[:match.start()]
        if (prefix.count('(') - prefix.count(')') == 1 and
                prefix.count('{') == prefix.count('}') and
                prefix.count('[') == prefix.count(']')):
            timeouts.append(match)
    if len(timeouts) != 1:
        return False
    value = timeouts[0][1]
    if re.fullmatch(r'[0-9][0-9\']*', value):
        number = int(value.replace("'", ''))
    else:
        constant = re.search(r'\bconstexpr\s+(?:long|int|int32_t)\s+' + re.escape(value) + r'\s*=\s*([0-9][0-9\']*)\s*;', code)
        if not constant:
            return False
        number = int(constant[1].replace("'", ''))
    return 0 < number <= 2_147_483_647


class NetworkDeadlineTests(unittest.TestCase):
    def test_direct_production_provider_calls_have_finite_total_timeout(self):
        calls = []
        for path in (ROOT / 'backend/src').rglob('*.cpp'):
            for call, line, code in direct_calls(path.read_text(encoding='utf-8')):
                calls.append((path, line))
                with self.subTest(source=path.relative_to(ROOT).as_posix(), line=line):
                    self.assertTrue(finite_timeout(call, code), 'FINITE_TOTAL_TIMEOUT_REQUIRED')
        self.assertTrue(calls, 'NO_CPR_PRODUCTION_CALLS_FOUND')

    def test_comments_strings_and_nested_arguments_cannot_supply_timeout(self):
        source = 'cpr::Post(make("cpr::Timeout{100}"), /* cpr::Timeout{200} */ payload);'
        calls = list(direct_calls(source))
        self.assertEqual(len(calls), 1)
        self.assertFalse(finite_timeout(calls[0][0], calls[0][2]))
        self.assertEqual(list(direct_calls('R"raw(cpr::Get(fake))raw"; // cpr::Get(fake)')), [])
        source = 'cpr::Post(make(cpr::Timeout{100}), payload);'
        call, _, code = next(direct_calls(source))
        self.assertFalse(finite_timeout(call, code))

    def test_timeout_value_must_be_provably_positive_and_finite(self):
        for value in ['0', '-1', 'unknown', "3'000'000'000"]:
            source = 'cpr::Get(url, cpr::Timeout{' + value + '});'
            call, _, code = next(direct_calls(source))
            self.assertFalse(finite_timeout(call, code))
        source = "constexpr long LIMIT = 30'000; cpr::Post(url, cpr::Timeout{LIMIT});"
        call, _, code = next(direct_calls(source))
        self.assertTrue(finite_timeout(call, code))
        with self.assertRaises(ValueError):
            list(direct_calls('cpr::Get('))


if __name__ == '__main__':
    unittest.main()
