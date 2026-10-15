"""Read R10-R3 authorities in place; export only scalar historical measurements."""
import argparse
import json
from pathlib import Path
from statistics import mean

from ap06_authorities import validate_owned_destination, verify_files, sha256
from run_ap06_r10 import SCHEDULE, validate_condition

MIB = 1024 ** 2
CATEGORIES = ('browser', 'renderer', 'gpu-process', 'utility')


def trajectory(raw):
    run = raw['runs'][0]
    baseline = run['samples'][0]
    result = []
    for sample in run['samples']:
        memory = sample['processMemory']
        processes = memory['processes']
        assert len({p['pid'] for p in processes}) == len(processes), 'R11_DUPLICATE_PID'
        absolute = {k: memory['byCategory'][k]['privateBytes'] for k in CATEGORIES}
        absolute['total'] = memory['privateBytes']
        assert sum(absolute[k] for k in CATEGORIES) == absolute['total'], 'R11_TOTAL_MISMATCH'
        before = baseline['processMemory']
        delta = {k: (v - (before['privateBytes'] if k == 'total' else before['byCategory'][k]['privateBytes'])) / MIB
                 for k, v in absolute.items()}
        observed = sample['counters']['observed']
        result.append({'phase': sample['phase'], 'cycle': sample['cycle'], 'gc': sample['gc'],
            'privateBytes': absolute, 'privateDeltaMiB': delta,
            'pids': [{'pid': p['pid'], 'type': p['type'], 'privateBytes': p['privateBytes']} for p in processes],
            'performance': sample['metrics'], 'rendererMemory': sample['rendererMemory'],
            'logicalBytes': {k: observed.get(k) for k in ('rangeBytesReceived', 'workerTransferBytesSent', 'bytesAppended')},
            'ownership': sample['ownership'], 'cleanupStatus': sample['cleanupStatus']})
    return result


def audit(root, identity, public):
    validate_owned_destination(root, identity)
    publications = {}
    def verify(name):
        path = root/'manifests'/f'{name}.json'
        manifest = json.loads(path.read_text())
        assert manifest['campaign'] == 'AP-06-R10'
        verify_files(root, manifest)
        publications[name] = sha256(path)
        return manifest
    for name in ('corpus-publication', 'r10-r3-implementation', 'r10-r3-freeze', 'r10-r3-reports', 'r10-r3-delivery'):
        verify(name)
    freeze_path = root/'r10-r3/freeze/freeze.json'
    assert sha256(freeze_path) == public['freezeSha256'], 'R11_HISTORY_FREEZE_CHANGED'
    freeze = json.loads(freeze_path.read_text())
    assert freeze['implementationHead'] == public['implementationHead'], 'R11_HISTORY_HEAD_CHANGED'
    assert freeze['fixtureHash'] == public['fixtureManifestSha256'], 'R11_HISTORY_CORPUS_CHANGED'
    for name, digest in freeze['publicationHashes'].items():
        if name not in publications: verify(name)
        assert publications[name] == digest, 'R11_HISTORY_MANIFEST_CHANGED'
    for relative, digest in freeze['files'].items():
        assert sha256(root/'r10-r3/tooling/source'/relative) == digest, 'R11_HISTORY_FROZEN_FILE_CHANGED'
    fixtures = json.loads((root/'r10-r3/tooling/source/.quality/readiness-wave10-r3/fixtures/manifest.json').read_text())
    runs = []
    for index, (stage, condition) in enumerate(SCHEDULE, 1):
        attempt = f'{index:02}-{condition}'
        verify(f'r10-r3-{stage}-{attempt}-complete')
        path = root/f'r10-r3/evidence/{stage}/{attempt}/complete.raw.json'
        raw = json.loads(path.read_text())
        classification = validate_condition(raw, condition, stage, freeze, fixtures)
        runs.append({'stage': stage, 'condition': condition, 'rawPath': path.relative_to(root).as_posix(),
            'rawSha256': sha256(path), 'classification': classification, 'samples': trajectory(raw)})
    means = {}
    for condition in ('r10.0', 'r10.1', 'r10.2'):
        selected = [r for r in runs if r['condition'] == condition and r['stage'] == ('triage' if condition == 'r10.2' else 'formal')]
        means[condition] = {}
        for phase in ('cycle-6-close', 'forced-GC-final'):
            rows = [next(s for s in r['samples'] if s['phase'] == phase) for r in selected]
            means[condition][phase] = {k: mean(s['privateDeltaMiB'][k] for s in rows) for k in (*CATEGORIES, 'total')}
    return {'status': 'PASS', 'independentAuthorityReadback': True, 'chromiumUsed': 0,
        'freezeSha256': sha256(freeze_path), 'publications': publications, 'runs': runs, 'meansMiB': means,
        'unavailableHistorically': ['Blob materialization bytes', 'ArrayBuffer materialization bytes', 'explicit slice bytes', '30-second idle checkpoint'],
        'metricSeparation': 'Private process commit and logical pipeline byte counts are separate quantities; never summed.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--public', type=Path, default=Path('docs/qualidade/ap06-r10-r3.json'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.root, args.identity, json.loads(args.public.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'runs': len(result['runs']), 'meansMiB': result['meansMiB']}))
