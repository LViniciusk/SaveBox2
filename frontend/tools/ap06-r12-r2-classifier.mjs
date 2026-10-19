import {classify,confirm,effects} from './ap06-r12-r2-contract.mjs';
let input='';
try{
  for await(const part of process.stdin){input+=part;if(Buffer.byteLength(input)>4096)throw new Error();}
  const request=JSON.parse(input);
  if(request.mode==='triage')console.log(JSON.stringify({...classify(request.values),effects:effects(request.values)}));
  else if(request.mode==='formal')console.log(JSON.stringify(confirm(request.candidate,request.control,request.formal)));
  else throw new Error();
}catch{process.stderr.write('R12R2_CLASSIFIER_FAILED\n');process.exitCode=1;}
