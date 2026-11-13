# ADR 0024: The photographer studio's dark redesign, with numbers you can read at a glance

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

The owner sent a design ("Obsidian Kinetic", a Stitch export: dark navy canvas, raised slate
bento cards, electric indigo actions, cyan telemetry, Space Grotesk figures) and asked for the
photographer side of Snap to look like it: same features and details, easier to read, with charts.

## Decision

- **Scope.** The studio only (`/studio/*`, every page under the studio shell). Share pages, the
  landing page, sign-in and the admin app keep their look.
- **Theme.** The studio shell carries `studio-theme`; `:root:has(.studio-theme)` (globals.css)
  sets the shared tokens to the dark palette, so every component, dialog and menu (portalled to
  `<body>`) follows. The studio is always dark (the design is dark), whatever the OS setting.
  Contrast is noted next to the tokens (text 15:1, muted 7.4:1, primary 6.4:1 on the canvas).
- **Type.** Space Grotesk (next/font, self-hosted like the other fonts) as `font-display` for
  headings and figures; Thai falls back to Noto Sans Thai.
- **Shell.** Brand block (gradient aperture, "Snap · สตูดิโอ"), nav with a cyan active marker,
  storage card with an indigo→cyan bar, search field restyled.
- **Events page** (studio root):
  - Header with "อัปโหลดไฟล์" and "อีเวนต์ใหม่" (the same commands as "+ ใหม่").
  - Overview bento (`EventsOverview`): published events (live count, paused), share-page
    visitors, photos downloaded and photos uploaded for 7/30/90 days, each with its change
    against the period before and a small chart (one measure per chart, no dual axis; colours
    from the dataviz reference palette, validated on the card surface), hover values and a
    screen-reader table.
  - Filter bar: tabs by link status (all, published, paused, no link) with counts, a name filter
    and the grid/list toggle.
  - Event rows: cover, name, date, status, link chip with copy, QR, stats, edit, menu. QR and
    stats move into the menu on phones.
  - Inspector (`EventInspector`, ≥ 1280 px only, mounted only there): the chosen event's cover,
    link, a QR to scan from the screen, its visitors over the last 7 days
    (`GET /shares/:id/stats`) with visitors, downloads and scans, edit and manage-link. The
    stats button picks the event; on smaller screens it opens the link's page.
- **API.** `GET /drive/stats` (ADR 0023) adds `visitors` (`daily_stats.visitors`) to totals,
  period and days, and `previous` (the same number of days before `from`) for the change.
  Still rollups only, still the caller's own rows.

## Consequences

- One more font file in the studio (Latin only).
- `:has()` needs Safari 15.4+, Chrome 105+, Firefox 121+; older browsers show the studio in the
  default theme, still usable.
- Parts of the design without a feature behind them (workspaces, notifications, collaborators,
  quotas, CDN/TLS cards) are not built.
