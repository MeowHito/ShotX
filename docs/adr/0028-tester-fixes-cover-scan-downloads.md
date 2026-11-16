# ADR 0028: Event cover upload (2:3), "use a photo" on scan-only pages, 1.5 MB downloads and share page fixes

- Status: Accepted (owner, 2026-11-16)
- Date: 2026-11-16
- Builds on: ADR 0011 (event gallery, cover), ADR 0013 (designs, design images), ADR 0016
  (event editor), ADR 0019 (design on a live link, "show photos" switch)

## Context

The owner sent six findings from testing (2026-11-16):

1. The event editor has no field for the event cover; it should be possible to upload or change it,
   in a 2:3 ratio as originally specified.
2. With the design's photos hidden (a scan-only page), "use a photo" disappears and only the camera
   button stays; viewers must be able to search with a photo too. (The button's final style is
   still to be confirmed.)
3. The house icon and "Snap" at the top left of a share page must not lead to the home page.
4. The design marked "แบบหลัก" should be the default choice, and "จัดการดีไซน์" should be a
   visible button.
5. Every image a viewer downloads should be at most 1.5 MB, resized automatically.
6. A scan-only designed page leaves a large blank strip at the bottom, on phones and desktops.

Production on 2026-11-16: 4,651 ready images, web.jpg 196 kB on average and one over 1.5 MB; two
live shares serve originals, 555 originals are over 1.5 MB (the largest about 10 MB).

## Decision

### 1. Uploaded event cover, 2:3

- `folders.cover_asset_id` (migration 0018, nullable): a design image (`design_assets`, ADR 0013)
  uploaded as the event's cover. Same-owner foreign key `(cover_asset_id, owner_id)`, ON DELETE SET
  NULL of `cover_asset_id` only. The design image orphan purge counts it as a reference (any folder
  row, trashed ones too).
- `PATCH /drive/folders/:id` accepts `coverAssetId`: the caller's live design image (uploading or
  processing allowed; it shows once `ready`), else `DESIGN_ASSET_NOT_FOUND`, locked FOR KEY SHARE
  like a design save. Setting one cover (`coverAssetId` or `coverFileId`) clears the other; `null`
  for either clears both. Both ids in one body is `VALIDATION_FAILED`. `DriveFolder` gains
  `coverAssetId`.
- The uploaded cover wins everywhere a cover is read: the event listing's `coverThumbUrl` (its
  web.webp) and the share link's OG cover, in any mode (a poster is not a photo of people).
- The event editor gets "ภาพปกกิจกรรม": a 2:3 preview, "อัปโหลดภาพปก" (the browser crops the
  middle 2:3, at most 1800 px tall, JPEG, then uploads it through `POST /designs/assets`),
  "เลือกจากรูปในอีเวนต์" (the old picker, shown as 2:3 crops) and "ใช้รูปแรกอัตโนมัติ". Each change
  saves at once. Studio cards keep their frames (the cover is cropped to them).

### 2. "Use a photo" in every mode

ADR 0011 allowed choosing a photo from the device only in `gallery` shares. The owner now wants it
on scan-only pages too: the designed card shows both buttons in every mode, the how-to sheet lists
the step, and the scan sheet offers the gallery picker for `face_only` shares. The api never
restricted it. The trade-off is accepted: someone holding another person's photo can find that
person's photos on a scan-only link, as on a gallery link.

### 3. No home link on share pages

The share pages' top bar shows "Snap" as plain text, with no house icon and no link.

### 4. The default design

- The owner's first design becomes the default when they have none (`POST /designs`, under the
  per-owner lock), so new links start on it.
- The picker lists the default design first, before "ไม่ใช้ดีไซน์", and "จัดการดีไซน์" is an
  outline button with an icon.

### 5. Viewer downloads at most 1.5 MB

- `MEDIA_WEB_MAX_BYTES` (default 1,500,000; 0 = no cap) and `MEDIA_WEB_MIN_JPEG_QUALITY` (default
  70). The worker writes web.jpg at `MEDIA_WEB_JPEG_QUALITY`, then lowers the quality in steps of
  5 to the minimum, then shrinks the long edge by 15% per step (not below 640 px) until it fits.
- Share downloads: an image whose original is over the cap is served as web.jpg even when the share
  allows originals (`shareDownloadObject`); originals at or under the cap, videos, and the owner's
  own downloads are unchanged.
- Existing web.jpg over the cap: `media.sweep` sends a new media message `web.rerender` (job
  `media.web-rerender`) for ready, live images whose `web_size_bytes` is over the cap. The worker
  re-checks the row, renders web.jpg from the original under the cap, overwrites the same key and
  updates `web_size_bytes`. No outbox mark: a row is re-sent until it is under the cap.

### 6. No blank strip under a scan-only card

While a scan-only designed card is the whole page (no results yet, nothing selected), the page keeps
no bottom room for the sticky scan button or the download bar.

## Consequences

- Migration 0018 must run before the new api (additive).
- Downloads from "original" shares now mix originals and web.jpg; the file name extension follows
  what is served.
- Photographers who relied on the share page's home link lose it; the studio is reached from its
  own address.
