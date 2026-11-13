# ADR 0019: Design "show all photos" switch, design on a live link, sync settle time, IPv6 client addresses, overview costs

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

Owner feedback from the first live event (Pocari Trail, 2026-11-13):

1. A photographer published a link without a design, then wanted the design during the event.
   They made a second link (`pocari-trail-ryar52`) because the drive's "แชร์" dialog always
   offered a new link; the event dialog could already change the design but sat behind a long
   form with a cover picker that listed every photo.
2. On a designed page the full-screen card gave no hint that photos follow, so viewers (and the
   owner) thought a design meant "scan only". The owner wants that as an explicit choice per
   design: show all photos (default) or scan only.
3. Lightroom exports with a watermark plugin lost the watermark: folder sync uploaded the file
   as soon as two scans saw the same size, before the plugin rewrote it; the rewritten version
   was then NAME_TAKEN (`exists`) and never uploaded.
4. Face scans hit per-IP limits: IPv6 visitors reached Caddy through docker-proxy as the edge
   network's gateway (172.30.0.x), so they shared one address (memory: raised limits as a stopgap).
5. The admin overview should estimate what R2 and the VPS cost per month.

## Decision

- **Design switch.** The design document gets an optional `showPhotos` (absent or true: show;
  false: scan only), set by a "แสดงรูปทั้งหมด" checkbox in the designer's top bar (on by default).
  No migration: `doc` is jsonb and old documents parse as "show". The api enforces it in one
  place, `loadShare` (share-access): a **folder** share whose own design (`shares.design_id`; the
  owner's default is still never applied at view time, ADR 0013) has `showPhotos: false` is served
  as `face_only` (meta, items, views, downloads all read that mode). The share row keeps its own
  mode, so switching the design back restores browsing. File shares keep their mode (face_only
  needs a folder). Hiding wins: a `face_only` share stays scan-only whatever the design says.
- **Discoverability.** With photos below (gallery), the designed card is 3rem shorter and closes
  with a "เลื่อนลงดูรูปทั้งหมด" strip that scrolls to the gallery.
- **Design on a live link.** The share dialog lists each live link with its design, changed in
  place (`PATCH /shares/:id { designId }`, same URL), and hides the new-link form behind
  "สร้างลิงก์ใหม่อีกอัน" once a link is live. The event dialog drops the cover picker (the cover
  stays settable from the drive menu) and shows the link's design picker; with no designs, a
  "ไปสร้างดีไซน์" button. The design picker labels designs that hide photos.
- **Folder sync settle time.** A file is uploaded only when unchanged between two scans **and**
  last modified at least `WEB_FOLDER_SYNC_SETTLE_MS` ago (default 20 s), so post-processors that
  rewrite Lightroom's export (watermarks) finish first. Replacing an already-uploaded version is
  not supported (still `exists`).
- **IPv6 client addresses.** The compose `edge` network enables IPv6 (ULA `fd30:0:0:1::/64`, proxy
  `fd30:0:0:1::10`); with Docker's ip6tables, published ports NAT IPv6 clients and keep their
  address. `TRUSTED_PROXY_ADDRESSES` lists both proxy addresses. The VPS's IPv6 default route is
  static (`accept_ra` 0), so the forwarding Docker enables doesn't affect it. Recreating the edge
  network takes the site down for about a minute (owner accepted). The raised per-IP limits stay
  (guests at one venue share a Wi-Fi address). Rate-limit keys still hash the full IPv6 address.
- **Overview costs.** GET /admin/system adds `cost`: R2 storage above the free GB at the bucket's
  current size (`R2_STORAGE_GB_MONTH` 0.015 USD, `R2_FREE_STORAGE_GB` 10; operations not counted,
  egress free), a monthly VPS bill `VPS_MONTH_THB` and `USD_THB`. The admin shows each in USD and
  THB and a monthly total. Amended the same day (owner): the VPS is prepaid (KVM 8, 2 years up
  front), so `VPS_MONTH_THB` defaults to 0, the VPS card says "จ่ายรายปีแล้ว" and the total is R2
  only; under the free GB, R2 says "ยังอยู่ในโควตาฟรี" with how much of it is used.

## Consequences

- A photographer can turn a live gallery link into scan-only (or back) by switching its design
  or the design's checkbox; viewers holding the page see the change on the next request.
- Server-side watermarking was asked about; it is not part of this ADR (the settle time keeps the
  Lightroom watermark working at no server cost). A worker-side watermark on derivatives would
  cost little CPU and can follow in its own ADR.
- Docker build cache on the VPS (~53 GB) is trimmed after deploys (deploy/README.md).
