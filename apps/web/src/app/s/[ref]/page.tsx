/**
 * Old share links, `/s/{ref}` (ADR 0015). src/proxy.ts redirects them to `/{ref}`; only a share
 * whose slug the web app's own pages use (SHARE_SLUG_RESERVED) is still served here.
 */
export { default, generateMetadata } from '../../[ref]/page';
