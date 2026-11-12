/**
 * A full-page navigation. Used after the session cookies change (sign-in, password change, a
 * session that must change its password): the server renders the next page with the new cookies
 * and every client cache (GET /me included) starts fresh. Tests mock this module.
 */
export function navigateTo(href: string): void {
  window.location.assign(href);
}

/** Reloads the page (after the language cookie changed, so the server renders the new language). */
export function reloadPage(): void {
  window.location.reload();
}
