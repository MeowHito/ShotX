# ADR 0026: Time-boxed packages, self sign-up and online payment through mpay

- Status: Accepted (owner, 2026-11-16)
- Date: 2026-11-16
- Supersedes: ADR 0010 section 1 for photographers only ("accounts are created by admins only"):
  a photographer account can now also be created by the system, after a verified email (Free) or a
  paid order. Admin accounts are still created only by admins.
- Amends: the photo-platform skill "Plans, quota and billing" — the monthly/yearly storage plans
  and subscriptions (BILLING_MODE, `plans`, `subscriptions`, `payments`) stay switched off and
  untouched; packages below are a separate, simpler system.
- Keeps: ADR 0009 (face scan free on every package), ADR 0010 admin-created accounts (no package
  row = unlimited, exactly as today), ADR 0025 (account email over SMTP, password reset).

## Context

The owner's pricing mockup (`snap-pricing 2.html`) becomes the public home page. A photographer
picks a package by duration and photo count, pays once, and gets an account. The payment gateway
is **mpay**; the owner has applied and is waiting for the merchant details, so the mpay adapter
is written against a gateway interface and stays off until the details arrive.

Owner's answers (2026-11-16):

1. Paying creates the account automatically; someone who already has an account signs in and buys
   more.
2. Free can be taken without paying, confirmed by email, once per email.
3. Expiry and the photo limit are enforced from this release.
4. A package applies to the whole account (not to one event).

## Decision

### 1. Packages

Table `packages` (seeded by the migration; prices are config/DB, never literals in code):

| code | name    | days | photo_limit | price_satang (ex VAT) | total with 7% VAT |
| ---- | ------- | ---- | ----------- | --------------------- | ----------------- |
| free | Free    | 3    | 100         | 0                     | 0                 |
| d3   | 3 Days  | 3    | 1,000       | 39,900                | 42,693            |
| d7   | 7 Days  | 7    | 3,000       | 59,900                | 64,093            |
| d15  | 15 Days | 15   | 5,000       | 79,900                | 85,493            |
| d30  | 30 Days | 30   | 10,000      | 129,900               | 138,993           |

Columns: `id, code UNIQUE, name, days > 0, photo_limit > 0, price_satang >= 0, is_active,
sort_order`. Prices are **VAT-exclusive** (the mockup shows "ราคายังไม่รวม VAT 7%"); the charged
total is `price + vatOnTop(price, VAT_RATE_BASIS_POINTS)` where `vatOnTop = round_half_up(price ×
rate / 10000)` — a new helper beside `splitVat` in `@shotx/shared` billing/money. The featured card
is `PACKAGES_FEATURED_CODE` (default `d7`).

### 2. The photographer's package (one row per account)

Table `photographer_packages`: `photographer_id PK → users, package_id → packages (the last one
applied), starts_at, expires_at, photo_limit, photos_used >= 0, updated_at`.

- **No row = unlimited** (every admin-created account today and later). Nothing changes for them.
- Applying a package (Free confirm or a paid order), in one transaction with `FOR UPDATE`:
  - no row, or `expires_at <= now` (expired): a fresh period — `starts_at = now`,
    `expires_at = now + days`, `photo_limit = package.photo_limit`, `photos_used = 0`;
  - still running: extend — `expires_at += days`, `photo_limit += package.photo_limit`
    (`photos_used` kept).
- **Counting photos:** one file accepted by `POST /uploads/init` = one photo (videos too). The
  increment is a guarded update in the same transaction as the file row
  (`photos_used + n <= photo_limit`, else `PHOTO_LIMIT_REACHED`). `DELETE /uploads/:id` (abort)
  gives it back, and so does the worker's nightly cleanup of an abandoned upload (an upload session
  that expired without completing counts as an abort); deleting or trashing a ready file does
  not; copies inside the drive don't count. Design-image uploads (ADR 0013) don't count.
  Lock order: `photographer_packages` before `storage_usage` (init, abort and the worker
  cleanup), and the init takes the package row only after the storage call.
- **Expired** (`now >= expires_at`): `POST /uploads/init` → `PLAN_EXPIRED`; creating a share,
  re-activating or un-pausing one → `PLAN_EXPIRED`; turning on face indexing → `PLAN_EXPIRED`;
  every share of that owner stops serving (`SHARE_EXPIRED` with `reason: 'plan_expired'`, the
  share page says the link is closed for now). Sign-in, the studio, browsing, renaming, deleting
  and the photographer's own downloads keep working, so they can renew. Nothing is deleted on
  expiry (retention after expiry is a later decision).
