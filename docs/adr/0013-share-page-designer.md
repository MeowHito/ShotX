# ADR 0013: Share page designer ("ออกแบบหน้าแชร์")

- Status: Accepted (owner, 2026-11-12)
- Date: 2026-11-12
- Amends: ADR 0011 (share page layout), ADR 0012 (after-scan layout)

## Context

Event organisers want the face-search page in their own branding: a background, logos, a
title, a centred face-scan icon (the rounded-corner face glyph style), and two buttons, "take a
selfie" and "use a photo". The owner's references are branded landing cards (white card with a
logo, pastel glow, dark gala, tech blue, a bold poster). Photographers design these themselves,
Canva-style, in a new studio tab, and the people who open the link see that design.

Owner decisions (2026-11-12):

1. A photographer keeps several designs and picks one per share link when creating or editing
   it, or "no design" (the plain ADR 0011 layout). One design can be marked as the default: the
   share form preselects it for a new link. Amended after review (2026-11-12): the default is
   never applied at view time, so marking a default later doesn't rebrand existing links
   (including other clients' events).
2. In a `gallery` share the design is a full-screen card first; scrolling down shows every photo
   as before. In a `face_only` share the card is all there is until a scan.
3. After a scan the card is hidden and the found photos come first (as ADR 0012 does for the
   title and cover).

## Decision

### Data (contracts)

- `share_designs`: `id`, `owner_id`, `name` (1..80), `doc` jsonb (the design document below,
  validated by zod on every write), `revision` int (optimistic concurrency: a save sends the
  revision it started from; a stale one is `DESIGN_REVISION_CONFLICT`), `is_default` bool
  (partial unique index: at most one default per owner), `created_at`, `updated_at`. Hard delete;
  `shares.design_id` is set to null.
- `design_assets`: `id`, `owner_id`, `mime`, `size_bytes`, `width`, `height`,
  `status (uploading|processing|ready|failed)`, `created_at`. Images only (JPEG, PNG, WebP; PNG
  keeps transparency for logos). Keys from builders:
  `designs/{photographerId}/{assetId}/original` and `designs/{photographerId}/{assetId}/web.webp`
  (long edge ≤ `DESIGN_ASSET_LONG_EDGE`, default 2560, alpha kept, metadata stripped). Counted in
  `storage_usage` like originals.
- `shares.design_id` nullable, composite foreign key `(design_id, owner_id)` so a share can only
  use its owner's design.
- Limits (config): `DESIGN_MAX_PER_OWNER` 50, `DESIGN_MAX_ELEMENTS` 60, `DESIGN_DOC_MAX_BYTES`
  65536, `DESIGN_ASSET_MAX_BYTES` 15 MB, `DESIGN_ASSET_LONG_EDGE` 2560.

### The design document (`designDocSchema`, `version: 1`)

All coordinates are design units on a portrait artboard of 390 × 844 (a phone); the renderer
scales it. No URLs, HTML, CSS strings or font files in the document, only enums, numbers,
`#rrggbb`/`#rrggbbaa` colours, plain text and asset ids, so a document can't inject anything.

```
background: { type: 'color', color }
          | { type: 'gradient', angle 0..360, stops: [{ color, at 0..1 }] (2..5) }
          | { type: 'image', assetId, blur 0..40, dim 0..0.8, color (shown while loading) }
elements (bottom to top, ≤ DESIGN_MAX_ELEMENTS), each with
  id, x, y, w, h, rotation -180..180, opacity 0..1, locked, hidden, and one of:
  text:        text ≤ 500 chars, font (DESIGN_FONTS enum), size 8..200, weight 300..900,
               color, align left|center|right, lineHeight 0.8..3, letterSpacing -5..50,
               italic, uppercase, shadow { color, blur 0..40, x, y } | null
  image:       assetId, fit cover|contain, radius 0..200, flipX
  shape:       shape rect|ellipse|line, fill color|null, stroke color|null, strokeWidth 0..40,
               radius 0..200, glass 0..40 (backdrop blur: frosted card)
  faceIcon:    color, strokeWidth 1..12   (exactly one; can't be deleted)
  scanButtons: layout row|column, gap, height 36..80, radius 0..40, primary { bg, fg },
               secondary { bg, fg, border color|null }   (exactly one; can't be deleted)
  helpButton:  bg, fg, radius            (at most one: "วิธีการค้นหา", opens a how-to sheet)
```

Button and help labels are not in the document: they come from i18n (th/en/zh) so the viewer's
language applies. "ใช้ภาพใบหน้า" (choose a photo) shows only in `gallery` shares (ADR 0011
rule); in `face_only` the row has the camera button alone.

`DESIGN_FONTS` (self-hosted with next/font, OFL licensed, Thai-capable unless noted): Noto Sans
Thai, Kanit, Prompt, Sarabun, Mitr, Chakra Petch, IBM Plex Sans Thai, Bai Jamjuree, Noto Serif
Thai, and Latin display faces Playfair Display and Bebas Neue (Thai text falls back to Noto Sans
Thai).

Built-in templates (`DESIGN_TEMPLATES`, documents without assets, generic, no brands): "Clean
white card", "Pastel glow", "Night gala", "Tech blue glass", "Bold poster". A new design starts
from a template or blank.

### API

```
GET  /designs                      list own (id, name, isDefault, updatedAt, doc for previews)
POST /designs                      { name, templateId? | doc? }  → design
GET  /designs/:id                  own only
PUT  /designs/:id                  { name, doc, revision } → design (revision + 1)
DELETE /designs/:id
POST /designs/:id/default          make default (clears the previous one, one transaction)
POST /designs/assets               { fileName, mime, sizeBytes } → { assetId, uploadUrl, headers }
POST /designs/assets/:id/complete  → enqueues the worker job
GET  /designs/assets/:id           { status, width, height, url (signed CDN URL when ready) }
```

- Every route is photographer-only and owner-scoped (guard + `owner_id` in every query).
- A saved document may only reference the owner's assets; unknown or foreign asset ids are
  `DESIGN_ASSET_NOT_FOUND`. Assets still processing are allowed (the editor shows a spinner).
- Uploads are presigned single PUTs straight to R2 (file bytes never pass through the API).
- `POST /shares` and `PATCH /shares/:id` take `designId` (own design or null).
- Public `GET /s/:token` meta gains `design: { doc, assets: { [assetId]: { url, width, height } } } | null`:
  the share's own design, else null (today's layout). Asset URLs are signed
  CDN URLs like previews; only `ready` assets are included.

