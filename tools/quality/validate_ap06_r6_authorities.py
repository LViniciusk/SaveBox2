"""Read-only R6 authority gate. This command never launches a browser or measures memory."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

HISTORY = '.quality/readiness-wave5-r2'
CHROMIUM = '151.0.7922.34'
REQUIRED_TOOLS = frozenset({
    'frontend/e2e-video/video-fixtures.ts', 'frontend/package.json', 'frontend/package-lock.json',
    'frontend/tools/ap06-mse-probe.mjs', 'frontend/tools/ap06-mse-probe.test.mjs',
    'frontend/tools/ap06-transmux-probe.mjs', 'frontend/tools/ap06-transmux-probe.test.mjs',
    'frontend/tools/browser-memory-probe.mjs', 'frontend/tools/mp4-resource-calibration-lib.mjs',
    'tools/quality/run_ap06_mse_probe.py', 'tools/quality/run_ap06_transmux_probe.py',
    'tools/quality/run_ap06_transport_probe.py', 'tools/quality/run_readiness_wave1.py',
    'tools/quality/test_run_ap06_transmux_probe.py',
})
BUNDLES = {
    'transmuxWorker': ('frontend/dist/frontend/browser/worker-NVYMNESP.js', 'aadbab5d9bf4357ff7a7cdf92d81b53d62d25d4fa61e2480b85bd1d456de9dc6'),
    'cryptoWorker': ('frontend/dist/frontend/browser/worker-QPAI5PFL.js', 'ea645aefd0a14148aeaa7e95a672b446745f4a2436ae5c018549efd1fd94273b'),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_source(root, relative, source_ref):
    if relative not in REQUIRED_TOOLS | {item[0] for item in BUNDLES.values()}:
        raise ValueError('SOURCE_NOT_WHITELISTED')
    if source_ref is not None and not re.fullmatch(r'[a-f0-9]{40}', source_ref):
        raise ValueError('SOURCE_REF_MUST_BE_COMMIT_OID')
    root = root.resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('SOURCE_OUTSIDE_AUTHORITY_ROOT')
    if path.is_file():
        return path.read_bytes(), 'original-worktree'
    if source_ref:
        result = subprocess.run(['git', 'show', '--no-textconv', source_ref + ':' + relative],
                                cwd=root, capture_output=True, timeout=30)
        if result.returncode == 0:
            return result.stdout, 'git-object:' + source_ref
    return None, 'not-found'


def audit_authorities(root, source_reader, *, bundles=BUNDLES):
    result = {'status': 'BLOCKED_MISSING_R5_R2_AUTHORITY', 'ap06': 'OPEN',
              'browserLaunches': 0, 'conditions': {name: 'NOT_RUN' for name in ['R6.1', 'R6.2', 'R6.3']},
              'sources': [], 'historicalMeasurements': [], 'unavailableAuthorities': []}
    current = None

    def load(relative):
        nonlocal current
        current = HISTORY + '/' + relative
        return json.loads((root / current).read_text(encoding='utf-8'))

    def require(valid):
        if not valid:
            raise ValueError('INVALID_AUTHORITY')

    try:
        decision = load('final/decision.json')
        require(decision['status'] == 'PASS_AP06_R5_R2_EVIDENCE_COMPLETE' and decision['ap06'] == 'OPEN')
        manifest = load('baseline/tooling-hashes.json')
        require(set(manifest) == REQUIRED_TOOLS)
        require(all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in manifest.values()))
        freeze = load('tooling/freeze.json')
        require(freeze['status'] == 'FROZEN' and freeze['toolingHashesSha256'] == sha256((root / HISTORY / 'baseline/tooling-hashes.json').read_bytes()))
        for mode, key in [('transmux-mse', 'plainTriage'), ('crypto-transmux-mse', 'cryptoTriage')]:
            raw = load(f'triage/{mode}.raw.json')
            require(sha256((root / current).read_bytes()) == decision[key]['rawSha256'])
            require(decision[key]['classification'] == ('CRYPTO_' if key == 'cryptoTriage' else '') + 'TRANSMUX_MSE_DOES_NOT_REPRODUCE')
            require(raw['browserLaunches'] == 1 and raw['processSampleCalls'] == 8 and len(raw['runs']) == 1)
            run = raw['runs'][0]
            require(run['browserVersion'] == CHROMIUM and run['playbackSessions'] == 18 and len(run['samples']) == 8)
            require(run['functionalStatus'] == 'PASS' and run['cleanupStatus'] == 'PASS')
            result['historicalMeasurements'].append({'mode': mode, 'rawSha256': decision[key]['rawSha256'],
                'classification': decision[key]['classification'], 'browserVersion': CHROMIUM, 'playbackSessions': 18, 'samples': 8})
        workers = load('baseline/worker-authority.json')
        require(workers['chromiumVersion'] == CHROMIUM)
        for key, (path, expected) in bundles.items():
            require(workers[key]['path'] == path and workers[key]['sha256'] == expected)
        for path, expected in sorted({**manifest, **{path: sha for path, sha in bundles.values()}}.items()):
            data, provenance = source_reader(path)
            observed = sha256(data) if data is not None else None
            status = 'VERIFIED' if observed == expected else 'MISSING' if data is None else 'HASH_MISMATCH'
            result['sources'].append({'path': path, 'expectedSha256': expected, 'observedSha256': observed, 'provenance': provenance, 'status': status})
            if status != 'VERIFIED':
                result['unavailableAuthorities'].append(path)
        if not result['unavailableAuthorities']:
            result['status'] = 'R5_R2_AUTHORITIES_VERIFIED'
    except (FileNotFoundError, ValueError, KeyError, TypeError, IndexError) as error:
        result['status'] = 'BLOCKED_MISSING_R5_R2_AUTHORITY' if isinstance(error, FileNotFoundError) else 'BLOCKED_INVALID_R5_R2_AUTHORITY'
        result['failureAuthority'] = current
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--authority-root', type=Path, required=True)
    parser.add_argument('--source-ref', help='Full commit OID for read-only recovery of absent source candidates')
    args = parser.parse_args()
    if args.source_ref and not re.fullmatch(r'[a-f0-9]{40}', args.source_ref):
        parser.error('--source-ref must be a full commit OID')
    result = audit_authorities(args.authority_root, lambda path: read_source(args.authority_root, path, args.source_ref))
    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'R5_R2_AUTHORITIES_VERIFIED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
