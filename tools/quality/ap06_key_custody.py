"""DPAPI CurrentUser custody exclusively for AP-06-R10 synthetic campaign keys."""
import csv
import ctypes
from ctypes import wintypes
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

if __name__ == '__main__':
    sys.dont_write_bytecode = True  # An independent audit must not add cache files to immutable authorities.

from ap06_authorities import checked_path, private_permissions, sha256, validate_owned_destination, verify_publication


@lru_cache(maxsize=1)
def current_sid():
    if os.name != 'nt': raise ValueError('DPAPI_WINDOWS_REQUIRED_NO_FALLBACK')
    output = subprocess.check_output(['whoami','/user','/fo','csv','/nh'], text=True)
    sid = next(csv.reader(output.splitlines()))[-1]
    if not re.fullmatch(r'S-1-\d+(?:-\d+)+',sid): raise ValueError('CUSTODY_USER_ID_UNAVAILABLE')
    return sid


def custody_context(identity, manifest_sha256):
    if any(not re.fullmatch(r'[0-9a-f]{64}',value) for value in (identity,manifest_sha256)):
        raise ValueError('CUSTODY_INVALID_BINDING')
    return {'campaign':'AP-06-R10','schema':1,'scope':'CurrentUser','userSid':current_sid(),
            'identity':identity,'manifestSha256':manifest_sha256}


