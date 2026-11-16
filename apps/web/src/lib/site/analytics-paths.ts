import { SIGNUP_CONFIRM_PATH } from '@shotx/shared';
import { AUTH_PATHS } from '../auth/handlers';

/**
 * Request header the proxy sets to the page's path (overwriting any copy a client sent), so the
 * root layout can tell which page it renders.
 */
export const PATHNAME_HEADER = 'x-snap-pathname';

/**
 * Pages opened from an emailed link with a token in the URL fragment: the password reset
 * (ADR 0025) and the Free sign-up confirmation (ADR 0026). Google Analytics (ADR 0017) is not
 * loaded there, so no third-party script runs while the token is in the address bar.
 */
export const NO_ANALYTICS_PATHS: readonly string[] = [
  AUTH_PATHS.resetPasswordPage,
  SIGNUP_CONFIRM_PATH,
];

/** Whether the page at `pathname` may load Google Analytics (unknown path: yes). */
export function analyticsAllowed(pathname: string | null): boolean {
  if (pathname === null) return true;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return !NO_ANALYTICS_PATHS.includes(path);
}
