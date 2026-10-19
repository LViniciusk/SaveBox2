import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKPOINTS, NativeTrace } from '../../frontend/tools/ap06-native-trace.mjs';
import { AUTOPLAY_ARGS, launchWithIdentityLease } from '../../frontend/tools/ap06-browser-identity.mjs';

async function attestedBrowser(cdp) {
  const version = '151.0.7922.34';
  const browser = { newBrowserCDPSession: async () => cdp, version: () => version };
  const old = process.env.AP06_R5_PROCESS_HANDLE_AUDIT;
  delete process.env.AP06_R5_PROCESS_HANDLE_AUDIT;
  try {
    await launchWithIdentityLease(
      { launch: async () => browser },
      { args: [...AUTOPLAY_ARGS, '--memlog=all', '--memlog-stack-mode=native', '--memlog-sampling-rate=16384', '--memlog-keep-small-allocations'] },
      { browserLaunches: 0, browserIdentity: {} },
      { chromiumVersion: version },
      { request: async () => ({ status: 'PASS', browserPid: 42, processCreationTime: '100' }) },
      () => {}
    );
  } finally {
    if (old === undefined) delete process.env.AP06_R5_PROCESS_HANDLE_AUDIT;
    else process.env.AP06_R5_PROCESS_HANDLE_AUDIT = old;
  }
  return browser;
}

export async function produceSyntheticNativeTrace(tracePath, receiptPath, scenario = 'valid') {
  await mkdir(dirname(tracePath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tracePath);
  } catch {}

  const rendererPid = 42;
  const guids = scenario === 'duplicate-guids'
    ? ['0x01', '0x01', '0x03', '0x04']
    : ['0x01', '0x02', '0x03', '0x04'];

  const rows = [];
  if (scenario !== 'divergent-filetime') {
    rows.push({ ph: 'M', pid: rendererPid, name: 'process_name', args: { name: 'Renderer' } });
  }

  const phases = ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'];
  for (let i = 0; i < 4; i++) {
    const guidVal = guids[i];
    const targetPid = (scenario === 'other-process-heaps') ? 999 : rendererPid;
    const includeHeaps = (scenario === 'missing-dump-4' && i === 3) ? false : true;

    const maps = { strings: [{ id: 0, string: 'SyntheticSymbol' }], nodes: [{ id: 1, name_sid: 0 }], types: [] };
    const dumps = {
      level_of_detail: 'detailed',
      allocators: {
        malloc: { attrs: { size: { type: 'scalar', units: 'bytes', value: (200 + i).toString(16) } } }
      }
    };
    if (includeHeaps) {
      dumps.heaps_v2 = {
        version: 1,
        maps,
        allocators: {
          malloc: { sizes: [100 + i], counts: [1], types: [0], nodes: [1] }
        }
      };
    }

    rows.push({
      ph: 'v', pid: targetPid, ts: (i + 1) * 1000, id: guidVal, name: 'explicitly_triggered',
      cat: ['disabled-by-default-memory-infra'],
      args: { dumps }
    });

    rows.push({
      ph: 'b', pid: 99, ts: (i + 1) * 1000 - 10, id2: { local: guidVal }, name: 'GlobalMemoryDump',
      cat: ['disabled-by-default-memory-infra'],
      args: { dump_guid: guidVal, dump_type: 'explicitly_triggered', level_of_detail: 'detailed', success: true }
    });

    rows.push({
      ph: 'e', pid: 99, ts: (i + 1) * 1000 + 10, id2: { local: guidVal }, name: 'GlobalMemoryDump',
      cat: ['disabled-by-default-memory-infra']
    });
  }

  const jsonContent = JSON.stringify({ traceEvents: rows });

  let dumpIndex = 0;
  const cdp = new EventEmitter();
  cdp.send = async (method, params) => {
    if (method === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: 42 }] };
    if (method === 'Browser.getVersion') return { product: 'HeadlessShell/151.0.7922.34' };
    if (method === 'Tracing.getCategories') return { categories: ['disabled-by-default-memory-infra'] };
    if (method === 'Tracing.start') return {};
    if (method === 'Tracing.requestMemoryDump') {
      if (scenario === 'timeout-checkpoint-3' && dumpIndex === 2) {
        throw new Error('NATIVE_CDP_TIMEOUT');
      }
      return { dumpGuid: guids[dumpIndex++], success: true };
    }
    if (method === 'Tracing.end') {
      queueMicrotask(() => cdp.emit('Tracing.tracingComplete', { dataLossOccurred: false, traceFormat: 'json', stream: 'stream-1' }));
      return {};
    }
    if (method === 'IO.read') {
      if (scenario === 'stream-interrupted') {
        throw new Error('CDP_READ_CONNECTION_RESET');
      }
      if (scenario === 'trace-size-limit') {
        return { data: 'X'.repeat(3 * 1024 * 1024), eof: false };
      }
      return { data: jsonContent, eof: true };
    }
    if (method === 'IO.close') return {};
    return {};
  };
  cdp.detach = async () => {};

  const browser = await attestedBrowser(cdp);
  const trace = new NativeTrace(tracePath);
  await trace.start(browser);

  const processes = { processes: [{ type: 'renderer', pid: rendererPid, privateBytes: 1024 }], privateBytes: 2048 };
  for (const phase of phases) {
    await trace.dump(phase, processes);
  }

  const receipt = await trace.stop();

  // Add identity and exit audits for complete receipt contract
  receipt.browserIdentity = { before: { nativeFlagsValidated: true } };
  receipt.processExitAudit = {
    status: scenario === 'divergent-filetime' ? 'FAILED' : 'PASS',
    method: 'retained-win32-process-handles',
    reusedPidCount: 0,
    timedOutProcessCount: 0,
    waitFailedProcessCount: 0,
    processes: [{
      pid: rendererPid,
      roles: ['renderer'],
      creationTimeExact: scenario === 'divergent-filetime' ? '999999' : '100'
    }]
  };
  receipt.rendererIdentityProof = {
    status: 'PASS',
    preRegistered: true,
    campaign: 'AP-06-R12-R16-native',
    rendererPid,
    roles: ['renderer'],
    attestationMethod: 'retained-win32-process-handles',
    linkedToProfiledProcess: true,
    processIdentityCount: 1,
    checkpointPhases: phases,
    creationTimeExact: '100'
  };
  receipt.processSamples = phases.map(phase => ({
    phase,
    processes: [{ type: 'renderer', pid: rendererPid }]
  }));
  receipt.handleRelease = {
    status: 'PASS',
    processHandles: { closeFailures: 0, releasedProcessHandles: 1 }
  };

  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  return { tracePath, receiptPath, receipt };
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [,, tracePath, receiptPath, scenario] = process.argv;
  if (!tracePath || !receiptPath) {
    console.error('Usage: node produce_synthetic_native_trace.mjs <tracePath> <receiptPath> [scenario]');
    process.exit(1);
  }
  produceSyntheticNativeTrace(tracePath, receiptPath, scenario || 'valid')
    .then(res => {
      console.log(JSON.stringify({ status: 'PRODUCED', scenario: scenario || 'valid', traceBytes: res.receipt?.trace?.bytes }));
      process.exit(0);
    })
    .catch(err => {
      console.error(JSON.stringify({ status: 'ERROR', message: err.message }));
      process.exit(2);
    });
}
