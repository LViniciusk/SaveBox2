import { classifyStages, confirmFormal } from './ap06-r11-contract.mjs';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > 4096) throw new Error('INPUT_LIMIT');
  }
  const payload = JSON.parse(input);
  const result = payload.mode === 'formal'
    ? confirmFormal(payload.candidate, payload.control, payload.formal)
    : payload.mode === 'triage'
      ? classifyStages(payload.values)
      : (() => { throw new Error('INVALID_MODE'); })();
  const output = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(output, 'utf8') > 4096) throw new Error('OUTPUT_LIMIT');
  process.stdout.write(output);
}

main().catch(() => {
  process.stderr.write('R11_CLASSIFIER_BRIDGE_FAILED\n');
  process.exitCode = 1;
});
