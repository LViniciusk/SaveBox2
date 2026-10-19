"""Verify immutable R12 factorial evidence, diagnose its private trace, and seed fresh R13 custody."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

from ap06_authorities import (CAMPAIGNS, checked_path, initialize, private_permissions, publish_authorities,
    publish_snapshot, relative_path, sha256, validate_owned_destination, verify_publication)
from ap06_key_custody import custody_context, protect, readback, unprotect
from ap06_native import inspect_trace, trace_events
from run_readiness_wave1 import Wave
from run_ap06_r12_r2 import read, validate_r8_corpus

SOURCE_HEAD = 'cbaf2ac1c831e9bc98b8e568435c69bd43304334'
DECISION_STATUS = 'R12R12_FACTORIAL_CONFIRMED'
PAIR = ['r12r2.0', 'r12r2.2']
CAMPAIGN = 'AP-06-R12-R13-native'
OUTPUT = '.quality/readiness-wave12-r13-native'
TASK_PATH = 'quality/ap06-r12-r13.md'
TRACE_SHA256 = 'da8d207b98b0979fb280ac821fde04c1a09ef3178acc22835d92ba9281798df6'
TRACE_BYTES = 4_430_975
PHASES = ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final']
NATIVE_BUDGET = {'capability': 1, 'profiledA': 1, 'profiledB': 1, 'maximum': 3, 'retries': 0}
R16_BUDGET = {'capability': 1, 'profiledA': 0, 'profiledB': 0, 'maximum': 1, 'retries': 0}


def configure_campaign(campaign, output, task_path, budget=None):
    global CAMPAIGN, OUTPUT, TASK_PATH, NATIVE_BUDGET
    CAMPAIGN = campaign
    OUTPUT = output
    TASK_PATH = task_path
    if budget is not None:
        NATIVE_BUDGET = budget


def require(value, reason):
    if not value:
        raise ValueError(reason)


def _write_json_atomic(path, value):
    path = checked_path(Path(path))
    temporary = path.with_name(path.name + '.staging-' + secrets.token_hex(8))
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        checked_path(temporary); os.replace(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()


def verify_all_publications_once(authority, identity, campaign):
    authority = validate_owned_destination(authority, identity, campaign=campaign)
    paths = {CAMPAIGNS[campaign], 'authority.json'}
    files = {}; all_rows = []; publication_paths = []
    manifests = list((authority / 'manifests').glob('*.json'))
    require(bool(manifests), 'R12R13_FACTORIAL_PUBLICATION_MISSING')
    for manifest_path in manifests:
        checked_path(manifest_path)
        manifest = read(manifest_path)
        if not isinstance(manifest, dict) or manifest.get('campaign') != campaign or not isinstance(manifest.get('files'), list):
            continue
        require(manifest.get('campaign') == campaign and isinstance(manifest.get('files'), list),
            'R12R13_FACTORIAL_PUBLICATION_SCHEMA_INVALID')
        paths.add(manifest_path.relative_to(authority).as_posix())
        publication_paths.append(manifest_path)
        for row in manifest['files']:
            relative = row.get('path')
            target = relative_path(relative).as_posix()
            value = (row.get('size'), row.get('sha256'))
            require(type(value[0]) is int and value[0] >= 0 and isinstance(value[1], str) and len(value[1]) == 64,
                'R12R13_FACTORIAL_PUBLICATION_SCHEMA_INVALID')
            require(target not in files or files[target] == value, 'R12R13_FACTORIAL_PUBLICATION_CONFLICT')
            files[target] = value
            all_rows.append(row)
    paths.update(files)
    for relative, (size, digest) in files.items():
        target = checked_path(authority / relative_path(relative))
        require(target.is_file() and target.stat().st_size == size and sha256(target) == digest,
            'R12R13_FACTORIAL_PUBLICATION_HASH_INVALID')
    actual = set()
    for path in authority.rglob('*'):
        checked_path(path)
        if path.is_file(): actual.add(path.relative_to(authority).as_posix())
    require(actual == paths, 'R12R13_FACTORIAL_PUBLICATION_PATH_SET_INVALID')
    return len(publication_paths), all_rows


def verify_historical_factorial(source, root):
    try: source = checked_path(Path(os.path.abspath(source)))
    except (OSError, ValueError): raise ValueError('R12R13_FACTORIAL_SOURCE_PATH_INVALID') from None
    decision = read(source / 'final/decision.json')
    triage = read(source / 'pipeline/triage-decision.json')
    frozen = read(source / 'tooling/freeze.json')
    complete = read(source / 'baseline/freeze-complete.json')
    require(decision.get('status') == DECISION_STATUS and decision.get('pair') == PAIR and triage.get('pair') == PAIR,
        'R12R13_FACTORIAL_DECISION_INVALID')
    require(frozen.get('status') in ('FROZEN', 'SNAPSHOT_AWAITING_READBACK') and frozen.get('implementationHead') == SOURCE_HEAD and
        complete.get('status') == 'FROZEN' and complete.get('implementationHead') == SOURCE_HEAD and
        complete.get('independentReadback') is True and complete.get('freezeSha256') == sha256(source / 'tooling/freeze.json'),
        'R12R13_FACTORIAL_FREEZE_INVALID')
    subprocess.run(['git', '-C', str(root), 'cat-file', '-e', SOURCE_HEAD + '^{commit}'], check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = decision.get('results')
    require(isinstance(results, list) and len(results) == 10 and
        sum(row.get('stage') == 'triage' for row in results) == 4 and
        sum(row.get('stage') == 'formal' for row in results) == 6, 'R12R13_FACTORIAL_RAW_SET_INVALID')
    config = read(source / 'baseline/authority-config.local.json')
    try: authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
    except (OSError, ValueError): raise ValueError('R12R13_FACTORIAL_AUTHORITY_PATH_INVALID') from None
    validate_owned_destination(authority, config['identity'], campaign='AP-06-R10')
    publication_count, rows = verify_all_publications_once(authority, config['identity'], 'AP-06-R10')
    publication_hashes = {row.get('sha256') for row in rows}
    implementation = verify_publication(authority, config['identity'], frozen['implementationPublication'])
    prefix = source.name.replace('readiness-wave', 'r') + '/tooling/source/'
    expected = {prefix + name: digest for name, digest in frozen['files'].items()}
    observed = {row['path']: row['sha256'] for row in implementation['files']}
    require(observed == expected, 'R12R13_FACTORIAL_IMPLEMENTATION_READBACK_FAILED')
    freeze_publication = verify_publication(authority, config['identity'], frozen['freezePublication'])
    require(any(row['sha256'] == sha256(source / 'tooling/freeze.json') for row in freeze_publication['files']),
        'R12R13_FACTORIAL_FREEZE_READBACK_FAILED')
    require(any(row.get('sha256') == sha256(source / 'final/decision.json') for row in rows),
        'R12R13_FACTORIAL_DECISION_NOT_PUBLISHED')
    raw_paths = set()
    for row in results:
        relative = Path(row['rawPath'])
        require(not relative.is_absolute() and '..' not in relative.parts, 'R12R13_FACTORIAL_RAW_PATH_INVALID')
        try: raw = checked_path(source / relative)
        except (OSError, ValueError): raise ValueError('R12R13_FACTORIAL_RAW_PATH_INVALID') from None
        require(raw.is_file() and sha256(raw) == row['rawSha256'] and row['rawSha256'] in publication_hashes,
            'R12R13_FACTORIAL_RAW_HASH_OR_PUBLICATION_INVALID')
        raw_paths.add(relative.as_posix())
    require(len(raw_paths) == 10, 'R12R13_FACTORIAL_RAW_DUPLICATE')
    # Validate the historical tree with its own root, without changing the source worktree.
    historical_wave = Wave(root); historical_wave.output = source
    try: corpus = validate_r8_corpus(historical_wave)
    except (OSError, ValueError, KeyError, TypeError): raise ValueError('R12R13_FACTORIAL_CORPUS_INVALID') from None
    provenance = read(source / 'baseline/corpus-provenance.json')
    require(provenance.get('manifestSha256') == sha256(source / 'fixtures/manifest.json') and
        frozen['files'].get(source.name.replace('readiness-wave', '.quality/readiness-wave') +
            '/baseline/corpus-provenance.json') == sha256(source / 'baseline/corpus-provenance.json'),
        'R12R13_FACTORIAL_PROVENANCE_INVALID')
    return {'status': 'PASS', 'decisionStatus': DECISION_STATUS, 'pair': PAIR,
        'implementationHead': SOURCE_HEAD, 'freezeSha256': sha256(source / 'tooling/freeze.json'),
        'decisionSha256': sha256(source / 'final/decision.json'), 'rawCount': len(results),
        'triageCount': 4, 'formalCount': 6, 'verifiedPublicationCount': publication_count,
        'corpusManifestSha256': corpus['manifestSha256'], 'provenanceSha256': sha256(source / 'baseline/corpus-provenance.json'),
        'historicalModified': False}


def diagnose_historical_trace(source):
    native_output = Path(source).absolute().parent / 'readiness-wave12-r12-native'
    try:
        config = read(native_output / 'baseline/authority-config.local.json')
        record = read(native_output / 'pipeline/native-receipt.json')
        registration = read(native_output / 'pipeline/native-trace.json')
        seal = read(native_output / 'pipeline/native-trace-seal.json')
        identity = read(native_output / 'baseline/browser-identity.json')
        from ap06_browser_identity import verify_identity
        verify_identity(identity)
        require(identity.get('chromiumVersion') == '151.0.7922.34' and record.get('launchAttempts') == 1 and
            record.get('browserLaunches') == 1 and record.get('retries') == 0 and record.get('browserClosed') is True and
            record.get('processExitAudit', {}).get('status') == 'PASS', 'R12R13_HISTORICAL_BROWSER_RECEIPT_INVALID')
        authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
        validate_owned_destination(authority, config['identity'], campaign='AP-06-R10')
        relative = registration['authorityRelativePath']
        parts = Path(relative)
        require(not parts.is_absolute() and '..' not in parts.parts, 'R12R13_TRACE_AUTHORITY_PATH_INVALID')
        trace = checked_path(authority / parts)
        publication = verify_publication(authority, config['identity'], 'r12-r12-native-trace-capability')
        require(trace.is_file() and trace.stat().st_size == TRACE_BYTES and sha256(trace) == TRACE_SHA256 and
            seal.get('traceSha256') == TRACE_SHA256 and seal.get('bytes') == TRACE_BYTES and
            any(row['path'] == relative and row['sha256'] == TRACE_SHA256 for row in publication['files']),
            'R12R13_HISTORICAL_TRACE_INTEGRITY_INVALID')
        trace_receipt = record['trace']
        checkpoints = trace_receipt['checkpoints']
        renderer_pid = trace_receipt.get('rendererPid')
        expected_flags = {'--memlog=all', '--memlog-stack-mode=native', '--memlog-sampling-rate=16384',
            '--memlog-keep-small-allocations'}
        require([row.get('phase') for row in checkpoints] == PHASES and all(row.get('success') is True for row in checkpoints) and
            len({row.get('dumpGuid') for row in checkpoints}) == 4 and expected_flags.issubset(set(trace_receipt.get('flags', []))) and
            trace_receipt.get('heapProfilingEffective') in (None, False), 'R12R13_HISTORICAL_TRACE_RECEIPT_INVALID')
        with trace.open(encoding='utf-8') as stream:
            inventory = inspect_trace(trace_events(stream), renderer_pid, checkpoints)
        matches = inventory['dumpEvents']['checkpointGuidsMatched']
        expected = inventory['dumpEvents']['checkpointGuidsExpected']
        has_memory_infra = inventory['eventsByCategory'].get('disabled-by-default-memory-infra', 0) > 0
        findings = {
            'RENDERER_METADATA_MISSING': inventory['processNameMetadata']['renderer'] == 0,
            'DUMP_GUID_NOT_EMITTED': matches < expected,
            'DUMP_GUID_SCHEMA_UNSUPPORTED': inventory['dumpEvents']['invalidGuid'] > 0 or
                inventory['dumpEvents']['guidValueTypes'].get('number', 0) > 0 or inventory['dumpEvents']['guidValueTypes'].get('other', 0) > 0,
            'HEAPS_V2_NOT_EMITTED': inventory['heapsV2']['eventsPresent'] == 0,
            'HEAPS_V2_SCHEMA_UNSUPPORTED': 'NOT_ASSESSABLE_NO_HEAPS_V2' if inventory['heapsV2']['eventsPresent'] == 0
                else inventory['heapsV2']['schemaVersion1WithAllocatorMap'] == 0,
            'MEMORY_PROFILER_NOT_ACTIVE': 'EFFECTIVE_PROFILING_NOT_PROVEN; NO_HEAPS_V2_OBSERVED',
            'TRACE_CATEGORY_MISCONFIGURED': not has_memory_infra,
            'TRACE_INSUFFICIENT_EVIDENCE': matches != expected or inventory['heapsV2']['eventsPresent'] == 0 or
                inventory['processNameMetadata']['renderer'] == 0,
        }
        return {'status': 'R12R13_HISTORICAL_TRACE_DIAGNOSED', 'sha256': TRACE_SHA256, 'bytes': TRACE_BYTES,
            'publication': 'PASS', 'streamComplete': trace_receipt.get('streamEof') is True and
                trace_receipt.get('complete') is True and trace_receipt.get('dataLossOccurred') is False,
            'checkpointsRequested': len(checkpoints), 'rendererPidRegistered': type(renderer_pid) is int,
            'browserVersion': identity['chromiumVersion'], 'inventory': inventory, 'findings': findings,
            'interpretation': 'requestMemoryDump success and category presence do not prove heaps_v2 allocation data.'}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return {'status': 'R12R13_HISTORICAL_TRACE_UNAVAILABLE', 'reason': 'HISTORICAL_EVIDENCE_NOT_VERIFIABLE'}


def prepare(wave, source):
    source = checked_path(Path(os.path.abspath(source)))
    resume_setup = wave.output.exists()
    if resume_setup:
        require(not any((wave.output / path).exists() for path in ('pipeline/capability-reservation.json',
            'final/STOP.json', 'final/decision.json', 'tooling/freeze.json', 'baseline/custody.json')),
            'R12R13_AUTHORITY_ALREADY_EXISTS')
        private_permissions(wave.output)
    historical = verify_historical_factorial(source, wave.root)
    diagnosis = diagnose_historical_trace(source)
    authority = wave.output / 'authority'
    if resume_setup:
        authority_metadata = read(authority / 'authority.json')
        identity = authority_metadata.get('identity')
        validate_owned_destination(authority, identity, campaign=CAMPAIGN)
        require((wave.output / 'pipeline/custody-stage/fdks.dpapi').is_file() and
            (authority / 'manifests/corpus-publication.json').is_file() and
            (authority / 'manifests/custody.json').is_file(), 'R12R13_PREPARATION_RESUME_INVALID')
    else:
        wave.output.mkdir(parents=True)
        private_permissions(wave.output, create=True)
        for name in ('baseline', 'pipeline', 'tooling', 'formal', 'final', 'fixtures'):
            (wave.output / name).mkdir()
        private_permissions(wave.output / 'baseline', create=True)
        identity = secrets.token_hex(32)
        initialize(authority, identity, campaign=CAMPAIGN)
    origin_config = read(source / 'baseline/authority-config.local.json')
    origin = checked_path(Path(origin_config['AP06_AUTHORITY_ROOT']))
    corpus = verify_publication(origin, origin_config['identity'], 'corpus-publication')
    previous = readback(origin, origin_config['identity'])
    if resume_setup:
        publication_path = authority / 'manifests/corpus-publication.json'
        old_publication = read(publication_path)
        require(old_publication.get('campaign') in ('AP-06-R10', CAMPAIGN) and old_publication.get('files') == corpus.get('files'),
            'R12R13_PREPARATION_RESUME_INVALID')
        old_publication['campaign'] = CAMPAIGN
        _write_json_atomic(publication_path, old_publication)
        verify_publication(authority, identity, 'corpus-publication')
        corpus_publication = {'status': 'PASS', 'manifestSha256': sha256(publication_path)}
        source_context = read(origin / 'keys/custody.json')
        old_payload = unprotect((origin / 'keys/fdks.dpapi').read_bytes(), source_context)
        context = read(wave.output / 'pipeline/custody-stage/custody.json')
        require(context == custody_context(identity, sha256(authority / 'manifests/corpus.json')) and
            unprotect((wave.output / 'pipeline/custody-stage/fdks.dpapi').read_bytes(), context) == old_payload,
            'R12R13_PREPARATION_RESUME_INVALID')
        del old_payload
        custody = {'status': 'PASS', 'manifestSha256': sha256(authority / 'manifests/custody.json')}
    else:
        corpus_publication = publish_authorities(origin, authority, dict(corpus, campaign=CAMPAIGN), identity, 'corpus-publication')
        previous_context = read(origin / 'keys/custody.json')
        payload = unprotect((origin / 'keys/fdks.dpapi').read_bytes(), previous_context)
        context = custody_context(identity, sha256(authority / 'manifests/corpus.json'))
        stage = wave.output / 'pipeline/custody-stage'
        stage.mkdir(); private_permissions(stage, create=True)
        (stage / 'fdks.dpapi').write_bytes(protect(payload, context))
        del payload
        (stage / 'custody.json').write_text(json.dumps(context, indent=2), encoding='utf-8')
        custody = publish_snapshot(authority, identity, 'custody',
            {'keys/fdks.dpapi': stage / 'fdks.dpapi', 'keys/custody.json': stage / 'custody.json'}, wave.output / 'pipeline')
    custody_readback = readback(authority, identity, campaign=CAMPAIGN)
    source_manifest = read(source / 'fixtures/manifest.json')
    for row in source_manifest:
        for kind, name, size, digest in (('plain', row['path'], row['bytes'], row['sha256']),
                ('cipher', f"video-{row['id']}.bin", row['ciphertextBytes'], row['ciphertextSha256'])):
            path = checked_path(source / 'fixtures' / kind / name)
            require(path.is_file() and path.stat().st_size == size and sha256(path) == digest,
                'R12R13_CORPUS_HASH_OR_SIZE_INVALID')
            target = wave.output / 'fixtures' / kind / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
    (wave.output / 'fixtures/manifest.json').write_bytes((source / 'fixtures/manifest.json').read_bytes())
    for name in ('workload.json', 'corpus-provenance.json'):
        (wave.output / 'baseline' / name).write_bytes((source / 'baseline' / name).read_bytes())
    task = wave.root / TASK_PATH
    require(task.is_file(), 'AP06_TASK_AUTHORITY_MISSING')
    task_hash = sha256(task)
    (wave.output / 'baseline/task.md').write_bytes(task.read_bytes())
    wave.save('baseline/task-provenance.json', {'sourceSha256': task_hash, 'sourceBytes': task.stat().st_size})
    wave.save('baseline/authority-config.local.json', {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity,
        'privateRuntime': str(wave.output / 'pipeline/key-runtime'), 'scientificCampaign': CAMPAIGN})
    wave.save('baseline/historical-factorial-gate.json', {**historical,
        'historicalSourceOutput': 'external-private-worktree', 'sourceCopiedAsRuntime': False})
    wave.save('baseline/historical-native-diagnosis.json', diagnosis)
    wave.save('baseline/native-budget.json', {'approved': True, **NATIVE_BUDGET, 'approvedByTaskSha256': task_hash})
    protocol = {'campaign': CAMPAIGN, 'implementationHead': wave.git('rev-parse', 'HEAD').strip(),
        'historicalDecisionSha256': historical['decisionSha256'], 'historicalFreezeSha256': historical['freezeSha256'],
        'budget': NATIVE_BUDGET, 'checkpoints': PHASES, 'samplingIntervalBytes': 16384,
        'traceLimitsBytes': {'stream': 536870912, 'event': 33554432}, 'retries': 0,
        'rendererAlternativeIdentityProof': {'preRegistered': True, 'requiredFields': ['rendererPid', 'creationTime',
            'rolesIncludesRenderer', 'retainedWin32ProcessHandles', 'linkedToProfiledProcess', 'oneStableIdentity', 'allCheckpoints']},
        'allocationInterpretation': 'Tracked requested bytes and allocator stats remain separate; no total-coverage, individual lifetime, or leak claim.'}
    if CAMPAIGN == 'AP-06-R12-R16-native':
        protocol['scope'] = 'capability-only'
        protocol['abAuthorized'] = False
    else:
        protocol['conditionA'] = {'id': PAIR[0], 'transport': 'XHR/XHR'}
        protocol['conditionB'] = {'id': PAIR[1], 'transport': 'XHR/Fetch'}
    wave.save('baseline/preregistered-protocol.json', protocol)
    wave.save('baseline/custody.json', {'status': 'PASS', 'newIdentity': True, 'newAuthority': True,
        'newDpapiSeal': True, 'historicalIdentityReused': False, 'historicalRuntimeCopied': False,
        'sourceCorpusPublicationSha256': corpus_publication['manifestSha256'], 'sourceCustodyReadback': previous['status'],
        'newCustodyPublicationSha256': custody['manifestSha256'], 'newCustodyReadback': custody_readback['status']})
    wave.save('baseline/provenance.json', {'status': 'PASS', 'historicalHead': SOURCE_HEAD,
        'factorialDecisionSha256': historical['decisionSha256'], 'factorialFreezeSha256': historical['freezeSha256'],
        'corpusManifestSha256': historical['corpusManifestSha256'], 'corpusProvenanceSha256': historical['provenanceSha256'],
        'historicalModified': False, 'rawsCopied': False, 'traceCopied': False})
    return {'status': 'PASS', 'newAuthority': True, 'newDpapiCustody': True,
        'historicalTrace': diagnosis['status'], 'scientificChromium': 0, 'reservationCreated': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-output', type=Path, required=True)
    args = parser.parse_args()
    wave = Wave(Path(__file__).resolve().parents[2]); wave.output = wave.root / OUTPUT
    try:
        print(json.dumps(prepare(wave, args.source_output)))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        reason = str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+', str(error)) else 'R12R13_PREPARATION_FAILED_' + type(error).__name__.upper()
        print(json.dumps({'status': 'STOP', 'reason': reason, 'scientificChromium': 0, 'reservationCreated': False}))
        raise SystemExit(1)
