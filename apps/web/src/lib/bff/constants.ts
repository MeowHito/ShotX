/** Path prefix of the BFF route handler (`/bff/<API route path>`). CloudFront sends it to web. */
export const BFF_PREFIX = '/bff';

/**
 * The client address CloudFront adds to origin requests (`ip:port`). The API reads it for rate
 * limits and consent `ip_hash`; server-side calls from web (BFF, SSR) forward the one web
 * received, so the API sees the viewer instead of the web task. Never derived from a header the
 * browser controls: CloudFront overwrites it, and the ALB only accepts CloudFront (infra).
 */
export const VIEWER_ADDRESS_HEADER = 'cloudfront-viewer-address';

/** `ip:port` (IPv4 or IPv6 with port), as CloudFront formats it. Anything else isn't forwarded. */
const VIEWER_ADDRESS = /^[0-9A-Fa-f.:]{3,64}$/;

/** The `CloudFront-Viewer-Address` header to pass on, or nothing when absent or malformed. */
export function viewerAddressHeader(value: string | null | undefined): Record<string, string> {
  return value != null && VIEWER_ADDRESS.test(value) ? { [VIEWER_ADDRESS_HEADER]: value } : {};
}
