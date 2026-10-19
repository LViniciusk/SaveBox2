const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number, fractionDigits = 1, zeroUnit = 'B'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${zeroUnit}`;

  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  return `${Number(value.toFixed(fractionDigits))} ${BYTE_UNITS[unitIndex]}`;
}
