import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('formats binary units', () => {
    expect([
      formatBytes(0),
      formatBytes(1),
      formatBytes(1024),
      formatBytes(1024 ** 2),
      formatBytes(1024 ** 3),
      formatBytes(1024 ** 4),
      formatBytes(1024 ** 5),
    ]).toEqual(['0 B', '1 B', '1 KB', '1 MB', '1 GB', '1 TB', '1 PB']);
  });

  it('caps values above petabytes at the PB unit', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024 PB');
  });

  it('preserves the requested precision', () => {
    expect(formatBytes(1536, 0)).toBe('2 KB');
    expect(formatBytes(1536, 1)).toBe('1.5 KB');
    expect(formatBytes(1536, 2)).toBe('1.5 KB');
  });

  it('handles invalid and negative values safely', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });
});
