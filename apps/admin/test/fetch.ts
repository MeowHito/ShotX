/** The URL of a fetch call's first argument, whatever form it takes. */
export function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

/** A fetch call's body when it is a string (JSON bodies), else ''. */
export function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}
