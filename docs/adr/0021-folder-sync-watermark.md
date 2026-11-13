# ADR 0021: Watermark on folder-synced photos

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

Photographers export from Lightroom into the synced folder. Their Lightroom watermark did not
reach Snap (the export preset or plugin did not burn it in, see ADR 0019's settle time), and the
owner wants Snap itself to add the watermark to photos pulled in by folder sync, with an image,
a position and a size the photographer sets and saves.

## Decision

- **Where.** In the photographer's browser, as a step of folder sync (ADR 0014) before each
  upload: no server CPU, no new API, nothing changes for manual uploads. The uploaded file
  (the original) carries the watermark, like a Lightroom export watermark would; derivatives
  are made from it as usual.
- **Settings** (sync page, "ลายน้ำ"): an image (PNG with transparency, JPEG or WebP, ≤ 5 MB), on
  or off, one of nine positions, size (5–60 % of the photo's shorter side, so portrait and
  landscape photos get the same mark), opacity (10–100 %) and margin (0–10 %), previewed on a
  landscape and a portrait frame, then saved. Stored in this browser's IndexedDB next to the
  sync job (`WatermarkSettings`); stopping or re-creating a sync keeps them. They apply to files
  queued after saving; uploaded photos don't change.
- **Composition** (`createWatermarker`): the mark is decoded once; each JPEG/PNG/WebP is drawn
  upright (`createImageBitmap(..., { imageOrientation: 'from-image' })`) on an OffscreenCanvas
  with the mark on top (`globalAlpha`), and encoded in its own type
  (`WEB_FOLDER_SYNC_WATERMARK_QUALITY`, default 0.92). JPEGs keep their EXIF segment
  (DateTimeOriginal orders share pages) with Orientation set to 1 and the IFD1 link cut, so the
  embedded thumbnail (an unwatermarked copy) is no longer referenced. Videos and other types
  are uploaded unchanged.
- **Failure.** If the step throws (undecodable file, the mark still loading), that version
  counts as a failed attempt and is retried like a failed upload; a photo is never sent without
  the watermark the photographer turned on.

## Consequences

- The original in Snap has the watermark; a clean original stays on the photographer's
  computer. A server-side watermark on derivatives only (clean originals in Snap) remains
  possible later as its own ADR.
- Settings are per browser, like the sync itself: another computer needs them set again.
- The re-encoded JPEG loses an ICC profile other than sRGB (Lightroom exports default to sRGB).
