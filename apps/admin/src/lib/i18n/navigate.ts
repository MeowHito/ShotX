/**
 * Reloads the page after the language cookie changed, so the server renders every message in the
 * new language. Tests mock this module.
 */
export function reloadPage(): void {
  window.location.reload();
}
