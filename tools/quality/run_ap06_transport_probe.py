"""AP06-R3: ordinary loopback media HTTP versus Playwright fulfillment, no app runtime."""
from __future__ import annotations

import argparse
import contextlib
import http.server
import json
import re
import sys
import tempfile
import threading
from pathlib import Path

from run_readiness_wave1 import Wave, WaveFailure, campaign

MODES = ('native-direct-no-interception', 'native-route-fulfill')


def validate_transport_raw(raw, stage, mode):
    from run_ap06_allocation_probe import validate_runs
    validate_runs(raw, stage)
    if len({run['runId'] for run in raw['runs']}) != len(raw['runs']): raise WaveFailure('AP06_INDEPENDENT_RUN_ID_DUPLICATED')
    for run in raw['runs']:
        intercepted = mode == 'native-route-fulfill'
        if run.get('mode') != mode or run.get('playwrightRoutingInstalled') is not intercepted or run.get('fetchInterceptionInstalled') is not intercepted:
            raise WaveFailure('AP06_TRANSPORT_IDENTITY_INVALID')
        closes = [(s.get('cycle'), s.get('fixture')) for s in run['samples'] if s['phase'] == 'close']
        expected = [(cycle, f'video-{fixture}') for cycle in range(1, 7) for fixture in range(3)]
        if closes != expected: raise WaveFailure('AP06_LIFECYCLE_PROTOCOL_INCOMPLETE')


def byte_range(value, size, strict=False):
    """One explicit nonnegative start; suffix/multiple/malformed ranges are rejected."""
    match = re.fullmatch(r'bytes=(\d+)-(\d*)', value)
    if not match or size <= 0 or (strict and not match[2]):
        raise ValueError('INVALID_RANGE')
    start = int(match[1]); end = int(match[2]) if match[2] else size - 1
    if start >= size or end < start or (strict and end >= size):
        raise ValueError('UNSATISFIABLE_RANGE')
    return start, min(end, size - 1)


