# ADR 0027: Admin finance (income, expenses, per-user money) and the audit log viewer

- Status: Accepted (owner, 2026-11-16)
- Date: 2026-11-16
- Builds on: ADR 0026 (package orders), ADR 0010 (cash payments, audit log), ADR 0019 (cost
  estimate on the overview)

## Context

The owner asked (2026-11-16): build what ADR 0026 left out — a page to read the audit log, a
chart of income and expenses, and per user: how many times they bought, how much they paid and
how much they have cost. The draft FAQ goes on the home page too, rewritten to match what the
system now does.

## Decision

### 1. Audit log viewer

`GET /admin/audit-log` (admin guard, MFA as every admin route): cursor-paginated newest first
(`ADMIN_LIST_PAGE_SIZE`), filters `action` (one or more values, OR-ed: each exact or a prefix
ending in `.`, e.g. `package.`; comma-separated and/or a repeated parameter, at most
`AUDIT_ACTION_FILTER_MAX_VALUES` = 10, e.g. `action=package.,account.self_signup`),
`actorId`, `targetId`, `from`, `to`. Each item: `id, createdAt, action, actorId | null,
actorEmail | null, targetType, targetId, targetEmail | null (when the target is a user), meta`.
`meta` is returned as stored (it never holds secrets, tokens, passwords or selfies by the
earlier ADRs). The admin app gets a "บันทึกกิจกรรม" page: table, filters, Thai labels for every
action in `ADMIN_AUDIT_*`/`PACKAGE_AUDIT_ACTIONS`/auth actions, "ระบบ" for a null actor, a link
to the user for user targets, and the raw meta on expand.

### 2. Expenses (manual ledger)

Table `expenses`: `id, spent_on date, amount_satang > 0, category (server | storage |
payment_fee | domain | email | marketing | other), note (≤ 500), recorded_by → admin, created_at,
deleted_at`. Routes: `GET /admin/expenses?from&to&cursor`, `POST /admin/expenses`,
`DELETE /admin/expenses/:id` (soft delete). Every write in one transaction with `audit_log`
(`finance.expense_created`, `finance.expense_deleted`).

### 3. Finance summary

`GET /admin/finance?from&to&bucket=day|month` (Asia/Bangkok buckets; default the last 30 days
by day). All money is integer satang.

- **Income:** paid `package_orders` (by `paid_at`; total incl. VAT, VAT, and net ex VAT) plus
  `cash_payments` (by `paid_at`; ADR 0010 amounts as recorded).
- **Expenses:** manual `expenses` (by `spent_on`) plus the **estimated running cost** from
  ADR 0019's constants (R2 storage above the free GB, `VPS_MONTH_THB`, `USD_THB`), spread evenly
  per day over the range and labelled as an estimate.
- Response: `totals { incomeSatang, packageIncomeSatang, cashIncomeSatang, vatSatang,
netIncomeSatang, manualExpenseSatang, estimatedCostSatang, expenseSatang, profitSatang,
ordersPaid, buyers, freeSignups, paidSignups }`, `series[] { bucket, packageIncomeSatang,
cashIncomeSatang, vatSatang, manualExpenseSatang, estimatedCostSatang }` (a bucket's profit is
  package + cash − VAT − manual − estimated; the series VAT adds up to `totals.vatSatang`), `packageMix[] { code, name,
orders, incomeSatang }`, `topCustomers[] { userId, email, name, orders, paidSatang }` (top 10).

### 4. Per-user money

`GET /admin/users/:id/finance`: `orders[] { id, packageCode, packageName, status, totalSatang,
vatSatang, createdAt, paidAt }` (newest first, all statuses), `ordersPaid`, `paidSatang`
(packages, VAT included), `netPaidSatang` (packages ex VAT), `cashPaidSatang`, `firstPaidAt`,
`lastPaidAt`, `usage { storageBytes, bytesServed (sum of daily_stats.bytes_out), photosUploaded
(non-deleted image files) }`, `estimatedCostSatang { storage, server, total }`,
`profitSatang = net paid (ex VAT) + cash − total cost` (owner, 2026-11-16: the same basis as the
finance summary's profit, net income − expenses; VAT is owed, not earned).

Estimated cost per user is an allocation, not a bill: the platform's monthly estimated cost
(ADR 0019) is shared by each user's share of stored bytes (storage) and of bytes served (server),
accrued per day from the account's creation to now. The admin UI says "ประมาณการ".

The users list adds optional `ordersPaid` and `paidSatang` (packages + cash) per user.

### 5. Admin UI

- New page "การเงิน": stat tiles (รายรับ, รายจ่าย, กำไร, คำสั่งซื้อที่ชำระแล้ว, สมัครฟรี), a
  range/bucket filter row, an income-vs-expenses bar chart, a separate profit chart (never a
  second y-axis), package mix, top customers, and the expenses ledger with "เพิ่มรายจ่าย".
- User detail gets a "การเงิน" section from §4; the users list gets a "ยอดชำระ" column.
- Charts use Apache ECharts (the platform's chart library), with tooltips, legends, a table view
  and dark mode.

### 6. FAQ on the home page

The mockup's FAQ, rewritten to the behaviour of ADR 0026 (per account, starts at payment or
Free confirmation, extension adds days and photos, one upload = one photo, deleting doesn't give
it back, face search on every package, VAT 7% on top, expiry closes links until renewal).
Questions the owner hasn't decided (retention after expiry, refunds) say to contact the team.
No "draft" notice.

## Consequences

- Expenses are only as complete as what admins record; the estimate covers R2 and the VPS only.
- Per-user cost is an allocation for finding loss-making accounts, not an invoice.
