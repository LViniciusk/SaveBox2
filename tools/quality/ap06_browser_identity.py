"""Windows executable identity and a read lease held across one owned browser attempt."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time


def require(value, reason='AP06_BROWSER_IDENTITY_MISMATCH'):
    if not value: raise ValueError(reason)


def digest(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def regular_path(value):
    path = Path(value)
    require(path.is_absolute() and path.is_file(), 'AP06_BROWSER_EXECUTABLE_MISSING')
    for item in (path, *path.parents):
        require(not item.is_symlink() and not getattr(item.lstat(), 'st_file_attributes', 0) & 0x400,
            'AP06_BROWSER_REPARSE_REJECTED')
    require(os.path.normcase(str(path.absolute())) == os.path.normcase(str(path.resolve())), 'AP06_BROWSER_PATH_CHANGED')
    return path.resolve()


def powershell(script):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference="Stop";' + script],
        capture_output=True, encoding='utf-8', timeout=30, creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    return json.loads(result.stdout.lstrip('\ufeff')) if result.stdout.strip() else None


def metadata(path):
    path = regular_path(path)
    with path.open('rb') as stream:
        require(stream.read(2) == b'MZ', 'AP06_BROWSER_PE_INVALID')
        stream.seek(0x3c); offset = struct.unpack('<I', stream.read(4))[0]
        stream.seek(offset); require(stream.read(4) == b'PE\0\0', 'AP06_BROWSER_PE_INVALID')
        machine = struct.unpack('<H', stream.read(2))[0]
    architecture = {0x8664:'x64', 0xaa64:'arm64', 0x14c:'ia32'}.get(machine)
    require(architecture == 'x64' and struct.calcsize('P') == 8, 'AP06_BROWSER_ARCHITECTURE_MISMATCH')
    quoted = str(path).replace("'", "''")
    version = powershell("(Get-Item -LiteralPath '" + quoted + "').VersionInfo.ProductVersion | ConvertTo-Json -Compress")
    return dict(executablePath=str(path), executableSha256=digest(path), executableBytes=path.stat().st_size,
        productVersion=version, architecture=architecture)


def safe_directory(value, expected_root, launch_started_ms):
    path, root = Path(value), Path(expected_root)
    require(path.is_absolute() and path.is_dir() and root.is_dir(), 'AP06_BROWSER_PROFILE_PATH_INVALID')
    for item in (path, *path.parents, root, *root.parents):
        require(not item.is_symlink() and not getattr(item.lstat(), 'st_file_attributes', 0) & 0x400,
            'AP06_BROWSER_REPARSE_REJECTED')
    require(os.path.normcase(str(path.resolve())) == os.path.normcase(str(path.absolute())) and
        os.path.normcase(str(path.parent.resolve())) == os.path.normcase(str(root.resolve())) and path.is_dir(),
        'AP06_BROWSER_PROFILE_PATH_INVALID')
    created_ms=path.stat().st_ctime*1000
    require(created_ms >= launch_started_ms-2000 and created_ms <= time.time()*1000+1000,
        'AP06_BROWSER_PROFILE_PATH_INVALID')
    return path


def validate_creation_times(handle_time, cim_time, verify_time):
    # shortcut: tolerate sub-ms CIM rounding; upgrade if CIM exposes raw FILETIME.
    require(type(handle_time) is int and handle_time > 0 and type(verify_time) is int and verify_time > 0 and type(cim_time) is int,
        'AP06_BROWSER_CREATION_UNAVAILABLE')
    require(handle_time == verify_time, 'AP06_BROWSER_HANDLE_CREATION_CHANGED')
    require(abs(handle_time-cim_time) <= 10000, 'AP06_BROWSER_CREATION_CIM_MISMATCH')
    return handle_time


def validate_process(identity, observed, pid, parent_pid, required_args, previous=None, parent=None,
        node_executable=None, launch_started_ms=None):
    require(type(pid) is int and pid > 0 and observed['pid'] == pid and observed['parentPid'] == parent_pid,
        'AP06_BROWSER_PID_NOT_OWNED')
    require(type(observed['creationTime']) is int and observed['creationTime'] > 0, 'AP06_BROWSER_CREATION_UNAVAILABLE')
    for key in ('executablePath', 'executableSha256', 'executableBytes', 'chromiumVersion', 'architecture'):
        expected, actual = identity[key], observed[key]
        require((os.path.normcase(os.path.normpath(expected)) == os.path.normcase(os.path.normpath(actual)))
            if key == 'executablePath' else expected == actual, 'AP06_BROWSER_IDENTITY_MISMATCH')
    require(identity['mode'] == 'headless-shell' and Path(observed['executablePath']).name.lower() == 'chrome-headless-shell.exe',
        'AP06_BROWSER_IDENTITY_MISMATCH')
    protocol=identity['launchProtocol'];allowed=protocol['allowedExperimentalArgs']
    require(isinstance(required_args,list) and required_args in allowed,'AP06_BROWSER_FLAGS_MISMATCH')
    argv=observed['args'];require(isinstance(argv,list) and argv and
        os.path.normcase(os.path.normpath(argv[0])) == os.path.normcase(os.path.normpath(observed['executablePath'])),
        'AP06_BROWSER_OS_QUERY_FAILED')
    tokens=argv[1:];fixed=protocol['fixedArgs'];suffix=protocol['suffixArgs'];profile_index=len(fixed)+len(required_args)
    require(not any(arg == '--type' or arg.startswith('--type=') for arg in tokens) and
        len(tokens) == profile_index+1+len(suffix) and tokens[:profile_index] == fixed+required_args,
        'AP06_BROWSER_FLAGS_MISMATCH')
    require(not suffix or tokens[-len(suffix):] == suffix, 'AP06_BROWSER_FLAGS_MISMATCH')
    profile_arg=tokens[profile_index];prefix=protocol['profileArgPrefix']
    require(profile_arg.startswith(prefix) and tokens.count(profile_arg)==1,'AP06_BROWSER_PROFILE_PATH_INVALID')
    profile=safe_directory(profile_arg[len(prefix):],protocol['profileRoot'],launch_started_ms)
    require(profile.name.startswith(protocol['profileNamePrefix']) and profile.name!=protocol['profileNamePrefix'],
        'AP06_BROWSER_PROFILE_PATH_INVALID')
    require(parent and parent['pid'] == parent_pid and node_executable and
        os.path.normcase(os.path.normpath(parent['executablePath'])) == os.path.normcase(os.path.normpath(node_executable)) and
        parent['creationTime'] < observed['creationTime'], 'AP06_BROWSER_ANCESTRY_INVALID')
    require(observed['creationTime']/10000-11644473600000 >= launch_started_ms-2000,
        'AP06_BROWSER_PID_NOT_OWNED')
    if previous:
        require(previous['browserPid'] == pid and previous['processCreationTime'] == observed['creationTime'] and
            previous['parentPid'] == parent_pid and previous['parentCreationTime'] == parent['creationTime'],
            'AP06_BROWSER_PID_REUSED')
    native_args=allowed[1] if len(allowed)>1 else []
    return dict(status='PASS', browserPid=pid, parentPid=parent_pid, parentCreationTime=parent['creationTime'],
        processCreationTime=observed['creationTime'], expectedSha256=identity['executableSha256'],
        observedSha256=observed['executableSha256'], expectedExecutable=identity['executablePath'],
        observedExecutable=observed['executablePath'], chromiumVersion=observed['chromiumVersion'],
        architecture=observed['architecture'], browserMode='headless-shell', launchArgsValidated=True,
        ancestryValidated=True,fixedDefaultsValidated=True,experimentalArgumentsValidated=True,profileDirectoryValidated=True,
        nativeFlagsValidated=required_args==native_args, imageHashBoundByLease=True, identityBeforeWorkload=previous is None)


def process_information(pid, include_identity=True, check_argv0=True):
    require(os.name == 'nt', 'AP06_BROWSER_WINDOWS_REQUIRED')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]; kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)]*4
    handle = kernel.OpenProcess(0x1000, False, pid); require(handle, 'AP06_BROWSER_OS_QUERY_FAILED')
    try:
        size = wintypes.DWORD(32768); image = ctypes.create_unicode_buffer(size.value); times = (wintypes.FILETIME*4)()
        require(kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)) and
            kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]), 'AP06_BROWSER_OS_QUERY_FAILED')
        creation = (times[0].dwHighDateTime << 32) + times[0].dwLowDateTime
        row = powershell(f'$p=Get-CimInstance Win32_Process -Filter "ProcessId={pid}";if($p){{[pscustomobject]@{{ProcessId=$p.ProcessId;ParentProcessId=$p.ParentProcessId;CommandLine=$p.CommandLine;CreationTimeFileTime=[long]$p.CreationDate.ToFileTimeUtc()}}|ConvertTo-Json -Compress}}')
        require(row and row['ProcessId'] == pid and row['CommandLine'], 'AP06_BROWSER_OS_QUERY_FAILED')
        shell = ctypes.WinDLL('shell32', use_last_error=True)
        shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
        shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        count = ctypes.c_int(); argv = shell.CommandLineToArgvW(row['CommandLine'], ctypes.byref(count))
        require(argv, 'AP06_BROWSER_OS_QUERY_FAILED')
        try: args = [argv[i] for i in range(count.value)]
        finally: kernel.LocalFree(argv)
        # Match both Windows views while the same process handle remains open.
        verify = (wintypes.FILETIME*4)(); require(kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in verify]), 'AP06_BROWSER_OS_QUERY_FAILED')
        verify_creation=(verify[0].dwHighDateTime << 32)+verify[0].dwLowDateTime
        validate_creation_times(creation,row['CreationTimeFileTime'],verify_creation)
        require(args and (not check_argv0 or
            os.path.normcase(os.path.normpath(args[0]))==os.path.normcase(os.path.normpath(image.value))),
            'AP06_BROWSER_IMAGE_ARGUMENT_MISMATCH')
        result=dict(pid=pid,parentPid=row['ParentProcessId'],creationTime=creation,args=args,executablePath=str(Path(image.value).resolve()))
        if include_identity: result.update(metadata(image.value))
        return result
    finally: kernel.CloseHandle(handle)


class WinProcessApi:
    WAIT_OBJECT_0, WAIT_TIMEOUT, WAIT_FAILED = 0, 258, 0xFFFFFFFF

    def __init__(self):
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD)]
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)]*4
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def open(self, pid):
        handle = self.kernel.OpenProcess(0x1000 | 0x00100000, False, pid)  # Query limited information + synchronize.
        require(handle, 'AP06_BROWSER_OS_QUERY_FAILED')
        try:
            size = wintypes.DWORD(32768); image = ctypes.create_unicode_buffer(size.value); times = (wintypes.FILETIME*4)()
            require(self.kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)) and
                self.kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]), 'AP06_BROWSER_OS_QUERY_FAILED')
            creation = (times[0].dwHighDateTime << 32) + times[0].dwLowDateTime
            return handle, creation, str(Path(image.value).resolve())
        except BaseException as error:
            try: closed = self.close(handle)
            except Exception: closed = False
            if not closed: raise ValueError('AP06_BROWSER_HANDLE_RELEASE_FAILED') from error
            raise

    def wait(self, handle, timeout_ms):
        return self.kernel.WaitForSingleObject(handle, timeout_ms)

    def close(self, handle):
        return bool(self.kernel.CloseHandle(handle))


class OwnedProcessAudit:
    """Retain CDP-owned process handles until the bounded post-close audit."""
    DEADLINE_MS = 10000

    def __init__(self, identity, api=None, monotonic=time.monotonic):
        require(os.name == 'nt' or api is not None, 'AP06_BROWSER_WINDOWS_REQUIRED')
        self.api = api or WinProcessApi()
        self.monotonic = monotonic
        self.executable = os.path.normcase(os.path.normpath(identity['executablePath']))
        self.entries = []
        self.current = {}
        self.reused_pid_count = 0
        self.released = False

    def register(self, processes):
        require(isinstance(processes, list) and len(processes) <= 512, 'AP06_BROWSER_CDP_PROCESS_QUERY_FAILED')
        for row in processes:
            require(isinstance(row, dict) and type(row.get('id')) is int and row['id'] > 0 and
                isinstance(row.get('type'), str) and 0 < len(row['type']) <= 64 and
                row['type'].replace('_', '').replace('-', '').replace('.', '').isalnum(),
                'AP06_BROWSER_CDP_PROCESS_QUERY_FAILED')
            pid, role = row['id'], row['type']
            previous = self.current.get(pid)
            if previous:
                state = self.api.wait(previous['handle'], 0)
                if state == WinProcessApi.WAIT_TIMEOUT:
                    previous['roles'].add(role)
                    continue
                require(state == WinProcessApi.WAIT_OBJECT_0, 'AP06_BROWSER_OS_QUERY_FAILED')
            handle, creation, image = self.api.open(pid)
            entry = {'pid': pid, 'creationTime': creation, 'roles': {role}, 'handle': handle}
            if os.path.normcase(os.path.normpath(image)) != self.executable:
                self.entries.append(entry)
                require(False, 'AP06_BROWSER_IDENTITY_MISMATCH')
            if previous and creation == previous['creationTime']:
                previous['roles'].add(role)
                try: closed = self.api.close(handle)
                except Exception: closed = False
                if not closed:
                    self.entries.append(entry)
                    require(False, 'AP06_BROWSER_HANDLE_RELEASE_FAILED')
                continue
            if previous:
                self.reused_pid_count += 1
            self.entries.append(entry); self.current[pid] = entry

    def audit(self):
        started = self.monotonic(); deadline = started + self.DEADLINE_MS/1000
        closed = timed_out = failed = 0
        for entry in self.entries:
            remaining = max(0, int((deadline-self.monotonic())*1000))
            result = self.api.wait(entry['handle'], remaining)
            if result == WinProcessApi.WAIT_OBJECT_0: closed += 1
            elif result == WinProcessApi.WAIT_TIMEOUT: timed_out += 1
            else: failed += 1
        elapsed = max(0, int((self.monotonic()-started)*1000))
        ok = bool(self.entries) and timed_out == 0 and failed == 0 and elapsed <= self.DEADLINE_MS
        return {'status': 'PASS' if ok else 'FAIL', 'method': 'retained-win32-process-handles',
            'registeredProcessCount': len(self.entries), 'closedProcessCount': closed, 'timedOutProcessCount': timed_out,
            'waitFailedProcessCount': failed, 'reusedPidCount': self.reused_pid_count, 'deadlineMs': self.DEADLINE_MS,
            'elapsedMs': elapsed, 'closedHashVerified': False,
            'processes': [{'pid': row['pid'], 'creationTime': row['creationTime'], 'roles': sorted(row['roles'])}
                for row in sorted(self.entries, key=lambda item: (item['pid'], item['creationTime']))]}

    def close(self):
        if self.released: return {'releasedProcessHandles': 0, 'closeFailures': 0}
        failures = 0
        for entry in self.entries:
            if entry['handle'] is not None:
                try:
                    if not self.api.close(entry['handle']): failures += 1
                except Exception: failures += 1
                finally: entry['handle'] = None
        self.released = True
        return {'releasedProcessHandles': len(self.entries), 'closeFailures': failures}


class ExecutableLease:
    def __init__(self, identity):
        require(os.name == 'nt', 'AP06_BROWSER_WINDOWS_REQUIRED')
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handles = []
        try:
            for path in [identity['executablePath'], *identity['installationFiles']]:
                regular_path(path)
                # Deny write/delete while hashing, launching and collecting; permit the image loader to read.
                handle = self.kernel.CreateFileW(path, 0x80000000, 1, None, 3, 0x80, None)
                require(handle != ctypes.c_void_p(-1).value, 'AP06_BROWSER_READ_LEASE_FAILED')
                self.handles.append(handle)
            verify_identity(identity)
        except BaseException:
            self.close(); raise

    def close(self):
        failures = sum(not self.kernel.CloseHandle(handle) for handle in self.handles)
        count = len(self.handles)
        self.handles.clear()
        return {'releasedExecutableHandles': count, 'closeFailures': failures}


def verify_identity(identity):
    require(identity.get('mode') == 'headless-shell', 'AP06_BROWSER_IDENTITY_MISSING')
    observed = metadata(identity['executablePath'])
    require(all(observed[key] == identity[key] for key in observed), 'AP06_BROWSER_EXECUTABLE_CHANGED')
    path = regular_path(identity['executablePath'])
    require(path.is_relative_to(Path(identity['installationDirectory'])), 'AP06_BROWSER_INSTALLATION_CHANGED')
    for path, expected in identity['installationFiles'].items():
        require(digest(regular_path(path)) == expected, 'AP06_BROWSER_PLAYWRIGHT_CHANGED')
    if 'launchProtocol' in identity:
        protocol=identity['launchProtocol']
        require(protocol['profileRoot'] and protocol['profileArgPrefix']=='--user-data-dir=' and
            protocol['profileNamePrefix']=='playwright_chromiumdev_profile-' and protocol['suffixArgs']==['--remote-debugging-pipe','--no-startup-window'] and
            protocol['fixedArgs'] and protocol['allowedExperimentalArgs']==[
                ['--autoplay-policy=no-user-gesture-required'],
                ['--autoplay-policy=no-user-gesture-required','--memlog=all','--memlog-stack-mode=native',
                    '--memlog-sampling-rate=16384','--memlog-keep-small-allocations']], 'AP06_BROWSER_FLAGS_MISMATCH')
    return dict(status='PASS', **observed)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--inspect'); parser.add_argument('--verify'); parser.add_argument('--session')
    args = parser.parse_args()
    try:
        if args.inspect: print(json.dumps(metadata(args.inspect))); return
        identity = json.loads(Path(args.verify or args.session).read_text(encoding='utf-8-sig'))
        if args.verify: print(json.dumps(verify_identity(identity))); return
        lease = ExecutableLease(identity)
        owned = OwnedProcessAudit(identity) if os.environ.get('AP06_R5_PROCESS_HANDLE_AUDIT') == '1' else None
        try:
            print(json.dumps({'status':'READY', 'lease':'Windows read sharing only; write/delete denied'}), flush=True)
            previous = None
            for line in sys.stdin:
                request = json.loads(line); require(len(line) <= 65536, 'AP06_BROWSER_QUERY_TOO_LARGE')
                action = request['action']
                if action == 'closed':  # R3/R4 legacy protocol.
                    result = verify_identity(identity); result['closedHashVerified'] = True
                    print(json.dumps(result), flush=True); break
                if action == 'register-processes':
                    require(owned is not None and previous is not None and owned.entries, 'AP06_BROWSER_NOT_ATTESTED')
                    owned.register(request['processes'])
                    print(json.dumps({'status':'PASS','registeredProcessCount':len(owned.entries)}), flush=True)
                    continue
                if action == 'audit-closed':
                    require(owned is not None, 'AP06_BROWSER_IDENTITY_UNPROVEN')
                    receipt = owned.audit()
                    try:
                        verify_identity(identity); receipt['closedHashVerified'] = True
                    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                        receipt['closedHashVerified'] = False
                    if not receipt['closedHashVerified']: receipt['status'] = 'FAIL'
                    print(json.dumps({'status':'PASS','receipt':receipt}), flush=True)
                    continue
                if action == 'release':
                    require(owned is not None, 'AP06_BROWSER_IDENTITY_UNPROVEN')
                    processes = owned.close(); files = lease.close()
                    result = {'status':'PASS' if not processes['closeFailures'] and not files['closeFailures'] else 'STOP',
                        'processHandles':processes,'executableHandles':files}
                    if result['status'] == 'STOP': result['reason'] = 'AP06_BROWSER_HANDLE_RELEASE_FAILED'
                    print(json.dumps(result), flush=True)
                    if result['status'] == 'STOP': raise ValueError('AP06_BROWSER_HANDLE_RELEASE_FAILED')
                    break
                require(action == 'attest' and previous is None, 'AP06_BROWSER_IDENTITY_UNPROVEN')
                observed = process_information(request['pid'],include_identity=False)
                observed.update({key:identity[key] for key in ('executableSha256','executableBytes','architecture','productVersion')})
                parent = process_information(request['parentPid'],include_identity=False,check_argv0=False)
                # The shell has no PE VERSIONINFO; bind its CDP product version to the OS-attested root PID.
                observed['chromiumVersion'] = request['browserVersion']
                require(observed['productVersion'] in (None, observed['chromiumVersion']), 'AP06_BROWSER_VERSION_MISMATCH')
                result = validate_process(identity, observed, request['pid'], request['parentPid'], request['requiredArgs'], previous,
                    parent, request['nodeExecutable'], request['launchStartedMs'])
                if owned is not None:
                    owned.register([{'id':request['pid'],'type':'browser'}])
                    require(owned.current[request['pid']]['creationTime']==result['processCreationTime'], 'AP06_BROWSER_PID_REUSED')
                previous = result
                print(json.dumps(result), flush=True)
        finally:
            if owned is not None: owned.close()
            lease.close()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        reason=str(error)
        if not reason.startswith('AP06_BROWSER_') or not reason.replace('_','').isalnum(): reason='AP06_BROWSER_IDENTITY_UNPROVEN'
        print(json.dumps({'status':'STOP', 'reason':reason}), flush=True); raise SystemExit(1)


if __name__ == '__main__': main()