def dpapi(data, context, decrypt):
    if context.get('userSid') != current_sid(): raise ValueError('CUSTODY_USER_MISMATCH')
    if context != custody_context(context.get('identity',''),context.get('manifestSha256','')):
        raise ValueError('CUSTODY_CONTEXT_MISMATCH')
    if not isinstance(data,bytes) or not 0 < len(data) <= 65536: raise ValueError('CUSTODY_INVALID_PAYLOAD')
    class Blob(ctypes.Structure):
        _fields_ = [('cbData',wintypes.DWORD),('pbData',ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data,len(data))
    entropy_bytes = json.dumps(context,sort_keys=True,separators=(',',':')).encode()
    entropy_buffer = ctypes.create_string_buffer(entropy_bytes,len(entropy_bytes))
    input_blob = Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)))
    entropy = Blob(len(entropy_bytes),ctypes.cast(entropy_buffer,ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL('crypt32',use_last_error=True)
    local_free = ctypes.WinDLL('kernel32',use_last_error=True).LocalFree
    local_free.argtypes = [ctypes.c_void_p]; local_free.restype = ctypes.c_void_p
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob),ctypes.c_void_p if decrypt else wintypes.LPCWSTR,
        ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    try:
        # UI_FORBIDDEN only: omitting LOCAL_MACHINE binds protection to the current user.
        if not function(ctypes.byref(input_blob),None if decrypt else 'AP-06-R10 synthetic keys',
                        ctypes.byref(entropy),None,None,1,ctypes.byref(output)):
            raise ValueError('DPAPI_UNSEAL_FAILED' if decrypt else 'DPAPI_SEAL_FAILED')
        return ctypes.string_at(output.pbData,output.cbData)
    finally:
        ctypes.memset(buffer,0,len(data))
        if output.pbData:
            ctypes.memset(output.pbData,0,output.cbData); local_free(output.pbData)


def protect(data, context):
    return dpapi(data,context,False)


def unprotect(data, context):
    return dpapi(data,context,True)


def verify_runtime_key_custody(blob_path, context, receipt, manifest_sha, identity, campaign, expected=None):
    """Runtime account/backend credentials are separate from the three corpus FDKs."""
    try:
        blob_path=checked_path(Path(blob_path).absolute());private_permissions(blob_path.parent)
        if context.get('identity')!=identity:raise ValueError('R12R9_DPAPI_IDENTITY_MISMATCH')
        if context.get('manifestSha256')!=manifest_sha:raise ValueError('R12R9_DPAPI_MANIFEST_MISMATCH')
        if context!=custody_context(identity,manifest_sha):raise ValueError('R12R9_DPAPI_UNSEAL_FAILED')
        if (receipt.get('status')!='PASS' or receipt.get('campaign')!=campaign or receipt.get('identity')!=identity or
            receipt.get('manifestSha256')!=manifest_sha or receipt.get('scope')!='CurrentUser' or
            receipt.get('sourceCustodyCampaign')!='AP-06-R10' or receipt.get('plaintextPersisted') is not False or
            receipt.get('independentProcess') is not True or receipt.get('credentialGroups')!=3 or
            not blob_path.is_file() or blob_path.stat().st_size!=receipt.get('protectedBytes') or
            sha256(blob_path)!=receipt.get('protectedSha256')):
            raise ValueError('R12R9_DPAPI_CUSTODY_MISMATCH')
    except ValueError as error:
        if str(error).startswith('R12R9_'):raise
        raise ValueError('R12R9_DPAPI_CUSTODY_MISMATCH') from None
    except (OSError,KeyError,TypeError,AttributeError):
        raise ValueError('R12R9_DPAPI_CUSTODY_MISMATCH') from None
    try:
        payload=json.loads(unprotect(blob_path.read_bytes(),context))
        if (not isinstance(payload,dict) or set(payload)!=
            {'accounts.local.json','player-auth.local.json','backend-runtime.local.json'} or
            not isinstance(payload['accounts.local.json'],list) or not payload['accounts.local.json'] or
            not all(isinstance(payload[n],dict) for n in ('player-auth.local.json','backend-runtime.local.json')) or
            expected is not None and payload!=expected):
            raise ValueError('R12R9_DPAPI_UNSEAL_FAILED')
        del payload
    except (ValueError,OSError,TypeError):
        raise ValueError('R12R9_DPAPI_UNSEAL_FAILED') from None
    return {'status':'PASS','credentialGroups':3,'plaintextPersisted':False}


def seal_runtime_credentials(baseline, identity, manifest_sha, campaign, credentials):
    baseline=checked_path(Path(baseline).absolute());private_permissions(baseline)
    context=custody_context(identity,manifest_sha);blob=baseline/'runtime-credentials.dpapi'
    sealed=protect(json.dumps(credentials,sort_keys=True).encode(),context)
    receipt={'status':'PASS','campaign':campaign,'sourceCustodyCampaign':'AP-06-R10','scope':'CurrentUser',
        'identity':identity,'manifestSha256':manifest_sha,'protectedSha256':hashlib.sha256(sealed).hexdigest(),
        'protectedBytes':len(sealed),'independentProcess':True,'credentialGroups':3,'plaintextPersisted':False,
        'provenance':'fresh seal of this campaign owned runtime; not copied from a historical blob'}
    with blob.open('xb') as stream:stream.write(sealed)
    with (baseline/'runtime-credentials-custody.json').open('x',encoding='utf-8') as stream:json.dump(context,stream,indent=2)
    verify_runtime_key_custody(blob,context,receipt,manifest_sha,identity,campaign,credentials)
    result=subprocess.run([sys.executable,__file__,'--runtime-readback',str(baseline)],
        input=json.dumps(receipt).encode(),capture_output=True,check=True)
    if json.loads(result.stdout).get('status')!='PASS':raise ValueError('R12R9_DPAPI_UNSEAL_FAILED')
    with (baseline/'runtime-credentials-readback.json').open('x',encoding='utf-8') as stream:json.dump(receipt,stream,indent=2)
    return receipt


def seal_runtime_keys(runtime, identity, manifest):
    runtime = checked_path(runtime); private_permissions(runtime)
    context = custody_context(identity,sha256(checked_path(manifest)))
    payload = checked_path(runtime/'fdks.local.json').read_bytes()
    sealed = protect(payload,context)
    with (runtime/'fdks.dpapi').open('xb') as stream: stream.write(sealed)
    with (runtime/'custody.json').open('x',encoding='utf-8') as stream: json.dump(context,stream,indent=2)
    if unprotect(sealed,context) != payload: raise ValueError('CUSTODY_SEAL_READBACK_MISMATCH')
    return {'status':'PASS','scope':'CurrentUser','protectedSha256':sha256(runtime/'fdks.dpapi')}


def readback(root, identity, campaign='AP-06-R10'):
    root = validate_owned_destination(root,identity,campaign=campaign)
    verify_publication(root,identity,'corpus-publication'); verify_publication(root,identity,'custody')
    context = json.loads(checked_path(root/'keys/custody.json').read_text())
    if context['identity'] != identity or context['manifestSha256'] != sha256(root/'manifests/corpus.json'):
        raise ValueError('CUSTODY_MANIFEST_OR_IDENTITY_MISMATCH')
    payload = unprotect(checked_path(root/'keys/fdks.dpapi').read_bytes(),context)
    result = subprocess.run(['node',str(root/'tooling/ap06-r10-custody-check.mjs'),str(root)],
        input=payload,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    if result.returncode: raise ValueError('CUSTODY_INDEPENDENT_DECRYPT_FAILED')
    verified = json.loads(result.stdout)
    if verified.get('status') != 'PASS' or len(verified.get('fixtures',[])) != 3:
        raise ValueError('CUSTODY_INVALID_DECRYPT_RECEIPT')
    return {'status':'PASS','scope':'CurrentUser','independentProcess':True,'worktreeRequired':False,
            'protectedSha256':sha256(root/'keys/fdks.dpapi'),'fixtures':verified['fixtures']}


if __name__ == '__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path);parser.add_argument('--identity');parser.add_argument('--runtime-readback',type=Path)
    args=parser.parse_args()
    if args.runtime_readback:
        receipt=json.loads(sys.stdin.buffer.read(65537));baseline=args.runtime_readback
        context=json.loads((baseline/'runtime-credentials-custody.json').read_text())
        print(json.dumps(verify_runtime_key_custody(baseline/'runtime-credentials.dpapi',context,receipt,
            receipt['manifestSha256'],receipt['identity'],receipt['campaign'])))
    else:
        if not args.root or not args.identity:parser.error('--root and --identity required')
        print(json.dumps(readback(args.root,args.identity)))
