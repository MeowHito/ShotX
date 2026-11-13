# ADR 0017: Google Analytics on the web app

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

The owner wants Google Analytics for Snap, as a separate GA4 property next to another system of
theirs (measurement id `G-YK90K2DDPX`). Asked whether to show a cookie consent banner first, the
owner chose to load it without one, on the share pages and the studio, not the admin app.

## Decision

- `GA_MEASUREMENT_ID` in the web env (deploy/env/web.env; empty or unset: no analytics). A
  malformed id fails the page instead of silently tracking nothing.
- The root layout renders one inline script with the request's CSP nonce: it sets up `gtag`,
  configures the property and inserts gtag.js. The CSP adds Google's documented GA4 sources
  (`script-src` www.googletagmanager.com; `connect-src` and `img-src` *.google-analytics.com,
  *.analytics.google.com, *.googletagmanager.com) only while the id is set.
- Page views only, through GA4's enhanced measurement (history changes cover client-side
  navigation). No custom events; nothing about selfies, faces, file names or downloads is sent.
- The admin app has no analytics.

## Consequences

- GA sets first-party cookies (`_ga`, `_ga_*`) without asking. Under PDPA, analytics cookies
  normally need consent; this is the owner's decision and is recorded here. A banner with
  Google Consent Mode can be added later without changing the property.
- Share page URLs (event slugs) appear in GA reports. They are the event names, not personal data.
