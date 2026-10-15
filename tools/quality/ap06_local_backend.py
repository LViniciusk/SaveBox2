"""Owned native PostgreSQL/backend lifetime for the R8 experiment; no production services."""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / os.environ.get('AP06_EXPERIMENT_ROOT', '.quality/readiness-wave8')
BACKEND_PORT, APP_PORT = 42187, 42088

def free_port(port=0):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))
        return sock.getsockname()[1]

def verify_storage(path, identity):
    path = Path(path)
    if (not path.is_absolute() or path.is_symlink() or not path.is_dir() or
            len(identity) != 64 or any(c not in '0123456789abcdef' for c in identity)):
        raise RuntimeError('R8_STORAGE_IDENTITY_INVALID')
    marker = path / '.nanika-e2e-storage-id'
    if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != identity:
        raise RuntimeError('R8_STORAGE_IDENTITY_MISMATCH')

def isolated_database(name):
    return name.startswith('nanika_e2e_') and len(name) > 11 and name.isascii() and all(c.isalnum() or c == '_' for c in name)

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')

def serve():
    free_port(BACKEND_PORT); free_port(APP_PORT)
    resume = '--resume' in sys.argv
    if resume:
        previous = json.loads((OUTPUT/'baseline/backend-runtime.local.json').read_text())
        runtime = Path(previous['cwd']); storage = Path(previous['storagePath']); identity = previous['storageId']
        assert runtime.resolve().is_relative_to(OUTPUT.resolve()) and not runtime.is_symlink()
        assert (runtime/'.owned-r8').read_text() == identity and storage == runtime/'storage'
        verify_storage(storage, identity)
        env = dict(os.environ, **previous['environment'])
        port = int(env['DB_PORT']); database = env['DB_NAME']; password = env['DB_PASSWORD']
        assert isolated_database(database) and env['DB_HOST'] == '127.0.0.1'
        assert env['NANIKA_STORAGE_PATH'] == str(storage)
        free_port(port)
    else:
        runtime, storage, identity, env, port, database, password = create_runtime()
    pgdata = runtime/'pg'; pwfile = runtime/'pg-password'
    server = None; pg_started = False
    log = (runtime / 'process.log').open('a', encoding='utf-8')
    def command(args):
        result = subprocess.run(args, cwd=runtime, env=env, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode: raise RuntimeError('R8_NATIVE_COMMAND_FAILED_' + Path(args[0]).stem)
    try:
        if not resume:
            command(['initdb','-D',str(pgdata),'-U','nanika_e2e','-A','scram-sha-256','--pwfile',str(pwfile),'--no-locale'])
        command(['pg_ctl','-D',str(pgdata),'-l',str(runtime/'postgres.log'),'-o',f'-h 127.0.0.1 -p {port}','-w','start'])
        pg_started = True
        if not resume:
            command(['createdb','-h','127.0.0.1','-p',str(port),'-U','nanika_e2e',database])
        binaries = OUTPUT / 'tooling/backend-build'
        server = subprocess.Popen([str(binaries/'savebox_server.exe')], cwd=runtime, env=env,
            stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        for attempt in range(100):
            if server.poll() is not None: raise RuntimeError('R8_BACKEND_START_FAILED')
            try:
                with urlopen(f'http://127.0.0.1:{BACKEND_PORT}/health', timeout=1) as response:
                    if response.status == 200: break
            except OSError: time.sleep(.2)
        else: raise RuntimeError('R8_BACKEND_HEALTH_TIMEOUT')
        config = {'executable':str(binaries/'nanika_e2e_fixture.exe'), 'cwd':str(runtime),
            'storagePath':str(storage), 'storageId':identity, 'backendOrigin':f'http://127.0.0.1:{BACKEND_PORT}',
            'environment':{key:value for key,value in env.items() if key not in os.environ or os.environ.get(key) != value}}
        save(OUTPUT/'baseline/backend-runtime.local.json',config)
        save(OUTPUT/'pipeline/backend-live.json',{'status':'READY','backendPid':server.pid,
            'postgresPid':int((pgdata/'postmaster.pid').read_text().splitlines()[0]), 'database':database,
            'backendOrigin':config['backendOrigin'],'appOrigin':f'http://127.0.0.1:{APP_PORT}', 'isolated':True,
            'resumedExistingOwnedCluster':resume})
        print('R8 native backend/PostgreSQL READY',flush=True)
        stop = OUTPUT/'pipeline/stop-backend.request'
        while not stop.exists():
            if server.poll() is not None: raise RuntimeError('R8_BACKEND_EXITED')
            time.sleep(.25)
        assert json.loads((OUTPUT/'pipeline/backend-account-cleanup.json').read_text())['status'] == 'PASS'
    finally:
        if server is not None and server.poll() is None:
            server.terminate(); server.wait(timeout=20)
        if pg_started:
            command(['pg_ctl','-D',str(pgdata),'-m','fast','-w','stop'])
        log.close()
        verify_storage(storage, identity)
        assert runtime.resolve().is_relative_to(OUTPUT.resolve()) and not runtime.is_symlink()
        assert (runtime/'.owned-r8').read_text() == identity
        shutil.rmtree(runtime)
        save(OUTPUT/'pipeline/backend-runtime-cleanup.json',{'status':'PASS','ownedServerStopped':True,
            'ownedPostgresStopped':True,'ownedClusterStorageAndDotenvRemoved':True,'personalServicesTouched':False})
        print('R8 owned native resources removed',flush=True)

def create_runtime():
    identity = secrets.token_hex(32)
    runtime = OUTPUT / 'pipeline' / ('runtime-' + secrets.token_hex(8))
    runtime.mkdir(); (runtime / '.owned-r8').write_text(identity)
    assert runtime.resolve().is_relative_to(OUTPUT.resolve()) and not runtime.is_symlink()
    storage = runtime / 'storage'; storage.mkdir()
    (storage / '.nanika-e2e-storage-id').write_text(identity)
    verify_storage(storage, identity)
    port = free_port()
    database = 'nanika_e2e_r8_' + secrets.token_hex(8)
    assert isolated_database(database)
    password = secrets.token_urlsafe(32)
    env = dict(os.environ, DB_USER='nanika_e2e', DB_PASSWORD=password, DB_NAME=database,
        DB_HOST='127.0.0.1', DB_PORT=str(port), PGPASSWORD=password,
        PASS_PEPPER=secrets.token_hex(32), NANIKA_JWT_SECRET=secrets.token_hex(32),
        RESEND_API_KEY='isolated-unused', EMAIL_VALIDATION_API_KEY='isolated-unused',
        NANIKA_STORAGE_PATH=str(storage), NANIKA_E2E_FIXTURE='1', NANIKA_E2E_STORAGE_PATH=str(storage),
        NANIKA_E2E_STORAGE_ID=identity, NANIKA_BIND_ADDRESS='127.0.0.1', PORT=str(BACKEND_PORT),
        CORS_ORIGIN=f'http://127.0.0.1:{APP_PORT}', CORS_ALLOWED_ORIGINS=f'http://127.0.0.1:{APP_PORT}')
    # A local dotenv prevents the backend's upward search from adopting a personal configuration.
    (runtime / '.env').write_text('\n'.join(f'{key}={value}' for key, value in env.items()
        if key.startswith(('DB_', 'NANIKA_', 'CORS_')) or key in ('PASS_PEPPER','PORT','RESEND_API_KEY','EMAIL_VALIDATION_API_KEY')) + '\n')
    pwfile = runtime / 'pg-password'; pwfile.write_text(password + '\n')
    return runtime, storage, identity, env, port, database, password

if __name__ == '__main__':
    serve()
