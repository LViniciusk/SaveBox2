import {runHttpPreflight} from './ap06-r12-preflight.mjs';
import {CONDITIONS} from './ap06-r12-r2-contract.mjs';
import {configure,initialize,pageScript,validateFunctional} from './ap06-r12-r2-probe.mjs';
await runHttpPreflight({conditions:Object.keys(CONDITIONS),cancellationCondition:'r12r2.3',
  configure,initialize,pageScript,validateFunctional,counterName:'r12r2'});
