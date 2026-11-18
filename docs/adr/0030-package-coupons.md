# ADR 0030: Discount coupons for package orders

- Status: Accepted (owner, 2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0026 §4 (package orders), ADR 0027 (admin finance and audit log), ADR 0029 (mPAY)

## Context

The owner wants to test the live mPAY payment without paying a full package price, and wants
discount codes for customers: an admin creates a code worth 1–100% off with a number of uses.

## Decision

1. **`package_coupons`** (migration 0020): `code` (upper-case A–Z, 0–9, `-`, `_`, 3–32 characters,
   unique; typed codes are upper-cased first), `percent_off` 1–100, `max_redemptions` ≥ 1,
   optional `expires_at`, `is_active`, optional `note`, `created_by` (an admin). Coupons are never
   deleted; an admin switches one off, or changes its uses or expiry. Every write is in one
   transaction with its audit row (`finance.coupon_created`, `finance.coupon_updated` with only
   what changed; target type `coupon`).
2. **Price.** The percent comes off the VAT-exclusive price (rounded half up to the satang), then
   VAT goes on top of what is left (`discountedPackageTotal`). Example: 3 Days at 99% is ฿3.99 +
   VAT = ฿4.27. `package_orders` gains `coupon_id`, `coupon_code` and `discount_satang`;
   `price_satang` is the price after the discount, so finance income is what was charged.
3. **Uses are counted, never stored**: orders with the coupon that are `paid`, plus `pending` or
   `failed` ones created less than `PACKAGE_COUPON_HOLD_SECONDS` ago (default 30 minutes), each
   holding one use while the buyer pays. A new order re-checks the coupon with its row locked
   `FOR UPDATE` in the insert's transaction, so two buyers can't both take the last use
   (COUPON_USED_UP). A payment always settles: an order paid after its hold ended still counts,
   which can take a coupon one past its limit; that is accepted (money received counts).
   A replay of the same request (same Idempotency-Key) is the same order, not another use.
4. **Buy dialog.** A "โค้ดส่วนลด" field: `POST /package-coupons/check` (bff, PACKAGE_SALES on,
   `PACKAGE_COUPON_CHECK_RATE_PER_IP` per IP, default 30 per 10 minutes, so codes can't be guessed
   quickly) answers the new price; nothing is held. The order sends `couponCode`. Errors:
   COUPON_INVALID (unknown, off or expired: one code, so the answer never says which codes exist)
   and COUPON_USED_UP. The pay page shows the code and the price without it.
5. **100% off** needs no gateway: the order is created with `gateway` `coupon` and settled at once
   through the paid-callback transaction (account, package, audit, emails); `redirectUrl` is
   `/checkout/return`. It works even with `PACKAGE_GATEWAY=off`, but not with `PACKAGE_SALES=off`.
6. **Admin** `/coupons` page: create (confirmed first), list with uses (paid + holding), switch on
   or off, change the number of uses. Routes: `GET /admin/coupons`, `POST /admin/coupons`
   (CONFLICT for a taken code), `PATCH /admin/coupons/:id`.

## Consequences

- A coupon can't be limited to one package or one buyer yet; add columns by ADR if needed.
- mPAY may refuse very small amounts; with today's prices the smallest 99% total is ฿4.27.
