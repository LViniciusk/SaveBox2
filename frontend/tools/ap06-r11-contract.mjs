export const R11_CONDITIONS = Object.freeze({
  'r11.0': { range: 'xhr', terminal: 'mse' },
  'r11.1': { range: 'fetch', terminal: 'mse' },
  'r11.2': { range: 'fetch', terminal: 'arraybuffer' },
  'r11.3': { range: 'fetch', terminal: 'workers' },
});

export function selectR11(value, r10, r9) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !Object.hasOwn(R11_CONDITIONS, value)) throw new Error('R11_INVALID_CONDITION');
  if (r10 !== undefined || r9 !== undefined) throw new Error('R11_CONFLICTING_SELECTORS');
  return value;
}

export function classifyStages(values) {
  if (Object.keys(values).sort().join() !== Object.keys(R11_CONDITIONS).sort().join() ||
      Object.values(values).some(v => !Number.isFinite(v))) throw new Error('R11_INVALID_DELTAS');
  const control = values['r11.1'];
  if (control < 300) return { status: 'R11_CONTROL_NOT_REPRODUCED' };
  const low = v => v >= 0 && v < .3 * control;
  const high = v => v >= .7 * control;
  if (high(values['r11.2']) && high(values['r11.3']))
    return { status: 'R11_CANDIDATE', hypothesis: 'H1', pair: ['r11.0','r11.2'] };
  if (low(values['r11.2']) && high(values['r11.3']))
    return { status: 'R11_CANDIDATE', hypothesis: 'H2', pair: ['r11.2','r11.3'] };
  if (low(values['r11.2']) && low(values['r11.3']))
    return { status: 'R11_CANDIDATE', hypothesis: 'H3', pair: ['r11.3','r11.1'] };
  return { status: 'R11_INCONCLUSIVE' };
}

export function confirmFormal(candidate, control, results) {
  if (candidate.status !== 'R11_CANDIDATE' || !Number.isFinite(control) || control < 300 || results.length !== 6)
    return { status: 'R11_INCONCLUSIVE' };
  const [a,b] = candidate.pair, order = [a,b,b,a,a,b];
  if (results.some((r,i) => r.condition !== order[i] || !Number.isFinite(r.rendererPrivateDeltaMiB) ||
      (r.condition === a ? r.rendererPrivateDeltaMiB < 0 || r.rendererPrivateDeltaMiB >= .3*control : r.rendererPrivateDeltaMiB < .7*control)))
    return { status: 'R11_INCONCLUSIVE', reason: 'FORMAL_DISAGREEMENT' };
  return { status: 'R11_ATTRIBUTION_CONFIRMED', hypothesis: candidate.hypothesis, pair: candidate.pair };
}
