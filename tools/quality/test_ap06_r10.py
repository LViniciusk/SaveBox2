import copy
import os
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

import ap06_authorities as authorities
from ap06_key_custody import protect, unprotect, custody_context
from run_ap06_r10 import decide, check_r10_budget, FORMAL_ORDER, REPRODUCES, DOES_NOT


class R10Decisions(unittest.TestCase):
    def test_budget_and_frozen_alternating_order(self):
        self.assertEqual(FORMAL_ORDER,('r10.0','r10.1','r10.1','r10.0','r10.0','r10.1'))
        check_r10_budget(8)
        for value in [9,-1,True,1.5]:
            with self.assertRaises(ValueError):check_r10_budget(value)

    def test_each_scientific_branch_and_complete_formals(self):
        triage={'r10.0':REPRODUCES,'r10.1':DOES_NOT,'r10.2':DOES_NOT}
        formal={'r10.0':[REPRODUCES]*3,'r10.1':[DOES_NOT]*3}
        self.assertEqual(decide(triage,formal)['status'],'PASS_AP06_R10_RANGE_FETCH_EFFECT_CONFIRMED')
        triage['r10.1']=REPRODUCES;formal['r10.1']=[REPRODUCES]*3
        self.assertEqual(decide(triage,formal)['status'],'PASS_AP06_R10_RANGE_FETCH_NO_OWNERSHIP_SHIFT')
        self.assertEqual(decide(triage,formal)['reference'],'GLOBAL_PROVIDER_EFFECT_SUSPECTED')
        for values in [[REPRODUCES]*2,[REPRODUCES,DOES_NOT,REPRODUCES],['INCONCLUSIVE']*3]:
            formal['r10.1']=values
            self.assertEqual(decide(triage,formal)['status'],'BLOCKED_AP06_R10_FORMAL_DISAGREEMENT')
        self.assertEqual(decide({'r10.0':DOES_NOT},{})['status'],'BLOCKED_AP06_R10_CONTROL_NOT_REPRODUCED')
        self.assertEqual(decide({}, {})['status'],'BLOCKED_AP06_R10_INVALID_MEASUREMENT')

    def test_r10_authority_identity_cannot_adopt_or_mutate_r9(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'authority';identity=secrets.token_hex(32)
            authorities.initialize(root,identity,campaign='AP-06-R10')
            authorities.validate_owned_destination(root,identity,campaign='AP-06-R10')
            with self.assertRaises(ValueError):authorities.validate_owned_destination(root,identity,campaign='AP-06-R9-R2')


@unittest.skipUnless(os.name=='nt','DPAPI CurrentUser is Windows-only; runtime preflight refuses fallback')
class R10Custody(unittest.TestCase):
    def test_real_current_user_seal_unseal_and_context_binding(self):
        context=custody_context('a'*64,'b'*64)
        payload=secrets.token_bytes(32)
        sealed=protect(payload,context)
        self.assertNotIn(payload,sealed)
        self.assertEqual(unprotect(sealed,context),payload)
        for broken in [sealed[:-1],sealed[:20]+b'corrupt'+sealed[27:]]:
            with self.assertRaises(ValueError):unprotect(broken,context)
        with self.assertRaises(ValueError):unprotect(sealed,custody_context('c'*64,'b'*64))
        invalid=copy.deepcopy(context);invalid['userSid']='S-1-0-0'
        with self.assertRaisesRegex(ValueError,'USER_MISMATCH'):unprotect(sealed,invalid)


if __name__=='__main__':unittest.main()
