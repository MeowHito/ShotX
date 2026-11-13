/**
 * Google Analytics 4 (ADR 0017) on every web page: one inline script with the request's CSP
 * nonce sets up gtag and inserts gtag.js ('strict-dynamic' trusts what a nonced script inserts;
 * a plain `<script async src>` would be hoisted by React as a resource). Page views only: GA4's
 * enhanced measurement records client-side navigations from the browser history, so nothing else
 * is sent (no selfies, face data or file names).
 */
export function gtagSnippet(id: string): string {
  const quoted = JSON.stringify(id);
  return [
    'window.dataLayer = window.dataLayer || [];',
    'function gtag(){dataLayer.push(arguments);}',
    "gtag('js', new Date());",
    `gtag('config', ${quoted});`,
    "var s = document.createElement('script');",
    's.async = true;',
    `s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(${quoted});`,
    'document.head.appendChild(s);',
  ].join('\n');
}

export function GoogleAnalytics({ id, nonce }: { id: string; nonce: string | undefined }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: gtagSnippet(id) }} />;
}