@contextlib.contextmanager
def media_server(files, strict_ranges=False, content_type='video/mp4', assets=None):
    """Explicit URL map only. No directory traversal, static root, or external bind."""
    files = dict(files)
    assets = dict(assets or {})
    allowed_mimes = {'text/html; charset=utf-8', 'text/javascript', 'text/css'}
    if any((key != '/' and not re.fullmatch(r'/[\w.-]+\.(?:js|css)', key)) or
           not path.is_file() or path.is_symlink() or mime not in allowed_mimes
           for key, (path, mime) in assets.items()):
        raise ValueError('INVALID_EXPERIMENTAL_ASSET_MAP')
    if content_type not in ('video/mp4','application/octet-stream'): raise ValueError('INVALID_FIXTURE_CONTENT_TYPE')
    if not files or any(not re.fullmatch(r'/video-\d+\.mp4', key) or not path.is_file() or path.is_symlink()
                        for key, path in files.items()):
        raise ValueError('INVALID_FIXTURE_MAP')
    stats = {'requests': 0, 'bytesWritten': 0, 'ranges': 0, 'cancelledTransfers': 0}
    lock = threading.Lock()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def setup(self):
            super().setup()
            if strict_ranges: self.connection.settimeout(5)

        def do_HEAD(self):
            if strict_ranges: self.send_error(405)
            else: self.serve(False)
        def do_GET(self): self.serve(True)

        def serve(self, body):
            with lock: stats['requests'] += 1
            if self.path == '/' and self.path not in assets:
                html = b'<!doctype html><html><body></body></html>'
                self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(html))); self.end_headers()
                if body: self.wfile.write(html)
                return
            asset = assets.get(self.path)
            path = asset[0] if asset else files.get(self.path)
            if path is None:
                self.send_error(404); return
            size = path.stat().st_size; start, end = 0, size - 1
            ranges = self.headers.get_all('Range', [])
            if strict_ranges and not ranges and not asset:
                self.send_response(416); self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0'); self.end_headers(); return
            if ranges:
                try:
                    if asset: raise ValueError('ASSET_RANGE_FORBIDDEN')
                    if len(ranges) != 1: raise ValueError('MULTIPLE_RANGES')
                    start, end = byte_range(ranges[0], size, strict_ranges)
                except ValueError:
                    self.send_response(416); self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0'); self.end_headers(); return
                with lock: stats['ranges'] += 1
            self.send_response(206 if ranges else 200)
            self.send_header('Content-Type', asset[1] if asset else content_type); self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Cache-Control', 'no-store')
            if ranges: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if body:
                try:
                    with path.open('rb') as source:
                        source.seek(start); remaining = end - start + 1
                        while remaining:
                            chunk = source.read(min(65536, remaining))
                            if not chunk: raise OSError('FIXTURE_CHANGED_DURING_TRANSFER')
                            self.wfile.write(chunk); remaining -= len(chunk)
                            with lock: stats['bytesWritten'] += len(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
                    with lock: stats['cancelledTransfers'] += 1

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    if strict_ranges: server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try: yield f'http://127.0.0.1:{server.server_port}', stats
    finally:
        server.shutdown(); server.server_close(); thread.join(5)
        if thread.is_alive(): raise RuntimeError('MEDIA_SERVER_CLEANUP_FAILED')


def fixture_paths(root):
    folder = root / '.quality/readiness-wave2/ap06/fixtures'
    manifest = json.loads((folder / 'manifest.json').read_text())
    paths = [folder / f'video-{index}.mp4' for index in range(3)]
    if len(manifest) != 3 or any(campaign.sha256_file(path) != manifest[i]['sha256'] or
                               path.stat().st_size != manifest[i]['bytes'] for i, path in enumerate(paths)):
        raise WaveFailure('AP06_FIXTURE_HASH_MISMATCH')
    return paths, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=('triage', 'formal'), required=True)
    parser.add_argument('--mode', choices=MODES, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]; wave = Wave(root)
    if args.stage == 'formal' and not (root / '.quality/readiness-wave3/ap06/formal-protocol.json').is_file():
        raise WaveFailure('AP06_FORMAL_PROTOCOL_REQUIRED')
    wave.output = root / '.quality/readiness-wave3/ap06' / args.stage / args.mode
    if wave.output.exists(): raise WaveFailure('AP06_CONDITION_ALREADY_RECORDED')
    baseline = json.loads((root / '.quality/readiness-wave3/baseline/source-hashes.json').read_text())
    wave.output.mkdir(parents=True)
    paths, manifest = fixture_paths(root)
    wave.env.update(AP06_MODE=args.mode, AP06_STAGE=args.stage, AP06_ARTIFACT_ROOT=str(wave.output),
                    AP06_PLAYER_SOURCE_HASH=baseline['groups']['frontend-player-production'],
                    AP06_FIXTURE_PATHS=json.dumps([str(path) for path in paths]),
                    WAVE1_PYTHON=sys.executable, WAVE1_RUNNER=str(root / 'tools/quality/run_readiness_wave1.py'))
    sys.addaudithook(lambda event, _: wave.counts.__setitem__('processInvocations', wave.counts['processInvocations'] + 1)
                    if event == 'subprocess.Popen' else None)
    result = {'status': 'FAIL', 'stage': args.stage, 'mode': args.mode}
    with tempfile.TemporaryDirectory(prefix='nanika-ap06-transport-') as temporary:
        wave.temp = Path(temporary)
        try:
            with media_server({f'/video-{i}.mp4': path for i, path in enumerate(paths)}) as (url, stats):
                wave.env['AP06_MEDIA_ORIGIN'] = url
                wave.save('protocol.json', {'mode': args.mode, 'repetitions': 1 if args.stage == 'triage' else 3,
                    'cycles': 6, 'playbackProgressSeconds': 1.5, 'naturalSampleIntervalMs': 1000,
                    'freshBrowserPerRepetition': True, 'automaticRetries': 0, 'fixtureManifest': manifest,
                    'angularOrBackendUsed': False, 'forcedGc': 'FINAL_DIAGNOSTIC_ONLY'})
                with wave.phase('AP06 transport ' + args.stage):
                    try: wave.command('transport-browser', [wave.node, 'tools/ap06-transport-probe.mjs'], root / 'frontend')
                    except WaveFailure: pass  # A failed original run remains raw evidence, never retried.
                raw = json.loads((wave.output / 'raw.json').read_text())
                wave.counts['browserMeasurementProcesses'] = raw['browserLaunches']
                validate_transport_raw(raw, args.stage, args.mode)
                wave.save('transport.json', stats)
                result['status'] = 'CHARACTERIZED'
            result['mediaServerCleanup'] = 'PASS'
        except Exception as error:
            result['reason'] = str(error) if isinstance(error, WaveFailure) else type(error).__name__
        finally:
            receipt = wave.output / 'launches.json'
            if receipt.exists(): wave.counts['browserMeasurementProcesses'] = json.loads(receipt.read_text())['launches']
            wave.save('decision.json', result); wave.save('pipeline/operations.json', wave.counts)
    print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'CHARACTERIZED' else 1


if __name__ == '__main__': raise SystemExit(main())
