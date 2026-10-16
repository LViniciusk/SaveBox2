"""Owned native PostgreSQL/backend lifetime for the R8 experiment; no production services."""
import json
import http.client
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
from ap06_authorities import sha256, checked_path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / os.environ.get('AP06_EXPERIMENT_ROOT', '.quality/readiness-wave8')
EXPERIMENT_ID = {'readiness-wave10':'r10','readiness-wave10-r2':'r10_r2','readiness-wave10-r3':'r10_r3','readiness-wave11':'r10_r3','readiness-wave11-r2':'r10_r3','readiness-wave11-r3':'r10_r3','readiness-wave12':'r10_r3'}.get(OUTPUT.name,'r8')
R3 = EXPERIMENT_ID == 'r10_r3'
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


def build_experimental():
    if not R3: raise RuntimeError('AP06_R3_BUILD_NAMESPACE_REQUIRED')
    build = OUTPUT/'tooling/backend-build'
    env = dict(os.environ, PATH='C:/msys64/ucrt64/bin;'+os.environ['PATH'])
    subprocess.run(['cmake','-S',str(ROOT/'backend'),'-B',str(build),'-G','Ninja',
        '-DCMAKE_BUILD_TYPE=Debug','-DCMAKE_CXX_COMPILER=C:/msys64/ucrt64/bin/g++.exe',
        '-DCMAKE_MAKE_PROGRAM=C:/msys64/ucrt64/bin/ninja.exe','-DCMAKE_PREFIX_PATH=C:/msys64/ucrt64',
        '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON','-DBUILD_TESTS=ON','-DBUILD_AP06_LOCAL_TEST_SERVER=ON'],env=env,check=True)
    subprocess.run(['cmake','--build',str(build),'--target','nanika_ap06_local_server','nanika_ap06_tests',
        'savebox_server','savebox_tests','nanika_e2e_fixture','--parallel','2'],env=env,check=True)
    verify_experimental_build()


def verify_experimental_build():
    build = OUTPUT/'tooling/backend-build'
    commands = json.loads((build/'compile_commands.json').read_text())
    for target,experimental in [('nanika_ap06_local_server',True),('savebox_server',False),('nanika_ap06_tests',True),('savebox_tests',False)]:
        rows = [row for row in commands if f'CMakeFiles/{target}.dir/' in row['command'].replace('\\','/')]
        if not rows or any(('NANIKA_AP06_LOCAL_TEST_SERVER=1' in row['command']) != experimental for row in rows):
            raise RuntimeError('AP06_COMPILATION_SCOPE_INVALID')
    binary = build/'nanika_ap06_local_server.exe'
    version = subprocess.check_output([str(binary),'--version'],text=True).strip()
    if version != 'Nanika AP06 local laboratory R10-R3': raise RuntimeError('AP06_BINARY_VERSION_INVALID')
    result = {'status':'PASS','target':'nanika_ap06_local_server','version':version,
        'binarySha256':sha256(binary),'compileCommandsSha256':sha256(build/'compile_commands.json'),
        'cmakeCacheSha256':sha256(build/'CMakeCache.txt'),'crowHeaderSha256':sha256(ROOT/'backend/include/crow_all.h'),
        'compilerVersion':subprocess.check_output(['C:/msys64/ucrt64/bin/g++.exe','-dumpfullversion'],text=True).strip(),
        'productionTargetHasBypass':False,'configuration':'Debug','bind':'127.0.0.1','trustProxyHeaders':False}
    save(OUTPUT/'baseline/experimental-backend.json',result)
    return result


def native_processes():
    script = "ConvertTo-Json -InputObject @(Get-Process postgres,savebox_server,nanika_ap06_local_server -ErrorAction SilentlyContinue | Sort-Object Id | Select-Object Id,@{n='started';e={$_.StartTime.ToUniversalTime().ToString('o')}}) -Compress"
    return json.loads(subprocess.check_output(['powershell','-NoProfile','-Command',script],text=True))


def postgres_toolchain():
    directory=Path(os.environ['ProgramFiles'])/'PostgreSQL/16/bin'
    if not all((directory/(name+'.exe')).is_file() for name in ('initdb','pg_ctl','createdb','psql','postgres')):
        raise RuntimeError('AP06_NATIVE_POSTGRES_16_UNAVAILABLE')
    save(OUTPUT/'baseline/postgres-toolchain.json',{'status':'PASS','bin':str(directory),
        'version':subprocess.check_output([str(directory/'postgres.exe'),'--version'],text=True).strip(),
        'serverSha256':sha256(directory/'postgres.exe'),'installedBinariesOnly':True,'existingServicesTouched':False})
    return directory


