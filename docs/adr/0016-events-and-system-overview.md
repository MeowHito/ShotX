# ADR 0016: Folders are events; unpublish without losing the link; admin system overview

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

Owner requests (2026-11-13):

1. The studio calls a folder an **Event** (every folder, at every level). Each event shows its
   created date, whether its link is published, unpublished or not created yet, a QR code of the
   link that can be saved, an edit action, and a ⋮ menu for the rest. The list view follows a
   reference table (name and link, date, status, QR, manage); the grid view gets a card design.
2. Edit covers the event's name, its link settings and its cover photo.
3. Turning publishing off and on again must bring back **the same link** (and so the same printed
   QR code). Today's revoke is final by design (ADR 0011: a revoked slug is never reused).
4. The admin app gets an overview tab: storage used and capacity, how much is in Cloudflare R2,
   and the VPS's state (CPU and other usage, temperature if there is one).
5. The share page lightbox's download button sat at the bottom, where PhotoSwipe's button styles
   pushed it off screen; it moves to the top bar next to zoom and close.

## Decision

- **Pause, not revoke.** `shares.paused_at` (migration 0014, nullable, additive). `PATCH
/shares/:id { paused: true | false }` sets it (keeping the first time) or clears it. Public routes
  answer `SHARE_EXPIRED` with the new reason `paused` (checked after `revoked`, before `expired`);
  the share page says "ลิงก์นี้ยังไม่เปิดให้ดู" without "ask for a new link". The owner status
  gains `paused`. Revoke stays final and separate.
- **Event view in the listing.** `GET /drive/folders/:id/children` adds `event` to each folder:
  `coverThumbUrl` (the chosen cover while it is a live, ready image in the subtree, else the first
  such image in share-page order) and `link` (the newest share of the folder that isn't revoked,
  with its status, path and URL). Two queries per page. Other responses leave `event` out.
- **Studio UI.** Folders render as event cards (4:3 cover, name, created date, status, QR, edit,
  menu) in their own section above the files; the list layout shows name and link path, created
  date, status, QR, "แก้ไข" and ⋮. The QR code is drawn in the browser (`qrcode`, error
  correction M, black on white, 1024 px PNG on save); nothing leaves the page. The edit dialog
  renames, picks the cover from the event's photos, and creates the link or edits its settings and
  publishes or unpublishes it. "โฟลเดอร์" reads "อีเวนต์" across the studio (the computer folder of
  folder sync keeps its word).
- **Admin overview.** `GET /admin/system` (admin only, read-only, not audited):
  - what the database records: originals bytes (storage_usage), photo and video counts,
    photographers, the database size;
  - the media bucket counted with ListObjectsV2 by top-level prefix, cached for
    `ADMIN_STORAGE_SCAN_TTL_SECONDS` (default 600; one scan at a time). Null when the R2 key may not
    list or the scan fails. R2 has no capacity: the page says so instead of inventing one;
  - the server from the kernel: CPU busy share over a 250 ms `/proc/stat` sample, load averages,
    memory (MemTotal − MemAvailable), the disk at `ADMIN_SYSTEM_DISK_PATH` (statfs, default `/`,
    the host disk under the container's overlay), uptime, and the hottest thermal zone or hwmon
    sensor (null on a KVM guest without sensors).
- **Lightbox.** The download button is a PhotoSwipe top-bar element before zoom and close.

## Consequences

- An unpublished event keeps its slug; anyone with the link sees "not open yet" until it is
  published again. Pausing and expiry are independent: an expired link stays expired when
  published again until its expiry is changed.
- The listing does two extra queries per page; the cover lookup walks the folder's subtree with the
  ltree index and stops at the first image.
- The overview's CPU and memory are the host's because the api container sees the host's /proc
  (no lxcfs). Docker's per-container limits aren't shown. The R2 count costs one Class A request
  per 1,000 objects per scan (at most one scan per TTL).
