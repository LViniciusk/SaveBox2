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


def validate_process(identity, observed, pid, parent_pid, cdp_args, required_args, previous=None):
    require(type(pid) is int and pid > 0 and observed['pid'] == pid and observed['parentPid'] == parent_pid,
        'AP06_BROWSER_PID_NOT_OWNED')
    require(type(observed['creationTime']) is int and observed['creationTime'] > 0, 'AP06_BROWSER_CREATION_UNAVAILABLE')
    for key in ('executablePath', 'executableSha256', 'executableBytes', 'chromiumVersion', 'architecture'):
        expected, actual = identity[key], observed[key]
        require((os.path.normcase(expected) == os.path.normcase(actual)) if key == 'executablePath' else expected == actual)
    require(identity['mode'] == 'headless-shell' and isinstance(observed['args'], list) and
        observed['args'] == cdp_args and '--headless' in observed['args'] and
        not any(arg.startswith('--type=') for arg in observed['args']) and
        all(arg in observed['args'] for arg in required_args), 'AP06_BROWSER_FLAGS_MISMATCH')
    if previous:
        require(previous['browserPid'] == pid and previous['processCreationTime'] == observed['creationTime'], 'AP06_BROWSER_PID_REUSED')
    return dict(status='PASS', browserPid=pid, processCreationTime=observed['creationTime'],
        expectedSha256=identity['executableSha256'], observedSha256=observed['executableSha256'],
        expectedExecutable=identity['executablePath'], observedExecutable=observed['executablePath'],
        chromiumVersion=observed['chromiumVersion'], architecture=observed['architecture'],
        headless=True, launchArgsValidated=True, identityBeforeWorkload=previous is None)


def process_information(pid):
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
        row = powershell(f'Get-CimInstance Win32_Process -Filter "ProcessId={pid}" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress')
        require(row and row['ProcessId'] == pid and row['CommandLine'], 'AP06_BROWSER_OS_QUERY_FAILED')
        shell = ctypes.WinDLL('shell32', use_last_error=True)
        shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
        shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        count = ctypes.c_int(); argv = shell.CommandLineToArgvW(row['CommandLine'], ctypes.byref(count))
        require(argv, 'AP06_BROWSER_OS_QUERY_FAILED')
        try: args = [argv[i] for i in range(count.value)]
        finally: kernel.LocalFree(argv)
        # Query through the held process handle again, so a recycled CIM PID cannot pass.
        verify = (wintypes.FILETIME*4)(); require(kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in verify]), 'AP06_BROWSER_OS_QUERY_FAILED')
        return dict(pid=pid, parentPid=row['ParentProcessId'], creationTime=creation, args=args, **metadata(image.value))
    finally: kernel.CloseHandle(handle)


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
        for handle in self.handles: self.kernel.CloseHandle(handle)
        self.handles.clear()


def verify_identity(identity):
    require(identity.get('mode') == 'headless-shell', 'AP06_BROWSER_IDENTITY_MISSING')
    observed = metadata(identity['executablePath'])
    require(all(observed[key] == identity[key] for key in observed), 'AP06_BROWSER_EXECUTABLE_CHANGED')
    path = regular_path(identity['executablePath'])
    require(path.is_relative_to(Path(identity['installationDirectory'])), 'AP06_BROWSER_INSTALLATION_CHANGED')
    for path, expected in identity['installationFiles'].items():
        require(digest(regular_path(path)) == expected, 'AP06_BROWSER_PLAYWRIGHT_CHANGED')
    return dict(status='PASS', **observed)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--inspect'); parser.add_argument('--verify'); parser.add_argument('--session')
    args = parser.parse_args()
    try:
        if args.inspect: print(json.dumps(metadata(args.inspect))); return
        identity = json.loads(Path(args.verify or args.session).read_text(encoding='utf-8-sig'))
        if args.verify: print(json.dumps(verify_identity(identity))); return
        lease = ExecutableLease(identity)
        try:
            print(json.dumps({'status':'READY', 'lease':'Windows read sharing only; write/delete denied'}), flush=True)
            previous = None
            for line in sys.stdin:
                request = json.loads(line); require(len(line) <= 65536, 'AP06_BROWSER_QUERY_TOO_LARGE')
                if request['action'] == 'closed':
                    result = verify_identity(identity); result['closedHashVerified'] = True
                    print(json.dumps(result), flush=True); break
                observed = process_information(request['pid'])
                # The shell has no PE VERSIONINFO; bind its CDP product version to the OS-attested root PID.
                observed['chromiumVersion'] = request['browserVersion']
                require(observed['productVersion'] in (None, observed['chromiumVersion']), 'AP06_BROWSER_VERSION_MISMATCH')
                require(observed['creationTime']/10000 - 11644473600000 >= request['launchStartedMs'] - 2000, 'AP06_BROWSER_PID_NOT_OWNED')
                result = validate_process(identity, observed, request['pid'], request['parentPid'], request['cdpArgs'], request['requiredArgs'], previous)
                previous = previous or result
                print(json.dumps(result), flush=True)
        finally: lease.close()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({'status':'STOP', 'reason':'AP06_BROWSER_IDENTITY_UNPROVEN'}), flush=True); raise SystemExit(1)


if __name__ == '__main__': main()
