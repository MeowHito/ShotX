const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Bytes as a short size with 1024-based units, e.g. `1.5 GB`. */
export function formatBytes(bytes: number, locale = 'th-TH'): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  return `${number} ${UNITS[unit]}`;
}

/** Integer satang as Thai baht (THB currency format, satang only when not whole). */
export function formatSatang(satang: number, locale = 'th-TH'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: satang % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(satang / 100);
}
