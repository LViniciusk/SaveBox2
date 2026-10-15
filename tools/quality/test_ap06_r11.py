import copy
import unittest
from run_ap06_r11 import check_budget, validate_memory, reserve_development
from run_ap06_r9 import verify_freeze
from ap06_authorities import sha256
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
import json
import tempfile


class R11Tests(unittest.TestCase):
    def test_budget(self):
        for previous in range(10): check_budget({'approved':True,'measurementMaximum':10,'measurementRetries':0},previous,1)
        for previous in (-1,10,True):
            with self.assertRaises(ValueError): check_budget({'approved':True,'measurementMaximum':10,'measurementRetries':0},previous,1)

    def test_memory_identity_signed_delta_and_totals(self):
        sample={'processMemory':{'status':'AVAILABLE','privateBytes':40,'byCategory':{k:{'privateBytes':10} for k in ('browser','renderer','gpu-process','utility')},
            'processes':[{'pid':i+1,'type':k,'privateBytes':10} for i,k in enumerate(('browser','renderer','GPU','Service'))]}}
        validate_memory(sample,sample)
        for change in ('duplicate','missing','nan','total','type'):
            bad=copy.deepcopy(sample)
            p=bad['processMemory']
            if change=='duplicate': p['processes'][0]['pid']=2
            if change=='missing': p['processes'].pop()
            if change=='nan': p['processes'][0]['privateBytes']=float('nan')
            if change=='total': p['privateBytes']=41
            if change=='type': p['processes'][0]['type']='renderer'
            with self.assertRaises(ValueError):validate_memory(bad,sample)

    def test_development_has_no_retry(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'reservation.json'
            reserve_development(path,'a'*40)
            with self.assertRaises(FileExistsError):reserve_development(path,'a'*40)

    def test_authority_head_hash_manifest_and_ownership_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'out';(out/'baseline').mkdir(parents=True)
            (out/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(root/'authority'),'identity':'unit'}))
            source=root/'code.py';source.write_text('before')
            freeze={'files':{'code.py':sha256(source)},'publicationHashes':{},'implementationHead':'head'}
            wave=SimpleNamespace(root=root,output=out,git=lambda *args:'head')
            with patch('run_ap06_r9.verify_publication') as publication:
                verify_freeze(wave,freeze)
                source.write_text('changed')
                with self.assertRaisesRegex(RuntimeError,'FROZEN_FILE_CHANGED'):verify_freeze(wave,freeze)
                source.write_text('before');wave.git=lambda *args:'other'
                with self.assertRaisesRegex(RuntimeError,'HEAD_CHANGED'):verify_freeze(wave,freeze)
                wave.git=lambda *args:'head'
                for failure in (ValueError('AUTHORITY_OWNERSHIP_MISMATCH'),FileNotFoundError('manifest')):
                    publication.side_effect=failure
                    with self.assertRaisesRegex(RuntimeError,'READBACK_FAILED'):verify_freeze(wave,freeze)


if __name__=='__main__':unittest.main()