- `GET /drive/usage` `uploadsBlockedBy` also answers `PLAN_EXPIRED` / `PHOTO_LIMIT_REACHED`.
- `GET /me/package` → `{ code, name, startsAt, expiresAt, photoLimit, photosUsed, expired }` or
  `null` (unlimited).

### 3. Free sign-up (email-verified, once per email)

1. Home page → Free → dialog asks name + email → web BFF → API `POST /signup/free` (`bff`).
   Always `204` for any well-formed body (no account enumeration). Rate-limited per IP
   (`SIGNUP_RATE_PER_IP`, default 5 / hour), per email (`SIGNUP_EMAILS_PER_HOUR`, default 3) and
   in total (`SIGNUP_EMAILS_PER_DAY`, default 200 emails a day for all addresses together; over it
   nothing is sent, still `204`). With `CAPTCHA_PROVIDER=turnstile` the form carries a Turnstile
   token (`captchaToken`, action `signup_free`); missing or rejected is `RATE_LIMITED` with
   `details.captcha`, as face search answers. The emails never repeat the typed name (it is
   unverified).
2. If the email has no account: Redis stores `SHA-256(token) → { email, name }` for
   `SIGNUP_LINK_TTL_SECONDS` (default 24 h) and the account mailer sends a Thai email linking to
   `/signup/confirm#token=<43-char token>` (fragment, never logged; the page strips it). If the
   email already has an account: an email that says so, with links to sign in and to
   "ลืมรหัสผ่าน". Sent after the answer, as in ADR 0025.
3. `/signup/confirm` asks for a password (photographer policy) → `POST /signup/free/confirm`
   `{ token, password }`. Single use. In one transaction: create the photographer (`created_by`
   NULL, `must_change_password = false`), apply `free`, audit `account.self_signup`
   (`meta.package = 'free'`), then a new session the web stores in the cookies; browser → `/studio`.
   If the email got an account in the meantime → `SIGNUP_LINK_INVALID`.
4. Free is only for emails with no account, so it can't be taken twice.

### 4. Paid orders

Table `package_orders`: `id, package_id, photographer_id NULL → users, email, name,
price_satang, vat_satang, total_satang, gateway, gateway_ref NULL, status
(pending|paid|failed|amount_mismatch), access_token_hash, idempotency_key UNIQUE, paid_at,
applied_at, created_at, updated_at`; `UNIQUE(gateway, gateway_ref)`.

1. Home page → a paid package → dialog: signed-in photographer: summary only (their account);
   otherwise name + email. Shows price, VAT and total. "ชำระเงิน" → web BFF →
   `POST /package-orders` (`Idempotency-Key`), rate-limited per IP (`PACKAGE_ORDER_RATE_PER_IP`,
   default 20 / hour).
   - Refused: unknown/inactive/free package (`PACKAGE_UNAVAILABLE`); `PACKAGE_GATEWAY=off`
     (`PAYMENT_UNAVAILABLE` — the dialog then says online payment opens soon, contact the team);
     an email that belongs to an admin, a disabled account, or an unlimited (no package row)
     photographer (`EMAIL_UNAVAILABLE`, generic Thai message).
   - The API stores the order (`pending`), calls `gateway.createCheckout({ orderId, amountSatang,
description, returnUrl, callbackUrl })` and answers `{ orderId, accessToken, redirectUrl }`.
     The BFF puts `orderId.accessToken` in an httpOnly cookie (`snap_order`, 1 day) and the
     browser goes to `redirectUrl` (the gateway's hosted page; card/QR data never touches Snap).
2. The gateway calls `POST /package-payments/webhooks/:gateway` (raw body, signature checked by
   the adapter before anything is parsed). In one transaction with the order `FOR UPDATE`:
   - already `paid` → no-op (idempotent);
   - amount ≠ `total_satang` → `amount_mismatch`, audit, nothing applied;
   - paid → `paid`, `paid_at`; resolve the account: the order's `photographer_id`, else an
     existing photographer with that email, else create one (`created_by` NULL, random password
     hash nobody knows); apply the package; `applied_at`; audit `package.order_paid`
     (`meta: { orderId, package, totalSatang, accountCreated }`).
   - the account can't take a package (it has no package row, i.e. it is an unlimited ADR 0010
     account, or it is disabled, or the email now belongs to an admin) → nothing is applied, the
     order stays `pending` and the operator gets a `package.account_unresolvable` event (a package
     must never limit an unlimited account).
   - failed → `failed`.
     After commit: a new account gets a "ตั้งรหัสผ่าน" email — an ADR 0025 reset token with
     `PACKAGE_SET_PASSWORD_TTL_SECONDS` (default 7 days) linking to `/reset-password#token=…`; an
     existing account gets "เพิ่มแพ็กเกจแล้ว". Both show package, expiry and amount (not a tax
     invoice).
     A paid callback for an old pending order still applies: money received always counts.
