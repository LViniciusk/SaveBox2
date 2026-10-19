import { classifyR12, confirmR12 } from './ap06-r12-contract.mjs';
try {
  let input='';
  for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input,'utf8')>4096)throw new Error();}
  const p=JSON.parse(input);
  const result=p.mode==='triage'?classifyR12(p.values):p.mode==='formal'?confirmR12(p.candidate,p.control,p.formal):(()=>{throw new Error();})();
  const output=JSON.stringify(result)+'\n';if(Buffer.byteLength(output,'utf8')>4096)throw new Error();
  process.stdout.write(output);
}catch{process.stderr.write('R12_CLASSIFIER_BRIDGE_FAILED\n');process.exitCode=1;}
