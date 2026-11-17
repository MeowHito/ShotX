# ADR 0029: mPAY ONE behind Snap's own pay page (PromptPay QR and card)

- Status: Accepted (owner, 2026-11-17)
- Date: 2026-11-17
- Builds on: ADR 0026 §5 (package gateways; the mpay skeleton this replaces)

## Context

mPAY (AIS) opened a production service for Snap on 2026-11-17 (merchant `2317346`, service
`23173462632177666`). mPAY ONE ("API Specification" v4.19) has no single hosted page with every
method: PromptPay is `POST /v1/qr` (answers a QR image) and cards are
`POST /v1/cc/txns/payment_order` with `form_type` FORM (answers a hosted form URL). Each request's
`order_id` is at most 20 characters and unique per merchant. Payment Notify callbacks go to one URL
registered with mPAY per service. A probe on 2026-11-17 (1 THB, nothing paid) showed the signature
accepted and both channels still switched off on mPAY's side; mPAY says they open on 2026-11-18.

## Decision

1. **Pay page.** With `PACKAGE_GATEWAY=mpay`, `createCheckout` sends the buyer to Snap's
   `/checkout/pay?order=<id>` (PACKAGE_PAY_PATH); nothing goes to mPAY until a method is picked.
   The page shows the package and total and the methods of `MPAY_METHODS` (default `qr,card`):
   - `qr`: the PromptPay QR on the page with a countdown (`MPAY_QR_EXPIRE_SECONDS`, default 600),
     "save the QR", a new QR when it expires; the page polls the order and goes to
     `/checkout/return` once it is no longer pending;
   - `card`: the browser goes to mPAY's form; 3-D Secure success and failure both come back to
     `/checkout/back` (PACKAGE_GATEWAY_RETURN_PATH, GET or POST), which answers 303 to
     `/checkout/return`. Nothing is read from the return request.
2. **`POST /package-orders/:id/pay`** (bff, order token) `{ method }`: a new attempt id
   (`SN` + 18 random characters) is stored first in `package_orders.gateway_attempts` (migration
   0019, `text[]`, newest first, at most 10), then mPAY is called with `order_id` = the attempt id,
   `ref_1` and `cust_id` = Snap's order id, `amount` = total in THB. PAYMENT_UNAVAILABLE when the
   method isn't offered or the order is paid; RATE_LIMITED past `PACKAGE_PAY_RATE_PER_ORDER`
   (default 10 per 10 minutes); PAYMENT_GATEWAY_ERROR when mPAY refuses or times out
   (`MPAY_TIMEOUT_MS`), with mPAY's error code in event `package.payment_start_failed`.
   `GET /package-orders/:id` gains `paymentMethods` (what the pay page may offer now).
3. **Signatures.** Requests and callbacks: `X-sdpg-signature` = lowercase hex
   HMAC-SHA256(`MPAY_SECRET_KEY`, body + `X-sdpg-nonce`) over the exact bytes. Callbacks are also
   accepted as upper-case hex or base64 of the hex (the spec's examples show both); a
   `X-sdpg-merchant-id` header, when sent, must be ours.
4. **Results.** A callback (or enquiry) with `status` SUCCESS and `txn_type` PAYMENT is `paid`
   with `gatewayRef` = mPAY's `txn_id` and the amount from `amount` (must equal the order total:
   mPAY's customer fee must be 0, else `amount_mismatch`). FAIL, voids and refunds are `pending`:
   the order stays payable (another QR or the card), and refunds are made in mPAY's back office.
   `inquire` asks `POST /v1/enquiry` about the 3 newest attempts once an order has been pending for
   `PACKAGE_ORDER_INQUIRE_AFTER_SECONDS`.
5. **Config.** `MPAY_SERVICE_ID` joins `MPAY_API_URL`, `MPAY_MERCHANT_ID` and `MPAY_SECRET_KEY`
   (required with mpay). Production: `MPAY_API_URL=https://api.paymentgateway.ais.co.th/prod`.
   The secret lives only in the VPS api.env.

## Consequences

- One order can have several mPAY transactions; two successful ones (a QR paid after a card) are
  recorded once (`duplicate`) and the second is refunded by the operator from mPAY's back office.
- The return page offers "pay again" while the order is still payable.
- Production switches stay off until mPAY opens the channels and one real payment succeeds:
  then `PACKAGE_GATEWAY=mpay` with the `MPAY_*` values and `PACKAGE_SALES=on`.
