"""DPAPI CurrentUser custody exclusively for AP-06-R10 synthetic campaign keys."""
import csv
import ctypes
from ctypes import wintypes
from functools import lru_cache
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


def seal_runtime_keys(runtime, identity, manifest):
    runtime = checked_path(runtime); private_permissions(runtime)
    context = custody_context(identity,sha256(checked_path(manifest)))
    payload = checked_path(runtime/'fdks.local.json').read_bytes()
    sealed = protect(payload,context)
    with (runtime/'fdks.dpapi').open('xb') as stream: stream.write(sealed)
    with (runtime/'custody.json').open('x',encoding='utf-8') as stream: json.dump(context,stream,indent=2)
    if unprotect(sealed,context) != payload: raise ValueError('CUSTODY_SEAL_READBACK_MISMATCH')
    return {'status':'PASS','scope':'CurrentUser','protectedSha256':sha256(runtime/'fdks.dpapi')}


def readback(root, identity):
    root = validate_owned_destination(root,identity,campaign='AP-06-R10')
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
    parser.add_argument('--root',type=Path,required=True);parser.add_argument('--identity',required=True)
    args=parser.parse_args()
    print(json.dumps(readback(args.root,args.identity)))