3. `/checkout/return` (the gateway's return URL) reads the cookie and polls
   `GET /package-orders/:id` with header `X-Order-Token` (constant-time hash compare) every 3 s
   for up to 2 min: `pending` → waiting; `paid` → "ส่งลิงก์ตั้งรหัสผ่านไปที่ a***@…" or, for a
   signed-in buyer, a link to the studio; `failed`/`amount_mismatch` → try again / contact us. When
   the adapter supports `inquire(gatewayRef)`, the poll asks the gateway once the order has been
   pending for 30 s (`PACKAGE_ORDER_INQUIRE_AFTER_SECONDS`), then at most once per order every
   `PACKAGE_ORDER_INQUIRE_INTERVAL_SECONDS` (default 20, a Redis key), and applies the result
   through the same transaction as the webhook. The poll shows the package expiry only to an
   order that created the account or was placed signed in; an anonymous order for an existing
   account answers `expiresAt: null`.

### 5. Gateways

`PACKAGE_GATEWAY` = `off | fake | mpay` (default `off`), api only.

- `PackagePaymentGateway` interface: `createCheckout`, `verifyCallback(raw)`,
  `parseCallback(raw) → { gatewayRef, orderId, status: paid|failed|pending, amountSatang }`,
  optional `inquire(gatewayRef)`.
- `mpay`: adapter skeleton reading `MPAY_API_URL`, `MPAY_MERCHANT_ID`, `MPAY_SECRET_KEY`
  (secret, never logged). Until the merchant documentation arrives every call throws
  `PaymentGatewayNotConfiguredError` and `verifyCallback` answers false, so nothing is applied.
- `fake`: dev/test only (allowed only on `APP_STAGE=local` or `test`, an allowlist): `redirectUrl` is the web page
  `/checkout/fake?order=<id>` with "จ่ายสำเร็จ" / "จ่ายไม่สำเร็จ" buttons that call
  `POST /package-orders/:id/fake-result` (exists only with the fake gateway) → same transaction as
  the webhook.
- Production until mpay is ready: `PACKAGE_GATEWAY=off`. Free sign-up works; paid cards show the
  "coming soon / contact us" dialog of the mockup.

`PACKAGE_SALES` = `on | off` (default `off`): the kill switch. `off`: `/signup/*` and
`/package-orders` answer `NOT_FOUND`, the home page still shows the packages and the dialog says
to contact the team.

### 6. Web

- `/` becomes the mockup's pricing page: the mockup's header (camera-face logo + SNAP) with the
  language switcher and "เข้าสู่ระบบ", hero, "ทุกแพ็กเกจใช้งานได้ครบ" feature grid, the five
  package cards (featured `d7`), footnote "ราคายังไม่รวม VAT 7% · ชำระครั้งเดียวตามระยะเวลาที่เลือก"
  and the footer. The FAQ was added by ADR 0027 §6, rewritten to this behaviour. `/pricing` redirects to
  `/#packages`. Prices come from `GET /packages` (server-rendered; `Cache-Control` max-age `PACKAGES_CACHE_MAX_AGE_SECONDS`, default 60).
- Studio: a package chip (name · days left · photos used / limit) with "ต่ออายุ" → `/#packages`;
  an expired banner; Thai messages for `PLAN_EXPIRED` and `PHOTO_LIMIT_REACHED` in upload, sync,
  share and face-index flows.
- Admin: the users list/detail shows the package and expiry of self-signed-up accounts.

### 7. New error codes

`PLAN_EXPIRED`, `PHOTO_LIMIT_REACHED`, `PACKAGE_UNAVAILABLE`, `PAYMENT_UNAVAILABLE`,
`EMAIL_UNAVAILABLE`, `SIGNUP_LINK_INVALID`, `ORDER_NOT_FOUND` (wrong id or token).

## Consequences

- Anyone can now get a photographer account. Abuse is limited by email verification, one Free per
  email, rate limits, 100 photos and 3 days.
- Bandwidth: Free shares serve for at most 3 days; shares of expired accounts stop serving, which
  also stops their download cost.
- Orders keep the buyer's name and email (personal data, needed for the account and receipts).
- Still open for the owner: retention after expiry, refund policy, terms page, tax invoices, mpay
  merchant details.