def verify_listener(server_pid):
    script = '$p=Get-NetTCPConnection -State Listen -OwningProcess '+str(server_pid)+'; @($p | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress'
    rows = json.loads(subprocess.check_output(['powershell','-NoProfile','-Command',script],text=True))
    if isinstance(rows,dict): rows=[rows]
    if not rows or any(row != {'LocalAddress':'127.0.0.1','LocalPort':BACKEND_PORT} for row in rows):
        raise RuntimeError('AP06_LISTENER_NOT_EXCLUSIVE_LOOPBACK')
    rejected=[]
    for address in sorted({'127.0.0.2','::1',socket.gethostbyname(socket.gethostname())}-{'127.0.0.1'}):
        try:
            connection=socket.create_connection((address,BACKEND_PORT),timeout=2)
        except OSError: rejected.append(address)
        else:
            connection.close(); raise RuntimeError('AP06_NON_LOOPBACK_LISTENER_ACCESSIBLE')
    return {'status':'PASS','listeners':rows,'realRejectedConnections':rejected,'ownedBackendPid':server_pid}


def verify_spoof_guard():
    statuses=[]
    for attempt in range(1,17):
        conn=http.client.HTTPConnection('127.0.0.1',BACKEND_PORT,timeout=10,source_address=('127.0.0.2',0))
        try:
            conn.request('POST','/login',json.dumps({'username':'nanika_e2e_unknown','password':'synthetic-invalid-password'}),
                {'Content-Type':'application/json','Host':'localhost','X-Real-IP':'127.0.0.1','X-Forwarded-For':'127.0.0.1, ::1'})
            response=conn.getresponse();response.read();statuses.append(response.status)
            expected=401 if attempt<=5 else 429 if attempt<15 else 403
            if response.status!=expected: raise RuntimeError('AP06_REAL_PEER_SPOOF_GUARD_FAILED')
        finally: conn.close()
    save(OUTPUT/'baseline/network-spoof-guard.json',{'status':'PASS','actualPeer':'127.0.0.2',
        'spoofedLocalHeaders':True,'statuses':statuses,'authLimit':5,'banThreshold':15})


