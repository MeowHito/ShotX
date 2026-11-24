# ADR 0032: Buy more days or photos, and renew, from the studio

- Status: Accepted (owner, 2026-11-24)
- Date: 2026-11-24
- Builds on: ADR 0026 (packages), ADR 0029 (pay page), ADR 0030 (coupons)

## Context

A photographer whose package ran out of days may still want to hand out the event's photos. Today
the only way back is to buy a whole package again from the home page: an expired account then
starts a fresh period with `photos_used = 0` and only that package's photo limit, and there is no
way to buy days (or photos) alone. The owner wants, for people who already have an account:

1. packages that add days only ("ซื้อวันเพิ่ม"): +1 day ฿79, +3 days ฿199, +7 days ฿399;
2. packages that add photos only ("ซื้อภาพเพิ่ม"): +1,000 ฿199, +3,000 ฿449, +5,000 ฿649;
3. renewal ("ต่ออายุ") from inside the studio.

These are shown only to signed-in photographers who have a package, never on the public home
page. Prices are VAT-exclusive, as every package (ADR 0026).

## Decision

### 1. Package kinds

`packages.kind` (enum `package_kind`, migration 0022, default `plan`):

| kind     | days | photo_limit | what applying it does                                          |
| -------- | ---- | ----------- | -------------------------------------------------------------- |
| `plan`   | > 0  | > 0         | ADR 0026 unchanged (fresh period if none/expired, else extend) |
| `days`   | > 0  | 0           | more days, photos untouched                                    |
| `photos` | 0    | > 0         | more photos, expiry untouched                                  |

The CHECKs `packages_days_positive` and `packages_photo_limit_positive` become one
`packages_kind_terms`; `free` must be a `plan`. Migration 0022 seeds (`ON CONFLICT DO NOTHING`;
edited in the DB later, never in code):

| code      | name          | kind   | days | photos | price_satang |
| --------- | ------------- | ------ | ---- | ------ | ------------ |
| day1      | +1 Day        | days   | 1    | 0      | 7,900        |
| day3      | +3 Days       | days   | 3    | 0      | 19,900       |
| day7      | +7 Days       | days   | 7    | 0      | 39,900       |
| photo1000 | +1,000 Photos | photos | 0    | 1,000  | 19,900       |
| photo3000 | +3,000 Photos | photos | 0    | 3,000  | 44,900       |
| photo5000 | +5,000 Photos | photos | 0    | 5,000  | 64,900       |

### 2. Applying an add-on (`applyPackage`, in the paid callback's transaction)

An add-on needs a `photographer_packages` row (the account has had a package).

- `days`, package running: `expires_at += days`.
- `days`, package expired: `starts_at = now`, `expires_at = now + days`; **`photo_limit` and
  `photos_used` are kept** — the point of the add-on is to keep handing out the same event's
  photos, and the shares re-open at once.
- `photos`: `photo_limit += n`, expiry untouched (also if it expired between order and payment:
  money received always counts).
- `package_id` stays the last **plan** applied, so the studio chip and the admin keep the
  package's name (an add-on is not a package of its own).

`plan` stays as ADR 0026 (a running package is extended with its days and photos; an expired one
starts fresh). That is "ต่ออายุ".

### 3. Ordering

`POST /package-orders` with an add-on code:

- only for a signed-in photographer (anonymous: `PACKAGE_UNAVAILABLE`); the account must have a
  package row (`EMAIL_UNAVAILABLE`, as for plans);
- `photos` while the package has expired: `PLAN_EXPIRED` (buy days or renew first);
- coupons (ADR 0030) work as for plans; everything after the order (pay page, callback, emails,
  admin finance) is the same.

`GET /packages` (public, home page) answers `plan` packages only, unchanged. New
`GET /me/package/offers` (photographer) answers the same shape with every active, priced package
the account can buy: plans (no Free) and add-ons, each with its `kind`; an unlimited account (no
row) gets an empty list. `publicPackageSchema` gains `kind`.

### 4. Studio

New page `/studio/package` ("แพ็กเกจของฉัน"): the current package (name, expiry, days left,
photos used of the limit) and three sections — "ซื้อวันเพิ่ม", "ซื้อภาพเพิ่ม" (disabled with a
note while expired) and "ต่ออายุ / ซื้อแพ็กเกจ" — each card opening the existing buy dialog
(coupon, price, VAT, total, pay page). The studio chip's and the expired banner's "ต่ออายุ" link
here instead of `/#packages` (both show only for accounts with a package, so the page needs no
nav item); an unlimited account that opens it is told there is nothing to buy.

## Consequences

- An expired account can buy one day to re-open its links without paying for photos again.
- Add-ons are not offered to visitors; prices still aren't secret (the studio shows them).
- Admin finance and the audit log show add-on orders like any package order, by name.
