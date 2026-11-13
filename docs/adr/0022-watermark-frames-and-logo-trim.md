# ADR 0022: Frame watermarks, logo trim, and the phone lightbox download button

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13
- Amends: ADR 0021 (folder sync watermark), ADR 0016 (lightbox download in the top bar)

## Context

After ADR 0021 shipped, the owner reported three things:

1. The logo looked right in the sync page preview but small on the real photos.
2. Photographers also use frames (a border artwork over the whole photo), designed once for
   landscape and once for portrait photos, and want the sync to pick the right one per photo.
3. On phones, the lightbox download button should sit at the bottom centre, not in the top bar.

On (1): the placement maths is the same in the preview and in the sync (`watermarkBox`), so the
difference is in what is drawn. Logos exported from design tools usually sit on a canvas with a
wide transparent border; the box the size slider sets is then mostly empty, and the visible
logo is a fraction of it. In the 240 px preview that was hard to see. The size range (max 60 %
of the shorter side) was also smaller than a Lightroom watermark can be.

## Decision

- **Logo trim.** The logo is trimmed to its visible pixels (alpha > 8) before it is placed, in
  the sync (`trimmedMark`) and in the preview, so the size set is the size of the visible logo.
  Saved logos get bigger where they had a transparent border; that is the intent.
- **Size range** 5–100 % of the photo's shorter side (was 5–60 %). Bigger previews (300×200 and
  150×225).
- **Mode** (`WatermarkSettings.mode`): `logo` (ADR 0021) or `frame`. Settings saved before this
  ADR read as `logo` (`normalizeWatermark`).
- **Frames.** Two optional images, `frameLandscape` and `framePortrait` (PNG/JPEG/WebP, ≤ 15 MB
  each). Each photo gets the frame for its own orientation (width ≥ height is landscape, so
  squares take the landscape frame), stretched over the whole photo at full opacity (a frame is
  drawn as designed). A photo whose orientation has no frame is uploaded unchanged; the page
  says so. Position, size, opacity and margin apply to the logo only.
- **Phones (< 768 px)**: the lightbox download button is `position: fixed` at the bottom centre
  (above the safe-area inset). Wider screens keep it in the top bar (ADR 0016).

## Consequences

- A frame made in a different aspect ratio than the photo is stretched; photographers make
  frames in their camera's ratio (3:2 / 2:3), which the page says.
- Everything else of ADR 0021 holds: browser-side, per browser, applies to photos queued after
  saving, the uploaded original carries the mark, videos unchanged.