def verify_startup_rejections(binary,runtime,env,command):
    dotenv=runtime/'.env'; original=dotenv.read_text()
    cases=[]
    try:
        for key,value in [('NANIKA_BIND_ADDRESS','0.0.0.0'),('NANIKA_BIND_ADDRESS','192.0.2.1'),
            ('NANIKA_E2E_FIXTURE','0'),('DB_NAME','production'),('DB_HOST','192.0.2.1'),
            ('TRUST_PROXY_HEADERS','true'),('NANIKA_E2E_STORAGE_ID','0'*64),('NANIKA_AP06_RUNTIME_ROOT',str(runtime/'absent'))]:
            values=dict(line.split('=',1) for line in original.splitlines()); values[key]=value
            dotenv.write_text('\n'.join(f'{k}={v}' for k,v in values.items())+'\n')
            result=subprocess.run([str(binary)],cwd=runtime,env=env,capture_output=True,timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode==0 or b'AP06_LOCAL_RUNTIME_INVALID' not in result.stderr:
                raise RuntimeError('AP06_INVALID_STARTUP_ACCEPTED')
            free_port(BACKEND_PORT); cases.append(key+':'+('wildcard' if value=='0.0.0.0' else 'rejected'))
    finally: dotenv.write_text(original)
    for marker in [runtime/'.owned-r10_r3',runtime/'storage/.nanika-e2e-storage-id',runtime/'ap06-runtime.json']:
        data=marker.read_bytes();marker.unlink()
        try:
            result=subprocess.run([str(binary)],cwd=runtime,env=env,capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode==0 or b'AP06_LOCAL_RUNTIME_INVALID' not in result.stderr: raise RuntimeError('AP06_UNOWNED_STARTUP_ACCEPTED')
            free_port(BACKEND_PORT);cases.append(marker.name+':missing')
        finally: marker.write_bytes(data)
    command(['psql','-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',env['DB_PORT'],'-U',env['DB_USER'],
        '-d',env['DB_NAME'],'-c','ALTER TABLE public.nanika_ap06_runtime RENAME TO missing_ap06_ownership'])
    try:
        result=subprocess.run([str(binary)],cwd=runtime,env=env,capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode==0 or b'AP06_LOCAL_RUNTIME_INVALID' not in result.stderr: raise RuntimeError('AP06_UNOWNED_DATABASE_ACCEPTED')
        free_port(BACKEND_PORT);cases.append('databaseOwnership:missing')
    finally:
        command(['psql','-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',env['DB_PORT'],'-U',env['DB_USER'],
            '-d',env['DB_NAME'],'-c','ALTER TABLE public.missing_ap06_ownership RENAME TO nanika_ap06_runtime'])
    save(OUTPUT/'baseline/startup-rejections.json',{'status':'PASS','cases':cases,'count':len(cases)})

def serve():
    free_port(BACKEND_PORT); free_port(APP_PORT)
    if R3:
        verify_experimental_build()
        pg_bin=postgres_toolchain()
        foreign_before=native_processes()
        save(OUTPUT/'baseline/foreign-native-before.json',foreign_before)
    resume = '--resume' in sys.argv
    if resume:
        previous = json.loads((OUTPUT/'baseline/backend-runtime.local.json').read_text())
        runtime = Path(previous['cwd']); storage = Path(previous['storagePath']); identity = previous['storageId']
        assert runtime.resolve().is_relative_to(OUTPUT.resolve()) and not runtime.is_symlink()
        assert (runtime/('.owned-'+EXPERIMENT_ID)).read_text() == identity and storage == runtime/'storage'
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
        if R3 and args[0] in ('initdb','pg_ctl','createdb','psql'):
            args=[str(pg_bin/(args[0]+'.exe')),*args[1:]]
        result = subprocess.run(args, cwd=runtime, env=env, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode: raise RuntimeError('R8_NATIVE_COMMAND_FAILED_' + Path(args[0]).stem)
    try:
        if not resume:
            command(['initdb','-D',str(pgdata),'-U','nanika_e2e','-A','scram-sha-256','--pwfile',str(pwfile),'--no-locale','--encoding=UTF8'])
        try:
            command(['pg_ctl','-D',str(pgdata),'-l',str(runtime/'postgres.log'),'-o',f'-h 127.0.0.1 -p {port}','-w','start'])
        finally: pg_started = (pgdata/'postmaster.pid').is_file()
        if not resume:
            command(['createdb','-h','127.0.0.1','-p',str(port),'-U','nanika_e2e',database])
        binaries = OUTPUT / 'tooling/backend-build'
        if R3 and not resume:
            sql = "CREATE TABLE public.nanika_ap06_runtime (singleton boolean PRIMARY KEY CHECK(singleton), identity text NOT NULL, runtime_path text NOT NULL); INSERT INTO public.nanika_ap06_runtime VALUES (TRUE, '"+identity+"', '"+runtime.as_posix().replace("'","''")+"');"
            command(['psql','-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','nanika_e2e','-d',database,'-c',sql])
        binary = binaries/('nanika_ap06_local_server.exe' if R3 else 'savebox_server.exe')
        if R3 and any(flag in sys.argv for flag in ('--validate','--validate-experimental')):
            verify_startup_rejections(binary,runtime,env,command)
            original=(runtime/'.env').read_text()
            try:
                # Native regressions use the same default test origin as CI; restore the lab before serving.
                values=dict(line.split('=',1) for line in original.splitlines())
                values.update(CORS_ORIGIN='http://localhost:4200',CORS_ALLOWED_ORIGINS='http://localhost:4200')
                (runtime/'.env').write_text('\n'.join(f'{key}={value}' for key,value in values.items())+'\n')
                suites=[('savebox_tests','native-production'),('nanika_ap06_tests','native-experimental')]
                for name,report in (suites[1:] if '--validate-experimental' in sys.argv else suites):
                    command([str(binaries/(name+'.exe')),'--order','rand','--rng-seed','60102',
                        '--reporter','xml','--out',str(OUTPUT/'baseline'/(report+'.xml'))])
            finally: (runtime/'.env').write_text(original)
        server = subprocess.Popen([str(binary)], cwd=runtime, env=env,
            stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        for attempt in range(100):
            if server.poll() is not None: raise RuntimeError('R8_BACKEND_START_FAILED')
            try:
                with urlopen(f'http://127.0.0.1:{BACKEND_PORT}/health', timeout=1) as response:
                    if response.status == 200: break
            except OSError: time.sleep(.2)
        else: raise RuntimeError('R8_BACKEND_HEALTH_TIMEOUT')
        if R3:
            save(OUTPUT/'baseline/listener-isolation.json',verify_listener(server.pid))
            verify_spoof_guard()
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
            server.terminate()
            try: server.wait(timeout=20)
            except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=20)
        if pg_started:
            command(['pg_ctl','-D',str(pgdata),'-m','fast','-w','stop'])
        log.close()
        if R3:
            shutil.copyfile(runtime/'process.log',OUTPUT/'baseline/native-runtime.log')
            if (runtime/'postgres.log').exists(): shutil.copyfile(runtime/'postgres.log',OUTPUT/'baseline/native-postgres.log')
        verify_storage(storage, identity)
        assert runtime.resolve().is_relative_to(OUTPUT.resolve()) and not runtime.is_symlink()
        assert (runtime/('.owned-'+EXPERIMENT_ID)).read_text() == identity
        shutil.rmtree(runtime)
        if R3:
            foreign_after=native_processes()
            save(OUTPUT/'pipeline/foreign-native-after.json',{'status':'PASS' if foreign_after==foreign_before else 'FAIL',
                'sameForeignProcesses':foreign_after==foreign_before,'before':foreign_before,'after':foreign_after})
        save(OUTPUT/'pipeline/backend-runtime-cleanup.json',{'status':'PASS','ownedServerStopped':True,
            'ownedPostgresStopped':True,'ownedClusterStorageAndDotenvRemoved':True,'personalServicesTouched':False})
        print('R8 owned native resources removed',flush=True)

def create_runtime():
    identity = secrets.token_hex(32)
    runtime = OUTPUT / 'pipeline' / ('runtime-' + secrets.token_hex(8))
    if R3: checked_path(runtime)
    runtime.mkdir(); (runtime / ('.owned-'+EXPERIMENT_ID)).write_text(identity)
    assert runtime.resolve().is_relative_to(OUTPUT.resolve()) and not runtime.is_symlink()
    storage = runtime / 'storage'; storage.mkdir()
    (storage / '.nanika-e2e-storage-id').write_text(identity)
    verify_storage(storage, identity)
    if R3:
        shutil.copytree(ROOT/'config',runtime/'config')
        (runtime/'docs').mkdir()
        shutil.copyfile(ROOT/'docs/swagger.yaml',runtime/'docs/swagger.yaml')
        shutil.copytree(ROOT/'docs/swagger-ui',runtime/'docs/swagger-ui')
    port = free_port()
    database = 'nanika_e2e_'+EXPERIMENT_ID+'_' + secrets.token_hex(8)
    assert isolated_database(database)
    password = secrets.token_urlsafe(32)
    env = dict(os.environ, DB_USER='nanika_e2e', DB_PASSWORD=password, DB_NAME=database,
        DB_HOST='127.0.0.1', DB_PORT=str(port), PGPASSWORD=password,
        PASS_PEPPER=secrets.token_hex(32), NANIKA_JWT_SECRET=secrets.token_hex(32),
        RESEND_API_KEY='isolated-unused', EMAIL_VALIDATION_API_KEY='isolated-unused',
        NANIKA_STORAGE_PATH=str(storage), NANIKA_E2E_FIXTURE='1', NANIKA_E2E_STORAGE_PATH=str(storage),
        NANIKA_E2E_STORAGE_ID=identity, NANIKA_BIND_ADDRESS='127.0.0.1', PORT=str(BACKEND_PORT),
        CORS_ORIGIN=f'http://127.0.0.1:{APP_PORT}', CORS_ALLOWED_ORIGINS=f'http://127.0.0.1:{APP_PORT}')
    if R3:
        env.update(NANIKA_AP06_RUNTIME_ROOT=str(runtime),TRUST_PROXY_HEADERS='false',IMGUR_CLIENT_ID='isolated-unused')
        save(runtime/'ap06-runtime.json',{'campaign':'AP-06-R10-R3','schema':1,'identity':identity,
            'database':database,'storage':storage.as_posix()})
    # A local dotenv prevents the backend's upward search from adopting a personal configuration.
    (runtime / '.env').write_text('\n'.join(f'{key}={value}' for key, value in env.items()
        if key.startswith(('DB_', 'NANIKA_', 'CORS_')) or key in ('PASS_PEPPER','PORT','RESEND_API_KEY','EMAIL_VALIDATION_API_KEY','TRUST_PROXY_HEADERS','IMGUR_CLIENT_ID')) + '\n')
    pwfile = runtime / 'pg-password'; pwfile.write_text(password + '\n')
    return runtime, storage, identity, env, port, database, password

if __name__ == '__main__':
    if '--build' in sys.argv: build_experimental()
    else: serve()
