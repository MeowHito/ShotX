import { useLocale } from 'next-intl';
import { intlLocale } from '../../i18n/config';
import { formatBytes, formatSatang } from '../format';

/** formatBytes in the UI language's number format (Intl), e.g. `1.5 GB` / `1,5 GB`. */
export function useFormatBytes(): (bytes: number) => string {
  const locale = intlLocale(useLocale());
  return (bytes) => formatBytes(bytes, locale);
}

/** formatSatang (THB) in the UI language's currency format. */
export function useFormatSatang(): (satang: number) => string {
  const locale = intlLocale(useLocale());
  return (satang) => formatSatang(satang, locale);
}
