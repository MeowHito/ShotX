# ADR 0031: Print orders from the share page

- Status: Accepted (owner, 2026-11-19)
- Date: 2026-11-19
- Builds on: ADR 0011 (share page), ADR 0012 (downloads), ADR 0024 (studio)

## Context

The owner wants viewers of a share link to ask for a printed photo at the event: a printer icon
at the top right of each photo, a choice of paper size, and the order goes to the photographer
who shared the link, who prints it on their own printer. The viewer never prints. The photographer
sets how many photos one device may order, which paper sizes are offered, and whether orders print
on their own or must be allowed first. It is a new studio tab.

## Decision

1. **Settings** (`print_settings`, one row per photographer, migration 0021; no row = off):
   `enabled`, `approval` (`auto` | `manual`), `per_device_limit` (1–100, per share), `paper_sizes`
   (codes of `PRINT_PAPER_SIZES`: 4R 4×6", 5R 5×7", 6R 6×8", 8R 8×10", A5, A4; at least one).
   They apply to every share of the photographer. `GET` / `PUT /print/settings`.
2. **Orders** (`print_orders`): share, file, device, optional viewer, paper size, optional
   `customer_name` (≤ 60, name or bib number so the print can be handed over), status
   `pending` → `queued` → `printed`, or `rejected`; `order_number` counts up per photographer and
   is what the viewer is told ("#12"). Purging the file or deleting the share removes its orders.
3. **Device** = the share page's `anon_id` cookie (set for every browser, signed in or not). The
   limit counts the device's non-rejected orders on that share; numbering and the limit check run
   under a per-photographer advisory lock, so parallel orders can't pass the limit or share a
   number. Clearing cookies gives a new device: the limit is a courtesy limit, not a quota.
   `PRINT_ORDER_RATE_PER_VIEWER` (default 30 per 10 minutes) bounds requests per share and device.
4. **Share page**: `GET /s/:token/prints` (offer or null, the device's orders and how many it has
   used) and `POST /s/:token/prints` (`fileId`, `paperSize`, `customerName`). Every share gate
   applies, and the file must be a ready photo in the share's scope and, in face_only mode, in the
   viewer's grant (NOT_FOUND otherwise, like downloads). Videos and a switched-off photographer are
   PRINT_UNAVAILABLE, a size not offered PRINT_SIZE_UNAVAILABLE, the limit PRINT_LIMIT_REACHED
   (details `limit`, `used`). The printer button sits in the photo's top-right corner (the
   selection dot moves left of it) and is filled once the device ordered that photo; the dialog
   shows the sizes, the name field, how many prints are left, then the order number.
5. **Studio `/studio/print` ("สั่งพิมพ์")**: the settings, the orders by status with counts
   (polled every 5 s), allow / decline / print / print again. `auto` creates orders as `queued`,
   `manual` as `pending` until allowed.
6. **Printing** happens in the photographer's browser: a hidden iframe with one borderless page of
   the chosen size (`@page size`, turned to the photo's orientation, the photo filling it with
   `object-fit: cover`) and the original image (signed view URL), then `print()`.
   `POST /print/orders/:id/print` marks the order `printed` and counts it before the browser
   prints. A **print station** is a browser switch (localStorage) on the computer with the printer:
   while the page is open it takes the oldest `queued` order with `onlyQueued: true` (CONFLICT if
   another station took it first) and prints it, one at a time. Browsers show their print dialog
   for each page unless Chrome runs with `--kiosk-printing`, which the page explains.

## Consequences

- Prints are free and offline: no payment, no per-print price. Selling prints is a later ADR.
- The settings are per photographer, not per share; a per-share switch can be added later.
- A failed physical print stays `printed`; the photographer uses "print again".
- `customer_name` is personal data typed by the viewer; it stays with the order and goes when the
  share or file is deleted.
- The studio lists the newest 200 orders per status.
