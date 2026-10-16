import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { groupProcessMetrics } from './browser-memory-probe.mjs';

const exec=promisify(execFile);
export async function sampleOwnedProcesses(browserCdp,execute=exec) {
  const {processInfo}=await browserCdp.send('SystemInfo.getProcessInfo');
  const {stdout}=await execute(process.env.WAVE1_PYTHON,
    [process.env.WAVE1_RUNNER,'--process-sample',processInfo.map(p=>p.id).join(',')],{windowsHide:true});
  return groupProcessMetrics(JSON.parse(stdout),processInfo);
}
