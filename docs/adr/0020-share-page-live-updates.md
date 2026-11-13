# ADR 0020: Share pages show new photos without a reload

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

During an event the photographer keeps uploading (folder sync from Lightroom), but a viewer on
the share page saw new photos only after reloading. The owner wants the newest photos to appear
by themselves, with nothing spinning or announcing a refresh.

Polling `GET /s/:token/items` would re-sign every URL and write one `view` activity event per
call: with hundreds of viewers polling every few seconds that floods `activity_events`.

## Decision

- New public route `GET /s/:token/changes` → `{ version }`: an opaque hash of the share's mode,
  design and its ready, live files in scope (count and newest id). Same gates as items (token,
  availability, login, password); no activity event; no per-viewer data. The api reuses each
  share's answer for `SHARE_CHANGES_CACHE_SECONDS` (default 5), so one event's viewers cost one
  count query per 5 s.
- The share page asks it every `WEB_SHARE_LIVE_POLL_MS` (default 15 s; 0 turns it off) while the
  tab is visible. When the version moves, it refetches meta and items in the background
  (TanStack Query keeps the current photos on screen meanwhile). Items are newest first
  (ADR 0018), so new photos appear at the top. No spinner, notice or scroll jump.
- Signed view URLs are bucketed (`SIGNED_URL_EXPIRY_BUCKET_SECONDS`), so a refetch keeps the
  same URLs for photos already on screen and the browser doesn't reload them.

## Consequences

- A refetch after a change re-reads every page the viewer has loaded (one `view` event per page),
  only when something changed.
- A design switched to "scan only" (ADR 0019) or a paused link reaches open pages within one poll.
