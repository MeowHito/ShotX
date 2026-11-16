/** The VAT rate as the copy shows it: basis points to percent (700 → `7`, 750 → `7.5`). */
export function vatPercent(basisPoints: number): string {
  return String(basisPoints / 100);
}
