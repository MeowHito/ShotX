# ADR 0010: Admin-provisioned accounts, cash payment, no storage limit

- Status: Accepted (the owner's decision of 2026-11-10). Online billing returns in a later ADR
  once the bank/payment gateway sends its details.
- Date: 2026-11-10
- Supersedes: the self-serve parts of the photo-platform skill — "Roles" (photographers buy and
  renew a plan), "Plans, quota and billing" (checkout, webhooks, quota enforcement, subscription
  lifecycle as the gate to the drive) and the self-serve `POST /me/photographer` upgrade
- Amends: ADR 0008 section 4 (auth issued by the API: photographers no longer sign in only with
  LINE/Google; admins are no longer created by the operator CLI only)
- Keeps: ADR 0009 (self-hosted face recognition, free) unchanged

## Context

The bank has not yet sent what the payment gateway needs, so the platform cannot take money
online. The owner wants to launch anyway with a manual flow:

1. A photographer pays the owner in cash (or a transfer the owner checks by hand).
2. An admin creates the photographer's account in the admin UI.
3. The photographer signs in with the email and password the admin gave them and uses their own
   drive, which works like Google Drive.

Storage is not limited for now. Face scan stays the self-hosted, free provider of ADR 0009.

## Decision

### 1. Accounts are created by admins only

- There is no self sign-up for photographers or admins. `POST /me/photographer` (self-serve
  upgrade) is removed or answers `FORBIDDEN`.
- An admin creates a user in the admin app with: email, display name, role (`admin` or
  `photographer`) and an initial password. The admin hands the password to the person out of
  band.
- Viewers (role `user`) are unchanged: they open share links anonymously, or sign in with
  LINE/Google when a share has `require_login`.
- Admins can also: list and search users, reset a user's password (new initial password),
  disable and re-enable an account, and change a photographer's display name. Every one of these
  actions writes `audit_log`.
- An admin cannot disable or demote themself, and the last active admin cannot be disabled or
  demoted.
- The role of an existing account doesn't change between `admin` and `photographer` (the two
  live in different auth pools); create a new account instead.

### 2. Sign-in with email and password

- Photographers sign in at the studio (apps/web) with email + password. Credentials are argon2id
  PHC strings, like `admin_credentials` (ADR 0008 section 4), in a users-pool credentials table
  (contracts owns the name and migration). Lockout after repeated failures uses the same
  mechanism and config pattern as admins.
- The initial password set by an admin is temporary: the first sign-in must set a new password
  before anything else works (`PASSWORD_CHANGE_REQUIRED`). The same applies after an admin
  reset.
- Photographers can change their own password in the studio. Password reset by email is a later
  step; until then an admin resets it.
- Admins sign in to the admin app with email + password + TOTP, as today. MFA stays required for
  admins; it is not relaxed for convenience. An admin created in the UI enrols TOTP on first
  sign-in (the enrolment secret is shown once to that admin, never to the creating admin).
- Password length policy comes from config (`ADMIN_PASSWORD_MIN_LENGTH` for admins, a new
  photographer minimum for photographers). Short or guessable passwords are rejected.
- The bootstrap admin is `action.in.th@gmail.com`, created once with the operator CLI
  (`pnpm --filter @shotx/api admin create`). Its password is typed on stdin and never written
  into the repo, `.claude/`, docs, env files or logs.
- Disabling an account revokes all its sessions (`auth_sessions` families) and blocks sign-in.
  A disabled photographer's shares stop working (`SHARE_EXPIRED`-style page) until re-enabled;
  files are kept, never deleted by disabling.

### 3. Payment is offline

- No payment gateway, checkout or webhook runs in this phase. The billing module stays in the
  code but is switched off by config (`BILLING_MODE=offline`, contracts names it); its routes
  answer `NOT_FOUND`/`FORBIDDEN` and the studio hides plans and checkout.
- Optional in the admin UI: record a cash payment against a photographer (amount in satang,
  date, note, recording admin) for the owner's own bookkeeping. It is a ledger entry inside a DB
  transaction with an audit_log row, not a gateway payment. Money is still integer satang.
- The subscription lifecycle (trial/grace/expired/purged) and its reminder emails don't run.
  Account access is decided by the account's status (`active` / `disabled`) only.

### 4. No storage limit for now

- Uploads are not checked against a plan quota (`QUOTA_EXCEEDED` doesn't fire) while
  `STORAGE_QUOTA_ENFORCED=false` (contracts names it; default false in this phase).
- `storage_usage` (used and reserved bytes) is still maintained exactly, including the upload
  reservation and nightly reconciliation, so a limit can be switched on later and the admin
  can see who uses how much. Per-file size limits and the MIME allowlist stay.

### 5. What does not change

- Each photographer has their own drive (tenant isolation by `owner_id`, ltree share scope).
- Sharing, consent, face scan (self-hosted, ADR 0009), downloads, PDPA rules, R2/VPS (ADR 0008).
- Admins read across tenants and take down files/shares; every admin action is audit-logged.

## Consequences

- New work, in order: contracts (account status, photographer credentials, admin user-management
  schemas and error codes, `BILLING_MODE`, `STORAGE_QUOTA_ENFORCED`, optional `cash_payments`)
  → api (admin users endpoints, photographer password sign-in, forced password change, disable
  revokes sessions, billing off, quota off) → admin app (first pages: sign-in with TOTP, users
  list/create/reset/disable, optional cash payments) and web (studio email/password sign-in,
  change password, hide plans/checkout) → reviewer.
- apps/admin doesn't exist yet; user management becomes its first feature, before the
  dashboards.
- Cost risk: with no storage limit, one account can upload without bound. The admin users list
  shows used bytes; the owner watches it until limits return.
- When online billing returns: a new ADR decides how existing admin-created accounts map to
  plans and subscriptions.

## Open questions for the owner

- Should disabling a photographer also take their shares offline (assumed yes, above)?
- Record cash payments in the system, or keep them outside it?
- Password reset by email for photographers: when?