### Worker

A `design-asset` job on the media queue: HeadObject + magic-byte sniff (mismatch: delete,
`failed`), sharp → `web.webp` with alpha, EXIF orientation applied, all metadata stripped, width
and height stored, usage moved from reserved to used, `ready`. Idempotent. Purging a design never
deletes assets (they may be reused); a nightly job deletes assets no design references after 30
days (`DESIGN_ASSET_ORPHAN_DAYS`).

### Studio: the designer (new tab "ออกแบบหน้าแชร์", `/studio/designs`)

- List: live mini previews, create (template picker or blank), rename, duplicate, delete, set
  default.
- Editor (`/studio/designs/[id]`), Canva-like, desktop-first (works on tablets; phones get a
  read-only preview with a note):
  - left: Templates, Text (heading / body presets), Shapes (rectangle, ellipse, line, frosted
    card), Uploads (drag-and-drop or pick; logos and pictures), Background (colours, gradients,
    image with blur and dim), Layers (reorder by drag, lock, hide).
  - centre: the phone artboard with zoom; click to select, Shift-click to add to the selection,
    drag to move, 8 handles to resize (Shift keeps ratio), a rotate handle, smart guides that
    snap to the artboard's centre and edges and to other elements, double-click a text to edit
    it in place.
  - right: properties of the selection (position, size, rotation, opacity, colours with a
    picker and swatches from the design, font, size, weight, alignment, spacing, radius, glass,
    shadow, layer order, lock).
  - top: name, undo/redo, zoom, "Preview as viewer" (th/en/zh, gallery / face_only), save
    state. Autosave 1 s after the last change, with `revision`; a conflict offers reload.
  - Keyboard shortcuts (a "?" dialog lists them): ⌘/Ctrl+Z undo, ⇧⌘Z or Ctrl+Y redo, Delete /
    Backspace delete, ⌘D duplicate, ⌘C / ⌘V copy and paste, arrows nudge 1 (Shift 10), ⌘] / ⌘[
    forward / backward, ⌥⌘] / ⌥⌘[ to front / back, ⌘A select all, Esc deselect, T add text, R
    rectangle, E ellipse, L lock, ⌘S save now, ⌘= / ⌘- zoom, ⌘0 fit, Space+drag pan.
    Shortcuts are off while typing in a text field.
  - The face icon and the scan buttons can be moved, resized and restyled but not deleted; the
    editor shows the buttons with the photographer's UI language.
- Share form: a "หน้าแชร์" picker ("no design" or one of the designs, with a preview; the
  default is badged and preselected for a new link).

### Share page

One renderer (`DesignCanvas`, apps/web) draws a document for the editor and the share page so
both look the same: the background fills the viewport; the artboard is centred and scaled to
the viewport width (capped on desktop); elements are absolutely positioned in design units.
"ถ่ายภาพใบหน้า" opens the existing scan sheet (consent first, unchanged), "ใช้ภาพใบหน้า" opens it
straight on the gallery pick, "วิธีการค้นหา" opens a short how-to sheet. The face icon is our own
SVG in the rounded-corner face-glyph style (not Apple's asset). The top bar (home, language) stays
above the card.

## Consequences

- New tables and a migration, new routes, a worker job, a large studio feature. Built in the
  usual order: contracts, then api / worker / web in parallel, then the reviewer.
- PDPA unchanged: the consent screen still comes before any camera or upload, whatever the
  design says; design text can't replace it.
- Bandwidth: design images are served from the CDN at ≤ 2560 px WebP, once per visitor.
