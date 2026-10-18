"""Immutable AP-06 private authorities, independent of a Git worktree."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import stat
import subprocess

_VERIFIED_ACLS = {}
CAMPAIGNS = {'AP-06-R9-R2': '.owned-ap06-r9-r2', 'AP-06-R10': '.owned-ap06-r10'}


def windows_descriptor(path):
    import ctypes
    from ctypes import wintypes
    api = ctypes.WinDLL('advapi32', use_last_error=True).GetFileSecurityW
    api.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    api.restype = wintypes.BOOL
    required = wintypes.DWORD()
    api(str(path), 0x5, None, 0, ctypes.byref(required))  # Owner and DACL, including protection flags.
    if not required.value: raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(required.value)
    if not api(str(path), 0x5, buffer, required.value, ctypes.byref(required)):
        raise ctypes.WinError(ctypes.get_last_error())
    return buffer.raw


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked_path(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('AUTHORITY_ABSOLUTE_PATH_REQUIRED')
    for part in [*reversed(path.parents), path]:
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('AUTHORITY_REPARSE_POINT_REJECTED')
    return path


def private_permissions(path, create=False):
    path = checked_path(path)
    if os.name == 'nt':
        if not create and str(path) in _VERIFIED_ACLS:
            if windows_descriptor(path) != _VERIFIED_ACLS[str(path)]:
                raise ValueError('AUTHORITY_ACL_CHANGED')
            return
        # Pass paths through the environment, never interpolate them into PowerShell code.
        script = '''$ErrorActionPreference='Stop'; $p=$env:AP06_ACL_PATH;
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
        if ($env:AP06_ACL_CREATE -eq '1') {
          $acl=New-Object Security.AccessControl.DirectorySecurity;
          $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
          $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
          $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl;
        }
        $acl=Get-Acl -LiteralPath $p;
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected) {throw 'AUTHORITY_ACL_OWNER'};
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
          if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) {throw 'AUTHORITY_ACL_SHARED'};
        }'''
        subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                       env=dict(os.environ, AP06_ACL_PATH=str(path), AP06_ACL_CREATE='1' if create else '0'),
                       check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        _VERIFIED_ACLS[str(path)] = windows_descriptor(path)
    else:
        if create:
            path.chmod(0o700)
        info = path.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('AUTHORITY_PERMISSIONS_SHARED')


def initialize(root, identity, campaign='AP-06-R9-R2'):
    if campaign not in CAMPAIGNS: raise ValueError('AUTHORITY_INVALID_CAMPAIGN')
    root = checked_path(root)
    if len(identity) != 64 or any(c not in '0123456789abcdef' for c in identity):
        raise ValueError('AUTHORITY_INVALID_IDENTITY')
    if root.exists():
        validate_owned_destination(root, identity, campaign=campaign)
        return
    root.parent.mkdir(parents=True, exist_ok=True)
    checked_path(root.parent)
    root.mkdir()
    private_permissions(root, create=True)
    (root / CAMPAIGNS[campaign]).write_text(identity, encoding='ascii')
    with (root / 'authority.json').open('x', encoding='utf-8') as stream:
        json.dump({'campaign': campaign, 'identity': identity, 'schema': 1}, stream)
    validate_owned_destination(root, identity)


def validate_owned_destination(root, identity, campaign=None):
    root = checked_path(root)
    authority = checked_path(root / 'authority.json')
    metadata = json.loads(authority.read_text())
    campaign = metadata.get('campaign') if campaign is None else campaign
    if campaign not in CAMPAIGNS: raise ValueError('AUTHORITY_INVALID_CAMPAIGN')
    marker = checked_path(root / CAMPAIGNS[campaign])
    if (not marker.is_file() or marker.read_text(encoding='ascii') != identity or
            metadata != {'campaign': campaign, 'identity': identity, 'schema': 1}):
        raise ValueError('AUTHORITY_OWNERSHIP_MISMATCH')
    private_permissions(root)
    return root


def relative_path(value):
    if not isinstance(value, str): raise ValueError('AUTHORITY_INVALID_RELATIVE_PATH')
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or '..' in path.parts or
            '\\' in value or ':' in value or path.as_posix() != value or value.startswith('.')):
        raise ValueError('AUTHORITY_INVALID_RELATIVE_PATH')
    return Path(*path.parts)


def verify_files(root, manifest):
    paths = [item['path'] for item in manifest['files']]
    if not paths or len(paths) != len(set(paths)):
        raise ValueError('AUTHORITY_INVALID_PATH_SET')
    for item in manifest['files']:
        if (type(item['size']) is not int or item['size'] < 0 or not isinstance(item['sha256'], str) or
                len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256'])):
            raise ValueError('AUTHORITY_INVALID_SIZE_OR_HASH')
        path = checked_path(Path(root) / relative_path(item['path']))
        if not path.is_file() or path.stat().st_size != item['size'] or sha256(path) != item['sha256']:
            raise ValueError('AUTHORITY_HASH_OR_SIZE_MISMATCH')


def atomic_copy(source, root, relative, identity):
    root = validate_owned_destination(root, identity)
    target = checked_path(root / relative_path(relative))
    target.parent.mkdir(parents=True, exist_ok=True)
    checked_path(target.parent)
    if target.exists():
        if target.stat().st_size != source.stat().st_size or sha256(target) != sha256(source):
            raise ValueError('AUTHORITY_IMMUTABLE_CONTENT_CONFLICT')
        return
    staging = target.with_name('.staging-' + secrets.token_hex(16))
    try:
        with staging.open('xb') as output, source.open('rb') as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush(); os.fsync(output.fileno())
        if staging.stat().st_size != source.stat().st_size or sha256(staging) != sha256(source):
            raise ValueError('AUTHORITY_STAGING_COPY_MISMATCH')
        validate_owned_destination(root, identity)
        checked_path(target)
        if os.name == 'nt':
            staging.rename(target)  # Windows rename fails if another writer already published the destination.
        else:
            os.link(staging, target); staging.unlink()
    finally:
        if staging.exists():
            staging.unlink()


def publish_authorities(source_root, authority_root, manifest, identity, name):
    relative_path('manifests/' + name + '.json')
    validate_owned_destination(authority_root, identity)
    verify_files(source_root, manifest)
    for item in manifest['files']:
        atomic_copy(Path(source_root) / relative_path(item['path']), authority_root, item['path'], identity)
    verify_files(authority_root, manifest)
    # Publish the receipt last: a failed copy can never leave a valid manifest for a partial batch.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='ap06-manifest-') as temporary:
        receipt = Path(temporary) / 'manifest.json'
        receipt.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        atomic_copy(receipt, authority_root, 'manifests/' + name + '.json', identity)
    verify_publication(authority_root, identity, name)
    return {'status': 'PASS', 'files': len(manifest['files']), 'manifestSha256': sha256(receipt_path(authority_root, name))}


def receipt_path(root, name):
    return checked_path(Path(root) / relative_path('manifests/' + name + '.json'))


def verify_publication(root, identity, name):
    validate_owned_destination(root, identity)
    manifest = json.loads(receipt_path(root, name).read_text())
    verify_files(root, manifest)
    campaign = json.loads((Path(root)/'authority.json').read_text())['campaign']
    expected = {CAMPAIGNS[campaign], 'authority.json'}
    for receipt in (Path(root)/'manifests').glob('*.json'):
        checked_path(receipt)
        data = json.loads(receipt.read_text())
        if isinstance(data, dict) and data.get('campaign') == campaign and 'files' in data:
            expected.add(receipt.relative_to(root).as_posix())
            expected.update(item['path'] for item in data['files'])
        elif receipt == receipt_path(root, name):
            expected.add(receipt.relative_to(root).as_posix())
            expected.update(item['path'] for item in manifest['files'])
    actual = set()
    for path in Path(root).rglob('*'):
        checked_path(path)
        if path.is_file(): actual.add(path.relative_to(root).as_posix())
    if actual != expected:
        raise ValueError('AUTHORITY_PUBLISHED_PATH_SET_MISMATCH')
    return manifest


def publish_snapshot(authority_root, identity, name, files, temporary_parent):
    """Map explicitly selected files to durable paths; never publish a runtime directory."""
    import tempfile
    with tempfile.TemporaryDirectory(prefix='publication-', dir=temporary_parent) as temporary:
        stage = Path(temporary)
        validate_owned_destination(authority_root, identity)
        manifest = {'campaign': json.loads((Path(authority_root)/'authority.json').read_text())['campaign'], 'files': []}
        for relative, source in sorted(files.items()):
            target = stage / relative_path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(checked_path(source), target)
            manifest['files'].append({'path': relative, 'size': target.stat().st_size, 'sha256': sha256(target)})
        return publish_authorities(stage, authority_root, manifest, identity, name)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--expected-freeze-sha256')
    parser.add_argument('--freeze-relative', default='freeze/freeze.json')
    args = parser.parse_args()
    validate_owned_destination(args.root, args.identity)
    campaign = json.loads((args.root/'authority.json').read_text())['campaign']
    count = 0
    for path in (args.root/'manifests').glob('*.json'):
        data = json.loads(path.read_text())
        if isinstance(data, dict) and data.get('campaign') == campaign and 'files' in data:
            verify_publication(args.root, args.identity, path.stem); count += 1
    if args.expected_freeze_sha256 and sha256(checked_path(args.root/relative_path(args.freeze_relative))) != args.expected_freeze_sha256:
        raise ValueError('AUTHORITY_FREEZE_SEAL_MISMATCH')
    if not count: raise ValueError('AUTHORITY_NO_PUBLISHED_MANIFESTS')
    print(json.dumps({'status': 'PASS', 'verifiedPublications': count, 'worktreeRequired': False}))
